import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream } from "node:fs";
import path from "node:path";

import { loadThreadManagerConfig } from "../config.ts";
import { isProviderCredentialEnvKey } from "../provider-env.ts";
import type { ManagedThread } from "../types.ts";
import { getPiSpawnCommand, type PiSpawnCommand } from "./pi-spawn.ts";
import { PiRpcClient, type ChildRpcPort, type PiRpcUiRequest } from "./rpc-client.ts";

export interface LaunchedThreadProcess {
	pid: number;
	startedAt: string;
	rpc: ChildRpcPort;
	child?: ChildProcessWithoutNullStreams;
}

export interface LaunchDeps {
	spawn?: typeof spawn;
	getCommand?: (args: string[]) => PiSpawnCommand;
	now?: () => Date;
	onUiRequest?: (request: PiRpcUiRequest) => unknown | Promise<unknown>;
}

export function buildPiRpcArgs(thread: ManagedThread): string[] {
	const args = ["--mode", "rpc", "--session-dir", thread.launchProfile.cwd === thread.cwd ? thread.sessionFile ? dirnameForCli(thread.sessionFile) : thread.cwd : thread.cwd];
	if ((thread.restartCount ?? 0) > 0 && thread.safetyPolicy.restartPolicy.mode === "from_session" && thread.sessionFile) {
		args.push("--session", thread.sessionFile);
	}
	const model = thread.launchProfile.model ?? thread.model;
	if (model) args.push("--model", model);
	if (thread.name) args.push("--name", thread.name);
	return args;
}

export function launchPiRpcThread(thread: ManagedThread, deps: LaunchDeps = {}): LaunchedThreadProcess {
	const now = deps.now ?? (() => new Date());
	const spawnFn = deps.spawn ?? spawn;
	const command = (deps.getCommand ?? getPiSpawnCommand)(buildPiRpcArgs(thread));
	if (!command.allowPathCommand && !path.isAbsolute(command.command)) {
		throw new Error(`Refusing to launch Pi through non-absolute command: ${command.command}`);
	}
	const child = spawnFn(command.command, command.args, {
		cwd: thread.cwd,
		env: buildSafeChildEnv(thread.id, process.env, loadThreadManagerConfig().childEnv),
		stdio: "pipe",
		windowsHide: true,
	}) as ChildProcessWithoutNullStreams;
	const consumeSpawnError = () => undefined;
	child.once("error", consumeSpawnError);
	if (!child.pid) throw new Error("Pi RPC child did not expose a pid");
	if (thread.logFile) child.stderr.pipe(createWriteStream(thread.logFile, { flags: "a" }));
	else child.stderr.resume();
	const rpc = new PiRpcClient(child, 10_000, { onUiRequest: deps.onUiRequest });
	child.off("error", consumeSpawnError);
	return { pid: child.pid, startedAt: now().toISOString(), rpc, child };
}

export function buildSafeChildEnv(threadId: string, source: NodeJS.ProcessEnv = process.env, childEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
	const allowed = new Set(["PATH", "Path", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMP", "TEMP", "LANG", "LC_ALL", "CI"]);
	const env: NodeJS.ProcessEnv = { ...childEnv, PI_THREAD_ID: threadId };
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (!allowed.has(key) && !isProviderCredentialEnvKey(key)) continue;
		if (!isProviderCredentialEnvKey(key) && /(TOKEN|SECRET|AUTHORIZATION|PASSWORD|CREDENTIAL|KEY)$/i.test(key)) continue;
		env[key] = value;
	}
	return env;
}

function dirnameForCli(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	return normalized.slice(0, normalized.lastIndexOf("/"));
}
