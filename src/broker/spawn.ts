import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isProviderCredentialEnvKey } from "../provider-env.ts";
import { getBrokerPidPath, getBrokerSocketPath, getBrokerSpawnLockPath, getThreadManagerDir } from "./paths.ts";

type BrokerLaunchSpec =
	| { kind: "direct"; command: string; args: string[] }
	| { kind: "windows-launcher"; command: string; args: string[]; launcherPath: string; launcherCommandLine: string };

const EXTENSION_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function getTsxCliPath(extensionDir = EXTENSION_DIR): string {
	for (const candidate of [
		path.join(extensionDir, "node_modules", "tsx", "dist", "cli.mjs"),
		path.join(path.dirname(extensionDir), "node_modules", "tsx", "dist", "cli.mjs"),
	]) {
		if (existsSync(candidate)) return candidate;
	}
	return path.join(extensionDir, "node_modules", "tsx", "dist", "cli.mjs");
}

export function getWindowsHiddenLauncherPath(managerDir = getThreadManagerDir()): string {
	return path.join(managerDir, "broker-launch.vbs");
}

export function getWindowsHiddenLauncherScript(commandLine: string): string {
	return [
		'Set WshShell = CreateObject("WScript.Shell")',
		`WshShell.Run "${commandLine.replace(/"/g, '""')}", 0, False`,
		'Set WshShell = Nothing',
		'',
	].join("\r\n");
}

export function getBrokerLaunchSpec(
	brokerPath: string,
	platform: NodeJS.Platform = process.platform,
	extensionDir = EXTENSION_DIR,
	managerDir = getThreadManagerDir(),
	nodePath = process.execPath,
): BrokerLaunchSpec {
	if (platform === "win32") {
		const launcherPath = getWindowsHiddenLauncherPath(managerDir);
		return {
			kind: "windows-launcher",
			command: "wscript.exe",
			args: [launcherPath],
			launcherPath,
			launcherCommandLine: [nodePath, getTsxCliPath(extensionDir), brokerPath].map(quoteWindowsArg).join(" "),
		};
	}
	return { kind: "direct", command: nodePath, args: [getTsxCliPath(extensionDir), brokerPath] };
}

export async function spawnBrokerIfNeeded(options: { homeDir?: string; platform?: NodeJS.Platform; extensionDir?: string; timeoutMs?: number } = {}): Promise<void> {
	const homeDir = options.homeDir;
	const platform = options.platform ?? process.platform;
	const managerDir = getThreadManagerDir(homeDir);
	mkdirSync(managerDir, { recursive: true, mode: 0o700 });
	if (await isBrokerRunning(homeDir, platform)) return;
	if (!acquireSpawnLock(getBrokerSpawnLockPath(homeDir))) {
		await waitForBroker(homeDir, platform, options.timeoutMs);
		return;
	}
	try {
		if (await isBrokerRunning(homeDir, platform)) return;
		const brokerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "broker.ts");
		const launch = getBrokerLaunchSpec(brokerPath, platform, options.extensionDir, managerDir);
		if (launch.kind === "windows-launcher") writeFileSync(launch.launcherPath, getWindowsHiddenLauncherScript(launch.launcherCommandLine), "utf8");
		const child = spawn(launch.command, launch.args, { cwd: options.extensionDir ?? EXTENSION_DIR, detached: true, stdio: "ignore", windowsHide: true, env: buildBrokerEnv(process.env, homeDir) });
		child.unref();
		await waitForBroker(homeDir, platform, options.timeoutMs);
	} finally {
		releaseSpawnLock(getBrokerSpawnLockPath(homeDir));
	}
}

export async function isBrokerRunning(homeDir?: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
	if (await checkSocketConnectable(getBrokerSocketPath(platform, homeDir))) return true;
	const pidPath = getBrokerPidPath(homeDir);
	if (!existsSync(pidPath)) return false;
	try {
		const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
		if (!Number.isInteger(pid)) return false;
		process.kill(pid, 0);
		return checkSocketConnectable(getBrokerSocketPath(platform, homeDir));
	} catch {
		return false;
	}
}

async function waitForBroker(homeDir?: string, platform: NodeJS.Platform = process.platform, timeoutMs = 5000): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (await isBrokerRunning(homeDir, platform)) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Thread manager broker failed to start within timeout");
}

function checkSocketConnectable(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect(socketPath);
		const timeout = setTimeout(() => done(false), 500);
		const done = (connected: boolean) => {
			clearTimeout(timeout);
			socket.destroy();
			resolve(connected);
		};
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

function acquireSpawnLock(lockPath: string): boolean {
	try {
		writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, { flag: "wx", mode: 0o600 });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (isSpawnLockStale(lockPath)) {
			try {
				unlinkSync(lockPath);
			} catch {}
			return acquireSpawnLock(lockPath);
		}
		return false;
	}
}

function isSpawnLockStale(lockPath: string): boolean {
	try {
		const [pidLine = "", createdAtLine = "0"] = readFileSync(lockPath, "utf8").split("\n");
		const pid = Number.parseInt(pidLine, 10);
		const createdAt = Number.parseInt(createdAtLine, 10);
		try {
			if (Number.isInteger(pid)) {
				process.kill(pid, 0);
				return false;
			}
		} catch {
			return true;
		}
		return !Number.isFinite(createdAt);
	} catch {
		return true;
	}
}

function releaseSpawnLock(lockPath: string): void {
	try {
		unlinkSync(lockPath);
	} catch {}
}

function quoteWindowsArg(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

export function buildBrokerEnv(source: NodeJS.ProcessEnv = process.env, homeDir?: string): NodeJS.ProcessEnv {
	const allowed = new Set(["path", "systemroot", "windir", "home", "userprofile", "appdata", "localappdata", "tmp", "temp", "lang", "lc_all", "ci", "gh_token", "github_token"]);
	const env: NodeJS.ProcessEnv = { NODE_NO_WARNINGS: "1" };
	if (homeDir) env.PI_THREAD_MANAGER_HOME = homeDir;
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined || (!allowed.has(key.toLowerCase()) && !isProviderCredentialEnvKey(key))) continue;
		if (key !== "GH_TOKEN" && key !== "GITHUB_TOKEN" && !isProviderCredentialEnvKey(key) && /(TOKEN|SECRET|AUTHORIZATION|PASSWORD|CREDENTIAL|KEY)$/i.test(key)) continue;
		env[key] = value;
	}
	return env;
}
