import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadOrCreateAuthRoot } from "../src/broker/auth.ts";
import { getThreadManagerDir, getThreadStorePath } from "../src/broker/paths.ts";
import { mutateThreadStore, readThreadStore } from "../src/store/thread-store.ts";
import { isPassiveChildUiRequest, ThreadService, type WorktreeManagerPort } from "../src/pi/lifecycle.ts";
import type { ChildRpcPort } from "../src/pi/rpc-client.ts";
import type { ReviewSnapshot } from "../src/automation/review-loop.ts";
import type { ManagedThread, SafetyPolicy, ThreadWorktree } from "../src/types.ts";

test("reserves thread before spawn and marks failed spawn without losing record", async () => {
	const { service, statePath, managerDir } = await createService({ launchThread: () => { throw new Error("spawn failed"); } });
	await assert.rejects(() => service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() }), /spawn failed/);
	const store = await readThreadStore(statePath, managerDir);
	const thread = Object.values(store.threads)[0];
	assert.equal(thread.status, "failed");
	assert.match(thread.lastError ?? "", /spawn failed/);
});

test("creates idle thread with explicit launch profile and pid", async () => {
	const { service, statePath, managerDir, rpc } = await createService();
	const thread = await service.createThread({ cwd: managerDir, model: "openai/test", name: "worker", createdBy: "test", safetyPolicy: sharedSafetyPolicy(), launchProfile: { inheritedFromParent: false } });
	assert.equal(thread.status, "idle");
	assert.equal(thread.pid, 1234);
	assert.equal(thread.launchProfile.inheritedFromParent, false);
	assert.equal(thread.model, "openai/test");
	assert.deepEqual(rpc.calls, []);
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.operations[Object.keys(store.operations)[0]].status, "completed");
});

test("create stores generated Pi session jsonl path", async () => {
	const { service, statePath, managerDir } = await createService({
		launchThread: async (thread) => {
			await fs.writeFile(path.join(path.dirname(thread.sessionFile!), "generated-session.jsonl"), `${JSON.stringify({ role: "assistant", content: "generated" })}\n`, "utf8");
			return { pid: 1234, startedAt: "2026-01-01T00:00:00.000Z", rpc: new FakeRpc() };
		},
	});
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	assert.equal(path.basename(thread.sessionFile!), "generated-session.jsonl");
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(path.basename(store.threads[thread.id].sessionFile!), "generated-session.jsonl");
});

test("create rejects read-only requested worktree safety", async () => {
	const { service, managerDir } = await createService();
	await assert.rejects(() => service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: { worktreeMode: "read_only" } }), /read-only thread worktree mode is not implemented/);
});

test("passive child UI requests are safe to acknowledge headlessly", () => {
	assert.equal(isPassiveChildUiRequest({ type: "extension_ui_request", id: "ui-1", method: "notify" }), true);
	assert.equal(isPassiveChildUiRequest({ type: "extension_ui_request", id: "ui-2", method: "setWidget" }), true);
	assert.equal(isPassiveChildUiRequest({ type: "extension_ui_request", id: "ui-3", kind: "approval" }), false);
});

test("isolated create is default and launches from allocated worktree cwd", async () => {
	const sourceCwd = await fs.mkdtemp(path.join(os.tmpdir(), "thread-source-"));
	const executionCwd = path.join(sourceCwd, "..", "source-thread-1-worker");
	const worktreeManager = createFakeWorktreeManager({ sourceCwd, executionCwd });
	let launchedCwd = "";
	const { service, statePath, managerDir } = await createService({
		worktreeManager,
		launchThread: (thread) => {
			launchedCwd = thread.cwd;
			return { pid: 1234, startedAt: "2026-01-01T00:00:00.000Z", rpc: new FakeRpc() };
		},
	});
	const thread = await service.createThread({ cwd: sourceCwd, name: "worker", createdBy: "test" });
	assert.equal(thread.worktree?.mode, "isolated");
	assert.equal(thread.cwd, executionCwd);
	assert.equal(thread.launchProfile.cwd, executionCwd);
	assert.equal(launchedCwd, executionCwd);
	assert.equal((thread.worktree as Extract<ThreadWorktree, { mode: "isolated" }>).allocationState, "allocated");
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.operations[Object.keys(store.operations)[0]].status, "completed");
});

test("explicit shared-cwd create records legacy worktree metadata", async () => {
	const { service, managerDir } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	assert.deepEqual(thread.worktree, { mode: "legacy_shared_cwd", sourceCwd: managerDir, cleanupState: "not_applicable" });
});

test("create request id deduplicates retried thread creation", async () => {
	const { service, managerDir, rpc, statePath } = await createService();
	const first = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() }, "create-1");
	const second = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() }, "create-1");
	assert.equal(second.id, first.id);
	assert.equal(rpc.calls.length, 0);
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(Object.keys(store.threads).length, 1);
	assert.equal(Object.values(store.operations).filter((operation) => operation.kind === "create_thread").length, 1);
});

test("failed create request id can be retried", async () => {
	let attempts = 0;
	const { service, managerDir, statePath } = await createService({
		launchThread: () => {
			attempts += 1;
			if (attempts === 1) throw new Error("spawn failed once");
			return { pid: 1234, startedAt: "2026-01-01T00:00:00.000Z", rpc: new FakeRpc() };
		},
	});
	await assert.rejects(() => service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() }, "create-retry"), /spawn failed once/);
	const retry = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() }, "create-retry");
	const duplicate = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() }, "create-retry");
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(attempts, 2);
	assert.equal(retry.status, "idle");
	assert.equal(duplicate.id, retry.id);
	assert.deepEqual(Object.values(store.operations).filter((operation) => operation.kind === "create_thread").map((operation) => operation.status), ["failed", "completed"]);
});

test("homeDir defaults state paths into injected thread-manager home", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-home-"));
	const service = new ThreadService({ homeDir: root, randomId: () => "home" });
	const status = await service.status();
	assert.equal(status.storePath, getThreadStorePath(root));
	assert.equal((await service.listThreads()).length, 0);
});

