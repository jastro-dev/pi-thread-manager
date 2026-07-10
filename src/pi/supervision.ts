import { createHash } from "node:crypto";

import type { ManagedThread, ThreadSupervisionEvent, ThreadSupervisionState, SupervisionSnapshot } from "../types.ts";

const ACTIONABLE_STATUSES = new Set(["idle", "failed", "crashed", "approval_blocked"]);
export const SUPERVISION_LEASE_MS = 30_000;

type PreviousObservation = { status?: string; lastActivityAt?: string };

export function isActionableThreadStatus(status: ManagedThread["status"]): status is ThreadSupervisionEvent["status"] {
	return ACTIONABLE_STATUSES.has(status);
}

export function threadObservationKey(thread: ManagedThread): string {
	return JSON.stringify({
		status: thread.status,
		lastActivityAt: thread.lastActivityAt,
		currentOperationId: thread.currentOperationId,
		lastError: thread.lastError,
	});
}

export function observeThreadTransition(state: ThreadSupervisionState, thread: ManagedThread, now: string, ownerSessionId = thread.ownerSessionId ?? "legacy"): void {
	const observation = threadObservationKey(thread);
	const previousObservation = state.lastSeen[thread.id];
	if (previousObservation === observation) return;

	const previous = parseObservation(previousObservation);
	const enteredActionableState = previousObservation === undefined || previous.status !== thread.status;
	const completedTurn = thread.status === "idle" && previous.status === "idle" && previous.lastActivityAt !== thread.lastActivityAt;
	if (isActionableThreadStatus(thread.status) && (enteredActionableState || completedTurn)) {
		const eventId = createEventId(thread, previousObservation, observation);
		if (!state.pendingWakes[eventId] && !state.inFlightWakes[eventId] && !state.consumedEventIds[eventId]) {
			state.pendingWakes[eventId] = {
				id: eventId,
				threadId: thread.id,
				ownerSessionId,
				status: thread.status,
				createdAt: now,
				lastActivityAt: thread.lastActivityAt,
				error: thread.lastError,
			};
		}
	}

	state.lastSeen[thread.id] = observation;
}

export function claimNextWake(state: ThreadSupervisionState, ownerSessionId = "legacy", now = new Date().toISOString(), leaseMs = SUPERVISION_LEASE_MS, allowedThreadIds?: ReadonlySet<string>): ThreadSupervisionEvent | undefined {
	const event = findNextWake(state.pendingWakes, ownerSessionId, allowedThreadIds);
	if (!event) return undefined;
	delete state.pendingWakes[event.id];
	state.inFlightWakes[event.id] = { ...event, claimedAt: now, leaseExpiresAt: new Date(new Date(now).getTime() + leaseMs).toISOString() };
	return state.inFlightWakes[event.id];
}

export function acknowledgeWake(state: ThreadSupervisionState, eventId: string, now: string, ownerSessionId = "legacy"): ThreadSupervisionEvent | undefined {
	const event = state.inFlightWakes[eventId];
	if (!event || event.ownerSessionId !== ownerSessionId) return undefined;
	delete state.inFlightWakes[eventId];
	state.consumedEventIds[eventId] = now;
	return event;
}

export function rejectWake(state: ThreadSupervisionState, eventId: string, ownerSessionId = "legacy"): ThreadSupervisionEvent | undefined {
	const event = state.inFlightWakes[eventId];
	if (!event || event.ownerSessionId !== ownerSessionId) return undefined;
	delete state.inFlightWakes[eventId];
	if (!state.consumedEventIds[eventId]) state.pendingWakes[eventId] = { ...event, claimedAt: undefined, leaseExpiresAt: undefined };
	return event;
}

