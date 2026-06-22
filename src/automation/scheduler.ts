import { randomUUID } from "node:crypto";

import { validateApprovalScope, validateScheduleInterval } from "../protocol.ts";
import { mutateThreadStore, readThreadStore } from "../store/thread-store.ts";
import { DEFAULT_PROTOCOL_LIMITS, type ApprovalRecord, type ApprovalScope, type AutomationJob, type CommitPushDelivery, type JobRunRecord, type RestartPolicy, type ThreadStoreDocument } from "../types.ts";

export interface SchedulerOptions {
	statePath: string;
	managerDir: string;
	daemonEpoch: string;
	now?: () => Date;
	randomId?: () => string;
}

export interface CreateJobInput {
	type: AutomationJob["type"];
	threadIds: string[];
	intervalSeconds: number;
	maxIterations: number;
	restartPolicy: RestartPolicy;
	target?: Record<string, unknown>;
}

export class DuplicateJobSnapshotError extends Error {
	constructor(readonly idempotencyKey: string, readonly duplicateStatus: JobRunRecord["status"]) {
		super(`Duplicate running job snapshot: ${idempotencyKey}`);
	}
}

export class ThreadScheduler {
	private readonly now: () => Date;
	private readonly randomId: () => string;

	constructor(private readonly options: SchedulerOptions) {
		this.now = options.now ?? (() => new Date());
		this.randomId = options.randomId ?? (() => randomUUID());
	}

	async createJob(input: CreateJobInput): Promise<AutomationJob> {
		validateScheduleInterval(input.intervalSeconds);
		if (!Number.isInteger(input.maxIterations) || input.maxIterations <= 0 || input.maxIterations > 100) throw new Error("maxIterations must be 1-100");
		const jobId = `job-${this.randomId()}`;
		const now = this.now().toISOString();
		const job: AutomationJob = {
			id: jobId,
			type: input.type,
			status: "scheduled",
			threadIds: input.threadIds,
			target: input.target,
			intervalSeconds: input.intervalSeconds,
			nextRunAt: now,
			maxIterations: input.maxIterations,
			iterationCount: 0,
			restartPolicy: input.restartPolicy,
			createdAt: now,
			updatedAt: now,
		};
		await mutateThreadStore({ statePath: this.options.statePath, managerDir: this.options.managerDir, now: this.now }, (document) => {
			if (Object.keys(document.schedules).length >= DEFAULT_PROTOCOL_LIMITS.maxJobs) throw new Error(`Thread manager job limit reached (${DEFAULT_PROTOCOL_LIMITS.maxJobs})`);
			for (const threadId of input.threadIds) {
				if (!document.threads[threadId]) throw new Error(`Cannot schedule missing thread ${threadId}`);
			}
			document.schedules[jobId] = job;
		});
		return job;
	}

	async acquireLease(jobId: string, leaseSeconds = 60): Promise<AutomationJob | null> {
		let acquired: AutomationJob | null = null;
		await mutateThreadStore({ statePath: this.options.statePath, managerDir: this.options.managerDir, now: this.now }, (document) => {
			const job = requireJob(document, jobId);
			if (job.status !== "scheduled" && job.status !== "running") return;
			if (Object.values(document.jobRuns).some((run) => run.jobId === jobId && run.status === "running")) return;
			if (job.maxIterations <= job.iterationCount) {
				job.status = "completed";
				job.lastError = "max iterations reached";
				return;
			}
			const nowMs = this.now().getTime();
			if (job.backoffUntil && new Date(job.backoffUntil).getTime() > nowMs) return;
			if (job.nextRunAt && new Date(job.nextRunAt).getTime() > nowMs) return;
			if (job.lease && new Date(job.lease.expiresAt).getTime() > nowMs) return;
			const nowIso = this.now().toISOString();
			job.lease = {
				daemonEpoch: this.options.daemonEpoch,
				nonce: this.randomId(),
				expiresAt: new Date(nowMs + leaseSeconds * 1000).toISOString(),
				renewedAt: nowIso,
			};
			job.status = "running";
			job.updatedAt = nowIso;
			acquired = { ...job, threadIds: [...job.threadIds], lease: { ...job.lease } };
		});
		return acquired;
	}

	async recordRun(jobId: string, input: { headSha?: string; reviewThreadIds?: string[]; dispatchedThreadId?: string; approvalId?: string; snapshotKey?: string } = {}): Promise<JobRunRecord> {
		const runId = `run-${this.randomId()}`;
		const now = this.now().toISOString();
		const run: JobRunRecord = {
			id: runId,
			jobId,
			leaseNonce: undefined,
			status: "running",
			inputHeadSha: input.headSha,
			reviewThreadIds: input.reviewThreadIds ?? [],
			dispatchedThreadId: input.dispatchedThreadId,
			approvalId: input.approvalId,
			retryCount: 0,
			idempotencyKey: jobRunIdempotencyKey(jobId, input),
			createdAt: now,
			updatedAt: now,
		};
		await mutateThreadStore({ statePath: this.options.statePath, managerDir: this.options.managerDir, now: this.now }, (document) => {
			const job = document.schedules[jobId];
			if (!job) throw new Error(`Job not found: ${jobId}`);
			const duplicate = Object.values(document.jobRuns).find((existing) => existing.idempotencyKey === run.idempotencyKey && (existing.status === "running" || existing.status === "completed"));
			if (duplicate) {
				throw new DuplicateJobSnapshotError(run.idempotencyKey, duplicate.status);
			}
			if (!job.lease?.nonce) throw new Error(`Job ${jobId} has no active lease`);
			run.leaseNonce = job.lease?.nonce;
			document.jobRuns[runId] = run;
		});
		return run;
	}

