import assert from "node:assert/strict";
import net from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ThreadManagerClient } from "../src/broker/client.ts";
import { loadOrCreateAuthRoot } from "../src/broker/auth.ts";
import { createMessageReader, writeMessage } from "../src/broker/framing.ts";
import { getBrokerSocketPath } from "../src/broker/paths.ts";
import { buildBrokerEnv, getBrokerLaunchSpec } from "../src/broker/spawn.ts";
import { startThreadBroker, type BrokerRequestHandler } from "../src/broker/broker.ts";
import { normalizeSafetyPolicy } from "../src/protocol.ts";
import { createEmptyThreadStore, writeThreadStore } from "../src/store/thread-store.ts";
import { PROTOCOL_VERSION } from "../src/types.ts";

test("length-prefixed framing handles partial reads and oversized frames", () => {
	const messages: unknown[] = [];
	const errors: Error[] = [];
	const reader = createMessageReader((message) => messages.push(message), (error) => errors.push(error), { maxFrameBytes: 12, maxPromptBytes: 1, maxNameBytes: 1, maxTagBytes: 1, maxRequestIdBytes: 20, maxReadLimit: 1, maxQueueDepth: 1, maxThreads: 1, maxJobs: 1, minScheduleIntervalSeconds: 10 });
	const payload = Buffer.from(JSON.stringify({ ok: true }), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32BE(payload.length, 0);
	reader(header.subarray(0, 2));
	reader(Buffer.concat([header.subarray(2), payload]));
	assert.deepEqual(messages, [{ ok: true }]);
	const badHeader = Buffer.alloc(4);
	badHeader.writeUInt32BE(13, 0);
	reader(badHeader);
	assert.match(errors[0].message, /exceeds/);
});

test("computes platform-specific socket and launch specs", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-broker-"));
	assert.match(getBrokerSocketPath("win32", root), /^\\\\\.\\pipe\\pi-thread-manager-/);
	assert.equal(getBrokerSocketPath("linux", root), path.join(root, ".pi", "agent", "thread-manager", "broker.sock"));
	const direct = getBrokerLaunchSpec("broker.ts", "linux", root, root, "node");
	assert.deepEqual(direct, { kind: "direct", command: "node", args: [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "broker.ts"] });
	const windows = getBrokerLaunchSpec("broker.ts", "win32", root, root, "node.exe");
	assert.equal(windows.kind, "windows-launcher");
});

test("broker env preserves GitHub CLI auth and drops unrelated secrets", () => {
	const env = buildBrokerEnv({ PATH: "/bin", Path: "C:/bin", GH_TOKEN: "gh", GITHUB_TOKEN: "github", API_TOKEN: "api", OPENAI_API_KEY: "openai", AWS_SECRET_ACCESS_KEY: "aws" }, "/tmp/thread-home");
	assert.equal(env.PATH, "/bin");
	assert.equal(env.Path, "C:/bin");
	assert.equal(env.GH_TOKEN, "gh");
	assert.equal(env.GITHUB_TOKEN, "github");
	assert.equal(env.OPENAI_API_KEY, "openai");
	assert.equal(env.AWS_SECRET_ACCESS_KEY, "aws");
	assert.equal(env.PI_THREAD_MANAGER_HOME, "/tmp/thread-home");
	assert.equal(env.API_TOKEN, undefined);
});

test("broker handles pipelined handshake and first request", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-broker-"));
	const socketPath = testSocketPath(root);
	const broker = await startThreadBroker({
		socketPath,
		pidPath: path.join(root, "broker.pid"),
		managerDir: root,
		storePath: path.join(root, "threads.json"),
		platform: process.platform,
		requiredToken: "secret",
		handler: { handle: async (command) => ({ command }) },
	});
	try {
		const socket = net.connect(socketPath);
		const responses: unknown[] = [];
		const reader = createMessageReader((message) => responses.push(message), (error) => { throw error; });
		socket.on("data", reader);
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		writeMessage(socket, { type: "handshake", id: "handshake", protocolVersion: PROTOCOL_VERSION, token: "secret" });
		writeMessage(socket, { type: "request", id: "list-1", command: "list", token: "secret", params: {} });
		await waitFor(() => responses.length === 2);
		assert.deepEqual(responses.map((response) => (response as { success: boolean }).success), [true, true]);
		socket.destroy();
	} finally {
		await broker.close();
	}
});

