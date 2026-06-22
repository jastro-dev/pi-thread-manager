import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getThreadManagerDir, getThreadStorePath } from "../src/broker/paths.ts";
import { normalizeLaunchProfile, normalizeRestartPolicy, normalizeSafetyPolicy } from "../src/protocol.ts";
import { acquireFileLock } from "../src/store/lock.ts";
import { assertThreadStoreInvariants, createEmptyThreadStore, mutateThreadStore, readThreadStore, readThreadStoreSafe, writeThreadStore } from "../src/store/thread-store.ts";
import type { ManagedThread, ThreadOperation } from "../src/types.ts";

test("reads missing store as an empty versioned document", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-store-"));
	const store = await readThreadStore(getThreadStorePath(root), getThreadManagerDir(root));
	assert.equal(store.storeVersion, 2);
	assert.deepEqual(store.threads, {});
});

test("writes through temp rename and preserves trailing newline", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-store-"));
	const statePath = getThreadStorePath(root);
	const document = createEmptyThreadStore(new Date("2026-01-01T00:00:00.000Z"));
	await writeThreadStore(statePath, document);
	const raw = await fs.readFile(statePath, "utf8");
	assert.equal(raw.endsWith("\n"), true);
	assert.deepEqual(await readThreadStore(statePath, getThreadManagerDir(root)), document);
});

test("rejects malformed JSON without overwriting the store", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-store-"));
	const statePath = getThreadStorePath(root);
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	await fs.writeFile(statePath, "{bad", "utf8");
	await assert.rejects(() => readThreadStore(statePath, getThreadManagerDir(root)), /Invalid thread manager store JSON/);
	assert.equal(await fs.readFile(statePath, "utf8"), "{bad");
});

test("safe read pauses automation on corrupt primary store", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-store-"));
	const statePath = getThreadStorePath(root);
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	await fs.writeFile(statePath, "{bad", "utf8");
	const result = await readThreadStoreSafe(statePath, path.join(path.dirname(statePath), "missing-backup.json"), getThreadManagerDir(root));
	assert.match(result.document.pausedReason ?? "", /corrupt/);
	assert.equal(result.loadedBackup, false);
});

test("safe read treats future store versions as read-only without renaming primary", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-store-"));
	const statePath = getThreadStorePath(root);
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	const futureStore = JSON.stringify({ ...createEmptyThreadStore(), storeVersion: 999 });
	await fs.writeFile(statePath, futureStore, "utf8");
	const result = await readThreadStoreSafe(statePath, path.join(path.dirname(statePath), "backup.json"), getThreadManagerDir(root));
	assert.match(result.document.pausedReason ?? "", /read-only/);
	assert.equal(await fs.readFile(statePath, "utf8"), futureStore);
});

test("migrates v1 shared-cwd threads to v2 legacy worktree metadata", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-store-"));
	const managerDir = getThreadManagerDir(root);
	const statePath = getThreadStorePath(root);
	const v1 = createEmptyThreadStore(new Date("2026-01-01T00:00:00.000Z")) as unknown as Record<string, unknown>;
	v1.storeVersion = 1;
	(v1.threads as Record<string, ManagedThread>)["thread-1"] = createThread("thread-1", managerDir, "idle");
	delete (v1.threads as Record<string, ManagedThread>)["thread-1"].worktree;
	delete v1.jobRuns;
	delete v1.commitPushDeliveries;
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	await fs.writeFile(statePath, `${JSON.stringify(v1)}\n`, "utf8");
	const migrated = await readThreadStore(statePath, managerDir);
	assert.equal(migrated.storeVersion, 2);
	assert.deepEqual(migrated.jobRuns, {});
	assert.deepEqual(migrated.commitPushDeliveries, {});
	assert.deepEqual(migrated.threads["thread-1"].worktree, { mode: "legacy_shared_cwd", sourceCwd: managerDir, cleanupState: "not_applicable" });
	assert.deepEqual(migrated.migrationHistory, ["v1_to_v2_thread_worktree_metadata"]);
});

test("removes stale lock only when owning pid is dead", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-store-"));
	const lockPath = path.join(root, "state.lock");
	await fs.writeFile(lockPath, JSON.stringify({ pid: 999_999, hostname: "host", nonce: "old", createdAt: "2026-01-01T00:00:00.000Z" }));
	const release = await acquireFileLock(lockPath, { pidExists: () => false, maxWaitMs: 20 });
	await release();
	await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, hostname: "host", nonce: "live", createdAt: "2026-01-01T00:00:00.000Z" }));
	await assert.rejects(
		() => acquireFileLock(lockPath, { pidExists: () => true, maxWaitMs: 20, retryIntervalMs: 1 }),
		/Timed out/,
	);
});

