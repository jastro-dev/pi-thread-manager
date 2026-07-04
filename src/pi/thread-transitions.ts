import { PROTOCOL_VERSION, type DaemonStatus, type ManagedThread, type ThreadOperation, type ThreadStoreDocument } from "../types.ts";
import type { WorktreeCleanupResult } from "../worktree/thread-worktrees.ts";
import type { PiRpcUiRequest } from "./rpc-client.ts";

export const GLOBAL_APPROVAL_SCOPE_THREAD_ID = "thread-manager-global-approval-scope";

export class DuplicateOperationError extends Error {
	constructor(readonly operationId: string) {
		super(`duplicate operation ${operationId}`);
	}
}

export function requireThread(document: ThreadStoreDocument, threadId: string): ManagedThread {
	const thread = document.threads[threadId];
	if (!thread) throw new Error(`Thread not found: ${threadId}`);
	return thread;
}

export function authorizationCwd(thread: ManagedThread | undefined): string | undefined {
	return thread?.worktree?.sourceCwd ?? thread?.cwd;
}

export function createOperation(id: string, kind: ThreadOperation["kind"], threadId: string, now: string, message?: string, requestId?: string): ThreadOperation {
	return {
		id,
		kind,
		status: "intent_recorded",
		threadId,
		requestId,
		idempotencyKey: requestId ? `${kind}:${threadId}:${requestId}` : `${kind}:${threadId}:${id}`,
		createdAt: now,
		updatedAt: now,
		message,
	};
}

export function isTerminalOperation(status: ThreadOperation["status"]): boolean {
	return ["cancelled", "completed", "failed", "reconciled", "manual_action_required"].includes(status);
}

export function requireDeliveredOperation(operation: ThreadOperation | undefined): ThreadOperation {
	if (!operation) throw new Error("duplicate operation not found");
	if (operation.status === "acknowledged" || operation.status === "completed" || operation.status === "reconciled") return operation;
	throw new Error(`duplicate operation ${operation.id} is ${operation.status}, not delivered`);
}

export function cancelNonTerminalThreadOperations(document: ThreadStoreDocument, threadId: string, exceptOperationId: string, error: string, updatedAt: string): void {
	for (const operation of Object.values(document.operations)) {
		if (operation.id === exceptOperationId || operation.threadId !== threadId || isTerminalOperation(operation.status)) continue;
		operation.status = "cancelled";
		operation.error = error;
		operation.updatedAt = updatedAt;
	}
}

export function cloneManagedThread(thread: ManagedThread): ManagedThread {
	return {
		...thread,
		tags: [...thread.tags],
		launchProfile: { ...thread.launchProfile },
		safetyPolicy: { ...thread.safetyPolicy, restartPolicy: { ...thread.safetyPolicy.restartPolicy } },
		worktree: thread.worktree ? { ...thread.worktree } : undefined,
	};
}

export function getRestartDecision(thread: ManagedThread, now: Date): { allowed: true } | { allowed: false; reason: string; retryAfter?: string } {
	const policy = thread.safetyPolicy.restartPolicy;
	if (policy.mode !== "from_session") return { allowed: false, reason: "Daemon restarted without a reconnectable child RPC control channel" };
	if (thread.currentOperationId) return { allowed: false, reason: "Daemon restarted while operation outcome is unknown" };
	if ((thread.restartCount ?? 0) >= policy.maxRestarts) return { allowed: false, reason: "Restart policy maxRestarts exhausted" };
	if (thread.restartBackoffUntil && new Date(thread.restartBackoffUntil).getTime() > now.getTime()) {
		return { allowed: false, reason: `Restart policy backoff active until ${thread.restartBackoffUntil}`, retryAfter: thread.restartBackoffUntil };
	}
	return { allowed: true };
}

export async function waitForChildExit(child: { once(event: "exit", listener: () => void): unknown; exitCode: number | null }, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null) return true;
	return await new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

export function describeChildUiRequest(request: PiRpcUiRequest): string {
	const label = request.method ?? request.kind ?? request.requestType ?? request.name ?? request.id;
	return typeof label === "string" ? label : request.id;
}

export function isPassiveChildUiRequest(request: PiRpcUiRequest): boolean {
	return ["notify", "setStatus", "setTitle", "setWidget"].includes(describeChildUiRequest(request));
}

export function markThreadOrphanAfterRestart(document: ThreadStoreDocument, thread: ManagedThread, now: string, reason = "Daemon restarted without a reconnectable child RPC control channel"): void {
	thread.status = "orphan_needs_manual_action";
	if (thread.currentOperationId && document.operations[thread.currentOperationId]) {
		document.operations[thread.currentOperationId].status = "unknown_after_restart";
		document.operations[thread.currentOperationId].recoveryAction = "manual";
		document.operations[thread.currentOperationId].error = reason;
		document.operations[thread.currentOperationId].updatedAt = now;
	}
	thread.currentOperationId = undefined;
	thread.lastError = reason;
	thread.updatedAt = now;
}

export function markCreatingThreadFailedAfterRestart(document: ThreadStoreDocument, thread: ManagedThread, now: string, reason = "Daemon restarted before thread launch completed"): void {
	thread.status = "failed";
	thread.lastError = reason;
	thread.updatedAt = now;
	if (thread.currentOperationId && document.operations[thread.currentOperationId]) {
		document.operations[thread.currentOperationId].status = "failed";
		document.operations[thread.currentOperationId].error = reason;
		document.operations[thread.currentOperationId].updatedAt = now;
	}
	thread.currentOperationId = undefined;
}

