import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
	isCommandAllowed,
	normalizeLaunchProfile,
	normalizeRestartPolicy,
	normalizeSafetyPolicy as normalizeProtocolSafetyPolicy,
	validateApprovalScope,
	validateBaseRef,
	validateBrokerRequest,
	validateCapability,
	validateLaunchProfile,
	validatePrompt,
	validateRestartPolicy,
	validateScheduleInterval,
} from "../src/protocol.ts";
import { PROTOCOL_VERSION, type ApprovalRecord, type CapabilityToken } from "../src/types.ts";

test("accepts valid handshake and rejects unsupported protocol", () => {
	assert.deepEqual(validateBrokerRequest({ type: "handshake", id: "req-1", protocolVersion: PROTOCOL_VERSION }), {
		type: "handshake",
		id: "req-1",
		protocolVersion: PROTOCOL_VERSION,
	});
	const newer = validateBrokerRequest({ type: "handshake", id: "req-1", protocolVersion: PROTOCOL_VERSION + 1 });
	assert.equal(newer.type, "handshake");
	assert.equal(newer.protocolVersion, PROTOCOL_VERSION + 1);
});

test("validates request envelopes and size limits", () => {
	assert.throws(() => validateBrokerRequest({ type: "request", id: "bad id", command: "list" }), /request id/);
	assert.throws(() => validateBrokerRequest({ type: "request", id: "req-1" }), /unknown thread action/);
	assert.throws(() => validateBrokerRequest({ type: "handshake", id: "req-1", protocolVersion: PROTOCOL_VERSION, token: 123 }), /token must be a string/);
	assert.throws(() => validateBrokerRequest({ type: "request", id: "req-1", command: "list", token: {} }), /token must be a string/);
	assert.throws(() => validatePrompt("x".repeat(11), { maxPromptBytes: 10, maxFrameBytes: 100, maxNameBytes: 10, maxTagBytes: 10, maxRequestIdBytes: 20, maxReadLimit: 10, maxQueueDepth: 1, maxThreads: 1, maxJobs: 1, minScheduleIntervalSeconds: 10 }), /prompt size/);
	assert.throws(() => validateScheduleInterval(5), /at least 10/);
});

test("enforces command legality by thread state", () => {
	assert.deepEqual(isCommandAllowed("idle", "send"), { allowed: true });
	assert.match(isCommandAllowed("running", "send").reason ?? "", /requires idle/);
	assert.deepEqual(isCommandAllowed("running", "steer"), { allowed: true });
	assert.match(isCommandAllowed("idle", "steer").reason ?? "", /requires running/);
	assert.match(isCommandAllowed("stopped", "send").reason ?? "", /requires idle/);
	assert.deepEqual(isCommandAllowed("kill_failed", "stop"), { allowed: true });
	assert.deepEqual(isCommandAllowed("stopped", "cleanup"), { allowed: true });
	assert.match(isCommandAllowed("running", "cleanup").reason ?? "", /cleanup requires/);
	assert.deepEqual(isCommandAllowed("running", "follow_up", { ...normalizeSafetyPolicy(), queuePolicy: "allow_follow_up" }), { allowed: true });
});

test("validates baseRef tokens", () => {
	assert.equal(validateBaseRef(undefined), undefined);
	assert.equal(validateBaseRef("refs/heads/main"), "refs/heads/main");
	assert.equal(validateBaseRef("abc123"), "abc123");
	assert.throws(() => validateBaseRef("bad ref"), /baseRef/);
	assert.throws(() => validateBaseRef("main..other"), /baseRef/);
	assert.throws(() => validateBaseRef("@{upstream}"), /baseRef/);
});

test("validates scoped capability tokens", () => {
	const token: CapabilityToken = {
		id: "token-1",
		secret: "secret",
		clientId: "client-1",
		actions: ["read"],
		threadIds: ["thread-1"],
		expiresAt: "2099-01-01T00:00:00.000Z",
	};
	assert.deepEqual(validateCapability(token, "secret", { action: "read", threadId: "thread-1" }), { allowed: true });
	assert.match(validateCapability(token, "wrong", { action: "read", threadId: "thread-1" }).reason ?? "", /invalid/);
	assert.match(validateCapability(token, "secret", { action: "stop", threadId: "thread-1" }).reason ?? "", /not scoped/);
	assert.match(validateCapability(token, "secret", { action: "read", threadId: "thread-2" }).reason ?? "", /this thread/);
});

test("thread-scoped capability tokens cannot create threadless threads", () => {
	const token: CapabilityToken = {
		id: "token-1",
		secret: "secret",
		clientId: "client-1",
		actions: "all",
		threadIds: ["thread-1"],
	};
	assert.match(validateCapability(token, "secret", { action: "create", cwd: path.resolve(".") }).reason ?? "", /cannot create/);
	assert.deepEqual(validateCapability(token, "secret", { action: "read", threadId: "thread-1" }), { allowed: true });
});

test("cwd-scoped thread tokens require stored target cwd", () => {
	const token: CapabilityToken = {
		id: "token-1",
		secret: "secret",
		clientId: "client-1",
		actions: ["read"],
		cwdRoots: [path.resolve(".")],
	};
	assert.match(validateCapability(token, "secret", { action: "read", threadId: "thread-1" }).reason ?? "", /cwd is unavailable/);
	assert.deepEqual(validateCapability(token, "secret", { action: "read", threadId: "thread-1", cwd: path.resolve(".") }), { allowed: true });
});

test("validates restart and launch profile policy", () => {
	assert.deepEqual(validateRestartPolicy(normalizeRestartPolicy({ mode: "manual" })).mode, "manual");
	assert.throws(
		() => validateRestartPolicy(normalizeRestartPolicy({ mode: "from_session", allowWhenOperationUnknown: true })),
		/operation outcome is unknown/,
	);
	const profile = normalizeLaunchProfile({ cwd: path.resolve("."), approvalMode: "ask", extensionLoading: "inherit" });
	assert.deepEqual(validateLaunchProfile(profile), profile);
	assert.throws(() => validateLaunchProfile({ ...profile, cwd: "relative" }), /absolute/);
	assert.throws(() => normalizeProtocolSafetyPolicy({ queuePolicy: "bad" as never }), /unknown queue policy/);
});

test("invalidates approvals when TOCTOU scope changes", () => {
	const approval: ApprovalRecord = {
		id: "approval-1",
		status: "approved",
		scope: {
			repo: "owner/repo",
			prNumber: 12,
			headSha: "abc",
			branch: "feature",
			actionType: "push",
			threadIds: ["thread-1"],
			reviewThreadIds: ["rt-1"],
			diffSummary: "one file",
		},
		operationId: "op-1",
		createdAt: "2026-01-01T00:00:00.000Z",
		expiresAt: "2099-01-01T00:00:00.000Z",
	};
	assert.deepEqual(validateApprovalScope(approval.scope, approval), { allowed: true });
	assert.match(validateApprovalScope({ ...approval.scope, headSha: "def" }, approval).reason ?? "", /headSha/);
	assert.match(validateApprovalScope({ ...approval.scope, threadIds: ["thread-1", "thread-1"] }, approval).reason ?? "", /threadIds/);
});

function normalizeSafetyPolicy() {
	return {
		worktreeMode: "isolated_required" as const,
		queuePolicy: "reject_when_running" as const,
		githubWritePolicy: "ask" as const,
		forceKillPolicy: "deny" as const,
		restartPolicy: normalizeRestartPolicy(),
	};
}
