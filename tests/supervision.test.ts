import assert from "node:assert/strict";
import test from "node:test";

import { SupervisionWatcher } from "../src/pi/supervision-watcher.ts";
import {
	acknowledgeWake,
	claimNextWake,
	consumeNextWake,
	observeThreadTransition,
	recoverInFlightWakes,
	rejectWake,
	shouldRunTurnEndGuard,
} from "../src/pi/supervision.ts";
import type { ManagedThread, SupervisionSnapshot, ThreadSupervisionState } from "../src/types.ts";

const now = "2026-01-01T00:00:00.000Z";

test("status transitions queue one actionable wake and suppress duplicate observations", () => {
	const state = createState();
	const thread = createThread({ status: "running" });
	observeThreadTransition(state, thread, now);
	observeThreadTransition(state, { ...thread, status: "idle" }, now);
	assert.equal(Object.keys(state.pendingWakes).length, 1);
	observeThreadTransition(state, { ...thread, status: "idle" }, now);
	assert.equal(Object.keys(state.pendingWakes).length, 1);

	const event = consumeNextWake(state, now);
	assert.ok(event);
	observeThreadTransition(state, { ...thread, status: "idle" }, now);
	assert.equal(Object.keys(state.pendingWakes).length, 0);
});

test("completed idle turns and actionable status changes have distinct event identities", () => {
	const state = createState();
	const idle = createThread({ status: "idle" });
	observeThreadTransition(state, idle, now);
	const first = consumeNextWake(state, now);
	assert.ok(first);

	observeThreadTransition(state, { ...idle, lastActivityAt: "2026-01-01T00:01:00.000Z" }, now);
	const second = consumeNextWake(state, now);
	assert.ok(second);
	assert.notEqual(first.id, second.id);

	const failed = { ...idle, status: "failed" as const, lastError: "first failure" };
	observeThreadTransition(state, failed, now);
	assert.equal(Object.keys(state.pendingWakes).length, 1);
	observeThreadTransition(state, { ...failed, lastError: "updated failure" }, now);
	assert.equal(Object.keys(state.pendingWakes).length, 1);
});

test("claimed wakes recover after restart and consumption is durable", () => {
	const state = createState();
	observeThreadTransition(state, createThread({ status: "idle" }), now);
	const claimed = claimNextWake(state);
	assert.ok(claimed);
	assert.equal(Object.keys(state.pendingWakes).length, 0);
	assert.equal(Object.keys(state.inFlightWakes).length, 1);

	recoverInFlightWakes(state);
	assert.equal(Object.keys(state.pendingWakes).length, 1);
	assert.equal(Object.keys(state.inFlightWakes).length, 0);
	const claimedAgain = claimNextWake(state);
	assert.equal(claimedAgain?.id, claimed.id);
	assert.equal(acknowledgeWake(state, claimed.id, "2026-01-01T00:02:00.000Z")?.id, claimed.id);
	recoverInFlightWakes(state);
	assert.equal(Object.keys(state.pendingWakes).length, 0);
	assert.equal(state.consumedEventIds[claimed.id], "2026-01-01T00:02:00.000Z");
});

test("rejected wake is requeued and turn-end guard only runs when needed", () => {
	const state = createState();
	observeThreadTransition(state, createThread({ status: "idle" }), now);
	const event = claimNextWake(state);
	assert.ok(event);
	rejectWake(state, event.id);
	assert.equal(Object.keys(state.pendingWakes).length, 1);

	assert.equal(shouldRunTurnEndGuard({ armed: true, activeThreadCount: 0, pendingWakeCount: 0, inFlightWakeCount: 0 }), false);
	assert.equal(shouldRunTurnEndGuard({ armed: false, activeThreadCount: 1, pendingWakeCount: 0, inFlightWakeCount: 0 }), true);
	assert.equal(shouldRunTurnEndGuard({ armed: true, activeThreadCount: 0, pendingWakeCount: 1, inFlightWakeCount: 0 }), true);
});