test("client handshakes, sends requests, and rejects unauthenticated clients", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-broker-"));
	const socketPath = testSocketPath(root);
	const pidPath = path.join(root, "broker.pid");
	const handler: BrokerRequestHandler = {
		status: () => ({ threadCount: 1 }),
		handle: async (command, params) => ({ command, params }),
	};
	const broker = await startThreadBroker({ socketPath, pidPath, managerDir: root, storePath: path.join(root, "threads.json"), requiredToken: "secret", platform: process.platform, handler });
	try {
		const badClient = new ThreadManagerClient({ socketPath, token: "wrong", requestTimeoutMs: 200 });
		await assert.rejects(() => badClient.connect(), /invalid daemon capability token/);

		const client = new ThreadManagerClient({ socketPath, token: "secret", requestTimeoutMs: 500 });
		const status = await client.connect();
		assert.equal(status.protocolVersion, PROTOCOL_VERSION);
		assert.equal(status.threadCount, 1);
		assert.deepEqual(await client.request("list", { scope: "all" }, "req-1"), { command: "list", params: { scope: "all" } });
		client.disconnect();
	} finally {
		await broker.close();
	}
});

test("broker refuses to unlink a live socket", { skip: process.platform === "win32" }, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-broker-"));
	const socketPath = testSocketPath(root);
	const pidPath = path.join(root, "broker.pid");
	const handler: BrokerRequestHandler = { handle: async () => ({ ok: true }) };
	const broker = await startThreadBroker({ socketPath, pidPath, managerDir: root, storePath: path.join(root, "threads.json"), requiredToken: "secret", platform: process.platform, handler });
	try {
		await assert.rejects(
			() => startThreadBroker({ socketPath, pidPath: path.join(root, "second.pid"), managerDir: root, storePath: path.join(root, "threads.json"), requiredToken: "secret", platform: process.platform, handler }),
			/already in use/,
		);
		const client = new ThreadManagerClient({ socketPath, token: "secret", requestTimeoutMs: 500 });
		await client.connect();
		assert.deepEqual(await client.request("list", {}, "req-1"), { ok: true });
		client.disconnect();
	} finally {
		await broker.close();
	}
});

test("client receives handshake version mismatch on handshake request", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-broker-"));
	const socketPath = testSocketPath(root);
	const broker = await startThreadBroker({
		socketPath,
		pidPath: path.join(root, "broker.pid"),
		managerDir: root,
		storePath: path.join(root, "threads.json"),
		platform: process.platform,
		requiredToken: "secret",
		protocolVersion: PROTOCOL_VERSION + 1,
		handler: { handle: async () => ({}) },
	});
	try {
		const client = new ThreadManagerClient({ socketPath, token: "secret", requestTimeoutMs: 500 });
		await assert.rejects(() => client.connect(), /unsupported protocol version/);
	} finally {
		await broker.close();
	}
});

test("client fails pending request on disconnect", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-broker-"));
	const socketPath = testSocketPath(root);
	let release!: () => void;
	const wait = new Promise<void>((resolve) => { release = resolve; });
	const broker = await startThreadBroker({
		socketPath,
		pidPath: path.join(root, "broker.pid"),
		managerDir: root,
		storePath: path.join(root, "threads.json"),
		platform: process.platform,
		homeDir: root,
		handler: { handle: async () => { await wait; return {}; } },
	});
	const client = new ThreadManagerClient({ socketPath, homeDir: root, requestTimeoutMs: 1000 });
	await client.connect();
	const pending = client.request("list", {}, "slow");
	client.disconnect(new Error("test disconnect"));
	await assert.rejects(() => pending, /test disconnect/);
	release();
	await broker.close();
});

