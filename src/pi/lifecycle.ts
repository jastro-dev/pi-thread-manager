import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import { getThreadManagerDir, getThreadStorePath } from "../broker/paths.ts";
import { authorizeSecret } from "../broker/auth.ts";
import type { BrokerRequestContext, BrokerRequestHandler } from "../broker/broker.ts";
import { DuplicateJobSnapshotError, ThreadScheduler } from "../automation/scheduler.ts";
import { fetchGithubReviewThreads } from "../automation/github-review-threads.ts";
import { buildFixerPrompt, recommendReviewLoopAction, type GithubReviewPort, type ReviewSnapshot, type ReviewThreadCluster } from "../automation/review-loop.ts";
import {
	isCommandAllowed,
	normalizeLaunchProfile,
	normalizeSafetyPolicy,
	validateBaseRef,
	validateLaunchProfile,
	validateName,
	validatePrompt,
	validateReadLimit,
	validateSafetyPolicy,
	validateTags,
	validateThreadId,
} from "../protocol.ts";
import { acquireFileLock } from "../store/lock.ts";
import { mutateThreadStore, readThreadStore, readThreadStoreSafe } from "../store/thread-store.ts";
import { DEFAULT_PROTOCOL_LIMITS, PROTOCOL_VERSION, type CreateThreadInput, type DaemonStatus, type JobLease, type ManagedThread, type ThreadAction, type ThreadOperation, type ThreadReadResult, type ThreadStoreDocument, type ThreadWorktree } from "../types.ts";
import { ThreadWorktreeManager, type WorktreeCleanupResult, type WorktreeInspection } from "../worktree/thread-worktrees.ts";
import { ensureThreadPathsForManager } from "./session-files.ts";
import { launchPiRpcThread, type LaunchedThreadProcess } from "./launcher.ts";
import type { PiRpcCommand, PiRpcUiRequest } from "./rpc-client.ts";

const STARTUP_STATE_TIMEOUT_MS = 30_000;

export interface ThreadServiceDeps {
	statePath?: string;
	managerDir?: string;
	homeDir?: string;
	now?: () => Date;
	randomId?: () => string;
	launchThread?: (thread: ManagedThread) => Promise<LaunchedThreadProcess> | LaunchedThreadProcess;
	worktreeManager?: WorktreeManagerPort;
	githubReviewPort?: GithubReviewPort;
	daemonEpoch?: string;
}

export interface WorktreeManagerPort {
	prepareAllocation(sourceCwd: string, input: { threadId: string; name?: string; baseRef?: string }): Promise<Extract<ThreadWorktree, { mode: "isolated" }>>;
	createAllocation(worktree: Extract<ThreadWorktree, { mode: "isolated" }>): Promise<Extract<ThreadWorktree, { mode: "isolated" }>>;
	rollbackAllocation(worktree: Extract<ThreadWorktree, { mode: "isolated" }>): Promise<WorktreeCleanupResult>;
	cleanupWorktree(worktree: Extract<ThreadWorktree, { mode: "isolated" }>): Promise<WorktreeCleanupResult>;
	inspectWorktree(worktree: Extract<ThreadWorktree, { mode: "isolated" }>): Promise<WorktreeInspection>;
}

export class ThreadService implements BrokerRequestHandler {
	private readonly statePath: string;
	private readonly managerDir: string;
	private readonly homeDir: string | undefined;
	private readonly now: () => Date;
	private readonly randomId: () => string;
	private readonly launchThread: (thread: ManagedThread) => Promise<LaunchedThreadProcess> | LaunchedThreadProcess;
	private readonly worktreeManager: WorktreeManagerPort;
	private readonly githubReviewPort: GithubReviewPort;
	private readonly daemonEpoch: string;
	private readonly handles = new Map<string, LaunchedThreadProcess>();
	private readonly commandLocks = new Map<string, Promise<void>>();
	private readonly scheduler: ThreadScheduler;
	private automationTimer?: ReturnType<typeof setInterval>;

	constructor(deps: ThreadServiceDeps = {}) {
		this.statePath = deps.statePath ?? getThreadStorePath(deps.homeDir);
		this.managerDir = deps.managerDir ?? path.dirname(this.statePath);
		this.homeDir = deps.homeDir;
		this.now = deps.now ?? (() => new Date());
		this.randomId = deps.randomId ?? (() => randomUUID());
		this.launchThread = deps.launchThread ?? ((thread) => launchPiRpcThread(thread, { onUiRequest: (request) => this.recordChildUiRequest(thread.id, request) }));
		this.worktreeManager = deps.worktreeManager ?? new ThreadWorktreeManager({ now: this.now });
		this.githubReviewPort = deps.githubReviewPort ?? { fetchSnapshot: ({ repo, prNumber }) => fetchGithubReviewThreads(repo, prNumber) };
		this.daemonEpoch = deps.daemonEpoch ?? randomUUID();
		this.scheduler = new ThreadScheduler({ statePath: this.statePath, managerDir: this.managerDir, daemonEpoch: this.daemonEpoch, now: this.now, randomId: this.randomId });
	}

	startAutomationLoop(intervalMs = 5000): () => void {
		if (this.automationTimer) return () => this.stopAutomationLoop();
		this.automationTimer = setInterval(() => {
			void this.runDueSchedulesOnce().catch(() => undefined);
		}, intervalMs);
		this.automationTimer.unref?.();
		return () => this.stopAutomationLoop();
	}

	stopAutomationLoop(): void {
		if (!this.automationTimer) return;
		clearInterval(this.automationTimer);
		this.automationTimer = undefined;
	}

	async handle(command: ThreadAction, params: Record<string, unknown>, context: BrokerRequestContext): Promise<unknown> {
		switch (command) {
			case "status":
				return this.status();
			case "list":
				return this.listThreads(context);
			case "create":
				return this.createThread({ ...params, createdBy: String(params.createdBy ?? context.clientId) } as unknown as CreateThreadInput, context.requestId);
			case "read":
				return this.readThread(validateThreadId(params.threadId), Number(params.cursor ?? 0), validateReadLimit(params.limit));
			case "send":
				return this.sendToThread(validateThreadId(params.threadId), "send", validatePrompt(params.message), context.requestId);
			case "follow_up":
				return this.sendToThread(validateThreadId(params.threadId), "follow_up", validatePrompt(params.message), context.requestId);
			case "steer":
				return this.sendToThread(validateThreadId(params.threadId), "steer", validatePrompt(params.message), context.requestId);
			case "abort":
				return this.abortThread(validateThreadId(params.threadId));
			case "stop":
				return this.stopThread(validateThreadId(params.threadId));
			case "cleanup":
				return this.cleanupThread(validateThreadId(params.threadId));
			case "approvals":
				return this.listApprovals(context);
			case "approve":
			case "deny":
				return this.resolveApproval(validateThreadId(params.approvalId), command === "approve", String(params.approver ?? context.clientId), context);
			case "schedule":
				return this.createSchedule(params);
			case "review_loop":
				return this.createReviewLoop(params);
			case "handshake":
				return this.status();
			default: {
				const exhaustive: never = command;
				throw new Error(`Unsupported thread command ${exhaustive}`);
			}
		}
	}

	async status(): Promise<DaemonStatus> {
		const { document } = await readThreadStoreSafe(this.statePath, path.join(this.managerDir, "threads.last-good.json"), this.managerDir);
		if (document.pausedReason) return summarizeStore(document, this.statePath, this.daemonEpoch);
		await this.refreshLiveThreads();
		return summarizeStore(await readThreadStore(this.statePath, this.managerDir), this.statePath, this.daemonEpoch);
	}