test("list filters threads by token cwd scope", async () => {
	const { service, statePath, managerDir, root } = await createService();
	const allowedRoot = path.join(root, "allowed");
	const disallowedRoot = path.join(root, "disallowed");
	await fs.mkdir(allowedRoot, { recursive: true });
	await fs.mkdir(disallowedRoot, { recursive: true });
	const allowed = await service.createThread({ cwd: allowedRoot, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await service.createThread({ cwd: disallowedRoot, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	const auth = loadOrCreateAuthRoot(root);
	auth.tokens.push({ id: "cwd-list", secret: "list-secret", clientId: "client", actions: ["list"], cwdRoots: [allowedRoot] });
	await fs.writeFile(path.join(managerDir, "auth-root.json"), `${JSON.stringify(auth)}\n`, "utf8");
	const threads = await service.listThreads({ clientId: "client", token: "list-secret" });
	assert.deepEqual(threads.map((thread) => thread.id), [allowed.id]);
	assert.equal((await readThreadStore(statePath, managerDir)).threads[allowed.id].cwd, allowedRoot);
});

test("send/steer legality and RPC acknowledgement", async () => {
	const { service, managerDir, rpc } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	const send = await service.sendToThread(thread.id, "send", "build this");
	assert.equal(send.status, "acknowledged");
	assert.deepEqual(rpc.calls[0], { type: "prompt", message: "build this" });
	await assert.rejects(() => service.sendToThread(thread.id, "send", "again"), /requires idle/);
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	await service.listThreads();
	const completed = await service.sendToThread(thread.id, "send", "again");
	assert.equal(completed.status, "acknowledged");
	const steer = await service.sendToThread(thread.id, "steer", "adjust");
	assert.equal(steer.status, "completed");
	assert.deepEqual(rpc.calls.at(-1), { type: "steer", message: "adjust" });
});

test("refresh preserves stopping status", async () => {
	const { service, managerDir, rpc, statePath } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.operations["op-stop"] = { id: "op-stop", kind: "stop", status: "completed", threadId: thread.id, idempotencyKey: "stop", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
		document.threads[thread.id].status = "stopping";
		document.threads[thread.id].currentOperationId = "op-stop";
	});
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	await service.listThreads();
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.threads[thread.id].status, "stopping");
});

test("abort returns thread to idle after child stops streaming", async () => {
	const { service, managerDir, rpc } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await service.sendToThread(thread.id, "send", "work");
	await service.abortThread(thread.id);
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	await service.listThreads();
	const send = await service.sendToThread(thread.id, "send", "more work");
	assert.equal(send.status, "acknowledged");
});

test("follow-up rejects when queued work reaches limit", async () => {
	const { service, managerDir, statePath } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy({ queuePolicy: "allow_follow_up" }) });
	await service.sendToThread(thread.id, "send", "start");
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		for (let index = 0; index < 20; index += 1) {
			document.operations[`op-follow-${index}`] = { id: `op-follow-${index}`, kind: "follow_up", status: "acknowledged", threadId: thread.id, idempotencyKey: `follow-${index}`, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
		}
	});
	await assert.rejects(() => service.sendToThread(thread.id, "follow_up", "too much"), /follow_up queue limit/);
});

test("stop cancels queued follow-ups", async () => {
	const { service, managerDir, statePath } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy({ queuePolicy: "allow_follow_up" }) });
	await service.sendToThread(thread.id, "send", "start");
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.operations["op-follow"] = { id: "op-follow", kind: "follow_up", status: "acknowledged", threadId: thread.id, idempotencyKey: "follow", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
	});
	await service.stopThread(thread.id);
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.operations["op-follow"].status, "cancelled");
});

test("accepted follow-ups count against queue limit until child drains", async () => {
	const { service, managerDir, statePath, rpc } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy({ queuePolicy: "allow_follow_up" }) });
	await service.sendToThread(thread.id, "send", "start");
	for (let index = 0; index < 20; index += 1) {
		const followUp = await service.sendToThread(thread.id, "follow_up", `follow ${index}`);
		assert.equal(followUp.status, "acknowledged");
	}
	await assert.rejects(() => service.sendToThread(thread.id, "follow_up", "too much"), /follow_up queue limit/);
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	await service.listThreads();
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(Object.values(store.operations).filter((operation) => operation.kind === "follow_up" && operation.status === "completed").length, 20);
});

test("failed send is not overwritten by later idle refresh", async () => {
	const { service, managerDir, rpc, statePath } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	rpc.failNext = new Error("delivery failed");
	await assert.rejects(() => service.sendToThread(thread.id, "send", "fail"), /delivery failed/);
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	await service.listThreads();
	const store = await readThreadStore(statePath, managerDir);
	const failed = Object.values(store.operations).find((operation) => operation.message === "fail");
	assert.equal(failed?.status, "failed");
});

test("command rejection preserves live thread state", async () => {
	const { service, managerDir, rpc, statePath } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	rpc.failNext = new Error("child rejected prompt");
	await assert.rejects(() => service.sendToThread(thread.id, "send", "reject"), /child rejected prompt/);
	const store = await readThreadStore(statePath, managerDir);
	const failed = Object.values(store.operations).find((operation) => operation.message === "reject");
	assert.equal(failed?.status, "failed");
	assert.equal(store.threads[thread.id].status, "idle");
	assert.equal(store.threads[thread.id].currentOperationId, undefined);
});

test("failed duplicate send request does not count as delivered", async () => {
	const { service, managerDir, statePath } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.operations["op-failed-duplicate"] = { id: "op-failed-duplicate", kind: "send", status: "failed", threadId: thread.id, requestId: "send-duplicate", idempotencyKey: "send-duplicate", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
	});
	await assert.rejects(() => service.sendToThread(thread.id, "send", "retry", "send-duplicate"), /not delivered/);
});

test("approval list expires stale pending approvals", async () => {
	const { service, statePath, managerDir } = await createService();
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.operations["op-approval"] = { id: "op-approval", kind: "approval", status: "approval_required", idempotencyKey: "approval", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", approvalId: "approval-1" };
		document.approvals["approval-1"] = { id: "approval-1", status: "pending", scope: { actionType: "push", threadIds: [] }, operationId: "op-approval", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:00:00.000Z" };
	});
	const result = await service.listApprovals();
	assert.deepEqual(result, { kind: "approvals", approvals: [] });
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.approvals["approval-1"].status, "expired");
});

test("direct approval persists expired state before rejecting", async () => {
	const { service, statePath, managerDir } = await createService();
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.operations["op-approval"] = { id: "op-approval", kind: "approval", status: "approval_required", idempotencyKey: "approval", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", approvalId: "approval-1" };
		document.approvals["approval-1"] = { id: "approval-1", status: "pending", scope: { actionType: "push", threadIds: [] }, operationId: "op-approval", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:00:00.000Z" };
	});
	await assert.rejects(() => service.handle("approve", { approvalId: "approval-1" }, { clientId: "test" }), /has expired/);
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.approvals["approval-1"].status, "expired");
	assert.equal(store.operations["op-approval"].status, "cancelled");
});

