import assert from "node:assert/strict";
import test from "node:test";

import { SupervisionWatcher } from "../src/pi/supervision-watcher.ts";
import {
	acknowledgeWake,
	claimNextWake,
	consumeNextWake,
	observeThreadTransition,
	recoverExpiredInFlightWakes,
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

test("ownership isolates concurrent parent sessions and leases recover only when stale", () => {
	const state = createState();
	observeThreadTransition(state, createThread({ id: "thread-a", ownerSessionId: "parent-a", status: "idle" }), now, "parent-a");
	observeThreadTransition(state, createThread({ id: "thread-b", ownerSessionId: "parent-b", status: "idle" }), now, "parent-b");
	const claimedA = claimNextWake(state, "parent-a", now);
	assert.equal(claimedA?.ownerSessionId, "parent-a");
	assert.equal(claimNextWake(state, "parent-b", now)?.ownerSessionId, "parent-b");
	assert.equal(acknowledgeWake(state, claimedA!.id, now, "parent-b"), undefined);
	assert.equal(Object.keys(state.inFlightWakes).length, 2);
	assert.equal(acknowledgeWake(state, claimedA!.id, now, "parent-a")?.ownerSessionId, "parent-a");
	const claimedB = Object.values(state.inFlightWakes).find((event) => event.ownerSessionId === "parent-b");
	assert.ok(claimedB);
	assert.equal(acknowledgeWake(state, claimedB.id, now, "parent-b")?.ownerSessionId, "parent-b");

	observeThreadTransition(state, createThread({ id: "thread-a", ownerSessionId: "parent-a", status: "failed" }), "2026-01-01T00:00:01.000Z", "parent-a");
	const staleClaim = claimNextWake(state, "parent-a", "2026-01-01T00:00:01.000Z", 1000);
	assert.ok(staleClaim);
	recoverExpiredInFlightWakes(state, "2026-01-01T00:00:01.500Z", "parent-a");
	assert.equal(Object.keys(state.inFlightWakes).length, 1);
	recoverExpiredInFlightWakes(state, "2026-01-01T00:00:02.100Z", "parent-a");
	assert.equal(Object.keys(state.inFlightWakes).length, 0);
	assert.equal(Object.keys(state.pendingWakes).length, 1);
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

test("watcher notifies once and acknowledges after queue acceptance", async () => {
	const state = createState();
	observeThreadTransition(state, createThread({ status: "idle" }), now);
	const client = new FakeSupervisionClient(state);
	const messages: string[] = [];
	const watcher = new SupervisionWatcher({
		spawnBroker: async () => undefined,
		createClient: () => client,
		sendUserMessage: (message) => { messages.push(message); },
		waitForDelivery: async () => undefined,
	});

	await watcher.runOnce();
	await watcher.runOnce();
	assert.equal(messages.length, 1);
	assert.equal(Object.keys(state.pendingWakes).length, 0);
	assert.equal(Object.keys(state.inFlightWakes).length, 0);
	assert.equal(Object.keys(state.consumedEventIds).length, 1);
	assert.ok(client.calls.includes("ack"));
});

test("turn-end guard arms without waiting for wake delivery", async () => {
	const state = createState();
	observeThreadTransition(state, createThread({ status: "idle" }), now);
	const client = new FakeSupervisionClient(state);
	const watcher = new SupervisionWatcher({
		spawnBroker: async () => undefined,
		createClient: () => client,
		sendUserMessage: () => undefined,
		waitForDelivery: async () => { throw new Error("turn-end guard must not wait for delivery"); },
		intervalMs: 1000,
	});

	await Promise.race([
		watcher.runTurnEndGuard(),
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("turn-end guard waited for wake delivery")), 100)),
	]);
	assert.equal(client.calls.includes("claim"), false);
	assert.equal(state.armedOwners.legacy, true);
	await watcher.stop();
});