export function applyThreadStatus(document: ThreadStoreDocument, threadId: string, status: ManagedThread["status"], now: () => Date, operationId?: string): void {
	const thread = requireThread(document, threadId);
	thread.status = status;
	thread.updatedAt = now().toISOString();
	if (operationId) thread.currentOperationId = operationId;
}

export function applyCreateFailed(document: ThreadStoreDocument, threadId: string, operationId: string, error: unknown, now: () => Date, cleanup?: WorktreeCleanupResult): void {
	const thread = document.threads[threadId];
	if (!thread) return;
	const message = error instanceof Error ? error.message : String(error);
	thread.status = "failed";
	thread.lastError = message;
	thread.updatedAt = now().toISOString();
	thread.currentOperationId = undefined;
	if (thread.worktree?.mode === "isolated" && cleanup) {
		thread.worktree.cleanupState = cleanup.state;
		thread.worktree.lastError = cleanup.message;
		thread.worktree.cleanedAt = cleanup.cleanedAt;
		if (thread.worktree.allocationState === "reserved") thread.worktree.allocationState = cleanup.state === "removed" ? "allocation_failed" : "allocated";
	}
	const operation = document.operations[operationId];
	if (operation) {
		operation.status = "failed";
		operation.error = message;
		operation.message = cleanup?.message;
		operation.updatedAt = now().toISOString();
	}
}

export function applyThreadStopped(document: ThreadStoreDocument, threadId: string, operationId: string, now: () => Date): void {
	const thread = requireThread(document, threadId);
	thread.status = "stopped";
	thread.pid = undefined;
	thread.pidStartedAt = undefined;
	thread.currentOperationId = undefined;
	thread.updatedAt = now().toISOString();
	const operation = document.operations[operationId];
	if (operation) {
		operation.status = "completed";
		if (thread.worktree?.mode === "isolated" && thread.worktree.cleanupState === "retained") {
			operation.message = `worktree retained at ${thread.worktree.worktreeRoot}; run /threads cleanup ${thread.id} when safe`;
		}
		operation.updatedAt = now().toISOString();
	}
}

export function applyStopKillFailed(document: ThreadStoreDocument, threadId: string, operationId: string, now: () => Date): void {
	const thread = requireThread(document, threadId);
	const operation = document.operations[operationId];
	if (operation) {
		operation.status = "failed";
		operation.error = "Child process did not exit after SIGTERM";
		operation.updatedAt = now().toISOString();
	}
	thread.status = "kill_failed";
	thread.lastError = "Child process did not exit after SIGTERM";
	thread.currentOperationId = undefined;
	thread.updatedAt = now().toISOString();
}

export function applyUnknownAfterMissingHandle(document: ThreadStoreDocument, threadId: string, operationId: string): void {
	document.operations[operationId].status = "manual_action_required";
	document.operations[operationId].recoveryAction = "manual";
	document.operations[operationId].error = "No live RPC handle for thread";
	document.threads[threadId].status = "orphan_needs_manual_action";
	document.threads[threadId].lastError = "No live RPC handle for thread";
}

export function applyThreadCrashedAfterReadFailure(document: ThreadStoreDocument, threadId: string, error: unknown, now: () => Date): void {
	const thread = document.threads[threadId];
	if (!thread || thread.status === "stopped" || thread.status === "failed" || thread.status === "kill_failed" || thread.status === "orphan_needs_manual_action") return;
	thread.status = "crashed";
	thread.lastError = error instanceof Error ? error.message : String(error);
	thread.updatedAt = now().toISOString();
	if (thread.currentOperationId && document.operations[thread.currentOperationId] && !isTerminalOperation(document.operations[thread.currentOperationId].status)) {
		document.operations[thread.currentOperationId].status = "unknown_after_restart";
		document.operations[thread.currentOperationId].recoveryAction = "manual";
		document.operations[thread.currentOperationId].updatedAt = now().toISOString();
	}
}

export function summarizeStore(document: ThreadStoreDocument, storePath: string, daemonEpoch: string): DaemonStatus {
	const threads = Object.values(document.threads);
	return {
		protocolVersion: PROTOCOL_VERSION,
		daemonPid: process.pid,
		daemonEpoch,
		storePath,
		threadCount: threads.length,
		activeThreadCount: threads.filter((thread) => ["creating", "starting", "idle", "running", "stopping"].includes(thread.status)).length,
		orphanThreadCount: threads.filter((thread) => thread.status === "orphan_needs_manual_action").length,
		isolatedThreadCount: threads.filter((thread) => thread.worktree?.mode === "isolated").length,
		legacySharedCwdThreadCount: threads.filter((thread) => thread.worktree?.mode === "legacy_shared_cwd").length,
		cleanupPendingWorktreeCount: threads.filter((thread) => thread.worktree?.mode === "isolated" && thread.worktree.cleanupState === "cleanup_pending").length,
		worktreeManualActionCount: threads.filter((thread) => thread.worktree?.mode === "isolated" && thread.worktree.cleanupState === "manual_action_required").length,
		pendingOperationCount: Object.values(document.operations).filter((operation) => ["intent_recorded", "external_action_attempted", "acknowledged", "running", "approval_required", "unknown_after_restart", "manual_action_required"].includes(operation.status)).length,
		pendingApprovalCount: Object.values(document.approvals).filter((approval) => approval.status === "pending").length,
		activeScheduleCount: Object.values(document.schedules).filter((schedule) => schedule.status === "scheduled" || schedule.status === "running").length,
		pausedReason: document.pausedReason,
	};
}
