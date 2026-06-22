import { promises as fs } from "node:fs";
import path from "node:path";

import { getLastKnownGoodStorePath, getThreadManagerDir, getThreadStorePath } from "../broker/paths.ts";
import { isPathInside, validateStoreVersion } from "../protocol.ts";
import { MIN_READER_VERSION, STORE_VERSION, type ManagedThread, type ThreadStoreDocument, type ThreadWorktree } from "../types.ts";
import { acquireFileLock, type LockOptions } from "./lock.ts";

const THREAD_STATUSES = new Set(["creating", "starting", "idle", "running", "stopping", "stopped", "failed", "crashed", "kill_failed", "orphan_needs_manual_action"]);
const OPERATION_KINDS = new Set(["create_thread", "send", "follow_up", "steer", "abort", "stop", "cleanup_worktree", "schedule_run", "approval", "child_ui_request", "commit_push_delivery", "review_loop"]);
const OPERATION_STATUSES = new Set(["intent_recorded", "external_action_attempted", "acknowledged", "running", "approval_required", "cancelled", "completed", "failed", "unknown_after_restart", "reconciled", "manual_action_required"]);
const SCHEDULE_TYPES = new Set(["review_loop", "custom"]);
const SCHEDULE_STATUSES = new Set(["scheduled", "running", "paused", "completed", "failed"]);
const APPROVAL_STATUSES = new Set(["pending", "approved", "denied", "expired", "invalidated"]);
const JOB_RUN_STATUSES = new Set(["running", "completed", "failed", "cancelled"]);
const DELIVERY_STATUSES = new Set(["pending", "approval_required", "approved", "pushed", "failed", "cancelled"]);

export interface ThreadStoreOptions extends LockOptions {
	statePath?: string;
	managerDir?: string;
	now?: () => Date;
	allowPausedMutation?: boolean;
}

export interface SafeReadResult {
	document: ThreadStoreDocument;
	corruptPath?: string;
	loadedBackup: boolean;
}

export function createEmptyThreadStore(now: Date = new Date()): ThreadStoreDocument {
	const timestamp = now.toISOString();
	return {
		storeVersion: STORE_VERSION,
		minReaderVersion: MIN_READER_VERSION,
		createdAt: timestamp,
		updatedAt: timestamp,
		migrationHistory: [],
		threads: {},
		operations: {},
		schedules: {},
		approvals: {},
		jobRuns: {},
		commitPushDeliveries: {},
	};
}

