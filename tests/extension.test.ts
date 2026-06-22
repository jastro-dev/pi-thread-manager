import assert from "node:assert/strict";
import test from "node:test";

import threadManagerExtension, { parseThreadCommand, runThreadCommand, type BrokerPort } from "../src/extension.ts";
import { formatToolResult } from "../src/presentation.ts";

test("parses thread commands", () => {
	assert.deepEqual(parseThreadCommand("", "/repo"), { action: "status", params: { cwd: "/repo", createdBy: "command" } });
	assert.deepEqual(parseThreadCommand("create worker build this", "/repo"), { action: "create", params: { cwd: "/repo", createdBy: "command", name: "worker", initialPrompt: "build this" } });
	assert.deepEqual(parseThreadCommand("send thread-1 hello there", "/repo"), { action: "send", params: { cwd: "/repo", createdBy: "command", threadId: "thread-1", message: "hello there" } });
	assert.deepEqual(parseThreadCommand("send thread-1 key=value --flag keep", "/repo"), { action: "send", params: { cwd: "/repo", createdBy: "command", threadId: "thread-1", message: "key=value --flag keep" } });
	assert.deepEqual(parseThreadCommand("follow-up thread-1 later", "/repo"), { action: "follow_up", params: { cwd: "/repo", createdBy: "command", threadId: "thread-1", message: "later" } });
	assert.deepEqual(parseThreadCommand("read thread-1 limit=10 cursor=2", "/repo"), { action: "read", params: { cwd: "/repo", createdBy: "command", threadId: "thread-1", limit: 10, cursor: 2 } });
	assert.deepEqual(parseThreadCommand("create worktreeMode=shared_cwd_allowed baseRef=main worker build", "/repo"), { action: "create", params: { cwd: "/repo", createdBy: "command", worktreeMode: "shared_cwd_allowed", baseRef: "main", name: "worker", initialPrompt: "build" } });
	assert.deepEqual(parseThreadCommand("cleanup thread-1", "/repo"), { action: "cleanup", params: { cwd: "/repo", createdBy: "command", threadId: "thread-1" } });
});

test("registers command and model-facing tool once", () => {
	const harness = createHarness();
	threadManagerExtension(harness.pi as never, { spawnBroker: async () => undefined, createClient: () => new FakeClient() });
	assert.equal(harness.commands.size, 1);
	assert.equal(harness.tools.size, 1);
	assert.equal(harness.commands.has("threads"), true);
	assert.equal(harness.tools.has("thread"), true);
	const properties = harness.tools.get("thread")!.parameters.properties;
	for (const key of ["repo", "prNumber", "pr", "fixerThreadId", "baseRef"] as const) assert.ok(properties[key], `${key} missing`);
	assert.deepEqual((properties.action as { enum: string[] }).enum.includes("cleanup"), true);
	assert.deepEqual((properties.worktreeMode as { enum: string[] }).enum, ["isolated_required", "shared_cwd_allowed"]);
});

test("command executes through broker and formats status", async () => {
	const client = new FakeClient({ daemonPid: 5, protocolVersion: 1, daemonEpoch: "epoch", storePath: "/store", threadCount: 0, activeThreadCount: 0, orphanThreadCount: 0, pendingOperationCount: 0, pendingApprovalCount: 0, activeScheduleCount: 0 });
	const text = await runThreadCommand("status", createContext() as never, async () => undefined, () => client);
	assert.match(text, /daemon pid 5/);
	assert.deepEqual(client.requests[0], { command: "status", params: { cwd: "/repo", createdBy: "command" } });
});

test("tool executes through broker and returns text content", async () => {
	const harness = createHarness();
	const client = new FakeClient([{ id: "thread-1", status: "idle", cwd: "/repo", tags: [], createdAt: "now", updatedAt: "now", createdBy: "test", launchProfile: { cwd: "/repo", extensionLoading: "inherit", approvalMode: "ask", inheritedFromParent: true }, safetyPolicy: { worktreeMode: "isolated_required", queuePolicy: "reject_when_running", githubWritePolicy: "ask", forceKillPolicy: "deny", restartPolicy: { mode: "manual", maxRestarts: 0, backoffSeconds: 30, allowWhenOperationUnknown: false } } }]);
	threadManagerExtension(harness.pi as never, { spawnBroker: async () => undefined, createClient: () => client });
	const result = await harness.tools.get("thread")!.execute("call-1/with-non-protocol-chars-and-extra-long-id-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", { action: "list" }, undefined, undefined, createContext());
	assert.match(result.content[0].text, /thread-1: idle/);
	assert.deepEqual(client.requests[0], { command: "list", params: { action: "list", cwd: "/repo", createdBy: "tool" }, requestId: "tool-b2715175098f2dd43fb2d9c0126d2731" });
});

test("tool create maps message to initialPrompt", async () => {
	const harness = createHarness();
	const client = new FakeClient({});
	threadManagerExtension(harness.pi as never, { spawnBroker: async () => undefined, createClient: () => client });
	await harness.tools.get("thread")!.execute("call-1", { action: "create", message: "build this" }, undefined, undefined, createContext());
	assert.equal(client.requests[0].params.initialPrompt, "build this");
});

test("empty approval lists render as approvals", () => {
	assert.equal(formatToolResult({ kind: "approvals", approvals: [] }), "No pending thread-manager approvals.");
});

test("formatting redacts environment-style JSON secrets", () => {
	const text = formatToolResult({ OPENAI_API_KEY: "sk-secret", AWS_SECRET_ACCESS_KEY: "aws-secret", safe: "ok" });
	assert.match(text, /"OPENAI_API_KEY": "\[redacted\]"/);
	assert.match(text, /"AWS_SECRET_ACCESS_KEY": "\[redacted\]"/);
	assert.match(text, /"safe": "ok"/);
	assert.doesNotMatch(text, /sk-secret|aws-secret/);
});

class FakeClient implements BrokerPort {
	requests: Array<{ command: string; params: Record<string, unknown>; requestId?: string }> = [];
	constructor(private readonly response: unknown = {}) {}
	async connect(): Promise<unknown> { return {}; }
	async request<T>(command: string, params: Record<string, unknown> = {}, requestId?: string): Promise<T> {
		this.requests.push(requestId === undefined ? { command, params } : { command, params, requestId });
		return this.response as T;
	}
	disconnect(): void {}
}

function createHarness() {
	const commands = new Map<string, { handler: (args: string, ctx: ReturnType<typeof createContext>) => Promise<void> }>();
	const tools = new Map<string, { parameters: { properties: Record<string, unknown> }; execute: (...args: any[]) => Promise<any> }>();
	return {
		commands,
		tools,
		pi: {
			registerCommand(name: string, options: { handler: (args: string, ctx: ReturnType<typeof createContext>) => Promise<void> }) { commands.set(name, options); },
			registerTool(tool: { name: string; parameters: { properties: Record<string, unknown> }; execute: (...args: any[]) => Promise<any> }) { tools.set(tool.name, tool); },
		},
	};
}

function createContext() {
	return {
		cwd: "/repo",
		async waitForIdle() {},
		ui: {
			notifications: [] as Array<{ message: string; level: string }>,
			notify(message: string, level: string) { this.notifications.push({ message, level }); },
		},
	};
}