test("client uses separate timeout for create requests", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-broker-"));
	const socketPath = testSocketPath(root);
	const broker = await startThreadBroker({
		socketPath,
		pidPath: path.join(root, "broker.pid"),
		managerDir: root,
		storePath: path.join(root, "threads.json"),
		platform: process.platform,
		homeDir: root,
		handler: {
			handle: async (command) => {
				await new Promise((resolve) => setTimeout(resolve, 120));
				return { command };
			},
		},
	});
	try {
		const client = new ThreadManagerClient({ socketPath, homeDir: root, requestTimeoutMs: 50, createRequestTimeoutMs: 500 });
		await client.connect();
		await assert.rejects(() => client.request("list", {}, "slow-list"), /timed out/);
		assert.deepEqual(await client.request("create", { cwd: root, createdBy: "test" }, "slow-create"), { command: "create" });
		client.disconnect();
	} finally {
		await broker.close();
	}
});

test("broker validates scoped token against every requested thread id", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-broker-"));
	const auth = loadOrCreateAuthRoot(root);
	auth.tokens.push({ id: "scoped", secret: "scoped-secret", clientId: "client", actions: ["handshake", "schedule"], threadIds: ["thread-1"] });
	await fs.writeFile(path.join(root, ".pi", "agent", "thread-manager", "auth-root.json"), `${JSON.stringify(auth)}\n`);
	const socketPath = testSocketPath(root);
	const broker = await startThreadBroker({
		socketPath,
		pidPath: path.join(root, "broker.pid"),
		managerDir: root,
		storePath: path.join(root, "threads.json"),
		platform: process.platform,
		homeDir: root,
		handler: { handle: async () => ({ ok: true }) },
	});
	try {
		const client = new ThreadManagerClient({ socketPath, homeDir: root, token: "scoped-secret", requestTimeoutMs: 500 });
		await client.connect();
		await assert.rejects(() => client.request("schedule", { threadIds: ["thread-1", "thread-2"] }, "sched-1"), /not scoped/);
		client.disconnect();
	} finally {
		await broker.close();
	}
});

test("broker authorizes thread commands against stored thread cwd", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-broker-"));
	const allowedRoot = path.join(root, "allowed");
	const disallowedRoot = path.join(root, "disallowed");
	await fs.mkdir(allowedRoot, { recursive: true });
	await fs.mkdir(disallowedRoot, { recursive: true });
	const auth = loadOrCreateAuthRoot(root);
	auth.tokens.push({ id: "cwd-scoped", secret: "cwd-secret", clientId: "client", actions: ["handshake", "send"], cwdRoots: [allowedRoot] });
	await fs.writeFile(path.join(root, ".pi", "agent", "thread-manager", "auth-root.json"), `${JSON.stringify(auth)}\n`);
	const storePath = path.join(root, "threads.json");
	const document = createEmptyThreadStore(new Date("2026-01-01T00:00:00.000Z"));
	document.threads["thread-1"] = {
		id: "thread-1",
		status: "idle",
		cwd: disallowedRoot,
		tags: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		createdBy: "test",
		launchProfile: { cwd: disallowedRoot, extensionLoading: "inherit", approvalMode: "ask", inheritedFromParent: true },
		safetyPolicy: normalizeSafetyPolicy(),
		worktree: { mode: "legacy_shared_cwd", sourceCwd: disallowedRoot, cleanupState: "not_applicable" },
	};
	await writeThreadStore(storePath, document);
	const socketPath = testSocketPath(root);
	const broker = await startThreadBroker({
		socketPath,
		pidPath: path.join(root, "broker.pid"),
		managerDir: root,
		storePath,
		platform: process.platform,
		homeDir: root,
		handler: { handle: async () => ({ ok: true }) },
	});
	try {
		const client = new ThreadManagerClient({ socketPath, homeDir: root, token: "cwd-secret", requestTimeoutMs: 500 });
		await client.connect();
		await assert.rejects(() => client.request("send", { threadId: "thread-1", cwd: allowedRoot, message: "x" }, "send-1"), /not scoped for this cwd/);
		client.disconnect();
	} finally {
		await broker.close();
	}
});