test("watcher notifies once and acknowledges only after delivery", async () => {
	const state = createState();
	observeThreadTransition(state, createThread({ status: "idle" }), now);
	const client = new FakeSupervisionClient(state);
	const messages: string[] = [];
	const watcher = new SupervisionWatcher({
		spawnBroker: async () => undefined,
		createClient: () => client,
		sendUserMessage: async (message) => { messages.push(message); },
	});

	await watcher.runOnce();
	await watcher.runOnce();
	assert.equal(messages.length, 1);
	assert.equal(Object.keys(state.pendingWakes).length, 0);
	assert.equal(Object.keys(state.inFlightWakes).length, 0);
	assert.equal(Object.keys(state.consumedEventIds).length, 1);
	assert.ok(client.calls.includes("ack"));
});

test("watcher requeues a wake when parent delivery fails", async () => {
	const state = createState();
	observeThreadTransition(state, createThread({ status: "failed", lastError: "boom" }), now);
	const client = new FakeSupervisionClient(state);
	let attempts = 0;
	const watcher = new SupervisionWatcher({
		spawnBroker: async () => undefined,
		createClient: () => client,
		sendUserMessage: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("parent unavailable");
		},
	});

	await watcher.runOnce();
	assert.equal(Object.keys(state.pendingWakes).length, 1);
	assert.equal(Object.keys(state.consumedEventIds).length, 0);
	await watcher.runOnce();
	assert.equal(attempts, 2);
	assert.equal(Object.keys(state.pendingWakes).length, 0);
	assert.equal(Object.keys(state.consumedEventIds).length, 1);
});

class FakeSupervisionClient {
	calls: string[] = [];

	constructor(private readonly state: ThreadSupervisionState) {}

	async connect(): Promise<void> {}

	async request<T>(command: "supervision", params: Record<string, unknown> = {}): Promise<T> {
		const operation = String(params.operation ?? "poll");
		this.calls.push(operation);
		if (operation === "poll") recoverInFlightWakes(this.state);
		if (operation === "arm" || operation === "disarm") this.state.armed = operation === "arm";
		if (operation === "claim") return { event: claimNextWake(this.state), snapshot: this.snapshot() } as T;
		if (operation === "ack") {
			acknowledgeWake(this.state, String(params.eventId), "2026-01-01T00:03:00.000Z");
			return { snapshot: this.snapshot() } as T;
		}
		if (operation === "nack") {
			rejectWake(this.state, String(params.eventId));
			return this.snapshot() as T;
		}
		return this.snapshot() as T;
	}

	disconnect(): void {}

	private snapshot(): SupervisionSnapshot {
		return {
			armed: this.state.armed,
			activeThreadCount: 1,
			pendingWakeCount: Object.keys(this.state.pendingWakes).length,
			inFlightWakeCount: Object.keys(this.state.inFlightWakes).length,
			nextWake: Object.values(this.state.pendingWakes)[0],
		};
	}
}

function createState(): ThreadSupervisionState {
	return { armed: false, lastSeen: {}, pendingWakes: {}, inFlightWakes: {}, consumedEventIds: {} };
}

function createThread(overrides: Partial<ManagedThread> = {}): ManagedThread {
	return {
		id: "thread-1",
		status: "running",
		cwd: "/repo",
		tags: [],
		createdAt: now,
		updatedAt: now,
		createdBy: "test",
		launchProfile: { cwd: "/repo", extensionLoading: "inherit", approvalMode: "ask", inheritedFromParent: true },
		safetyPolicy: {
			worktreeMode: "shared_cwd_allowed",
			queuePolicy: "reject_when_running",
			githubWritePolicy: "ask",
			forceKillPolicy: "deny",
			restartPolicy: { mode: "manual", maxRestarts: 0, backoffSeconds: 30, allowWhenOperationUnknown: false },
		},
		...overrides,
	};
}
