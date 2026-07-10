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
	/** @deprecated Queue acceptance is acknowledged by sendUserMessage returning. */
	waitForDelivery?: (content: string) => Promise<void>;
	intervalMs?: number;
	onError?: (error: unknown) => void;
	ownerSessionId?: string;
}

export class SupervisionWatcher {
	private readonly intervalMs: number;
	private readonly onError: (error: unknown) => void;
	private timer?: ReturnType<typeof setInterval>;
	private running?: Promise<boolean>;
	private started = false;
	private ownerSessionId: string;

	constructor(private readonly deps: SupervisionWatcherDeps) {
		this.intervalMs = deps.intervalMs ?? 2000;
		this.onError = deps.onError ?? (() => undefined);
		this.ownerSessionId = deps.ownerSessionId ?? "legacy";
	}

	setOwnerSessionId(ownerSessionId: string): void {
		if (!ownerSessionId) throw new Error("supervision watcher requires a parent session id");
		this.ownerSessionId = ownerSessionId;
	}

	async start(): Promise<void> {
		if (this.started && this.timer) return;
		this.started = true;
		const needed = await this.runOnce();
		if (!this.started || !needed) return;
		this.ensureTimer();
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
				await client.request<SupervisionSnapshot>("supervision", this.ownerParams({ operation: "disarm" }));
			} finally {
				client.disconnect?.();
			}
		} catch (error) {
			this.onError(error);
		}
	}

	async runOnce(guardOnly = false): Promise<boolean> {
		if (this.running) return await this.running;
		const current = this.cycle(guardOnly).catch((error) => {
			this.onError(error);
			return true;
		});
		this.running = current;
		try {
			return await current;
		} finally {
			if (this.running === current) this.running = undefined;
		}
	}

	async runTurnEndGuard(): Promise<void> {
		if (await this.runOnce(true)) this.ensureTimer();
	}

	private async cycle(guardOnly: boolean): Promise<boolean> {
		await this.deps.spawnBroker();
		const client = this.deps.createClient();
		try {
			await client.connect();
			let snapshot = await client.request<SupervisionSnapshot>("supervision", this.ownerParams({ operation: "poll" }));
			if (guardOnly) {
				if (!shouldRunTurnEndGuard(snapshot)) return false;
				if (shouldArmWatcher(snapshot)) {
					if (!snapshot.armed) snapshot = await client.request<SupervisionSnapshot>("supervision", this.ownerParams({ operation: "arm" }));
					return shouldArmWatcher(snapshot);
				}
				return true;
			}

			if (snapshot.pendingWakeCount > 0) {
				snapshot = await this.drainPendingWakes(client, snapshot);
			}
			if (shouldArmWatcher(snapshot)) {
				if (!snapshot.armed) snapshot = await client.request<SupervisionSnapshot>("supervision", this.ownerParams({ operation: "arm" }));
				return shouldArmWatcher(snapshot);
			}
			if (snapshot.armed) await client.request<SupervisionSnapshot>("supervision", this.ownerParams({ operation: "disarm" }));
			return false;
		} finally {
			client.disconnect?.();
		}
	}

	private ensureTimer(): void {
		if (!this.started || this.timer) return;
		this.timer = setInterval(() => {
			void this.runOnce().then((stillNeeded) => {
				if (!stillNeeded && this.timer) {
					clearInterval(this.timer);
					this.timer = undefined;
				}
			});
		}, this.intervalMs);
		this.timer.unref?.();
	}

	private async drainPendingWakes(client: SupervisionClientPort, initialSnapshot: SupervisionSnapshot): Promise<SupervisionSnapshot> {
		let snapshot = initialSnapshot;
		while (snapshot.pendingWakeCount > 0) {
			const result = await client.request<{ event?: ThreadSupervisionEvent; snapshot: SupervisionSnapshot }>("supervision", this.ownerParams({ operation: "claim" }));
			if (!result.event) return result.snapshot;
			try {
				const message = formatWakeMessage(result.event);
				await this.deps.sendUserMessage(message, { deliverAs: "followUp" });
				const acknowledged = await client.request<{ snapshot: SupervisionSnapshot }>("supervision", this.ownerParams({ operation: "ack", eventId: result.event.id }));
				snapshot = acknowledged.snapshot;
			} catch (error) {
				await client.request("supervision", this.ownerParams({ operation: "nack", eventId: result.event.id })).catch(() => undefined);
				throw error;
			}
		}
		return snapshot;
	}

	private ownerParams(params: Record<string, unknown>): Record<string, unknown> {
		return { ...params, ownerSessionId: this.ownerSessionId };
	}
}

export function formatWakeMessage(event: ThreadSupervisionEvent): string {
	const error = event.error ? ` Error: ${event.error}` : "";
	return `Thread-manager supervision wake ${event.id}: managed thread ${event.threadId} is ${event.status}.${error} Inspect the thread with the thread tool and continue or report the concrete result.`;
}
