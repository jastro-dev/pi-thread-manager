import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ThreadScheduler, shouldResumeAfterRestart, validateDeliveryApproval } from "../src/automation/scheduler.ts";
import { getThreadManagerDir, getThreadStorePath } from "../src/broker/paths.ts";
import { normalizeLaunchProfile, normalizeRestartPolicy, normalizeSafetyPolicy } from "../src/protocol.ts";
import { mutateThreadStore, readThreadStore } from "../src/store/thread-store.ts";
import type { ManagedThread, ThreadOperation } from "../src/types.ts";

test("acquires only one live job lease", async () => {
	const { scheduler } = await createScheduler();
	const job = await scheduler.createJob(baseJobInput());
	const first = await scheduler.acquireLease(job.id);
	const second = await scheduler.acquireLease(job.id);
	assert.equal(first?.id, job.id);
	assert.equal(second, null);
});

test("lease release is fenced by lease nonce", async () => {
	const { scheduler, statePath, managerDir } = await createScheduler();
	const job = await scheduler.createJob(baseJobInput());
	const staleLease = await scheduler.acquireLease(job.id);
	assert.ok(staleLease?.lease);
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.schedules[job.id].lease = { daemonEpoch: "new-daemon", nonce: "new-nonce", expiresAt: "2099-01-01T00:00:00.000Z", renewedAt: "2026-01-01T00:00:00.000Z" };
	});
	await scheduler.releaseLease(job.id, staleLease.lease);
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.schedules[job.id].lease?.nonce, "new-nonce");
});

test("lease renewal is fenced by lease nonce", async () => {
	const { scheduler, statePath, managerDir } = await createScheduler();
	const job = await scheduler.createJob(baseJobInput());
	const staleLease = await scheduler.acquireLease(job.id);
	assert.ok(staleLease?.lease);
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.schedules[job.id].lease = { daemonEpoch: "new-daemon", nonce: "new-nonce", expiresAt: "2026-01-01T00:00:00.000Z", renewedAt: "2026-01-01T00:00:00.000Z" };
	});
	assert.equal(await scheduler.renewLease(job.id, staleLease.lease), undefined);
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.schedules[job.id].lease?.nonce, "new-nonce");
});

test("duplicate snapshot release advances next run", async () => {
	const { scheduler, statePath, managerDir } = await createScheduler();
	const job = await scheduler.createJob(baseJobInput());
	const leased = await scheduler.acquireLease(job.id);
	assert.ok(leased?.lease);
	await scheduler.releaseLeaseUntilNextRun(job.id, leased.lease);
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.schedules[job.id].lease, undefined);
	assert.notEqual(store.schedules[job.id].nextRunAt, job.nextRunAt);
});

test("backs off and stops at max iterations without catch-up storm", async () => {
	const { scheduler, statePath, managerDir } = await createScheduler();
	const job = await scheduler.createJob({ ...baseJobInput(), maxIterations: 1 });
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.schedules[job.id].backoffUntil = "2099-01-01T00:00:00.000Z";
	});
	assert.equal(await scheduler.acquireLease(job.id), null);
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.schedules[job.id].backoffUntil = undefined;
	});
	const leased = await scheduler.acquireLease(job.id);
	assert.ok(leased);
	const run = await scheduler.recordRun(job.id, { headSha: "abc", reviewThreadIds: ["rt-1"] });
	await scheduler.completeRun(run.id, "completed", "done");
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.schedules[job.id].status, "completed");
	assert.equal(await scheduler.acquireLease(job.id), null);
});

test("prevents duplicate running runs for the same snapshot", async () => {
	const { scheduler } = await createScheduler();
	const job = await scheduler.createJob(baseJobInput());
	await scheduler.acquireLease(job.id);
	await scheduler.recordRun(job.id, { headSha: "abc", reviewThreadIds: ["rt-1"] });
	await assert.rejects(() => scheduler.recordRun(job.id, { headSha: "abc", reviewThreadIds: ["rt-1"] }), /Duplicate running job snapshot/);
});

