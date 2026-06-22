import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { loadThreadManagerConfig } from "../src/config.ts";
import { buildPiRpcArgs, buildSafeChildEnv, launchPiRpcThread } from "../src/pi/launcher.ts";
import { getPiSpawnCommand } from "../src/pi/pi-spawn.ts";
import type { ManagedThread } from "../src/types.ts";

test("safe child env strips token-like values", () => {
	const env = buildSafeChildEnv("thread-1", {
		PATH: "C:/bin",
		HOME: "C:/tmp/me",
		OPENAI_API_KEY: "openai-secret",
		AWS_SECRET_ACCESS_KEY: "aws-secret",
		GITHUB_TOKEN: "secret",
		AUTHORIZATION: "bearer secret",
	});
	assert.equal(env.PI_THREAD_ID, "thread-1");
	assert.equal(env.PATH, "C:/bin");
	assert.equal(env.HOME, "C:/tmp/me");
	assert.equal(env.OPENAI_API_KEY, "openai-secret");
	assert.equal(env.AWS_SECRET_ACCESS_KEY, "aws-secret");
	assert.equal(env.GITHUB_TOKEN, undefined);
	assert.equal(env.AUTHORIZATION, undefined);
});

test("safe child env includes configured PI flags without overriding managed thread id", () => {
	const env = buildSafeChildEnv("thread-1", {}, { PI_SUBAGENT_CHILD: "1", PI_THREAD_ID: "bad" });
	assert.equal(env.PI_SUBAGENT_CHILD, "1");
	assert.equal(env.PI_THREAD_ID, "thread-1");
});

test("safe child env preserves Windows Path casing", () => {
	const env = buildSafeChildEnv("thread-1", { Path: "C:/Windows/System32" });
	assert.equal(env.Path, "C:/Windows/System32");
});

test("launcher refuses non-absolute Pi command fallback", () => {
	assert.throws(() => launchPiRpcThread(createThread(), { getCommand: () => ({ command: "pi", args: [] }), spawn: (() => { throw new Error("should not spawn"); }) as never }), /non-absolute command/);
});

test("launcher consumes child spawn errors when pid is missing", () => {
	const child = createFakeChild();
	delete (child as { pid?: number }).pid;
	assert.throws(
		() => launchPiRpcThread(createThread(), { getCommand: () => ({ command: "/bin/pi", args: [] }), spawn: (() => child) as never }),
		/pid/,
	);
	assert.doesNotThrow(() => child.emit("error", new Error("spawn failed")));
});

test("launcher allows configured PATH launch command override", () => {
	const child = createFakeChild();
	let spawnedCommand = "";
	let spawnedArgs: string[] = [];
	launchPiRpcThread(createThread(), {
		getCommand: () => ({ command: "pnpx", args: ["tsx", "/opt/pi/dist/cli.js"], allowPathCommand: true }),
		spawn: ((command: string, args: string[]) => {
			spawnedCommand = command;
			spawnedArgs = args;
			return child;
		}) as never,
	});
	assert.equal(spawnedCommand, "pnpx");
	assert.deepEqual(spawnedArgs, ["tsx", "/opt/pi/dist/cli.js"]);
});