test("approval listing only returns approvals authorized by token scope", async () => {
	const { service, statePath, managerDir, root } = await createService();
	const auth = loadOrCreateAuthRoot(root);
	auth.tokens.push({ id: "thread-1-approvals", secret: "approval-secret", clientId: "client", actions: ["approvals"], threadIds: ["thread-1"] });
	await fs.writeFile(path.join(managerDir, "auth-root.json"), `${JSON.stringify(auth)}\n`, "utf8");
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.operations["op-1"] = { id: "op-1", kind: "approval", status: "approval_required", idempotencyKey: "approval-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", approvalId: "approval-1" };
		document.operations["op-2"] = { id: "op-2", kind: "approval", status: "approval_required", idempotencyKey: "approval-2", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", approvalId: "approval-2" };
		document.operations["op-global"] = { id: "op-global", kind: "approval", status: "approval_required", idempotencyKey: "approval-global", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", approvalId: "approval-global" };
		document.approvals["approval-1"] = { id: "approval-1", status: "pending", scope: { actionType: "push", threadIds: ["thread-1"] }, operationId: "op-1", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" };
		document.approvals["approval-2"] = { id: "approval-2", status: "pending", scope: { actionType: "push", threadIds: ["thread-2"] }, operationId: "op-2", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" };
		document.approvals["approval-global"] = { id: "approval-global", status: "pending", scope: { actionType: "push", threadIds: [] }, operationId: "op-global", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" };
	});
	const result = await service.listApprovals({ clientId: "client", token: "approval-secret" });
	assert.deepEqual((result.approvals as { id: string }[]).map((approval) => approval.id), ["approval-1"]);
});

test("empty-scope approvals require global approval authority", async () => {
	const { service, statePath, managerDir, root } = await createService();
	const auth = loadOrCreateAuthRoot(root);
	auth.tokens.push({ id: "thread-1-approve", secret: "approve-secret", clientId: "client", actions: ["approve"], threadIds: ["thread-1"] });
	await fs.writeFile(path.join(managerDir, "auth-root.json"), `${JSON.stringify(auth)}\n`, "utf8");
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.operations["op-global"] = { id: "op-global", kind: "approval", status: "approval_required", idempotencyKey: "approval-global", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", approvalId: "approval-global" };
		document.approvals["approval-global"] = { id: "approval-global", status: "pending", scope: { actionType: "push", threadIds: [] }, operationId: "op-global", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" };
	});
	await assert.rejects(() => service.handle("approve", { approvalId: "approval-global" }, { clientId: "client", token: "approve-secret" }), /not scoped/);
	const approved = await service.handle("approve", { approvalId: "approval-global" }, { clientId: "owner", token: auth.rootToken });
	assert.equal((approved as { status: string }).status, "approved");
});

test("read uses cursor/limit and does not expose arbitrary paths", async () => {
	const { service, managerDir, rpc } = await createService();
	rpc.messages = ["a", "b", "c"];
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	const result = await service.readThread(thread.id, 1, 1);
	assert.deepEqual(result, { threadId: thread.id, cursor: 1, nextCursor: 2, items: ["b"], truncated: true });
	await assert.rejects(() => service.readThread(thread.id, -1, 1), /non-negative/);
	await assert.rejects(() => service.readThread("thread-missing", 0, 1), /Thread not found/);
});

test("read falls back to persisted session file without live RPC handle", async () => {
	const { service, statePath, managerDir } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await fs.writeFile(thread.sessionFile!, `${JSON.stringify({ role: "assistant", content: "saved" })}\n`, "utf8");
	const restarted = new ThreadService({ statePath, managerDir, randomId: () => "restart" });
	const result = await restarted.readThread(thread.id, 0, 10);
	assert.deepEqual(result.items, [{ role: "assistant", content: "saved" }]);
});

test("persisted session read only returns requested cursor window", async () => {
	const { service, statePath, managerDir } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await fs.writeFile(thread.sessionFile!, ["a", "b", "c"].map((content) => JSON.stringify({ content })).join("\n") + "\n", "utf8");
	const restarted = new ThreadService({ statePath, managerDir, randomId: () => "restart" });
	const result = await restarted.readThread(thread.id, 1, 1);
	assert.deepEqual(result, { threadId: thread.id, cursor: 1, nextCursor: 2, items: [{ content: "b" }], truncated: true });
});

test("read falls back to persisted session file after live RPC crash", async () => {
	const { service, statePath, managerDir, rpc } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await fs.writeFile(thread.sessionFile!, `${JSON.stringify({ role: "assistant", content: "saved after crash" })}\n`, "utf8");
	rpc.failState = new Error("rpc broken");
	const result = await service.readThread(thread.id, 0, 10);
	assert.deepEqual(result.items, [{ role: "assistant", content: "saved after crash" }]);
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.threads[thread.id].status, "crashed");
});

test("read marks thread crashed when get_messages fails", async () => {
	const { service, statePath, managerDir, rpc } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await fs.writeFile(thread.sessionFile!, `${JSON.stringify({ role: "assistant", content: "saved after read failure" })}\n`, "utf8");
	rpc.failMessages = new Error("messages broken");
	const result = await service.readThread(thread.id, 0, 10);
	assert.deepEqual(result.items, [{ role: "assistant", content: "saved after read failure" }]);
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.threads[thread.id].status, "crashed");
	assert.match(store.threads[thread.id].lastError ?? "", /messages broken/);
});

test("idle refresh clears terminal current operation", async () => {
	const { service, statePath, managerDir, rpc } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.operations["op-terminal"] = { id: "op-terminal", kind: "abort", status: "completed", threadId: thread.id, idempotencyKey: "op-terminal", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
		document.threads[thread.id].currentOperationId = "op-terminal";
	});
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	await service.listThreads();
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.threads[thread.id].currentOperationId, undefined);
});

test("idle refresh does not complete undispatched current operation", async () => {
	const { service, statePath, managerDir, rpc } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.operations["op-undispatched"] = { id: "op-undispatched", kind: "send", status: "intent_recorded", threadId: thread.id, idempotencyKey: "send", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
		document.threads[thread.id].status = "running";
		document.threads[thread.id].currentOperationId = "op-undispatched";
	});
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	await service.listThreads();
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.operations["op-undispatched"].status, "intent_recorded");
	assert.equal(store.threads[thread.id].status, "running");
	assert.equal(store.threads[thread.id].currentOperationId, "op-undispatched");
});

test("reconcile refuses PID-only adoption after daemon restart", async () => {
	const { service, statePath, managerDir } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	const restarted = new ThreadService({ statePath, managerDir, randomId: () => "restart" });
	await restarted.reconcileAfterRestart();
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.threads[thread.id].status, "orphan_needs_manual_action");
	assert.match(store.threads[thread.id].lastError ?? "", /reconnectable/);
});