test("mutates under lock and persists failed partial records", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-store-"));
	const managerDir = getThreadManagerDir(root);
	const statePath = getThreadStorePath(root);
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.threads["thread-1"] = createThread("thread-1", managerDir, "failed");
		document.operations["op-1"] = createOperation("op-1", "thread-1");
		document.threads["thread-1"].currentOperationId = "op-1";
	});
	const document = await readThreadStore(statePath, managerDir);
	assert.equal(document.threads["thread-1"].status, "failed");
	assert.equal(document.operations["op-1"].status, "failed");
});

test("rejects dangling refs, impossible ids, and path traversal artifact refs", () => {
	const root = path.join(os.tmpdir(), "thread-store-root");
	const document = createEmptyThreadStore();
	document.threads["thread-1"] = createThread("wrong-id", root, "idle");
	assert.throws(() => assertThreadStoreInvariants(document, root), /Thread id mismatch/);
	document.threads["thread-1"] = createThread("thread-1", root, "idle");
	document.schedules["schedule-1"] = {
		id: "schedule-1",
		type: "review_loop",
		status: "scheduled",
		threadIds: ["missing"],
		intervalSeconds: 30,
		maxIterations: 3,
		iterationCount: 0,
		restartPolicy: normalizeRestartPolicy(),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	assert.throws(() => assertThreadStoreInvariants(document, root), /missing thread/);
	document.schedules = {};
	document.threads["thread-1"].logFile = path.resolve(root, "..", "outside.log");
	assert.throws(() => assertThreadStoreInvariants(document, root), /outside manager/);
});

test("rejects persisted enum values outside supported unions", () => {
	const root = path.join(os.tmpdir(), "thread-store-root");
	const document = createEmptyThreadStore();
	document.threads["thread-1"] = createThread("thread-1", root, "idle");
	document.operations["op-1"] = createOperation("op-1", "thread-1");
	(document.threads["thread-1"] as { status: string }).status = "teleporting";
	assert.throws(() => assertThreadStoreInvariants(document, root), /Thread thread-1 status is invalid/);
	document.threads["thread-1"].status = "idle";
	(document.operations["op-1"] as { status: string }).status = "half_done";
	assert.throws(() => assertThreadStoreInvariants(document, root), /Operation op-1 status is invalid/);
	(document.operations["op-1"] as { status: string }).status = "failed";
	(document.operations["op-1"] as { kind: string }).kind = "mystery";
	assert.throws(() => assertThreadStoreInvariants(document, root), /Operation op-1 kind is invalid/);
});

test("rejects invalid isolated worktree invariants", () => {
	const root = path.join(os.tmpdir(), "thread-store-root");
	const document = createEmptyThreadStore();
	document.threads["thread-1"] = createThread("thread-1", root, "idle");
	document.threads["thread-1"].cwd = path.join(root, "worktree", "src");
	document.threads["thread-1"].launchProfile.cwd = document.threads["thread-1"].cwd;
	document.threads["thread-1"].worktree = {
		mode: "isolated",
		sourceCwd: root,
		sourceRepoRoot: root,
		sourceSubdir: "",
		primaryRepoRoot: root,
		worktreeRoot: path.join(root, "worktree"),
		executionCwd: path.join(root, "elsewhere"),
		branchName: "thread-manager/thread-1-test",
		baseRef: "HEAD",
		baseSha: "abc123",
		allocationState: "allocated",
		cleanupState: "retained",
	};
	assert.throws(() => assertThreadStoreInvariants(document, root), /isolated execution cwd must match thread cwd/);
	document.threads["thread-1"].worktree.executionCwd = document.threads["thread-1"].cwd;
	assertThreadStoreInvariants(document, root);
});

function createThread(id: string, managerDir: string, status: ManagedThread["status"]): ManagedThread {
	const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
	return {
		id,
		status,
		cwd: managerDir,
		tags: [],
		createdAt: now,
		updatedAt: now,
		createdBy: "test",
		launchProfile: normalizeLaunchProfile({ cwd: managerDir }),
		safetyPolicy: normalizeSafetyPolicy(),
		worktree: { mode: "legacy_shared_cwd", sourceCwd: managerDir, cleanupState: "not_applicable" },
		logFile: path.join(managerDir, "threads", id, "thread.log"),
		sessionFile: path.join(managerDir, "threads", id, "sessions", "session.jsonl"),
	};
}

function createOperation(id: string, threadId: string): ThreadOperation {
	const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
	return {
		id,
		kind: "create_thread",
		status: "failed",
		threadId,
		idempotencyKey: id,
		createdAt: now,
		updatedAt: now,
		error: "spawn failed",
	};
}