test("launcher forwards child UI requests through handler", async () => {
	const child = createFakeChild();
	launchPiRpcThread(createThread(), {
		getCommand: () => ({ command: "/bin/pi", args: [] }),
		spawn: (() => child) as never,
		onUiRequest: (request) => ({ value: request.id }),
	});
	child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "confirm" })}\n`));
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(JSON.parse(child.writes[0]), { type: "extension_ui_response", id: "ui-1", value: "ui-1" });
});

test("RPC args use launch profile model", () => {
	assert.deepEqual(buildPiRpcArgs(createThread({ launchProfile: { cwd: process.cwd(), extensionLoading: "inherit", approvalMode: "ask", inheritedFromParent: true, model: "openai/profile" } })).slice(-2), ["--model", "openai/profile"]);
});

test("RPC args resume stored session after restart", () => {
	const args = buildPiRpcArgs(createThread({
		restartCount: 1,
		sessionFile: "/tmp/thread-session/session.jsonl",
		safetyPolicy: { worktreeMode: "isolated_required", queuePolicy: "reject_when_running", githubWritePolicy: "ask", forceKillPolicy: "deny", restartPolicy: { mode: "from_session", maxRestarts: 1, backoffSeconds: 0, allowWhenOperationUnknown: false } },
	}));
	assert.deepEqual(args.slice(0, 6), ["--mode", "rpc", "--session-dir", "/tmp/thread-session", "--session", "/tmp/thread-session/session.jsonl"]);
});

test("local pi spawn resolver uses package bin script", () => {
	const command = getPiSpawnCommand(["--mode", "rpc"], {
		config: { launchArgs: [], childEnv: {} },
		execPath: "C:/node/node.exe",
		argv1: undefined,
		resolvePackageJson: () => "C:/pi/package.json",
		readFileSync: () => JSON.stringify({ bin: { pi: "dist/cli.js" } }),
		existsSync: (filePath) => filePath.replace(/\\/g, "/") === "C:/pi/dist/cli.js",
	});
	assert.equal(command.command, "C:/node/node.exe");
	assert.deepEqual(command.args.map((arg) => arg.replace(/\\/g, "/")), ["C:/pi/dist/cli.js", "--mode", "rpc"]);
});

test("local pi spawn resolver ignores the tsx daemon launcher", () => {
	const command = getPiSpawnCommand(["--mode", "rpc"], {
		config: { launchArgs: [], childEnv: {} },
		execPath: "/node/node",
		argv1: "/extension/node_modules/tsx/dist/cli.mjs",
		resolvePackageJson: () => "/opt/pi/package.json",
		readFileSync: (filePath) => {
			if (filePath === "/extension/node_modules/tsx/package.json") return JSON.stringify({ name: "tsx", bin: { tsx: "dist/cli.mjs" } });
			if (filePath === "/opt/pi/package.json") return JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/cli.js" } });
			throw new Error(`unexpected read ${filePath}`);
		},
		existsSync: (filePath) => filePath === "/opt/pi/dist/cli.js" || filePath === "/extension/node_modules/tsx/dist/cli.mjs",
	});
	assert.equal(command.command, "/node/node");
	assert.deepEqual(command.args, ["/opt/pi/dist/cli.js", "--mode", "rpc"]);
});

test("thread-manager config defaults when config file is absent", () => {
	const config = loadThreadManagerConfig({ configPath: "/missing/config.json", existsSync: () => false });
	assert.deepEqual(config, { launchArgs: [], childEnv: {} });
});

test("thread-manager config parses launch command and args", () => {
	const config = loadThreadManagerConfig({
		configPath: "/config.json",
		existsSync: () => true,
		readFileSync: () => JSON.stringify({ launchCommand: " pnpx ", launchArgs: ["tsx", "--tsconfig", "/tmp/tsconfig.json"] }),
	});
	assert.deepEqual(config, { launchCommand: "pnpx", launchArgs: ["tsx", "--tsconfig", "/tmp/tsconfig.json"], childEnv: {} });
});

test("thread-manager config parses child env flags", () => {
	const config = loadThreadManagerConfig({
		configPath: "/config.json",
		existsSync: () => true,
		readFileSync: () => JSON.stringify({ launchArgs: [], childEnv: { PI_SUBAGENT_CHILD: "1" } }),
	});
	assert.deepEqual(config.childEnv, { PI_SUBAGENT_CHILD: "1" });
});

test("thread-manager config rejects non-PI child env keys", () => {
	const errors: string[] = [];
	const config = loadThreadManagerConfig({
		configPath: "/config.json",
		existsSync: () => true,
		readFileSync: () => JSON.stringify({ childEnv: { NOT_PI: "1" } }),
		onError: (message) => errors.push(message),
	});
	assert.deepEqual(config, { launchArgs: [], childEnv: {} });
	assert.equal(errors.length, 1);
});

test("thread-manager config falls back on invalid launch args", () => {
	const errors: string[] = [];
	const config = loadThreadManagerConfig({
		configPath: "/config.json",
		existsSync: () => true,
		readFileSync: () => JSON.stringify({ launchCommand: "pnpx", launchArgs: ["tsx", 1] }),
		onError: (message) => errors.push(message),
	});
	assert.deepEqual(config, { launchArgs: [], childEnv: {} });
	assert.equal(errors.length, 1);
});

test("configured pi spawn command wraps resolved Pi CLI script", () => {
	const command = getPiSpawnCommand(["--mode", "rpc"], {
		config: { launchCommand: "pnpx", launchArgs: ["tsx"], childEnv: {} },
		execPath: "/node/node",
		argv1: undefined,
		resolvePackageJson: () => "/opt/pi/package.json",
		readFileSync: () => JSON.stringify({ bin: { pi: "dist/cli.js" } }),
		existsSync: (filePath) => filePath === "/opt/pi/dist/cli.js",
	});
	assert.equal(command.command, "pnpx");
	assert.equal(command.allowPathCommand, true);
	assert.deepEqual(command.args, ["tsx", "/opt/pi/dist/cli.js", "--mode", "rpc"]);
});

test("configured pi spawn command resolves package root from exported entry", () => {
	const command = getPiSpawnCommand(["--mode", "rpc"], {
		config: { launchCommand: "pnpx", launchArgs: ["tsx"], childEnv: {} },
		execPath: "/node/node",
		argv1: undefined,
		resolvePackageJson: () => { throw new Error("package.json not exported"); },
		resolvePackageEntry: () => "/opt/pi/dist/index.js",
		readFileSync: (filePath) => {
			if (filePath === "/opt/pi/package.json") return JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/cli.js" } });
			throw new Error(`unexpected read ${filePath}`);
		},
		existsSync: (filePath) => filePath === "/opt/pi/dist/cli.js",
	});
	assert.equal(command.command, "pnpx");
	assert.deepEqual(command.args, ["tsx", "/opt/pi/dist/cli.js", "--mode", "rpc"]);
});

test("configured pi spawn command resolves package root from extension node_modules", () => {
	const command = getPiSpawnCommand(["--mode", "rpc"], {
		config: { launchCommand: "pnpx", launchArgs: ["tsx"], childEnv: {} },
		execPath: "/node/node",
		argv1: undefined,
		moduleSearchStartDir: "/extension/src/pi",
		resolvePackageJson: () => { throw new Error("package.json not exported"); },
		readFileSync: (filePath) => {
			if (filePath === "/extension/node_modules/@earendil-works/pi-coding-agent/package.json") return JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/cli.js" } });
			throw new Error(`unexpected read ${filePath}`);
		},
		existsSync: (filePath) => filePath === "/extension/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
	});
	assert.equal(command.command, "pnpx");
	assert.deepEqual(command.args, ["tsx", "/extension/node_modules/@earendil-works/pi-coding-agent/dist/cli.js", "--mode", "rpc"]);
});

function createThread(overrides: Partial<ManagedThread> = {}): ManagedThread {
	const now = "2026-01-01T00:00:00.000Z";
	return {
		id: "thread-1",
		status: "idle",
		cwd: process.cwd(),
		tags: [],
		createdAt: now,
		updatedAt: now,
		createdBy: "test",
		...overrides,
		launchProfile: { cwd: process.cwd(), extensionLoading: "inherit", approvalMode: "ask", inheritedFromParent: true, ...overrides.launchProfile },
		safetyPolicy: { worktreeMode: "isolated_required", queuePolicy: "reject_when_running", githubWritePolicy: "ask", forceKillPolicy: "deny", restartPolicy: { mode: "manual", maxRestarts: 0, backoffSeconds: 30, allowWhenOperationUnknown: false }, ...overrides.safetyPolicy },
	};
}

function createFakeChild(): EventEmitter & { pid: number; stdout: EventEmitter; stderr: { resume: () => void; pipe: () => void }; stdin: { write: (chunk: string | Buffer) => boolean }; writes: string[] } {
	const child = new EventEmitter() as EventEmitter & { pid: number; stdout: EventEmitter; stderr: { resume: () => void; pipe: () => void }; stdin: { write: (chunk: string | Buffer) => boolean }; writes: string[] };
	child.pid = 123;
	child.stdout = new EventEmitter();
	child.stderr = { resume: () => undefined, pipe: () => undefined };
	child.writes = [];
	child.stdin = { write: (chunk) => { child.writes.push(String(chunk).trim()); return true; } };
	return child;
}