	async listThreads(context?: BrokerRequestContext): Promise<ManagedThread[]> {
		await this.refreshLiveThreads();
		const document = await readThreadStore(this.statePath, this.managerDir);
		return Object.values(document.threads)
			.filter((thread) => !context?.token || authorizeSecret(context.token, { action: "list", threadId: thread.id, cwd: authorizationCwd(thread) }, this.homeDir).allowed)
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	}

	async createThread(input: CreateThreadInput, requestId?: string): Promise<ManagedThread> {
		const duplicate = await this.getDeliveredCreatedThread(requestId);
		if (duplicate) return duplicate;
		const sourceCwd = await realpathCwd(input.cwd);
		const id = `thread-${this.randomId()}`;
		const operationId = `op-${this.randomId()}`;
		const now = this.now().toISOString();
		const paths = await ensureThreadPathsForManager(id, this.managerDir);
		const name = validateName(input.name);
		const requestedSafetyPolicy = { ...input.safetyPolicy };
		const requestedWorktreeMode = input.safetyPolicy?.worktreeMode ?? input.worktreeMode;
		if (requestedWorktreeMode) requestedSafetyPolicy.worktreeMode = requestedWorktreeMode;
		const safetyPolicy = validateSafetyPolicy(normalizeSafetyPolicy(requestedSafetyPolicy));
		if (safetyPolicy.worktreeMode === "read_only") throw new Error("read-only thread worktree mode is not implemented yet");
		const baseRef = validateBaseRef(input.baseRef);
		const releaseAllocationLock = safetyPolicy.worktreeMode === "isolated_required"
			? await acquireFileLock(path.join(this.managerDir, "worktrees.alloc.lock"), {})
			: undefined;
		let worktree: ThreadWorktree;
		try {
			worktree = safetyPolicy.worktreeMode === "shared_cwd_allowed"
				? { mode: "legacy_shared_cwd", sourceCwd, cleanupState: "not_applicable" }
				: await this.worktreeManager.prepareAllocation(sourceCwd, { threadId: id, name, baseRef });
		} catch (error) {
			await releaseAllocationLock?.();
			throw error;
		}
		const cwd = worktree.mode === "isolated" ? worktree.executionCwd : sourceCwd;
		let launchProfile;
		let tags;
		try {
			if (input.launchProfile?.cwd !== undefined && input.launchProfile.cwd !== cwd) throw new Error("launch profile cwd must match thread cwd");
			launchProfile = validateLaunchProfile(normalizeLaunchProfile({ model: input.model, name, ...input.launchProfile, cwd }));
			if (launchProfile.extensionLoading !== "inherit") throw new Error("only inherited extension loading is supported in this release");
			if (launchProfile.approvalMode === "read_only") throw new Error("read-only child launch profile is not implemented yet");
			tags = validateTags(input.tags);
		} catch (error) {
			await releaseAllocationLock?.();
			throw error;
		}
		const thread: ManagedThread = {
			id,
			name: launchProfile.name,
			parentThreadId: input.parentThreadId,
			status: "creating",
			cwd,
			model: input.model,
			tags,
			createdAt: now,
			updatedAt: now,
			createdBy: input.createdBy,
			launchNonce: this.randomId(),
			restartCount: 0,
			sessionFile: path.join(paths.sessionDir, "session.jsonl"),
			logFile: paths.logFile,
			launchProfile,
			safetyPolicy,
			worktree,
			currentOperationId: operationId,
		};
		const operation = createOperation(operationId, "create_thread", id, now, undefined, requestId);
		try {
			await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
				if (requestId) {
					const existing = Object.values(document.operations).find((candidate) => candidate.kind === "create_thread" && candidate.requestId === requestId && candidate.status !== "failed");
					if (existing) throw new DuplicateOperationError(existing.id);
				}
				if (Object.keys(document.threads).length >= DEFAULT_PROTOCOL_LIMITS.maxThreads) throw new Error(`Thread manager thread limit reached (${DEFAULT_PROTOCOL_LIMITS.maxThreads})`);
				document.threads[id] = thread;
				document.operations[operationId] = operation;
			});
		} catch (error) {
			await releaseAllocationLock?.();
			if (error instanceof DuplicateOperationError) {
				return await this.requireDeliveredCreatedThread(error.operationId);
			}
			throw error;
		}
		if (worktree.mode === "isolated") {
			try {
				worktree = await this.worktreeManager.createAllocation(worktree);
				thread.worktree = worktree;
				await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
					document.threads[id].worktree = worktree;
					document.threads[id].updatedAt = this.now().toISOString();
				});
			} catch (error) {
				const cleanup = await this.safeRollbackAllocation(worktree);
				await this.markCreateFailed(id, operationId, error, cleanup);
				throw error;
			} finally {
				await releaseAllocationLock?.();
			}
		} else {
			await releaseAllocationLock?.();
		}

		let launchedHandle: LaunchedThreadProcess | undefined;
		try {
			await this.updateThreadStatus(id, "starting", operationId);
			const handle = await this.launchThread(thread);
			launchedHandle = handle;
			await handle.rpc.request({ type: "get_state" }, STARTUP_STATE_TIMEOUT_MS);
			const sessionFile = await discoverSessionFile(paths.sessionDir, thread.sessionFile);
			this.handles.set(id, handle);
			await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
				const current = document.threads[id];
				current.status = "idle";
				current.pid = handle.pid;
				current.pidStartedAt = handle.startedAt;
				current.sessionFile = sessionFile;
				current.updatedAt = this.now().toISOString();
				current.currentOperationId = undefined;
				document.operations[operationId].status = "completed";
				document.operations[operationId].updatedAt = this.now().toISOString();
			});
			if (input.initialPrompt) await this.sendToThread(id, "send", validatePrompt(input.initialPrompt));
			const document = await readThreadStore(this.statePath, this.managerDir);
			return document.threads[id];
		} catch (error) {
			if (launchedHandle) {
				launchedHandle.rpc.destroy(error instanceof Error ? error : new Error(String(error)));
				launchedHandle.child?.kill("SIGTERM");
				this.handles.delete(id);
			}
			const current = thread.worktree?.mode === "isolated" ? await this.safeRollbackAllocation(thread.worktree) : undefined;
			await this.markCreateFailed(id, operationId, error, current);
			throw error;
		}
	}

	private async safeRollbackAllocation(worktree: Extract<ThreadWorktree, { mode: "isolated" }>): Promise<WorktreeCleanupResult | undefined> {
		try {
			return await this.worktreeManager.rollbackAllocation(worktree);
		} catch (error) {
			return { state: "manual_action_required", message: error instanceof Error ? error.message : String(error) };
		}
	}

	private async markCreateFailed(threadId: string, operationId: string, error: unknown, cleanup?: WorktreeCleanupResult): Promise<void> {
		await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
			const thread = document.threads[threadId];
			if (!thread) return;
			const message = error instanceof Error ? error.message : String(error);
			thread.status = "failed";
			thread.lastError = message;
			thread.updatedAt = this.now().toISOString();
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
				operation.updatedAt = this.now().toISOString();
			}
		});
	}

	async readThread(threadId: string, cursor = 0, limit = 50): Promise<ThreadReadResult> {
		if (!Number.isInteger(cursor) || cursor < 0) throw new Error("read cursor must be a non-negative integer");
		const document = await readThreadStore(this.statePath, this.managerDir);
		const thread = document.threads[threadId];
		if (!thread) throw new Error(`Thread not found: ${threadId}`);
		await this.refreshThreadState(threadId);
		const handle = this.handles.get(threadId);
		let items: unknown[] = [];
		let transcriptWindow: TranscriptWindow | undefined;
		if (handle) {
			try {
				const response = await handle.rpc.request<{ messages?: unknown[] }>({ type: "get_messages" }, 1000);
				items = Array.isArray(response.messages) ? response.messages : [];
			} catch (error) {
				this.handles.delete(threadId);
				handle.rpc.destroy(error instanceof Error ? error : new Error(String(error)));
				await this.markThreadCrashedAfterReadFailure(threadId, error);
				transcriptWindow = thread.sessionFile ? await readSessionTranscript(thread.sessionFile, cursor, limit) : undefined;
			}
		} else if (thread.sessionFile) {
			transcriptWindow = await readSessionTranscript(thread.sessionFile, cursor, limit);
		} else {
			items = [{ type: "thread_manager_unavailable", message: `Thread ${threadId} has no live RPC handle or session transcript` }];
		}
		if (transcriptWindow) return { threadId, cursor, nextCursor: cursor + transcriptWindow.items.length, items: transcriptWindow.items, truncated: transcriptWindow.truncated };
		const sliced = items.slice(cursor, cursor + limit);
		return { threadId, cursor, nextCursor: cursor + sliced.length, items: sliced, truncated: cursor + sliced.length < items.length };
	}

	async sendToThread(threadId: string, action: "send" | "follow_up" | "steer", message: string, requestId?: string): Promise<ThreadOperation> {
		const operationId = `op-${this.randomId()}`;
		let rpcCommand: PiRpcCommand;
		switch (action) {
			case "send":
				rpcCommand = { type: "prompt", message };
				break;
			case "follow_up":
				rpcCommand = { type: "follow_up", message };
				break;
			case "steer":
				rpcCommand = { type: "steer", message };
				break;
			default: {
				const exhaustive: never = action;
				throw new Error(`Unsupported send action ${exhaustive}`);
			}
		}
		const now = this.now().toISOString();
		try {
			await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
				const thread = requireThread(document, threadId);
				if (requestId) {
					const existing = Object.values(document.operations).find((operation) => operation.threadId === threadId && operation.requestId === requestId);
					if (existing) throw new DuplicateOperationError(existing.id);
				}
				const legality = isCommandAllowed(thread.status, action, thread.safetyPolicy);
				if (!legality.allowed) throw new Error(legality.reason ?? `${action} not allowed`);
				if (action === "follow_up") {
					const queued = Object.values(document.operations).filter((operation) => operation.threadId === threadId && operation.kind === "follow_up" && !isTerminalOperation(operation.status)).length;
					if (queued >= DEFAULT_PROTOCOL_LIMITS.maxQueueDepth) throw new Error(`follow_up queue limit reached (${DEFAULT_PROTOCOL_LIMITS.maxQueueDepth})`);
				}
				document.operations[operationId] = createOperation(operationId, action, threadId, now, message, requestId);
				thread.status = "running";
				if (action === "send" || !thread.currentOperationId) thread.currentOperationId = operationId;
				thread.lastActivityAt = now;
				thread.updatedAt = now;
			});
		} catch (error) {
			if (error instanceof DuplicateOperationError) return await this.requireDeliveredDuplicate(error.operationId);
			throw error;
		}
		const duplicate = await this.getDuplicateOperation(threadId, requestId, operationId);
		if (duplicate) return requireDeliveredOperation(duplicate);
		return await this.withThreadCommandLock(threadId, async () => {
			await this.assertOperationStillOwnsThread(threadId, operationId, action);
			const handle = this.handles.get(threadId);
			if (!handle) {
				await this.markUnknownAfterMissingHandle(threadId, operationId);
				throw new Error(`Thread ${threadId} has no live RPC handle; manual reconciliation required`);
			}
			try {
				await handle.rpc.request(rpcCommand);
				await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
					document.operations[operationId].status = action === "send" || action === "follow_up" ? "acknowledged" : "completed";
					document.operations[operationId].updatedAt = this.now().toISOString();
				});
				return (await readThreadStore(this.statePath, this.managerDir)).operations[operationId];
			} catch (error) {
				await this.markCommandRejected(threadId, operationId, error, handle);
				throw error;
			}
		});
	}

	private async queueReviewLoopFollowUp(threadId: string, message: string, requestId: string): Promise<ThreadOperation> {
		const operationId = `op-${this.randomId()}`;
		const now = this.now().toISOString();
		try {
			await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
				const thread = requireThread(document, threadId);
				const existing = Object.values(document.operations).find((operation) => operation.threadId === threadId && operation.requestId === requestId);
				if (existing) throw new DuplicateOperationError(existing.id);
				if (thread.status !== "running") throw new Error(`review_loop follow-up requires running thread; current status is ${thread.status}`);
				const queued = Object.values(document.operations).filter((operation) => operation.threadId === threadId && operation.kind === "follow_up" && !isTerminalOperation(operation.status)).length;
				if (queued >= DEFAULT_PROTOCOL_LIMITS.maxQueueDepth) throw new Error(`follow_up queue limit reached (${DEFAULT_PROTOCOL_LIMITS.maxQueueDepth})`);
				document.operations[operationId] = createOperation(operationId, "follow_up", threadId, now, message, requestId);
				thread.lastActivityAt = now;
				thread.updatedAt = now;
			});
		} catch (error) {
			if (error instanceof DuplicateOperationError) return await this.requireDeliveredDuplicate(error.operationId);
			throw error;
		}
		return await this.withThreadCommandLock(threadId, async () => {
			await this.assertOperationStillOwnsThread(threadId, operationId, "follow_up");
			const handle = this.handles.get(threadId);
			if (!handle) {
				await this.markUnknownAfterMissingHandle(threadId, operationId);
				throw new Error(`Thread ${threadId} has no live RPC handle; manual reconciliation required`);
			}
			try {
				await handle.rpc.request({ type: "follow_up", message });
				await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
					document.operations[operationId].status = "acknowledged";
					document.operations[operationId].updatedAt = this.now().toISOString();
				});
				return (await readThreadStore(this.statePath, this.managerDir)).operations[operationId];
			} catch (error) {
				await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
					document.operations[operationId].status = "failed";
					document.operations[operationId].error = error instanceof Error ? error.message : String(error);
					document.operations[operationId].updatedAt = this.now().toISOString();
				});
				throw error;
			}
		});
	}

	async abortThread(threadId: string): Promise<ThreadOperation> {
		return this.signalThread(threadId, "abort", { type: "abort" });
	}

	async stopThread(threadId: string): Promise<ThreadOperation> {
		const operation = await this.signalThread(threadId, "stop", { type: "abort" });
		const handle = this.handles.get(threadId);
		if (handle?.child) {
			handle.child.kill("SIGTERM");
			const exited = await waitForChildExit(handle.child, 2000);
			if (!exited) {
				await this.markStopKillFailed(threadId, operation.id);
				this.handles.delete(threadId);
				throw new Error(`Thread ${threadId} did not exit after SIGTERM`);
			}
		}
		this.handles.delete(threadId);
		await this.markThreadStopped(threadId, operation.id);
		return (await readThreadStore(this.statePath, this.managerDir)).operations[operation.id];
	}

	async cleanupThread(threadId: string): Promise<ThreadOperation> {
		const operationId = `op-${this.randomId()}`;
		const now = this.now().toISOString();
		let worktree: Extract<ThreadWorktree, { mode: "isolated" }>;
		await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
			const thread = requireThread(document, threadId);
			const legality = isCommandAllowed(thread.status, "cleanup", thread.safetyPolicy);
			if (!legality.allowed) throw new Error(legality.reason ?? "cleanup not allowed");
			if (this.handles.has(threadId)) throw new Error(`cleanup requires no live handle for thread ${threadId}`);
			if (!thread.worktree || thread.worktree.mode === "legacy_shared_cwd") throw new Error("cleanup is not available for legacy shared-cwd threads");
			worktree = thread.worktree;
			document.operations[operationId] = createOperation(operationId, "cleanup_worktree", threadId, now);
		});
		let result: WorktreeCleanupResult;
		try {
			result = await this.worktreeManager.cleanupWorktree(worktree!);
		} catch (error) {
			result = { state: "manual_action_required", message: error instanceof Error ? error.message : String(error) };
		}
		await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
			const thread = requireThread(document, threadId);
			const operation = document.operations[operationId];
			if (thread.worktree?.mode === "isolated") {
				thread.worktree.cleanupState = result.state;
				thread.worktree.cleanedAt = result.cleanedAt;
				thread.worktree.lastError = result.state === "removed" ? undefined : result.message;
				thread.worktree.lastCheckedAt = this.now().toISOString();
			}
			operation.status = result.state === "removed" ? "completed" : "manual_action_required";
			operation.message = result.message;
			operation.error = result.state === "removed" ? undefined : result.message;
			operation.recoveryAction = result.state === "removed" ? undefined : "manual";
			operation.updatedAt = this.now().toISOString();
			thread.updatedAt = this.now().toISOString();
		});
		return (await readThreadStore(this.statePath, this.managerDir)).operations[operationId];
	}

	async reconcileAfterRestart(): Promise<void> {
		await this.scheduler.reconcileAfterRestart();
		const inspections = await this.inspectStoredIsolatedWorktrees(["creating", "starting", "idle", "running", "stopping", "crashed"]);
		const resumable: ManagedThread[] = [];
		await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
			for (const thread of Object.values(document.threads)) {
				const inspection = inspections.get(thread.id);
				if (inspection && !inspection.ok) {
					if (thread.worktree?.mode === "isolated") {
						thread.worktree.lastCheckedAt = this.now().toISOString();
						thread.worktree.lastError = inspection.reason;
					}
					if (thread.status === "creating" && thread.worktree?.mode === "isolated" && thread.worktree.allocationState === "reserved") {
						if (inspection.reservedExists) {
							thread.worktree.allocationState = "allocated";
							thread.worktree.cleanupState = "cleanup_pending";
						} else {
							thread.worktree.allocationState = "allocation_failed";
							thread.worktree.cleanupState = "removed";
						}
						markCreatingThreadFailedAfterRestart(document, thread, this.now().toISOString(), inspection.reason);
						continue;
					}
					markThreadOrphanAfterRestart(document, thread, this.now().toISOString(), inspection.reason);
					continue;
				}
				if (thread.status === "creating" && !this.handles.has(thread.id)) {
					if (thread.worktree?.mode === "isolated" && thread.worktree.allocationState === "allocated" && thread.worktree.cleanupState === "retained") {
						thread.worktree.cleanupState = "cleanup_pending";
					}
					markCreatingThreadFailedAfterRestart(document, thread, this.now().toISOString());
					continue;
				}
				if (["starting", "idle", "running", "stopping", "crashed"].includes(thread.status) && !this.handles.has(thread.id)) {
					const restart = getRestartDecision(thread, this.now());
					if (restart.allowed) {
						thread.restartCount = (thread.restartCount ?? 0) + 1;
						thread.restartBackoffUntil = thread.safetyPolicy.restartPolicy.backoffSeconds > 0
							? new Date(this.now().getTime() + thread.safetyPolicy.restartPolicy.backoffSeconds * 1000).toISOString()
							: undefined;
						thread.status = "starting";
						thread.lastError = undefined;
						thread.updatedAt = this.now().toISOString();
						resumable.push(cloneManagedThread(thread));
					} else if (restart.retryAfter) {
						thread.status = "crashed";
						thread.lastError = restart.reason;
						thread.updatedAt = this.now().toISOString();
					} else {
						markThreadOrphanAfterRestart(document, thread, this.now().toISOString(), restart.reason);
					}
				}
			}
		});
		for (const thread of resumable) await this.resumeThreadAfterRestart(thread);
	}

	async runDueSchedulesOnce(): Promise<void> {
		await this.refreshLiveThreads();
		await this.resumeRestartBackoffThreadsOnce();
		const document = await readThreadStore(this.statePath, this.managerDir);
		for (const job of Object.values(document.schedules).sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
			const leased = await this.scheduler.acquireLease(job.id);
			if (!leased) continue;
			const current = await readThreadStore(this.statePath, this.managerDir);
			if (leased.threadIds.some((threadId) => {
				const thread = current.threads[threadId];
				return !thread || thread.status !== "idle" || Boolean(thread.currentOperationId);
			})) {
				await this.scheduler.releaseLease(leased.id, leased.lease);
				continue;
			}
			if (leased.type !== "review_loop") {
				const run = await this.scheduler.recordRun(leased.id);
				await this.scheduler.completeRun(run.id, "cancelled", "custom job runner is not implemented");
				continue;
			}
			await this.runReviewLoopJob(leased.id, leased.target ?? {}, leased.lease);
		}
	}

	private async inspectStoredIsolatedWorktrees(statuses: ManagedThread["status"][]): Promise<Map<string, WorktreeInspection>> {
		const document = await readThreadStore(this.statePath, this.managerDir);
		const wanted = new Set(statuses);
		const inspections = new Map<string, WorktreeInspection>();
		for (const thread of Object.values(document.threads)) {
			if (this.handles.has(thread.id) || !wanted.has(thread.status) || thread.worktree?.mode !== "isolated") continue;
			try {
				inspections.set(thread.id, await this.worktreeManager.inspectWorktree(thread.worktree));
			} catch (error) {
				inspections.set(thread.id, { ok: false, reason: error instanceof Error ? error.message : String(error) });
			}
		}
		return inspections;
	}

	private async resumeRestartBackoffThreadsOnce(): Promise<void> {
		const inspections = await this.inspectStoredIsolatedWorktrees(["crashed"]);
		const resumable: ManagedThread[] = [];
		await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
			for (const thread of Object.values(document.threads)) {
				if (thread.status !== "crashed" || !thread.restartBackoffUntil || this.handles.has(thread.id)) continue;
				const inspection = inspections.get(thread.id);
				if (inspection && !inspection.ok) {
					markThreadOrphanAfterRestart(document, thread, this.now().toISOString(), inspection.reason);
					continue;
				}
				const restart = getRestartDecision(thread, this.now());
				if (restart.allowed) {
					thread.restartCount = (thread.restartCount ?? 0) + 1;
					thread.restartBackoffUntil = thread.safetyPolicy.restartPolicy.backoffSeconds > 0
						? new Date(this.now().getTime() + thread.safetyPolicy.restartPolicy.backoffSeconds * 1000).toISOString()
						: undefined;
					thread.status = "starting";
					thread.lastError = undefined;
					thread.updatedAt = this.now().toISOString();
					resumable.push(cloneManagedThread(thread));
				} else if (!restart.retryAfter && new Date(thread.restartBackoffUntil).getTime() <= this.now().getTime()) {
					markThreadOrphanAfterRestart(document, thread, this.now().toISOString(), restart.reason);
				}
			}
		});
		for (const thread of resumable) await this.resumeThreadAfterRestart(thread);
	}

	async listApprovals(context?: BrokerRequestContext): Promise<{ kind: "approvals"; approvals: unknown[] }> {
		await this.expireApprovals();
		const document = await readThreadStore(this.statePath, this.managerDir);
		const approvals = Object.values(document.approvals).filter((approval) => {
			if (approval.status !== "pending") return false;
			if (!context) return true;
			if (approval.scope.threadIds.length === 0) {
				return authorizeSecret(context.token, { action: "approvals", threadId: GLOBAL_APPROVAL_SCOPE_THREAD_ID }, this.homeDir).allowed;
			}
			return approval.scope.threadIds.every((threadId) => {
				const thread = document.threads[threadId];
				return authorizeSecret(context.token, { action: "approvals", threadId, cwd: authorizationCwd(thread) }, this.homeDir).allowed;
			});
		});
		return { kind: "approvals", approvals };
	}

	private async resolveApproval(approvalId: string, approved: boolean, approver: string, context: BrokerRequestContext): Promise<unknown> {
		let expired = false;
		await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
			const approval = document.approvals[approvalId];
			if (!approval) throw new Error(`Approval not found: ${approvalId}`);
			if (approval.status !== "pending") throw new Error(`Approval ${approvalId} is ${approval.status}`);
			if (new Date(approval.expiresAt).getTime() <= this.now().getTime()) {
				approval.status = "expired";
				approval.resolvedAt = this.now().toISOString();
				expired = true;
				const delivery = Object.values(document.commitPushDeliveries).find((candidate) => candidate.approvalId === approvalId);
				if (delivery) {
					delivery.status = "cancelled";
					delivery.updatedAt = this.now().toISOString();
				}
				const operation = document.operations[approval.operationId];
				if (operation?.approvalId === approval.id) {
					operation.status = "cancelled";
					operation.updatedAt = this.now().toISOString();
				}
				return;
			}
			const scopedThreadIds = approval.scope.threadIds.length > 0 ? approval.scope.threadIds : [GLOBAL_APPROVAL_SCOPE_THREAD_ID];
			for (const threadId of scopedThreadIds) {
				const thread = document.threads[threadId];
				const auth = authorizeSecret(context.token, { action: approved ? "approve" : "deny", threadId, cwd: authorizationCwd(thread) }, this.homeDir);
				if (!auth.allowed) throw new Error(auth.reason);
			}
			const operation = document.operations[approval.operationId];
			if (!operation || operation.approvalId !== approvalId) throw new Error(`Approval ${approvalId} is not current for operation ${approval.operationId}`);
			approval.status = approved ? "approved" : "denied";
			approval.approver = approver;
			approval.resolvedAt = this.now().toISOString();
			const delivery = Object.values(document.commitPushDeliveries).find((candidate) => candidate.approvalId === approvalId);
			if (delivery) {
				delivery.status = approved ? "approved" : "cancelled";
				delivery.updatedAt = this.now().toISOString();
			}
			operation.status = approved ? "acknowledged" : "cancelled";
			operation.updatedAt = this.now().toISOString();
		});
		if (expired) throw new Error(`Approval ${approvalId} has expired`);
		return (await readThreadStore(this.statePath, this.managerDir)).approvals[approvalId];
	}

	private async expireApprovals(): Promise<void> {
		await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
			for (const approval of Object.values(document.approvals)) {
				if (approval.status !== "pending") continue;
				if (new Date(approval.expiresAt).getTime() > this.now().getTime()) continue;
				approval.status = "expired";
				approval.resolvedAt = this.now().toISOString();
				const delivery = Object.values(document.commitPushDeliveries).find((candidate) => candidate.approvalId === approval.id);
				if (delivery) {
					delivery.status = "cancelled";
					delivery.updatedAt = this.now().toISOString();
				}
				const operation = document.operations[approval.operationId];
				if (operation?.approvalId === approval.id) {
					operation.status = "cancelled";
					operation.updatedAt = this.now().toISOString();
				}
			}
		});
	}

	private async getDuplicateOperation(threadId: string, requestId?: string, excludedOperationId?: string): Promise<ThreadOperation | undefined> {
		if (!requestId) return undefined;
		const document = await readThreadStore(this.statePath, this.managerDir);
		return Object.values(document.operations).find((operation) => operation.id !== excludedOperationId && operation.threadId === threadId && operation.requestId === requestId);
	}

	private async requireDeliveredDuplicate(operationId: string): Promise<ThreadOperation> {
		const operation = (await readThreadStore(this.statePath, this.managerDir)).operations[operationId];
		return requireDeliveredOperation(operation);
	}

	private async withThreadCommandLock<T>(threadId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.commandLocks.get(threadId) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => current, () => current);
		this.commandLocks.set(threadId, tail);
		await previous.catch(() => undefined);
		try {
			return await task();
		} finally {
			release();
			if (this.commandLocks.get(threadId) === tail) this.commandLocks.delete(threadId);
		}
	}

	private async assertOperationStillOwnsThread(threadId: string, operationId: string, action: "send" | "follow_up" | "steer"): Promise<void> {
		const document = await readThreadStore(this.statePath, this.managerDir);
		const operation = document.operations[operationId];
		const thread = document.threads[threadId];
		if (!operation || !thread) throw new Error(`Thread ${threadId} operation ${operationId} is missing`);
		if (operation.status === "cancelled") throw new Error(`Thread ${threadId} operation ${operationId} was cancelled before dispatch`);
		if (action === "send" && thread.currentOperationId !== operationId) throw new Error(`Thread ${threadId} operation ${operationId} no longer owns the thread`);
		if (thread.status === "stopping" || thread.status === "stopped" || thread.status === "kill_failed" || thread.status === "orphan_needs_manual_action") throw new Error(`Thread ${threadId} is ${thread.status}`);
	}

	private async requireDeliveredCreatedThread(operationId: string): Promise<ManagedThread> {
		const document = await readThreadStore(this.statePath, this.managerDir);
		const operation = document.operations[operationId];
		requireDeliveredOperation(operation);
		if (!operation.threadId || !document.threads[operation.threadId]) throw new Error(`duplicate create operation ${operationId} thread not found`);
		return document.threads[operation.threadId];
	}

	private async getDeliveredCreatedThread(requestId?: string): Promise<ManagedThread | undefined> {
		if (!requestId) return undefined;
		const document = await readThreadStore(this.statePath, this.managerDir);
		const operation = Object.values(document.operations).find((candidate) => candidate.kind === "create_thread" && candidate.requestId === requestId && candidate.status !== "failed");
		if (!operation) return undefined;
		requireDeliveredOperation(operation);
		if (!operation.threadId || !document.threads[operation.threadId]) throw new Error(`duplicate create operation ${operation.id} thread not found`);
		return document.threads[operation.threadId];
	}

	private async refreshLiveThreads(): Promise<void> {
		for (const threadId of this.handles.keys()) await this.refreshThreadState(threadId);
	}

	private async refreshThreadState(threadId: string): Promise<void> {
		const handle = this.handles.get(threadId);
		if (!handle) return;
		let state: { isStreaming?: boolean; pendingMessageCount?: number };
		try {
			state = await handle.rpc.request({ type: "get_state" }, 1000);
		} catch (error) {
			this.handles.delete(threadId);
			handle.rpc.destroy(error instanceof Error ? error : new Error(String(error)));
			await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
				const thread = document.threads[threadId];
				if (!thread || thread.status === "stopped" || thread.status === "failed" || thread.status === "kill_failed") return;
				thread.status = "crashed";
				thread.lastError = error instanceof Error ? error.message : String(error);
				thread.updatedAt = this.now().toISOString();
				if (thread.currentOperationId && document.operations[thread.currentOperationId] && !isTerminalOperation(document.operations[thread.currentOperationId].status)) {
					document.operations[thread.currentOperationId].status = "unknown_after_restart";
					document.operations[thread.currentOperationId].recoveryAction = "manual";
					document.operations[thread.currentOperationId].updatedAt = this.now().toISOString();
				}
			});
			return;
		}
		await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
			const thread = document.threads[threadId];
			if (!thread || thread.status === "stopped" || thread.status === "failed" || thread.status === "kill_failed" || thread.status === "orphan_needs_manual_action") return;
			if (thread.status === "stopping") return;
			const busy = state.isStreaming || (state.pendingMessageCount ?? 0) > 0;
			const currentOperation = thread.currentOperationId ? document.operations[thread.currentOperationId] : undefined;
			const undispatchedCurrentOperation = currentOperation && !isTerminalOperation(currentOperation.status) && currentOperation.status !== "acknowledged";
			thread.status = busy || undispatchedCurrentOperation ? "running" : "idle";
			thread.updatedAt = this.now().toISOString();
			if (!busy) {
				for (const operation of Object.values(document.operations)) {
					if (operation.threadId === threadId && operation.kind === "follow_up" && operation.status === "acknowledged") {
						operation.status = "completed";
						operation.updatedAt = this.now().toISOString();
					}
				}
			}
			if (!busy && thread.currentOperationId && currentOperation) {
				const operation = currentOperation;
				if (operation.status === "acknowledged") {
					operation.status = "completed";
					operation.updatedAt = this.now().toISOString();
					thread.currentOperationId = undefined;
				} else if (isTerminalOperation(operation.status)) {
					thread.currentOperationId = undefined;
				}
			}
		});
	}

	private async createSchedule(params: Record<string, unknown>): Promise<unknown> {
		const threadIds = Array.isArray(params.threadIds)
			? params.threadIds.map(validateThreadId)
			: params.threadId
				? [validateThreadId(params.threadId)]
				: [];
		if (threadIds.length === 0) throw new Error("schedule requires threadId or threadIds");
		return this.scheduler.createJob({
			type: params.type === "review_loop" ? "review_loop" : "custom",
			threadIds,
			intervalSeconds: Number(params.intervalSeconds ?? 30),
			maxIterations: Number(params.maxIterations ?? 10),
			restartPolicy: normalizeSafetyPolicy().restartPolicy,
			target: params.target as Record<string, unknown> | undefined,
		});
	}

	private async createReviewLoop(params: Record<string, unknown>): Promise<unknown> {
		const fixerThreadId = validateThreadId(params.fixerThreadId ?? params.threadId);
		const repo = String(params.repo ?? "");
		const prNumber = Number(params.prNumber ?? params.pr);
		if (!repo || !Number.isInteger(prNumber)) throw new Error("review_loop requires repo and prNumber");
		return this.scheduler.createJob({
			type: "review_loop",
			threadIds: [fixerThreadId],
			intervalSeconds: Number(params.intervalSeconds ?? 30),
			maxIterations: Number(params.maxIterations ?? 10),
			restartPolicy: normalizeSafetyPolicy().restartPolicy,
			target: { repo, prNumber, fixerThreadId },
		});
	}

	private async signalThread(threadId: string, kind: "abort" | "stop", command: PiRpcCommand): Promise<ThreadOperation> {
		const operationId = `op-${this.randomId()}`;
		const now = this.now().toISOString();
		let stopWithoutHandleAllowed = false;
		await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
			const thread = requireThread(document, threadId);
			const legality = isCommandAllowed(thread.status, kind, thread.safetyPolicy);
			if (!legality.allowed) throw new Error(legality.reason ?? `${kind} not allowed`);
			stopWithoutHandleAllowed = kind === "stop" && (thread.status === "orphan_needs_manual_action" || thread.status === "kill_failed");
			document.operations[operationId] = createOperation(operationId, kind, threadId, now);
			if (thread.currentOperationId && thread.currentOperationId !== operationId) {
				const interrupted = document.operations[thread.currentOperationId];
				if (interrupted && !isTerminalOperation(interrupted.status)) {
					interrupted.status = "cancelled";
					interrupted.error = `Interrupted by ${kind} operation ${operationId}`;
					interrupted.updatedAt = now;
				}
			}
			cancelNonTerminalThreadOperations(document, threadId, operationId, `Interrupted by ${kind} operation ${operationId}`, now);
			thread.status = kind === "stop" || thread.status === "stopping" ? "stopping" : "running";
			thread.currentOperationId = operationId;
			thread.updatedAt = now;
		});
		const handle = this.handles.get(threadId);
		if (!handle) {
			if (stopWithoutHandleAllowed) {
				await this.markThreadStopped(threadId, operationId);
				return (await readThreadStore(this.statePath, this.managerDir)).operations[operationId];
			}
			await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
				document.operations[operationId].status = "manual_action_required";
				document.operations[operationId].recoveryAction = "manual";
				document.operations[operationId].error = "No live RPC handle for abort/stop";
				document.operations[operationId].updatedAt = this.now().toISOString();
				document.threads[threadId].status = "orphan_needs_manual_action";
				document.threads[threadId].lastError = "No live RPC handle for abort/stop";
			});
			throw new Error(`Thread ${threadId} has no live RPC handle; manual cleanup required`);
		}
		try {
			await this.withThreadCommandLock(threadId, async () => {
				await handle.rpc.request(command);
			});
		} catch (error) {
			await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
				document.operations[operationId].status = "manual_action_required";
				document.operations[operationId].recoveryAction = "manual";
				document.operations[operationId].error = error instanceof Error ? error.message : String(error);
				document.operations[operationId].updatedAt = this.now().toISOString();
				document.threads[threadId].status = "orphan_needs_manual_action";
				document.threads[threadId].lastError = document.operations[operationId].error;
			});
			throw error;
		}
		await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
			document.operations[operationId].status = "completed";
			document.operations[operationId].updatedAt = this.now().toISOString();
		});
		return (await readThreadStore(this.statePath, this.managerDir)).operations[operationId];
	}

	private async updateThreadStatus(threadId: string, status: ManagedThread["status"], operationId?: string): Promise<void> {
		await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
			const thread = requireThread(document, threadId);
			thread.status = status;
			thread.updatedAt = this.now().toISOString();
			if (operationId) thread.currentOperationId = operationId;
		});
	}

	private async markThreadStopped(threadId: string, operationId: string): Promise<void> {
		await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
			const thread = requireThread(document, threadId);
			thread.status = "stopped";
			thread.pid = undefined;
			thread.pidStartedAt = undefined;
			thread.currentOperationId = undefined;
			thread.updatedAt = this.now().toISOString();
			const operation = document.operations[operationId];
			if (operation) {
				operation.status = "completed";
				if (thread.worktree?.mode === "isolated" && thread.worktree.cleanupState === "retained") {
					operation.message = `worktree retained at ${thread.worktree.worktreeRoot}; run /threads cleanup ${thread.id} when safe`;
				}
				operation.updatedAt = this.now().toISOString();
			}
		});
	}

	private async markStopKillFailed(threadId: string, operationId: string): Promise<void> {
		await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
			const thread = requireThread(document, threadId);
			const operation = document.operations[operationId];
			if (operation) {
				operation.status = "failed";
				operation.error = "Child process did not exit after SIGTERM";
				operation.updatedAt = this.now().toISOString();
			}
			thread.status = "kill_failed";
			thread.lastError = "Child process did not exit after SIGTERM";
			thread.currentOperationId = undefined;
			thread.updatedAt = this.now().toISOString();
		});
	}

	private async markUnknownAfterMissingHandle(threadId: string, operationId: string): Promise<void> {
		await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
			document.operations[operationId].status = "manual_action_required";
			document.operations[operationId].recoveryAction = "manual";
			document.operations[operationId].error = "No live RPC handle for thread";
			document.threads[threadId].status = "orphan_needs_manual_action";
			document.threads[threadId].lastError = "No live RPC handle for thread";
		});
	}

	private async markThreadCrashedAfterReadFailure(threadId: string, error: unknown): Promise<void> {
		await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
			const thread = document.threads[threadId];
			if (!thread || thread.status === "stopped" || thread.status === "failed" || thread.status === "kill_failed" || thread.status === "orphan_needs_manual_action") return;
			thread.status = "crashed";
			thread.lastError = error instanceof Error ? error.message : String(error);
			thread.updatedAt = this.now().toISOString();
			if (thread.currentOperationId && document.operations[thread.currentOperationId] && !isTerminalOperation(document.operations[thread.currentOperationId].status)) {
				document.operations[thread.currentOperationId].status = "unknown_after_restart";
				document.operations[thread.currentOperationId].recoveryAction = "manual";
				document.operations[thread.currentOperationId].updatedAt = this.now().toISOString();
			}
		});
	}

	private async markCommandRejected(threadId: string, operationId: string, error: unknown, handle: LaunchedThreadProcess): Promise<void> {
		const operationError = error instanceof Error ? error.message : String(error);
		let state: { isStreaming?: boolean; pendingMessageCount?: number } | undefined;
		let livenessError: unknown;
		try {
			state = await handle.rpc.request({ type: "get_state" }, 1000);
		} catch (stateError) {
			livenessError = stateError;
			this.handles.delete(threadId);
			handle.rpc.destroy(stateError instanceof Error ? stateError : new Error(String(stateError)));
		}
		await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
			const operation = document.operations[operationId];
			const thread = document.threads[threadId];
			if (!operation || !thread || operation.status === "cancelled") return;
			operation.status = "failed";
			operation.error = operationError;
			operation.updatedAt = this.now().toISOString();
			if (thread.currentOperationId === operationId) thread.currentOperationId = undefined;
			if (state) {
				if (!["stopping", "stopped", "failed", "kill_failed", "orphan_needs_manual_action"].includes(thread.status)) {
					thread.status = state.isStreaming || (state.pendingMessageCount ?? 0) > 0 ? "running" : "idle";
				}
				thread.lastError = operationError;
				thread.updatedAt = this.now().toISOString();
				return;
			}
			if (thread.status === "stopped" || thread.status === "failed" || thread.status === "kill_failed" || thread.status === "orphan_needs_manual_action") return;
			thread.status = "crashed";
			thread.lastError = livenessError instanceof Error ? livenessError.message : String(livenessError ?? error);
			thread.updatedAt = this.now().toISOString();
		});
	}

	private async recordChildUiRequest(threadId: string, request: PiRpcUiRequest): Promise<Record<string, unknown>> {
		if (isPassiveChildUiRequest(request)) return {};
		const operationId = `op-${this.randomId()}`;
		const now = this.now().toISOString();
		await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
			const thread = requireThread(document, threadId);
			document.operations[operationId] = {
				id: operationId,
				kind: "child_ui_request",
				status: "manual_action_required",
				threadId,
				idempotencyKey: `child_ui_request:${threadId}:${request.id}`,
				createdAt: now,
				updatedAt: now,
				externalId: request.id,
				error: `Child requested UI interaction: ${describeChildUiRequest(request)}`,
			};
			thread.lastError = document.operations[operationId].error;
			thread.updatedAt = now;
		});
		return { cancelled: true, error: `Thread ${threadId} UI request ${request.id} requires manual action` };
	}

	private async runReviewLoopJob(jobId: string, target: Record<string, unknown>, lease?: JobLease): Promise<void> {
		const repo = String(target.repo ?? "");
		const prNumber = Number(target.prNumber);
		const fixerThreadId = validateThreadId(target.fixerThreadId);
		let runId: string | undefined;
		let activeLease = lease;
		let leaseRenewalError: unknown;
		const renewTimer = lease
			? setInterval(() => {
				void this.scheduler.renewLease(jobId, activeLease, 60).then((renewed) => {
					if (renewed) activeLease = renewed;
				}).catch((error) => {
					leaseRenewalError = error;
				});
			}, 20_000)
			: undefined;
		renewTimer?.unref?.();
		try {
			const snapshot = await this.githubReviewPort.fetchSnapshot({ repo, prNumber });
			if (leaseRenewalError) throw leaseRenewalError;
			const action = recommendReviewLoopAction(snapshot);
			const snapshotKey = reviewLoopSnapshotKey(action);
			const reviewThreadIds = action.action === "process_review_comment"
				? action.clusters.flatMap((cluster) => cluster.threadIds)
				: [];
			const run = await this.scheduler.recordRun(jobId, { headSha: snapshot.headSha, reviewThreadIds, dispatchedThreadId: fixerThreadId, snapshotKey });
			runId = run.id;
			if (leaseRenewalError) throw leaseRenewalError;
			if (action.action === "process_review_comment") {
				const cluster = mergeReviewThreadClusters(action.clusters);
				const prompt = validatePrompt(buildFixerPrompt({ repo: snapshot.repo, prNumber: snapshot.prNumber, headSha: snapshot.headSha, cluster }));
				await this.sendToThread(fixerThreadId, "send", prompt, `review-loop:${snapshot.headSha}:${snapshotKey}:${run.id}`);
				if (leaseRenewalError) throw leaseRenewalError;
				await this.scheduler.completeRun(run.id, "completed", "review comments dispatched to fixer thread");
				return;
			}
			if (action.action === "stop_pr_closed" || action.action === "ready_to_merge") {
				if (leaseRenewalError) throw leaseRenewalError;
				await this.scheduler.completeRunTerminal(run.id, "completed", reviewLoopTerminalReason(action.action, snapshot));
				return;
			}
			if (leaseRenewalError) throw leaseRenewalError;
			await this.scheduler.completeRun(run.id, "cancelled", reviewLoopTerminalReason(action.action, snapshot));
		} catch (error) {
			if (error instanceof DuplicateJobSnapshotError && !runId) {
				if (error.duplicateStatus === "completed") {
					await this.scheduler.releaseLeaseAfterDuplicateCompletedSnapshot(jobId, activeLease, error.message);
				} else {
					await this.scheduler.releaseLeaseUntilNextRun(jobId, activeLease);
				}
				return;
			}
			if (runId) {
				await this.scheduler.completeRun(runId, "failed", error instanceof Error ? error.message : String(error));
				return;
			}
			await this.scheduler.releaseLeaseWithError(jobId, error instanceof Error ? error.message : String(error), activeLease, 30);
			throw error;
		} finally {
			if (renewTimer) clearInterval(renewTimer);
		}
	}

	private async resumeThreadAfterRestart(thread: ManagedThread): Promise<void> {
		let handle: LaunchedThreadProcess | undefined;
		try {
			handle = await this.launchThread(thread);
			const state = await handle.rpc.request<{ isStreaming?: boolean; pendingMessageCount?: number }>({ type: "get_state" }, STARTUP_STATE_TIMEOUT_MS);
			this.handles.set(thread.id, handle);
			await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
				const current = document.threads[thread.id];
				if (!current) return;
				const busy = state.isStreaming || (state.pendingMessageCount ?? 0) > 0;
				current.status = busy ? "running" : "idle";
				current.pid = handle?.pid;
				current.pidStartedAt = handle?.startedAt;
				current.lastError = undefined;
				current.restartBackoffUntil = undefined;
				current.updatedAt = this.now().toISOString();
			});
		} catch (error) {
			if (handle) {
				handle.rpc.destroy(error instanceof Error ? error : new Error(String(error)));
				handle.child?.kill("SIGTERM");
				this.handles.delete(thread.id);
			}
			await mutateThreadStore({ statePath: this.statePath, managerDir: this.managerDir, now: this.now }, (document) => {
				const current = document.threads[thread.id];
				if (!current) return;
				current.status = "crashed";
				current.lastError = error instanceof Error ? error.message : String(error);
				current.updatedAt = this.now().toISOString();
			});
		}
	}
}

