import type { ThreadAction, ThreadSupervisionEvent, SupervisionSnapshot } from "../types.ts";
import { shouldArmWatcher, shouldRunTurnEndGuard } from "./supervision.ts";

export interface SupervisionClientPort {
	connect(): Promise<unknown>;
	request<T = unknown>(command: ThreadAction, params?: Record<string, unknown>): Promise<T>;
	disconnect?(): void;
}

export interface SupervisionWatcherDeps {
	spawnBroker: () => Promise<void>;
	createClient: () => SupervisionClientPort;
	sendUserMessage: (content: string, options?: { deliverAs?: "followUp" }) => void | Promise<void>;
	intervalMs?: number;
	onError?: (error: unknown) => void;
}

export class SupervisionWatcher {
	private readonly intervalMs: number;
	private readonly onError: (error: unknown) => void;
	private timer?: ReturnType<typeof setInterval>;
	private running?: Promise<void>;
	private started = false;

	constructor(private readonly deps: SupervisionWatcherDeps) {
		this.intervalMs = deps.intervalMs ?? 2000;
		this.onError = deps.onError ?? (() => undefined);
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		await this.runOnce();
		if (!this.started) return;
		this.timer = setInterval(() => {
			void this.runOnce();
		}, this.intervalMs);
		this.timer.unref?.();
	}

	async stop(): Promise<void> {
		const wasStarted = this.started || Boolean(this.timer);
		this.started = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		if (this.running) await this.running;
		if (!wasStarted) return;
		try {
			await this.deps.spawnBroker();
			const client = this.deps.createClient();
			try {
				await client.connect();
				await client.request<SupervisionSnapshot>("supervision", { operation: "disarm" });
			} finally {
				client.disconnect?.();
			}
		} catch (error) {
			this.onError(error);
		}
	}

	async runOnce(guardOnly = false): Promise<void> {
		if (this.running) return this.running;
		const current = this.cycle(guardOnly).catch((error) => {
			this.onError(error);
		});
		this.running = current;
		try {
			await current;
		} finally {
			if (this.running === current) this.running = undefined;
		}
	}

	async runTurnEndGuard(): Promise<void> {
		return this.runOnce(true);
	}

	private async cycle(guardOnly: boolean): Promise<void> {
		await this.deps.spawnBroker();
		const client = this.deps.createClient();
		try {
			await client.connect();
			let snapshot = await client.request<SupervisionSnapshot>("supervision", { operation: "poll" });
			if (guardOnly && !shouldRunTurnEndGuard(snapshot)) return;

			if (snapshot.pendingWakeCount > 0) {
				snapshot = await this.drainPendingWakes(client, snapshot);
			}
			if (shouldArmWatcher(snapshot)) {
				if (!snapshot.armed) snapshot = await client.request<SupervisionSnapshot>("supervision", { operation: "arm" });
			} else if (snapshot.armed) {
				await client.request<SupervisionSnapshot>("supervision", { operation: "disarm" });
			}
		} finally {
			client.disconnect?.();
		}
	}

	private async drainPendingWakes(client: SupervisionClientPort, initialSnapshot: SupervisionSnapshot): Promise<SupervisionSnapshot> {
		let snapshot = initialSnapshot;
		while (snapshot.pendingWakeCount > 0) {
			const result = await client.request<{ event?: ThreadSupervisionEvent; snapshot: SupervisionSnapshot }>("supervision", { operation: "claim" });
			if (!result.event) return result.snapshot;
			try {
				await this.deps.sendUserMessage(formatWakeMessage(result.event), { deliverAs: "followUp" });
				const acknowledged = await client.request<{ snapshot: SupervisionSnapshot }>("supervision", { operation: "ack", eventId: result.event.id });
				snapshot = acknowledged.snapshot;
			} catch (error) {
				await client.request("supervision", { operation: "nack", eventId: result.event.id }).catch(() => undefined);
				throw error;
			}
		}
		return snapshot;
	}
}

export function formatWakeMessage(event: ThreadSupervisionEvent): string {
	const error = event.error ? ` Error: ${event.error}` : "";
	return `Thread-manager supervision wake ${event.id}: managed thread ${event.threadId} is ${event.status}.${error} Inspect the thread with the thread tool and continue or report the concrete result.`;
}