test("broker authorizes isolated thread commands against source cwd metadata", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-broker-"));
	const allowedRoot = path.join(root, "allowed");
	const executionRoot = path.join(root, "execution");
	await fs.mkdir(allowedRoot, { recursive: true });
	await fs.mkdir(executionRoot, { recursive: true });
	const auth = loadOrCreateAuthRoot(root);
	auth.tokens.push({ id: "cwd-scoped", secret: "cwd-secret", clientId: "client", actions: ["handshake", "send"], cwdRoots: [allowedRoot] });
	await fs.writeFile(path.join(root, ".pi", "agent", "thread-manager", "auth-root.json"), `${JSON.stringify(auth)}\n`);
	const storePath = path.join(root, "threads.json");
	const document = createEmptyThreadStore(new Date("2026-01-01T00:00:00.000Z"));
	document.threads["thread-1"] = {
		id: "thread-1",
		status: "idle",
		cwd: executionRoot,
		tags: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		createdBy: "test",
		launchProfile: { cwd: executionRoot, extensionLoading: "inherit", approvalMode: "ask", inheritedFromParent: true },
		safetyPolicy: normalizeSafetyPolicy(),
		worktree: {
			mode: "isolated",
			sourceCwd: allowedRoot,
			sourceRepoRoot: allowedRoot,
			sourceSubdir: "",
			primaryRepoRoot: allowedRoot,
			worktreeRoot: executionRoot,
			executionCwd: executionRoot,
			branchName: "thread-manager/thread-1-test",
			baseRef: "HEAD",
			baseSha: "abc123",
			allocationState: "allocated",
			cleanupState: "retained",
		},
	};
	await writeThreadStore(storePath, document);
	const socketPath = testSocketPath(root);
	const broker = await startThreadBroker({
		socketPath,
		pidPath: path.join(root, "broker.pid"),
		managerDir: root,
		storePath,
		platform: process.platform,
		homeDir: root,
		handler: { handle: async () => ({ ok: true }) },
	});
	try {
		const client = new ThreadManagerClient({ socketPath, homeDir: root, token: "cwd-secret", requestTimeoutMs: 500 });
		await client.connect();
		assert.deepEqual(await client.request("send", { threadId: "thread-1", message: "x" }, "send-1"), { ok: true });
		client.disconnect();
	} finally {
		await broker.close();
	}
});

test("broker auth uses resolved manager directory for custom home", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-broker-"));
	const managerDir = path.join(root, ".pi", "agent", "thread-manager");
	const allowedRoot = path.join(root, "allowed");
	await fs.mkdir(allowedRoot, { recursive: true });
	const auth = loadOrCreateAuthRoot(root);
	auth.tokens.push({ id: "cwd-scoped", secret: "cwd-secret", clientId: "client", actions: ["handshake", "send"], cwdRoots: [allowedRoot] });
	await fs.writeFile(path.join(managerDir, "auth-root.json"), `${JSON.stringify(auth)}\n`);
	const storePath = path.join(managerDir, "threads.json");
	const document = createEmptyThreadStore(new Date("2026-01-01T00:00:00.000Z"));
	document.threads["thread-1"] = {
		id: "thread-1",
		status: "idle",
		cwd: allowedRoot,
		tags: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		createdBy: "test",
		launchProfile: { cwd: allowedRoot, extensionLoading: "inherit", approvalMode: "ask", inheritedFromParent: true },
		safetyPolicy: normalizeSafetyPolicy(),
		worktree: { mode: "legacy_shared_cwd", sourceCwd: allowedRoot, cleanupState: "not_applicable" },
	};
	await writeThreadStore(storePath, document);
	const socketPath = testSocketPath(root);
	const broker = await startThreadBroker({
		socketPath,
		pidPath: path.join(root, "broker.pid"),
		platform: process.platform,
		homeDir: root,
		handler: { handle: async () => ({ ok: true }) },
	});
	try {
		const client = new ThreadManagerClient({ socketPath, homeDir: root, token: "cwd-secret", requestTimeoutMs: 500 });
		await client.connect();
		assert.deepEqual(await client.request("send", { threadId: "thread-1", message: "x" }, "send-1"), { ok: true });
		client.disconnect();
	} finally {
		await broker.close();
	}
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > 1000) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function testSocketPath(root: string): string {
	return process.platform === "win32" ? getBrokerSocketPath("win32", root) : path.join(root, "broker.sock");
}