export function createThreadService(deps: ThreadServiceDeps = {}): ThreadService {
	return new ThreadService(deps);
}

export function reviewLoopTerminalReason(action: Exclude<ReturnType<typeof recommendReviewLoopAction>["action"], "process_review_comment">, snapshot: ReviewSnapshot): string {
	switch (action) {
		case "ready_to_merge":
			return `no actionable review threads for ${snapshot.repo}#${snapshot.prNumber}`;
		case "diagnose_ci_failure":
			return `CI is blocking ${snapshot.repo}#${snapshot.prNumber}`;
		case "stop_pr_closed":
			return `PR ${snapshot.repo}#${snapshot.prNumber} is ${snapshot.state}`;
		case "idle":
			return `review loop idle for ${snapshot.repo}#${snapshot.prNumber}`;
		default: {
			const exhaustive: never = action;
			return exhaustive;
		}
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

async function realpathCwd(cwd: string): Promise<string> {
	return await realpath(path.resolve(cwd));
}

interface TranscriptWindow {
	items: unknown[];
	truncated: boolean;
}

async function readSessionTranscript(sessionFile: string, cursor: number, limit: number): Promise<TranscriptWindow> {
	const items: unknown[] = [];
	let lineIndex = 0;
	let truncated = false;
	let sawLine = false;
	const stream = createReadStream(sessionFile, { encoding: "utf8" });
	const reader = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of reader) {
			if (line.trim() === "") continue;
			sawLine = true;
			if (lineIndex >= cursor) {
				if (items.length >= limit) {
					truncated = true;
					break;
				}
				items.push(parseTranscriptLine(line));
			}
			lineIndex += 1;
		}
		if (!sawLine && cursor === 0) items.push({ type: "thread_manager_unavailable", message: "Persisted session transcript is empty" });
		return { items, truncated };
	} catch (error) {
		return { items: [{ type: "thread_manager_unavailable", message: `Could not read persisted session transcript: ${error instanceof Error ? error.message : String(error)}` }], truncated: false };
	} finally {
		reader.close();
		stream.destroy();
	}
}