test("reconcile fails creating threads left before launch", async () => {
	const { statePath, managerDir } = await createService();
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.operations["op-create"] = { id: "op-create", kind: "create_thread", status: "intent_recorded", threadId: "thread-creating", idempotencyKey: "create", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
		document.threads["thread-creating"] = {
			id: "thread-creating",
			status: "creating",
			cwd: managerDir,
			tags: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			createdBy: "test",
			currentOperationId: "op-create",
			launchProfile: { cwd: managerDir, extensionLoading: "inherit", approvalMode: "ask", inheritedFromParent: true },
			safetyPolicy: { worktreeMode: "shared_cwd_allowed", queuePolicy: "reject_when_running", githubWritePolicy: "ask", forceKillPolicy: "deny", restartPolicy: { mode: "manual", maxRestarts: 0, backoffSeconds: 30, allowWhenOperationUnknown: false } },
			worktree: { mode: "legacy_shared_cwd", sourceCwd: managerDir, cleanupState: "not_applicable" },
		};
	});
	const restarted = new ThreadService({ statePath, managerDir, randomId: () => "restart" });
	await restarted.reconcileAfterRestart();
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.threads["thread-creating"].status, "failed");
	assert.equal(store.threads["thread-creating"].currentOperationId, undefined);
	assert.equal(store.operations["op-create"].status, "failed");
	assert.match(store.operations["op-create"].error ?? "", /before thread launch completed/);
});

test("reconcile marks allocated creating isolated threads cleanup pending", async () => {
	const sourceCwd = await fs.mkdtemp(path.join(os.tmpdir(), "thread-source-"));
	const executionCwd = path.join(sourceCwd, "..", "source-thread-creating");
	const worktreeManager = createFakeWorktreeManager({ sourceCwd, executionCwd });
	const { service, statePath, managerDir } = await createService({ worktreeManager });
	const thread = await service.createThread({ cwd: sourceCwd, createdBy: "test" });
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.operations["op-restart-create"] = { id: "op-restart-create", kind: "create_thread", status: "intent_recorded", threadId: thread.id, idempotencyKey: "restart-create", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
		document.threads[thread.id].status = "creating";
		document.threads[thread.id].currentOperationId = "op-restart-create";
	});
	const restarted = new ThreadService({ statePath, managerDir, randomId: () => "restart", worktreeManager });
	await restarted.reconcileAfterRestart();
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.threads[thread.id].status, "failed");
	assert.equal((store.threads[thread.id].worktree as Extract<ThreadWorktree, { mode: "isolated" }>).cleanupState, "cleanup_pending");
});

test("reconcile marks missing reserved isolated threads failed without cleanup", async () => {
	const sourceCwd = await fs.mkdtemp(path.join(os.tmpdir(), "thread-source-"));
	const executionCwd = path.join(sourceCwd, "..", "source-thread-reserved");
	const worktreeManager = createFakeWorktreeManager({ sourceCwd, executionCwd, inspectOk: false });
	const { statePath, managerDir } = await createService({ worktreeManager });
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.operations["op-create"] = { id: "op-create", kind: "create_thread", status: "intent_recorded", threadId: "thread-reserved", idempotencyKey: "create", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
		document.threads["thread-reserved"] = {
			id: "thread-reserved",
			status: "creating",
			cwd: executionCwd,
			tags: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			createdBy: "test",
			currentOperationId: "op-create",
			launchProfile: { cwd: executionCwd, extensionLoading: "inherit", approvalMode: "ask", inheritedFromParent: true },
			safetyPolicy: { worktreeMode: "isolated_required", queuePolicy: "reject_when_running", githubWritePolicy: "ask", forceKillPolicy: "deny", restartPolicy: { mode: "manual", maxRestarts: 0, backoffSeconds: 30, allowWhenOperationUnknown: false } },
			worktree: {
				mode: "isolated",
				sourceCwd,
				sourceRepoRoot: sourceCwd,
				sourceSubdir: "",
				primaryRepoRoot: sourceCwd,
				worktreeRoot: executionCwd,
				executionCwd,
				branchName: "thread-manager/thread-reserved-test",
				baseRef: "HEAD",
				baseSha: "abc123",
				allocationState: "reserved",
				cleanupState: "cleanup_pending",
			},
		};
	});
	const restarted = new ThreadService({ statePath, managerDir, randomId: () => "restart", worktreeManager });
	await restarted.reconcileAfterRestart();
	const store = await readThreadStore(statePath, managerDir);
	const worktree = store.threads["thread-reserved"].worktree as Extract<ThreadWorktree, { mode: "isolated" }>;
	assert.equal(store.threads["thread-reserved"].status, "failed");
	assert.equal(worktree.allocationState, "allocation_failed");
	assert.equal(worktree.cleanupState, "removed");
});

test("reconcile marks missing isolated worktrees manual action", async () => {
	const sourceCwd = await fs.mkdtemp(path.join(os.tmpdir(), "thread-source-"));
	const executionCwd = path.join(sourceCwd, "..", "source-thread-missing");
	const createManager = createFakeWorktreeManager({ sourceCwd, executionCwd });
	const { service, statePath, managerDir } = await createService({ worktreeManager: createManager });
	const thread = await service.createThread({ cwd: sourceCwd, createdBy: "test" });
	const restarted = new ThreadService({ statePath, managerDir, randomId: () => "restart", worktreeManager: createFakeWorktreeManager({ sourceCwd, executionCwd, inspectOk: false }) });
	await restarted.reconcileAfterRestart();
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.threads[thread.id].status, "orphan_needs_manual_action");
	assert.match(store.threads[thread.id].lastError ?? "", /missing isolated worktree/);
});

test("reconcile resumes from_session threads", async () => {
	const { service, statePath, managerDir } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy({ restartPolicy: { mode: "from_session", maxRestarts: 1, backoffSeconds: 0, allowWhenOperationUnknown: false } }) });
	const resumedRpc = new FakeRpc();
	resumedRpc.state = { isStreaming: false, pendingMessageCount: 0 };
	const restarted = new ThreadService({ statePath, managerDir, randomId: () => "restart", launchThread: () => ({ pid: 4321, startedAt: "2026-01-01T00:01:00.000Z", rpc: resumedRpc }) });
	await restarted.reconcileAfterRestart();
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.threads[thread.id].status, "idle");
	assert.equal(store.threads[thread.id].pid, 4321);
	assert.equal(store.threads[thread.id].restartCount, 1);
});

test("successful resume clears restart backoff", async () => {
	const { service, statePath, managerDir } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy({ restartPolicy: { mode: "from_session", maxRestarts: 1, backoffSeconds: 30, allowWhenOperationUnknown: false } }) });
	const resumedRpc = new FakeRpc();
	resumedRpc.state = { isStreaming: false, pendingMessageCount: 0 };
	const restarted = new ThreadService({ statePath, managerDir, randomId: () => "restart", launchThread: () => ({ pid: 4321, startedAt: "2026-01-01T00:01:00.000Z", rpc: resumedRpc }) });
	await restarted.reconcileAfterRestart();
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.threads[thread.id].restartBackoffUntil, undefined);
});