test("does not acquire an expired lease while a run is still active", async () => {
	const { scheduler, statePath, managerDir } = await createScheduler();
	const job = await scheduler.createJob(baseJobInput());
	await scheduler.acquireLease(job.id);
	await scheduler.recordRun(job.id, { headSha: "abc", reviewThreadIds: ["rt-1"] });
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.schedules[job.id].lease!.expiresAt = "2000-01-01T00:00:00.000Z";
	});
	assert.equal(await scheduler.acquireLease(job.id), null);
});

test("rejects duplicate completed runs for the same snapshot", async () => {
	const { scheduler } = await createScheduler();
	const job = await scheduler.createJob(baseJobInput());
	await scheduler.acquireLease(job.id);
	const run = await scheduler.recordRun(job.id, { headSha: "abc", reviewThreadIds: ["rt-1"] });
	await scheduler.completeRun(run.id, "completed");
	await scheduler.acquireLease(job.id);
	await assert.rejects(() => scheduler.recordRun(job.id, { headSha: "abc", reviewThreadIds: ["rt-1"] }), /Duplicate running job snapshot/);
});

test("allows same review threads with changed snapshot key", async () => {
	const { scheduler, statePath, managerDir } = await createScheduler();
	const job = await scheduler.createJob(baseJobInput());
	await scheduler.acquireLease(job.id);
	const first = await scheduler.recordRun(job.id, { headSha: "abc", reviewThreadIds: ["rt-1"], snapshotKey: "revision-1" });
	await scheduler.completeRun(first.id, "completed");
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.schedules[job.id].nextRunAt = "2000-01-01T00:00:00.000Z";
	});
	await scheduler.acquireLease(job.id);
	const second = await scheduler.recordRun(job.id, { headSha: "abc", reviewThreadIds: ["rt-1"], snapshotKey: "revision-2" });
	assert.notEqual(second.idempotencyKey, first.idempotencyKey);
});

test("deduplicates review loop snapshots across jobs for same fixer", async () => {
	const { scheduler } = await createScheduler();
	const firstJob = await scheduler.createJob(baseJobInput());
	const secondJob = await scheduler.createJob(baseJobInput());
	await scheduler.acquireLease(firstJob.id);
	const firstRun = await scheduler.recordRun(firstJob.id, { headSha: "abc", reviewThreadIds: ["rt-1"], dispatchedThreadId: "thread-1", snapshotKey: "revision" });
	await scheduler.completeRun(firstRun.id, "completed");
	await scheduler.acquireLease(secondJob.id);
	await assert.rejects(() => scheduler.recordRun(secondJob.id, { headSha: "abc", reviewThreadIds: ["rt-1"], dispatchedThreadId: "thread-1", snapshotKey: "revision" }), /Duplicate running job snapshot/);
});

test("pre-run failures count toward max iterations", async () => {
	const { scheduler, statePath, managerDir } = await createScheduler();
	const job = await scheduler.createJob({ ...baseJobInput(), maxIterations: 1 });
	const lease = await scheduler.acquireLease(job.id);
	assert.ok(lease?.lease);
	await scheduler.releaseLeaseWithError(job.id, "gh auth failed", lease.lease, 30);
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.schedules[job.id].iterationCount, 1);
	assert.equal(store.schedules[job.id].status, "failed");
});

test("pre-run failure release is fenced by lease nonce", async () => {
	const { scheduler, statePath, managerDir } = await createScheduler();
	const job = await scheduler.createJob(baseJobInput());
	const staleLease = await scheduler.acquireLease(job.id);
	assert.ok(staleLease?.lease);
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.schedules[job.id].lease = { daemonEpoch: "daemon", nonce: "new-nonce", expiresAt: "2099-01-01T00:00:00.000Z", renewedAt: "2026-01-01T00:00:00.000Z" };
	});
	await scheduler.releaseLeaseWithError(job.id, "slow failure", staleLease.lease, 30);
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.schedules[job.id].lease?.nonce, "new-nonce");
	assert.equal(store.schedules[job.id].iterationCount, 0);
	assert.equal(store.schedules[job.id].lastError, undefined);
});

test("failed final run marks exhausted job failed", async () => {
	const { scheduler, statePath, managerDir } = await createScheduler();
	const job = await scheduler.createJob({ ...baseJobInput(), maxIterations: 1 });
	await scheduler.acquireLease(job.id);
	const run = await scheduler.recordRun(job.id, { headSha: "abc", reviewThreadIds: ["rt-1"] });
	await scheduler.completeRun(run.id, "failed", "dispatch failed");
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.schedules[job.id].status, "failed");
	assert.equal(store.jobRuns[run.id].status, "failed");
});