test("watcher requeues a wake when queueing the parent message fails", async () => {
	const state = createState();
	observeThreadTransition(state, createThread({ status: "failed", lastError: "boom" }), now);
	const client = new FakeSupervisionClient(state);
	let attempts = 0;
	const watcher = new SupervisionWatcher({
		spawnBroker: async () => undefined,
		createClient: () => client,
		sendUserMessage: () => {
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

test("watcher acknowledges an accepted streaming follow-up without waiting for message_start", async () => {
	const state = createState();
	observeThreadTransition(state, createThread({ status: "idle" }), now);
	const client = new FakeSupervisionClient(state);
	const watcher = new SupervisionWatcher({
		spawnBroker: async () => undefined,
		createClient: () => client,
		sendUserMessage: () => undefined,
		waitForDelivery: async () => { throw new Error("message_start is not queue acknowledgement"); },
	});

	await watcher.runOnce();
	assert.equal(Object.keys(state.pendingWakes).length, 0);
	assert.equal(Object.keys(state.inFlightWakes).length, 0);
	assert.equal(Object.keys(state.consumedEventIds).length, 1);
	assert.equal(client.calls.includes("nack"), false);
});

test("streaming wake and concurrent turn_end deliver exactly once", async () => {
	const state = createState();
	observeThreadTransition(state, createThread({ status: "idle" }), now);
	const client = new FakeSupervisionClient(state);
	let deliveries = 0;
	let turnEnd: Promise<void> | undefined;
	let watcher!: SupervisionWatcher;
	watcher = new SupervisionWatcher({
		spawnBroker: async () => undefined,
		createClient: () => client,
		sendUserMessage: () => {
			deliveries += 1;
			turnEnd = watcher.runTurnEndGuard();
		},
	});

	await watcher.runOnce();
	await turnEnd;
	assert.equal(deliveries, 1);
	assert.equal(Object.keys(state.consumedEventIds).length, 1);
	assert.equal(client.calls.filter((call) => call === "nack").length, 0);
});

class FakeSupervisionClient {
	calls: string[] = [];

	constructor(private readonly state: ThreadSupervisionState) {}

	async connect(): Promise<void> {}

	async request<T>(command: "supervision", params: Record<string, unknown> = {}): Promise<T> {
		const operation = String(params.operation ?? "poll");
		this.calls.push(operation);
		if (operation === "arm" || operation === "disarm") {
			this.state.armedOwners.legacy = operation === "arm";
			this.state.armed = operation === "arm";
		}
		if (operation === "claim") return { event: claimNextWake(this.state, "legacy"), snapshot: this.snapshot() } as T;
		if (operation === "ack") {
			acknowledgeWake(this.state, String(params.eventId), "2026-01-01T00:03:00.000Z", "legacy");
			return { snapshot: this.snapshot() } as T;
		}
		if (operation === "nack") {
			rejectWake(this.state, String(params.eventId), "legacy");
			return this.snapshot() as T;
		}
		return this.snapshot() as T;
	}

	disconnect(): void {}

	private snapshot(): SupervisionSnapshot {
		return {
			armed: this.state.armedOwners.legacy === true,
			activeThreadCount: 1,
			pendingWakeCount: Object.keys(this.state.pendingWakes).length,
			inFlightWakeCount: Object.keys(this.state.inFlightWakes).length,
			nextWake: Object.values(this.state.pendingWakes)[0],
		};
	}
}

function createState(): ThreadSupervisionState {
	return { armed: false, armedOwners: {}, lastSeen: {}, pendingWakes: {}, inFlightWakes: {}, consumedEventIds: {} };
}

test("idle watcher does not keep a polling timer", async () => {
	let polls = 0;
	const watcher = new SupervisionWatcher({
		spawnBroker: async () => undefined,
		createClient: () => ({
			connect: async () => undefined,
			request: async <T>() => {
				polls += 1;
				return { armed: false, activeThreadCount: 0, pendingWakeCount: 0, inFlightWakeCount: 0 } as T;
			},
			disconnect: () => undefined,
		}),
		sendUserMessage: () => undefined,
		waitForDelivery: async () => undefined,
		intervalMs: 5,
	});
	await watcher.start();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(polls, 1);
	await watcher.stop();
});

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