test("automation retries crashed from_session thread after restart backoff expires", async () => {
	let current = new Date("2026-01-01T00:00:00.000Z");
	const { service, statePath, managerDir } = await createService({ now: () => current });
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy({ restartPolicy: { mode: "from_session", maxRestarts: 2, backoffSeconds: 60, allowWhenOperationUnknown: false } }) });
	const resumedRpc = new FakeRpc();
	resumedRpc.state = { isStreaming: false, pendingMessageCount: 0 };
	let launches = 0;
	const restarted = new ThreadService({
		statePath,
		managerDir,
		now: () => current,
		randomId: () => "restart",
		launchThread: () => {
			launches += 1;
			if (launches === 1) throw new Error("resume failed");
			return { pid: 4321, startedAt: current.toISOString(), rpc: resumedRpc };
		},
	});
	await restarted.reconcileAfterRestart();
	let store = await readThreadStore(statePath, managerDir);
	assert.equal(launches, 1);
	assert.equal(store.threads[thread.id].status, "crashed");
	assert.equal(store.threads[thread.id].restartBackoffUntil, "2026-01-01T00:01:00.000Z");
	current = new Date("2026-01-01T00:01:01.000Z");
	await restarted.runDueSchedulesOnce();
	store = await readThreadStore(statePath, managerDir);
	assert.equal(launches, 2);
	assert.equal(store.threads[thread.id].status, "idle");
	assert.equal(store.threads[thread.id].restartBackoffUntil, undefined);
	assert.equal(store.threads[thread.id].restartCount, 2);
});

test("reconcile honors from_session restart limits", async () => {
	const { service, statePath, managerDir } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy({ restartPolicy: { mode: "from_session", maxRestarts: 0, backoffSeconds: 0, allowWhenOperationUnknown: false } }) });
	let launched = false;
	const restarted = new ThreadService({ statePath, managerDir, randomId: () => "restart", launchThread: () => { launched = true; throw new Error("should not launch"); } });
	await restarted.reconcileAfterRestart();
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(launched, false);
	assert.equal(store.threads[thread.id].status, "orphan_needs_manual_action");
	assert.match(store.threads[thread.id].lastError ?? "", /maxRestarts/);
});

test("stop aborts first then marks thread stopped", async () => {
	const { service, managerDir, rpc } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await service.stopThread(thread.id);
	assert.deepEqual(rpc.calls[0], { type: "abort" });
	const [stopped] = await service.listThreads();
	assert.equal(stopped.status, "stopped");
	assert.equal(stopped.pid, undefined);
	assert.equal(stopped.pidStartedAt, undefined);
	assert.equal(stopped.currentOperationId, undefined);
});

test("stop marks orphaned thread stopped without live handle", async () => {
	const { service, statePath, managerDir } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.threads[thread.id].status = "orphan_needs_manual_action";
		document.threads[thread.id].lastError = "No live RPC handle";
	});
	const restarted = new ThreadService({ statePath, managerDir, randomId: () => "restart" });
	const stop = await restarted.stopThread(thread.id);
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(stop.status, "completed");
	assert.equal(store.threads[thread.id].status, "stopped");
	assert.equal(store.threads[thread.id].currentOperationId, undefined);
});

test("stop marks kill-failed thread stopped without live handle", async () => {
	const { service, statePath, managerDir } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.threads[thread.id].status = "kill_failed";
		document.threads[thread.id].lastError = "did not exit after SIGTERM";
	});
	const restarted = new ThreadService({ statePath, managerDir, randomId: () => "restart" });
	const stop = await restarted.stopThread(thread.id);
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(stop.status, "completed");
	assert.equal(store.threads[thread.id].status, "stopped");
	assert.equal(store.threads[thread.id].currentOperationId, undefined);
});

test("cleanup removes stopped isolated worktree", async () => {
	const sourceCwd = await fs.mkdtemp(path.join(os.tmpdir(), "thread-source-"));
	const executionCwd = path.join(sourceCwd, "..", "source-thread-clean");
	const { service, statePath, managerDir } = await createService({ worktreeManager: createFakeWorktreeManager({ sourceCwd, executionCwd }) });
	const thread = await service.createThread({ cwd: sourceCwd, createdBy: "test" });
	await service.stopThread(thread.id);
	const cleanup = await service.cleanupThread(thread.id);
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(cleanup.status, "completed");
	assert.equal(store.threads[thread.id].worktree?.mode, "isolated");
	assert.equal((store.threads[thread.id].worktree as Extract<ThreadWorktree, { mode: "isolated" }>).cleanupState, "removed");
});

test("concurrent cleanup calls do not downgrade removed isolated worktree state", async () => {
	const sourceCwd = await fs.mkdtemp(path.join(os.tmpdir(), "thread-source-"));
	const executionCwd = path.join(sourceCwd, "..", "source-thread-concurrent-clean");
	let cleanupCalls = 0;
	let finishFirst!: () => void;
	let firstStarted!: () => void;
	const firstStartedPromise = new Promise<void>((resolve) => {
		firstStarted = resolve;
	});
	const finishFirstPromise = new Promise<void>((resolve) => {
		finishFirst = resolve;
	});
	const worktreeManager: WorktreeManagerPort = {
		...createFakeWorktreeManager({ sourceCwd, executionCwd }),
		async cleanupWorktree() {
			cleanupCalls += 1;
			if (cleanupCalls === 1) {
				firstStarted();
				await finishFirstPromise;
				return { state: "removed", message: "removed", cleanedAt: "2026-01-01T00:00:00.000Z" };
			}
			return { state: "manual_action_required", message: "second cleanup should not run" };
		},
	};
	const { service, statePath, managerDir } = await createService({ worktreeManager });
	const thread = await service.createThread({ cwd: sourceCwd, createdBy: "test" });
	await service.stopThread(thread.id);

	const first = service.cleanupThread(thread.id);
	await firstStartedPromise;
	const second = service.cleanupThread(thread.id);
	finishFirst();
	const [firstCleanup, secondCleanup] = await Promise.all([first, second]);
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(firstCleanup.status, "completed");
	assert.equal(secondCleanup.status, "completed");
	assert.equal(cleanupCalls, 1);
	assert.equal((store.threads[thread.id].worktree as Extract<ThreadWorktree, { mode: "isolated" }>).cleanupState, "removed");
	assert.equal((store.threads[thread.id].worktree as Extract<ThreadWorktree, { mode: "isolated" }>).cleanedAt, "2026-01-01T00:00:00.000Z");
	assert.equal((store.threads[thread.id].worktree as Extract<ThreadWorktree, { mode: "isolated" }>).lastError, undefined);
});