export async function readThreadStore(statePath = getThreadStorePath(), managerDir = getThreadManagerDir()): Promise<ThreadStoreDocument> {
	let raw: string;
	try {
		raw = await fs.readFile(statePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return createEmptyThreadStore();
		throw new Error(`Could not read thread manager store at ${statePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parseThreadStore(raw, statePath, managerDir);
}

export async function readThreadStoreSafe(
	statePath = getThreadStorePath(),
	backupPath = getLastKnownGoodStorePath(),
	managerDir = getThreadManagerDir(),
): Promise<SafeReadResult> {
	try {
		return { document: await readThreadStore(statePath, managerDir), loadedBackup: false };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/Unsupported thread manager store version/.test(message)) {
			const document = createEmptyThreadStore();
			document.pausedReason = `Thread manager store is read-only for this extension version: ${message}`;
			return { document, loadedBackup: false };
		}
		const corruptPath = `${statePath}.corrupt.${Date.now()}`;
		try {
			await fs.rename(statePath, corruptPath);
		} catch {}

		try {
			const raw = await fs.readFile(backupPath, "utf8");
			const document = parseThreadStore(raw, backupPath, managerDir);
			document.pausedReason = `Primary store was corrupt and backup was loaded: ${message}`;
			await writeThreadStore(statePath, document);
			return { document, corruptPath, loadedBackup: true };
		} catch {}

		const document = createEmptyThreadStore();
		document.pausedReason = `Thread manager store is corrupt; automation paused until repair: ${message}`;
		await writeThreadStore(statePath, document);
		return { document, corruptPath, loadedBackup: false };
	}
}

export async function mutateThreadStore<T>(
	options: ThreadStoreOptions,
	mutator: (document: ThreadStoreDocument) => T | Promise<T>,
): Promise<T> {
	const statePath = options.statePath ?? getThreadStorePath();
	const managerDir = options.managerDir ?? path.dirname(statePath);
	await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
	const release = await acquireFileLock(`${statePath}.lock`, options);
	try {
		const document = await readThreadStore(statePath, managerDir);
		if (document.pausedReason && !options.allowPausedMutation) {
			throw new Error(`Thread manager store is paused: ${document.pausedReason}`);
		}
		const result = await mutator(document);
		document.updatedAt = (options.now?.() ?? new Date()).toISOString();
		assertThreadStoreInvariants(document, managerDir);
		await writeThreadStore(statePath, document);
		await writeThreadStore(path.join(managerDir, "threads.last-good.json"), document).catch(() => undefined);
		return result;
	} finally {
		await release();
	}
}

export async function writeThreadStore(statePath: string, document: ThreadStoreDocument): Promise<void> {
	await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
	const tempPath = path.join(path.dirname(statePath), `${path.basename(statePath)}.${process.pid}.${Date.now()}.tmp`);
	const handle = await fs.open(tempPath, "w", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(document, null, "\t")}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.rename(tempPath, statePath);
	await fs.open(path.dirname(statePath), "r").then(async (dir) => {
		try { await dir.sync(); } finally { await dir.close(); }
	}).catch(() => undefined);
}

export function parseThreadStore(raw: string, source: string, managerDir = getThreadManagerDir()): ThreadStoreDocument {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid thread manager store JSON at ${source}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid thread manager store at ${source}: expected object`);
	}
	const document = migrateThreadStoreDocument(parsed as Record<string, unknown>);
	validateStoreVersion(document.storeVersion, document.minReaderVersion);
	if (!isRecord(document.threads) || !isRecord(document.operations) || !isRecord(document.schedules) || !isRecord(document.approvals) || !isRecord(document.jobRuns) || !isRecord(document.commitPushDeliveries)) {
		throw new Error(`Invalid thread manager store at ${source}: missing record sections`);
	}
	const result = document as ThreadStoreDocument;
	assertThreadStoreInvariants(result, managerDir);
	return result;
}

export function migrateThreadStoreDocument(document: Record<string, unknown>): Partial<ThreadStoreDocument> {
	if (document.storeVersion !== 1) return document;
	const migrated = document as Partial<ThreadStoreDocument>;
	migrated.storeVersion = STORE_VERSION;
	migrated.minReaderVersion = MIN_READER_VERSION;
	migrated.migrationHistory = [...(Array.isArray(migrated.migrationHistory) ? migrated.migrationHistory : []), "v1_to_v2_thread_worktree_metadata"];
	migrated.jobRuns = isRecord(migrated.jobRuns) ? migrated.jobRuns : {};
	migrated.commitPushDeliveries = isRecord(migrated.commitPushDeliveries) ? migrated.commitPushDeliveries : {};
	if (isRecord(migrated.threads)) {
		for (const thread of Object.values(migrated.threads) as ManagedThread[]) {
			thread.worktree ??= legacyWorktreeForThread(thread);
		}
	}
	return migrated;
}

export function assertThreadStoreInvariants(document: ThreadStoreDocument, managerDir = getThreadManagerDir()): void {
	for (const [id, thread] of Object.entries(document.threads)) {
		if (thread.id !== id) throw new Error(`Thread id mismatch for ${id}`);
		assertAllowed(THREAD_STATUSES, thread.status, `Thread ${id} status`);
		assertThreadWorktreeInvariants(id, thread);
		if (thread.sessionFile && !isPathInside(thread.sessionFile, managerDir)) throw new Error(`Thread ${id} session file is outside manager directory`);
		if (thread.logFile && !isPathInside(thread.logFile, managerDir)) throw new Error(`Thread ${id} log file is outside manager directory`);
		if (thread.currentOperationId && !document.operations[thread.currentOperationId]) throw new Error(`Thread ${id} references missing operation ${thread.currentOperationId}`);
		if (thread.currentOperationId && document.operations[thread.currentOperationId].threadId !== id) throw new Error(`Thread ${id} references operation owned by another thread`);
	}
	for (const [id, operation] of Object.entries(document.operations)) {
		if (operation.id !== id) throw new Error(`Operation id mismatch for ${id}`);
		assertAllowed(OPERATION_KINDS, operation.kind, `Operation ${id} kind`);
		assertAllowed(OPERATION_STATUSES, operation.status, `Operation ${id} status`);
		if (operation.threadId && !document.threads[operation.threadId]) throw new Error(`Operation ${id} references missing thread ${operation.threadId}`);
		if (operation.approvalId && !document.approvals[operation.approvalId]) throw new Error(`Operation ${id} references missing approval ${operation.approvalId}`);
	}
	for (const [id, schedule] of Object.entries(document.schedules)) {
		if (schedule.id !== id) throw new Error(`Schedule id mismatch for ${id}`);
		assertAllowed(SCHEDULE_TYPES, schedule.type, `Schedule ${id} type`);
		assertAllowed(SCHEDULE_STATUSES, schedule.status, `Schedule ${id} status`);
		for (const threadId of schedule.threadIds) {
			if (!document.threads[threadId]) throw new Error(`Schedule ${id} references missing thread ${threadId}`);
		}
	}
	for (const [id, approval] of Object.entries(document.approvals)) {
		if (approval.id !== id) throw new Error(`Approval id mismatch for ${id}`);
		assertAllowed(APPROVAL_STATUSES, approval.status, `Approval ${id} status`);
		if (!document.operations[approval.operationId]) throw new Error(`Approval ${id} references missing operation ${approval.operationId}`);
	}
	for (const [id, run] of Object.entries(document.jobRuns)) {
		if (run.id !== id) throw new Error(`Job run id mismatch for ${id}`);
		assertAllowed(JOB_RUN_STATUSES, run.status, `Job run ${id} status`);
		if (!document.schedules[run.jobId]) throw new Error(`Job run ${id} references missing schedule ${run.jobId}`);
		if (run.dispatchedThreadId && !document.threads[run.dispatchedThreadId]) throw new Error(`Job run ${id} references missing dispatched thread ${run.dispatchedThreadId}`);
	}
	for (const [id, delivery] of Object.entries(document.commitPushDeliveries)) {
		if (delivery.id !== id) throw new Error(`Commit/push delivery id mismatch for ${id}`);
		assertAllowed(DELIVERY_STATUSES, delivery.status, `Commit/push delivery ${id} status`);
		if (!document.operations[delivery.operationId]) throw new Error(`Commit/push delivery ${id} references missing operation ${delivery.operationId}`);
		if (delivery.approvalId) {
			const approval = document.approvals[delivery.approvalId];
			if (!approval) throw new Error(`Commit/push delivery ${id} references missing approval ${delivery.approvalId}`);
			if (approval.operationId !== delivery.operationId) throw new Error(`Commit/push delivery ${id} approval operation mismatch`);
		}
	}
}

function legacyWorktreeForThread(thread: ManagedThread): ThreadWorktree {
	return { mode: "legacy_shared_cwd", sourceCwd: thread.cwd, cleanupState: "not_applicable" };
}

function assertThreadWorktreeInvariants(id: string, thread: ManagedThread): void {
	if (!thread.worktree) throw new Error(`Thread ${id} is missing worktree metadata`);
	if (thread.worktree.mode === "legacy_shared_cwd") {
		if (thread.worktree.sourceCwd !== thread.cwd) throw new Error(`Thread ${id} legacy shared cwd metadata must match thread cwd`);
		if (thread.worktree.cleanupState !== "not_applicable") throw new Error(`Thread ${id} legacy shared cwd cleanup state is invalid`);
		return;
	}
	const worktree = thread.worktree;
	if (worktree.executionCwd !== thread.cwd) throw new Error(`Thread ${id} isolated execution cwd must match thread cwd`);
	for (const [label, value] of Object.entries({
		sourceCwd: worktree.sourceCwd,
		sourceRepoRoot: worktree.sourceRepoRoot,
		primaryRepoRoot: worktree.primaryRepoRoot,
		worktreeRoot: worktree.worktreeRoot,
		executionCwd: worktree.executionCwd,
	})) {
		if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`Thread ${id} isolated ${label} must be absolute`);
	}
	if (!isPathInside(worktree.executionCwd, worktree.worktreeRoot)) throw new Error(`Thread ${id} isolated execution cwd is outside worktree root`);
	if (!isPathInside(worktree.sourceCwd, worktree.sourceRepoRoot)) throw new Error(`Thread ${id} isolated source cwd is outside source repo root`);
	assertAllowed(new Set(["reserved", "allocated", "allocation_failed"]), worktree.allocationState, `Thread ${id} isolated allocation state`);
	assertAllowed(new Set(["retained", "cleanup_pending", "removed", "manual_action_required"]), worktree.cleanupState, `Thread ${id} isolated cleanup state`);
}

function assertAllowed(allowed: Set<string>, value: unknown, label: string): void {
	if (typeof value !== "string" || !allowed.has(value)) throw new Error(`${label} is invalid: ${String(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