/** Recover all claims during daemon-start reconciliation only. */
export function recoverInFlightWakes(state: ThreadSupervisionState): void {
	for (const [eventId, event] of Object.entries(state.inFlightWakes)) {
		delete state.inFlightWakes[eventId];
		if (!state.consumedEventIds[eventId] && !state.pendingWakes[eventId]) state.pendingWakes[eventId] = { ...event, claimedAt: undefined, leaseExpiresAt: undefined };
	}
}

/** Recover only this owner's claims whose delivery lease expired. */
export function recoverExpiredInFlightWakes(state: ThreadSupervisionState, now: string, ownerSessionId = "legacy", allowedThreadIds?: ReadonlySet<string>): void {
	const nowMs = new Date(now).getTime();
	for (const [eventId, event] of Object.entries(state.inFlightWakes)) {
		if (event.ownerSessionId !== ownerSessionId || (allowedThreadIds && !allowedThreadIds.has(event.threadId)) || !event.leaseExpiresAt || new Date(event.leaseExpiresAt).getTime() > nowMs) continue;
		delete state.inFlightWakes[eventId];
		if (!state.consumedEventIds[eventId] && !state.pendingWakes[eventId]) state.pendingWakes[eventId] = { ...event, claimedAt: undefined, leaseExpiresAt: undefined };
	}
}

/** Consume a wake synchronously for callers that do not have an external delivery step. */
export function consumeNextWake(state: ThreadSupervisionState, now: string, ownerSessionId = "legacy", allowedThreadIds?: ReadonlySet<string>): ThreadSupervisionEvent | undefined {
	const event = claimNextWake(state, ownerSessionId, now, SUPERVISION_LEASE_MS, allowedThreadIds);
	if (!event) return undefined;
	acknowledgeWake(state, event.id, now, ownerSessionId);
	return event;
}

export function supervisionSnapshot(state: ThreadSupervisionState, activeThreadCount: number, ownerSessionId = "legacy", allowedThreadIds?: ReadonlySet<string>): SupervisionSnapshot {
	const wake = findNextWake(state.pendingWakes, ownerSessionId, allowedThreadIds);
	const isAllowed = (event: ThreadSupervisionEvent) => event.ownerSessionId === ownerSessionId && (!allowedThreadIds || allowedThreadIds.has(event.threadId));
	return {
		armed: state.armedOwners[ownerSessionId] === true,
		activeThreadCount,
		pendingWakeCount: Object.values(state.pendingWakes).filter(isAllowed).length,
		inFlightWakeCount: Object.values(state.inFlightWakes).filter(isAllowed).length,
		nextWake: wake,
	};
}

export function shouldArmWatcher(snapshot: Pick<SupervisionSnapshot, "activeThreadCount" | "pendingWakeCount" | "inFlightWakeCount">): boolean {
	return snapshot.activeThreadCount > 0 || snapshot.pendingWakeCount > 0 || snapshot.inFlightWakeCount > 0;
}

export function shouldRunTurnEndGuard(snapshot: Pick<SupervisionSnapshot, "armed" | "activeThreadCount" | "pendingWakeCount" | "inFlightWakeCount">): boolean {
	return (snapshot.activeThreadCount > 0 && !snapshot.armed) || snapshot.pendingWakeCount > 0 || snapshot.inFlightWakeCount > 0;
}

function findNextWake(events: Record<string, ThreadSupervisionEvent>, ownerSessionId: string, allowedThreadIds?: ReadonlySet<string>): ThreadSupervisionEvent | undefined {
	return Object.values(events)
		.filter((event) => event.ownerSessionId === ownerSessionId && (!allowedThreadIds || allowedThreadIds.has(event.threadId)))
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
}

function createEventId(thread: ManagedThread, previousObservation: string | undefined, observation: string): string {
	return `wake-${createHash("sha256").update(`${thread.id}\0${previousObservation ?? ""}\0${observation}`).digest("hex").slice(0, 32)}`;
}

function parseObservation(observation: string | undefined): PreviousObservation {
	if (!observation) return {};
	try {
		const parsed = JSON.parse(observation) as PreviousObservation;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}