test("cleanup final write does not downgrade worktree already marked removed", async () => {
	const sourceCwd = await fs.mkdtemp(path.join(os.tmpdir(), "thread-source-"));
	const executionCwd = path.join(sourceCwd, "..", "source-thread-final-clean");
	let statePath = "";
	let managerDir = "";
	let threadId = "";
	const worktreeManager: WorktreeManagerPort = {
		...createFakeWorktreeManager({ sourceCwd, executionCwd }),
		async cleanupWorktree() {
			await mutateThreadStore({ statePath, managerDir, now: () => new Date("2026-01-01T00:00:00.000Z") }, (document) => {
				const worktree = document.threads[threadId].worktree as Extract<ThreadWorktree, { mode: "isolated" }>;
				worktree.cleanupState = "removed";
				worktree.cleanedAt = "2026-01-01T00:00:00.000Z";
				worktree.lastError = undefined;
			});
			return { state: "manual_action_required", message: "late stale failure" };
		},
	};
	const serviceContext = await createService({ worktreeManager });
	({ statePath, managerDir } = serviceContext);
	const thread = await serviceContext.service.createThread({ cwd: sourceCwd, createdBy: "test" });
	threadId = thread.id;
	await serviceContext.service.stopThread(thread.id);

	const cleanup = await serviceContext.service.cleanupThread(thread.id);
	const store = await readThreadStore(statePath, managerDir);
	const worktree = store.threads[thread.id].worktree as Extract<ThreadWorktree, { mode: "isolated" }>;
	assert.equal(cleanup.status, "completed");
	assert.equal(cleanup.message, "worktree already removed");
	assert.equal(worktree.cleanupState, "removed");
	assert.equal(worktree.cleanedAt, "2026-01-01T00:00:00.000Z");
	assert.equal(worktree.lastError, undefined);
});

test("cleanup refuses legacy shared-cwd threads", async () => {
	const { service, managerDir } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await service.stopThread(thread.id);
	await assert.rejects(() => service.cleanupThread(thread.id), /legacy shared-cwd/);
});

test("failed isolated create preserves manual-action rollback cleanup state", async () => {
	const sourceCwd = await fs.mkdtemp(path.join(os.tmpdir(), "thread-source-"));
	const executionCwd = path.join(sourceCwd, "..", "source-thread-manual");
	const { service, statePath, managerDir } = await createService({
		worktreeManager: createFakeWorktreeManager({
			sourceCwd,
			executionCwd,
			createError: new Error("worktree add failed"),
			cleanupResult: { state: "manual_action_required", message: "remove manually" },
		}),
	});
	await assert.rejects(() => service.createThread({ cwd: sourceCwd, createdBy: "test" }), /worktree add failed/);
	const store = await readThreadStore(statePath, managerDir);
	const [thread] = Object.values(store.threads);
	assert.equal(thread.status, "failed");
	assert.equal(thread.worktree?.mode, "isolated");
	assert.equal((thread.worktree as Extract<ThreadWorktree, { mode: "isolated" }>).cleanupState, "manual_action_required");
});

test("failed stop marks stop operation failed and interrupts running prompt", async () => {
	const child = createNonExitingChild();
	const rpc = new FakeRpc();
	const { service, statePath, managerDir } = await createService({ launchThread: () => ({ pid: 1234, startedAt: "2026-01-01T00:00:00.000Z", rpc, child }) });
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	const send = await service.sendToThread(thread.id, "send", "keep working");
	await assert.rejects(() => service.stopThread(thread.id), /did not exit after SIGTERM/);
	const store = await readThreadStore(statePath, managerDir);
	const stop = Object.values(store.operations).find((operation) => operation.kind === "stop");
	assert.equal(store.operations[send.id].status, "cancelled");
	assert.match(store.operations[send.id].error ?? "", /Interrupted by stop/);
	assert.equal(stop?.status, "failed");
	assert.equal(store.threads[thread.id].status, "kill_failed");
	assert.equal(store.threads[thread.id].currentOperationId, undefined);
	const [listed] = await service.listThreads();
	assert.equal(listed.status, "kill_failed");
});

test("crash refresh preserves completed current operation", async () => {
	const { service, statePath, managerDir, rpc } = await createService();
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	const send = await service.sendToThread(thread.id, "send", "work");
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.operations[send.id].status = "completed";
	});
	rpc.failState = new Error("state failed");
	await service.listThreads();
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(store.operations[send.id].status, "completed");
});