async function discoverSessionFile(sessionDir: string, fallback: string | undefined): Promise<string | undefined> {
	let entries: string[];
	try {
		entries = await readdir(sessionDir);
	} catch {
		return fallback;
	}
	let newest: { filePath: string; mtimeMs: number } | undefined;
	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue;
		const filePath = path.join(sessionDir, entry);
		try {
			const info = await stat(filePath);
			if (!info.isFile()) continue;
			if (!newest || info.mtimeMs > newest.mtimeMs) newest = { filePath, mtimeMs: info.mtimeMs };
		} catch {}
	}
	return newest?.filePath ?? fallback;
}

function cancelNonTerminalThreadOperations(document: ThreadStoreDocument, threadId: string, exceptOperationId: string, error: string, updatedAt: string): void {
	for (const operation of Object.values(document.operations)) {
		if (operation.id === exceptOperationId || operation.threadId !== threadId || isTerminalOperation(operation.status)) continue;
		operation.status = "cancelled";
		operation.error = error;
		operation.updatedAt = updatedAt;
	}
}

function mergeReviewThreadClusters(clusters: ReviewThreadCluster[]): ReviewThreadCluster {
	const allThreads = clusters.flatMap((cluster) => cluster.threads);
	return {
		key: clusters.map((cluster) => cluster.key).join(","),
		path: clusters.length === 1 ? clusters[0].path : null,
		threadIds: clusters.flatMap((cluster) => cluster.threadIds),
		threads: allThreads,
	};
}