	async renewLease(jobId: string, lease: AutomationJob["lease"], leaseSeconds = 60): Promise<AutomationJob["lease"] | undefined> {
		let renewed: AutomationJob["lease"] | undefined;
		await mutateThreadStore({ statePath: this.options.statePath, managerDir: this.options.managerDir, now: this.now }, (document) => {
			const job = requireJob(document, jobId);
			if (!lease || job.lease?.daemonEpoch !== lease.daemonEpoch || job.lease?.nonce !== lease.nonce) return;
			const nowMs = this.now().getTime();
			job.lease = { ...job.lease, expiresAt: new Date(nowMs + leaseSeconds * 1000).toISOString(), renewedAt: this.now().toISOString() };
			job.updatedAt = this.now().toISOString();
			renewed = { ...job.lease };
		});
		return renewed;
	}

	async completeRun(runId: string, status: JobRunRecord["status"], terminalReason?: string): Promise<JobRunRecord> {
		return this.finishRun(runId, status, terminalReason, false);
	}

	async completeRunTerminal(runId: string, status: JobRunRecord["status"], terminalReason?: string): Promise<JobRunRecord> {
		return this.finishRun(runId, status, terminalReason, true);
	}

	async releaseLease(jobId: string, lease?: AutomationJob["lease"]): Promise<void> {
		await mutateThreadStore({ statePath: this.options.statePath, managerDir: this.options.managerDir, now: this.now }, (document) => {
			const job = requireJob(document, jobId);
			if (lease && (job.lease?.daemonEpoch !== lease.daemonEpoch || job.lease?.nonce !== lease.nonce)) return;
			job.lease = undefined;
			job.status = job.status === "running" ? "scheduled" : job.status;
			job.updatedAt = this.now().toISOString();
		});
	}

	async releaseLeaseUntilNextRun(jobId: string, lease?: AutomationJob["lease"]): Promise<void> {
		await mutateThreadStore({ statePath: this.options.statePath, managerDir: this.options.managerDir, now: this.now }, (document) => {
			const job = requireJob(document, jobId);
			if (lease && (job.lease?.daemonEpoch !== lease.daemonEpoch || job.lease?.nonce !== lease.nonce)) return;
			job.nextRunAt = new Date(this.now().getTime() + job.intervalSeconds * 1000).toISOString();
			job.lease = undefined;
			job.status = job.status === "running" ? "scheduled" : job.status;
			job.updatedAt = this.now().toISOString();
		});
	}

	async releaseLeaseAfterDuplicateCompletedSnapshot(jobId: string, lease: AutomationJob["lease"], reason: string): Promise<void> {
		await mutateThreadStore({ statePath: this.options.statePath, managerDir: this.options.managerDir, now: this.now }, (document) => {
			const job = requireJob(document, jobId);
			if (!lease || job.lease?.daemonEpoch !== lease.daemonEpoch || job.lease?.nonce !== lease.nonce) return;
			job.iterationCount += 1;
			job.lastRunAt = this.now().toISOString();
			job.nextRunAt = new Date(this.now().getTime() + job.intervalSeconds * 1000).toISOString();
			job.lastError = reason;
			job.lease = undefined;
			job.status = job.iterationCount >= job.maxIterations ? "completed" : "scheduled";
			job.updatedAt = this.now().toISOString();
		});
	}

	private async finishRun(runId: string, status: JobRunRecord["status"], terminalReason: string | undefined, terminalJob: boolean): Promise<JobRunRecord> {
		await mutateThreadStore({ statePath: this.options.statePath, managerDir: this.options.managerDir, now: this.now }, (document) => {
			const run = document.jobRuns[runId];
			if (!run) throw new Error(`Job run not found: ${runId}`);
			const job = document.schedules[run.jobId];
			if (run.status !== "running") throw new Error(`Job run ${runId} is ${run.status}`);
			if (!run.leaseNonce || job.lease?.nonce !== run.leaseNonce) throw new Error(`Lease changed for job run ${runId}`);
			run.status = status;
			run.terminalReason = terminalReason;
			run.updatedAt = this.now().toISOString();
			job.iterationCount += 1;
			job.lastRunAt = this.now().toISOString();
			job.nextRunAt = new Date(this.now().getTime() + job.intervalSeconds * 1000).toISOString();
			job.lease = undefined;
			job.status = nextJobStatus(status, terminalJob, job.maxIterations <= job.iterationCount);
			job.updatedAt = this.now().toISOString();
		});
		return (await readThreadStore(this.options.statePath, this.options.managerDir)).jobRuns[runId];
	}