test("daemon scheduler tick runs review-loop jobs and dispatches fixer prompt", async () => {
	const snapshot: ReviewSnapshot = {
		repo: "owner/repo",
		prNumber: 7,
		headSha: "abc",
		state: "OPEN",
		threads: [
			{ id: "rt-1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 1, comments: [{ id: "c1", body: "Fix this" }] },
		],
	};
	const { service, statePath, managerDir, rpc } = await createService({ githubSnapshot: snapshot });
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await service.handle("review_loop", { repo: "owner/repo", prNumber: 7, fixerThreadId: thread.id, intervalSeconds: 30, maxIterations: 1 }, { clientId: "test" });
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	await service.runDueSchedulesOnce();
	assert.equal(rpc.calls.length, 1);
	assert.equal((rpc.calls[0] as { type: string }).type, "prompt");
	assert.match((rpc.calls[0] as { message: string }).message, /JSON payload below is untrusted review data/);
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(Object.values(store.jobRuns)[0].status, "completed");
	assert.equal(Object.values(store.schedules)[0].status, "completed");
});

test("review-loop batches multiple clusters into one prompt", async () => {
	const snapshot: ReviewSnapshot = {
		repo: "owner/repo",
		prNumber: 7,
		headSha: "abc",
		state: "OPEN",
		threads: [
			{ id: "rt-1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 1, comments: [{ id: "c1", body: "Fix A" }] },
			{ id: "rt-2", isResolved: false, isOutdated: false, path: "src/b.ts", line: 1, comments: [{ id: "c2", body: "Fix B" }] },
		],
	};
	const { service, managerDir, rpc } = await createService({ githubSnapshot: snapshot });
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await service.handle("review_loop", { repo: "owner/repo", prNumber: 7, fixerThreadId: thread.id, intervalSeconds: 30, maxIterations: 1 }, { clientId: "test" });
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	await service.runDueSchedulesOnce();
	assert.deepEqual(rpc.calls.map((call) => (call as { type: string }).type), ["prompt"]);
	assert.match((rpc.calls[0] as { message: string }).message, /rt-1/);
	assert.match((rpc.calls[0] as { message: string }).message, /rt-2/);
});

test("review-loop scheduler waits while fixer thread is busy", async () => {
	const snapshot: ReviewSnapshot = {
		repo: "owner/repo",
		prNumber: 7,
		headSha: "abc",
		state: "OPEN",
		threads: [
			{ id: "rt-1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 1, comments: [{ id: "c1", body: "Fix this" }] },
		],
	};
	const { service, managerDir, rpc } = await createService({ githubSnapshot: snapshot });
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await service.handle("review_loop", { repo: "owner/repo", prNumber: 7, fixerThreadId: thread.id, intervalSeconds: 30, maxIterations: 2 }, { clientId: "test" });
	rpc.state = { isStreaming: true, pendingMessageCount: 0 };
	await service.runDueSchedulesOnce();
	assert.equal(rpc.calls.length, 0);
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	await service.runDueSchedulesOnce();
	assert.equal(rpc.calls.length, 1);
});

test("review-loop scheduler re-reads fixer state between due jobs", async () => {
	const snapshot: ReviewSnapshot = {
		repo: "owner/repo",
		prNumber: 7,
		headSha: "abc",
		state: "OPEN",
		threads: [
			{ id: "rt-1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 1, comments: [{ id: "c1", body: "Fix this" }] },
		],
	};
	const { service, statePath, managerDir, rpc } = await createService({ githubSnapshot: snapshot });
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await service.handle("review_loop", { repo: "owner/repo", prNumber: 7, fixerThreadId: thread.id, intervalSeconds: 30, maxIterations: 2 }, { clientId: "test" });
	await service.handle("review_loop", { repo: "owner/repo", prNumber: 7, fixerThreadId: thread.id, intervalSeconds: 30, maxIterations: 2 }, { clientId: "test" });
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	await service.runDueSchedulesOnce();
	assert.equal(rpc.calls.length, 1);
	const store = await readThreadStore(statePath, managerDir);
	const scheduled = Object.values(store.schedules).filter((job) => job.status === "scheduled");
	assert.equal(scheduled.length, 2);
	assert.deepEqual(Object.values(store.schedules).map((job) => job.iterationCount).sort(), [0, 1]);
});

test("review-loop terminally completes closed PR jobs", async () => {
	const snapshot: ReviewSnapshot = { repo: "owner/repo", prNumber: 7, headSha: "abc", state: "CLOSED", threads: [] };
	const { service, statePath, managerDir, rpc } = await createService({ githubSnapshot: snapshot });
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await service.handle("review_loop", { repo: "owner/repo", prNumber: 7, fixerThreadId: thread.id, intervalSeconds: 30, maxIterations: 10 }, { clientId: "test" });
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	await service.runDueSchedulesOnce();
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(Object.values(store.schedules)[0].status, "completed");
	assert.equal(Object.values(store.schedules)[0].iterationCount, 1);
});

test("review-loop terminally completes ready PR jobs", async () => {
	const snapshot: ReviewSnapshot = { repo: "owner/repo", prNumber: 7, headSha: "abc", state: "OPEN", threads: [] };
	const { service, statePath, managerDir, rpc } = await createService({ githubSnapshot: snapshot });
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await service.handle("review_loop", { repo: "owner/repo", prNumber: 7, fixerThreadId: thread.id, intervalSeconds: 30, maxIterations: 10 }, { clientId: "test" });
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	await service.runDueSchedulesOnce();
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(Object.values(store.schedules)[0].status, "completed");
	assert.equal(Object.values(store.jobRuns)[0].status, "completed");
});

test("idle review-loop polls can repeat the same head sha", async () => {
	const snapshot: ReviewSnapshot = { repo: "owner/repo", prNumber: 7, headSha: "abc", state: "OPEN", threads: [], ciBlocking: true };
	const { service, statePath, managerDir, rpc } = await createService({ githubSnapshot: snapshot });
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await service.handle("review_loop", { repo: "owner/repo", prNumber: 7, fixerThreadId: thread.id, intervalSeconds: 10, maxIterations: 2 }, { clientId: "test" });
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	await service.runDueSchedulesOnce();
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.schedules[Object.keys(document.schedules)[0]].nextRunAt = "2000-01-01T00:00:00.000Z";
	});
	await service.runDueSchedulesOnce();
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(Object.values(store.schedules)[0].status, "completed");
	assert.deepEqual(Object.values(store.jobRuns).map((run) => run.status), ["cancelled", "cancelled"]);
});

test("review-loop request ids include comment snapshot revisions", async () => {
	const snapshot: ReviewSnapshot = {
		repo: "owner/repo",
		prNumber: 7,
		headSha: "abc",
		state: "OPEN",
		threads: [{ id: "rt-1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 1, comments: [{ id: "c1", body: "Fix A" }] }],
	};
	const { service, statePath, managerDir, rpc } = await createService({ githubSnapshot: snapshot });
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await service.handle("review_loop", { repo: "owner/repo", prNumber: 7, fixerThreadId: thread.id, intervalSeconds: 10, maxIterations: 2 }, { clientId: "test" });
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	await service.runDueSchedulesOnce();
	await service.listThreads();
	snapshot.threads[0].comments[0].body = "Fix A edited";
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.schedules[Object.keys(document.schedules)[0]].nextRunAt = "2000-01-01T00:00:00.000Z";
	});
	await service.runDueSchedulesOnce();
	assert.equal(rpc.calls.filter((call) => (call as { type: string }).type === "prompt").length, 2);
});

test("failed review-loop dispatch retries same snapshot with a fresh request id", async () => {
	const snapshot: ReviewSnapshot = {
		repo: "owner/repo",
		prNumber: 7,
		headSha: "abc",
		state: "OPEN",
		threads: [{ id: "rt-1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 1, comments: [{ id: "c1", body: "Fix A" }] }],
	};
	const { service, statePath, managerDir, rpc } = await createService({ githubSnapshot: snapshot });
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await service.handle("review_loop", { repo: "owner/repo", prNumber: 7, fixerThreadId: thread.id, intervalSeconds: 10, maxIterations: 2 }, { clientId: "test" });
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	rpc.failNext = new Error("delivery failed");
	await service.runDueSchedulesOnce();
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.schedules[Object.keys(document.schedules)[0]].nextRunAt = "2000-01-01T00:00:00.000Z";
	});
	await service.runDueSchedulesOnce();
	const store = await readThreadStore(statePath, managerDir);
	assert.deepEqual(Object.values(store.jobRuns).map((run) => run.status), ["failed", "completed"]);
	const dispatches = Object.values(store.operations).filter((operation) => operation.kind === "send" && operation.requestId?.startsWith("review-loop:"));
	assert.equal(dispatches.length, 2);
	assert.notEqual(dispatches[0].requestId, dispatches[1].requestId);
	assert.deepEqual(dispatches.map((operation) => operation.status).sort(), ["acknowledged", "failed"]);
});

test("duplicate completed review-loop snapshots count toward max iterations", async () => {
	const snapshot: ReviewSnapshot = {
		repo: "owner/repo",
		prNumber: 7,
		headSha: "abc",
		state: "OPEN",
		threads: [{ id: "rt-1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 1, comments: [{ id: "c1", body: "Fix A" }] }],
	};
	const { service, statePath, managerDir, rpc } = await createService({ githubSnapshot: snapshot });
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await service.handle("review_loop", { repo: "owner/repo", prNumber: 7, fixerThreadId: thread.id, intervalSeconds: 10, maxIterations: 2 }, { clientId: "test" });
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	await service.runDueSchedulesOnce();
	await service.listThreads();
	await mutateThreadStore({ statePath, managerDir }, (document) => {
		document.schedules[Object.keys(document.schedules)[0]].nextRunAt = "2000-01-01T00:00:00.000Z";
	});
	await service.runDueSchedulesOnce();
	const store = await readThreadStore(statePath, managerDir);
	const job = Object.values(store.schedules)[0];
	assert.equal(job.iterationCount, 2);
	assert.equal(job.status, "completed");
	assert.match(job.lastError ?? "", /Duplicate running job snapshot/);
	assert.equal(Object.values(store.jobRuns).length, 1);
});

test("review-loop validates fixer prompt size before dispatch", async () => {
	const snapshot: ReviewSnapshot = {
		repo: "owner/repo",
		prNumber: 7,
		headSha: "abc",
		state: "OPEN",
		threads: [{ id: "rt-1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 1, comments: [{ id: "c1", body: "x".repeat(300_000) }] }],
	};
	const { service, statePath, managerDir, rpc } = await createService({ githubSnapshot: snapshot });
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await service.handle("review_loop", { repo: "owner/repo", prNumber: 7, fixerThreadId: thread.id, intervalSeconds: 30, maxIterations: 1 }, { clientId: "test" });
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	await service.runDueSchedulesOnce();
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(rpc.calls.length, 0);
	assert.equal(Object.values(store.jobRuns)[0].status, "failed");
	assert.match(Object.values(store.jobRuns)[0].terminalReason ?? "", /prompt size/);
});

test("review-loop validates all fixer prompts before dispatch", async () => {
	const snapshot: ReviewSnapshot = {
		repo: "owner/repo",
		prNumber: 7,
		headSha: "abc",
		state: "OPEN",
		threads: [
			{ id: "rt-1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 1, comments: [{ id: "c1", body: "Fix A" }] },
			{ id: "rt-2", isResolved: false, isOutdated: false, path: "src/b.ts", line: 1, comments: [{ id: "c2", body: "x".repeat(300_000) }] },
		],
	};
	const { service, statePath, managerDir, rpc } = await createService({ githubSnapshot: snapshot });
	const thread = await service.createThread({ cwd: managerDir, createdBy: "test", safetyPolicy: sharedSafetyPolicy() });
	await service.handle("review_loop", { repo: "owner/repo", prNumber: 7, fixerThreadId: thread.id, intervalSeconds: 30, maxIterations: 1 }, { clientId: "test" });
	rpc.state = { isStreaming: false, pendingMessageCount: 0 };
	await service.runDueSchedulesOnce();
	const store = await readThreadStore(statePath, managerDir);
	assert.equal(rpc.calls.length, 0);
	assert.equal(Object.values(store.jobRuns)[0].status, "failed");
});

async function createService(options: { launchThread?: (thread: ManagedThread) => unknown; githubSnapshot?: ReviewSnapshot; now?: () => Date; worktreeManager?: WorktreeManagerPort } = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-lifecycle-"));
	const managerDir = getThreadManagerDir(root);
	await fs.mkdir(managerDir, { recursive: true });
	const statePath = getThreadStorePath(root);
	const rpc = new FakeRpc();
	let next = 1;
	const service = new ThreadService({
		statePath,
		managerDir,
		homeDir: root,
		now: options.now,
		randomId: () => `${next++}`,
		githubReviewPort: options.githubSnapshot ? { fetchSnapshot: async () => options.githubSnapshot! } : undefined,
		worktreeManager: options.worktreeManager,
		launchThread: options.launchThread as never ?? (() => ({ pid: 1234, startedAt: "2026-01-01T00:00:00.000Z", rpc })),
	});
	return { service, statePath, managerDir, root, rpc };
}

class FakeRpc implements ChildRpcPort {
	calls: unknown[] = [];
	messages: unknown[] = [];
	state = { isStreaming: true, pendingMessageCount: 0 };
	failNext?: Error;
	failState?: Error;
	failMessages?: Error;
	async request<T>(command: Record<string, unknown>): Promise<T> {
		if (command.type === "get_messages") {
			if (this.failMessages) throw this.failMessages;
			return { messages: this.messages } as T;
		}
		if (command.type === "get_state") {
			if (this.failState) throw this.failState;
			return this.state as T;
		}
		if (this.failNext) {
			const error = this.failNext;
			this.failNext = undefined;
			throw error;
		}
		this.calls.push(command);
		return {} as T;
	}
	destroy(): void {}
}

function createNonExitingChild() {
	return {
		exitCode: null,
		kill: () => true,
		once: () => undefined,
	};
}

function createFakeWorktreeManager(options: { sourceCwd: string; executionCwd: string; createError?: Error; cleanupResult?: { state: "removed" | "manual_action_required"; message: string; cleanedAt?: string }; inspectOk?: boolean }): WorktreeManagerPort {
	return {
		async prepareAllocation(sourceCwd, input) {
			assert.equal(sourceCwd, options.sourceCwd);
			return {
				mode: "isolated",
				sourceCwd,
				sourceRepoRoot: options.sourceCwd,
				sourceSubdir: "",
				primaryRepoRoot: options.sourceCwd,
				worktreeRoot: options.executionCwd,
				executionCwd: options.executionCwd,
				branchName: `thread-manager/${input.threadId}-test`,
				baseRef: input.baseRef ?? "HEAD",
				baseSha: "abc123",
				allocationState: "reserved",
				cleanupState: "cleanup_pending",
			};
		},
		async createAllocation(worktree) {
			if (options.createError) throw options.createError;
			return { ...worktree, allocationState: "allocated", cleanupState: "retained", allocatedAt: "2026-01-01T00:00:00.000Z" };
		},
		async rollbackAllocation() {
			return options.cleanupResult ?? { state: "removed", message: "removed", cleanedAt: "2026-01-01T00:00:00.000Z" };
		},
		async cleanupWorktree() {
			return options.cleanupResult ?? { state: "removed", message: "removed", cleanedAt: "2026-01-01T00:00:00.000Z" };
		},
		async inspectWorktree() {
			return options.inspectOk === false ? { ok: false, reason: "missing isolated worktree", reservedExists: false } : { ok: true };
		},
	};
}

function sharedSafetyPolicy(overrides: Partial<SafetyPolicy> = {}): Partial<SafetyPolicy> {
	return { ...overrides, worktreeMode: "shared_cwd_allowed" };
}