test("fences completion by lease nonce and reconciles stale running runs", async () => {
	const { scheduler, statePath, managerDir } = await createScheduler();
	const job = await scheduler.createJob(baseJobInput());
	await scheduler.acquireLease(job.id);
	const run = await scheduler.recordRun(job.id, { headSha: "abc", reviewThreadIds: ["rt-1"] });
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.schedules[job.id].lease = { daemonEpoch: "other", nonce: "changed", expiresAt: "2099-01-01T00:00:00.000Z", renewedAt: "2026-01-01T00:00:00.000Z" };
	});
	await assert.rejects(() => scheduler.completeRun(run.id, "completed"), /Lease changed/);
	await scheduler.reconcileAfterRestart();
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.jobRuns[run.id].status, "failed");
	assert.equal(store.schedules[job.id].lease, undefined);
});

test("creates approval-bound delivery and invalidates changed scope", async () => {
	const { scheduler, statePath, managerDir } = await createScheduler();
	const job = await scheduler.createJob(baseJobInput());
	await scheduler.acquireLease(job.id);
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.operations["op-1"] = createOperation("op-1", "thread-1");
	});
	const scope = { repo: "owner/repo", prNumber: 1, headSha: "abc", branch: "feature", actionType: "push" as const, threadIds: ["thread-1"], diffSummary: "one file" };
	const { approval, delivery } = await scheduler.requireApprovalForDelivery({
		operationId: "op-1",
		repo: "owner/repo",
		branch: "feature",
		expectedHeadSha: "abc",
		diffSummary: "one file",
		cleanWorktreeRequired: true,
		scope,
		expiresAt: "2099-01-01T00:00:00.000Z",
	});
	assert.equal(delivery.status, "approval_required");
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.approvals[approval.id].status = "approved";
	});
	const store = await readThreadStore(statePath, managerDir);
	validateDeliveryApproval(scope, store.approvals[approval.id]);
	assert.throws(() => validateDeliveryApproval({ ...scope, headSha: "def" }, store.approvals[approval.id]), /headSha/);
});

test("restart policy refuses unknown outcomes unless explicitly allowed", () => {
	assert.equal(shouldResumeAfterRestart(normalizeRestartPolicy({ mode: "never" }), true), false);
	assert.equal(shouldResumeAfterRestart(normalizeRestartPolicy({ mode: "manual" }), true), false);
	assert.equal(shouldResumeAfterRestart(normalizeRestartPolicy({ mode: "from_session" }), true), true);
	assert.equal(shouldResumeAfterRestart(normalizeRestartPolicy({ mode: "from_session" }), false), false);
});

async function createScheduler() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-scheduler-"));
	const managerDir = getThreadManagerDir(root);
	const statePath = getThreadStorePath(root);
	let next = 1;
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.threads["thread-1"] = createThread("thread-1", managerDir);
	});
	const scheduler = new ThreadScheduler({ statePath, managerDir, daemonEpoch: "daemon", randomId: () => `${next++}` });
	return { scheduler, statePath, managerDir };
}

function baseJobInput() {
	return {
		type: "review_loop" as const,
		threadIds: ["thread-1"],
		intervalSeconds: 30,
		maxIterations: 3,
		restartPolicy: normalizeRestartPolicy(),
		target: { repo: "owner/repo", prNumber: 1 },
	};
}

function createThread(id: string, managerDir: string): ManagedThread {
	const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
	return {
		id,
		status: "idle",
		cwd: managerDir,
		tags: [],
		createdAt: now,
		updatedAt: now,
		createdBy: "test",
		launchProfile: normalizeLaunchProfile({ cwd: managerDir }),
		safetyPolicy: normalizeSafetyPolicy(),
		worktree: { mode: "legacy_shared_cwd", sourceCwd: managerDir, cleanupState: "not_applicable" },
	};
}

function createOperation(id: string, threadId: string): ThreadOperation {
	const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
	return { id, kind: "commit_push_delivery", status: "running", threadId, idempotencyKey: id, createdAt: now, updatedAt: now };
}