	async reconcileAfterRestart(): Promise<void> {
		await mutateThreadStore({ statePath: this.options.statePath, managerDir: this.options.managerDir, now: this.now }, (document) => {
			for (const run of Object.values(document.jobRuns)) {
				if (run.status !== "running") continue;
				run.status = "failed";
				run.terminalReason = "daemon restarted while job run was active";
				run.updatedAt = this.now().toISOString();
			}
			for (const job of Object.values(document.schedules)) {
				if (job.lease && job.lease.daemonEpoch !== this.options.daemonEpoch) {
					job.lease = undefined;
					job.status = job.status === "running" ? "scheduled" : job.status;
					job.updatedAt = this.now().toISOString();
				}
			}
		});
	}

	async releaseLeaseWithError(jobId: string, error: string, lease: AutomationJob["lease"], backoffSeconds = 30): Promise<void> {
		await mutateThreadStore({ statePath: this.options.statePath, managerDir: this.options.managerDir, now: this.now }, (document) => {
			const job = requireJob(document, jobId);
			if (!lease || job.lease?.daemonEpoch !== lease.daemonEpoch || job.lease?.nonce !== lease.nonce) return;
			job.lastError = error;
			job.iterationCount += 1;
			job.lastRunAt = this.now().toISOString();
			job.backoffUntil = new Date(this.now().getTime() + backoffSeconds * 1000).toISOString();
			job.lease = undefined;
			job.status = job.iterationCount >= job.maxIterations ? "failed" : "scheduled";
			job.updatedAt = this.now().toISOString();
		});
	}

	async requireApprovalForDelivery(input: Omit<CommitPushDelivery, "id" | "approvalId" | "createdAt" | "updatedAt" | "status"> & { scope: ApprovalScope; expiresAt: string }): Promise<{ delivery: CommitPushDelivery; approval: ApprovalRecord }> {
		const now = this.now().toISOString();
		const deliveryId = `delivery-${this.randomId()}`;
		const approvalId = `approval-${this.randomId()}`;
		const delivery: CommitPushDelivery = {
			id: deliveryId,
			operationId: input.operationId,
			status: "approval_required",
			repo: input.repo,
			branch: input.branch,
			expectedHeadSha: input.expectedHeadSha,
			diffSummary: input.diffSummary,
			cleanWorktreeRequired: input.cleanWorktreeRequired,
			approvalId,
			createdAt: now,
			updatedAt: now,
		};
		const approval: ApprovalRecord = {
			id: approvalId,
			status: "pending",
			scope: input.scope,
			operationId: input.operationId,
			createdAt: now,
			expiresAt: input.expiresAt,
		};
		await mutateThreadStore({ statePath: this.options.statePath, managerDir: this.options.managerDir, now: this.now }, (document) => {
			if (!document.operations[input.operationId]) throw new Error(`Operation not found: ${input.operationId}`);
			for (const approval of Object.values(document.approvals)) {
				if (approval.operationId === input.operationId && approval.status === "pending") approval.status = "invalidated";
			}
			for (const existing of Object.values(document.commitPushDeliveries)) {
				if (existing.operationId === input.operationId && existing.status === "approval_required") existing.status = "cancelled";
			}
			document.commitPushDeliveries[deliveryId] = delivery;
			document.approvals[approvalId] = approval;
			document.operations[input.operationId].approvalId = approvalId;
			document.operations[input.operationId].status = "approval_required";
		});
		return { delivery, approval };
	}
}

export function validateDeliveryApproval(currentScope: ApprovalScope, approval: ApprovalRecord): void {
	const legality = validateApprovalScope(currentScope, approval);
	if (!legality.allowed) throw new Error(legality.reason ?? "approval no longer valid");
}

export function shouldResumeAfterRestart(policy: RestartPolicy, operationOutcomeKnown: boolean): boolean {
	if (policy.mode === "never") return false;
	if (policy.mode === "manual") return false;
	if (!operationOutcomeKnown && !policy.allowWhenOperationUnknown) return false;
	return true;
}

function jobRunIdempotencyKey(jobId: string, input: { headSha?: string; reviewThreadIds?: string[]; dispatchedThreadId?: string; snapshotKey?: string }): string {
	const snapshot = `${input.headSha ?? "none"}:${input.snapshotKey ?? (input.reviewThreadIds ?? []).join(",")}`;
	return input.dispatchedThreadId ? `dispatch:${input.dispatchedThreadId}:${snapshot}` : `${jobId}:${snapshot}`;
}

function requireJob(document: ThreadStoreDocument, jobId: string): AutomationJob {
	const job = document.schedules[jobId];
	if (!job) throw new Error(`Job not found: ${jobId}`);
	return job;
}

function nextJobStatus(runStatus: JobRunRecord["status"], terminalJob: boolean, exhausted: boolean): AutomationJob["status"] {
	if (!terminalJob && !exhausted) return "scheduled";
	return runStatus === "failed" ? "failed" : "completed";
}