function cloneManagedThread(thread: ManagedThread): ManagedThread {
	return {
		...thread,
		tags: [...thread.tags],
		launchProfile: { ...thread.launchProfile },
		safetyPolicy: { ...thread.safetyPolicy, restartPolicy: { ...thread.safetyPolicy.restartPolicy } },
		worktree: thread.worktree ? { ...thread.worktree } : undefined,
	};
}

function parseTranscriptLine(line: string): unknown {
	try {
		return JSON.parse(line) as unknown;
	} catch {
		return { type: "session_line", text: line };
	}
}

function createOperation(id: string, kind: ThreadOperation["kind"], threadId: string, now: string, message?: string, requestId?: string): ThreadOperation {
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

function isTerminalOperation(status: ThreadOperation["status"]): boolean {
	return ["cancelled", "completed", "failed", "reconciled", "manual_action_required"].includes(status);
}

function requireDeliveredOperation(operation: ThreadOperation | undefined): ThreadOperation {
	if (!operation) throw new Error("duplicate operation not found");
	if (operation.status === "acknowledged" || operation.status === "completed" || operation.status === "reconciled") return operation;
	throw new Error(`duplicate operation ${operation.id} is ${operation.status}, not delivered`);
}

class DuplicateOperationError extends Error {
	constructor(readonly operationId: string) {
		super(`duplicate operation ${operationId}`);
	}
}

const GLOBAL_APPROVAL_SCOPE_THREAD_ID = "thread-manager-global-approval-scope";

async function waitForChildExit(child: { once(event: "exit", listener: () => void): unknown; exitCode: number | null }, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null) return true;
	return await new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

function requireThread(document: ThreadStoreDocument, threadId: string): ManagedThread {
	const thread = document.threads[threadId];
	if (!thread) throw new Error(`Thread not found: ${threadId}`);
	return thread;
}

function authorizationCwd(thread: ManagedThread | undefined): string | undefined {
	return thread?.worktree?.sourceCwd ?? thread?.cwd;
}

function getRestartDecision(thread: ManagedThread, now: Date): { allowed: true } | { allowed: false; reason: string; retryAfter?: string } {
	const policy = thread.safetyPolicy.restartPolicy;
	if (policy.mode !== "from_session") return { allowed: false, reason: "Daemon restarted without a reconnectable child RPC control channel" };
	if (thread.currentOperationId) return { allowed: false, reason: "Daemon restarted while operation outcome is unknown" };
	if ((thread.restartCount ?? 0) >= policy.maxRestarts) return { allowed: false, reason: "Restart policy maxRestarts exhausted" };
	if (thread.restartBackoffUntil && new Date(thread.restartBackoffUntil).getTime() > now.getTime()) {
		return { allowed: false, reason: `Restart policy backoff active until ${thread.restartBackoffUntil}`, retryAfter: thread.restartBackoffUntil };
	}
	return { allowed: true };
}

function reviewLoopSnapshotKey(action: ReturnType<typeof recommendReviewLoopAction>): string | undefined {
	if (action.action !== "process_review_comment") return undefined;
	const revisions = action.clusters.flatMap((cluster) => cluster.threads.map((thread) => ({
		id: thread.id,
		comments: thread.comments.map((comment) => ({ id: comment.id, body: comment.body, updatedAt: comment.updatedAt, createdAt: comment.createdAt })),
	})));
	return createHash("sha256").update(JSON.stringify(revisions)).digest("hex");
}

export function isPassiveChildUiRequest(request: PiRpcUiRequest): boolean {
	return ["notify", "setStatus", "setTitle", "setWidget"].includes(describeChildUiRequest(request));
}

function describeChildUiRequest(request: PiRpcUiRequest): string {
	const label = request.method ?? request.kind ?? request.requestType ?? request.name ?? request.id;
	return typeof label === "string" ? label : request.id;
}

function markThreadOrphanAfterRestart(document: ThreadStoreDocument, thread: ManagedThread, now: string, reason = "Daemon restarted without a reconnectable child RPC control channel"): void {
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

function markCreatingThreadFailedAfterRestart(document: ThreadStoreDocument, thread: ManagedThread, now: string, reason = "Daemon restarted before thread launch completed"): void {
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
