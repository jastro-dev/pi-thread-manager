import os from "node:os";
import path from "node:path";

function sanitizePipeSegment(value: string): string {
	return value
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase() || "default";
}

export function getThreadManagerDir(homeDir: string = os.homedir()): string {
	return path.join(homeDir, ".pi", "agent", "thread-manager");
}

export function getThreadStorePath(homeDir: string = os.homedir()): string {
	return path.join(getThreadManagerDir(homeDir), "threads.json");
}

export function getLastKnownGoodStorePath(homeDir: string = os.homedir()): string {
	return path.join(getThreadManagerDir(homeDir), "threads.last-good.json");
}

export function getAuthRootPath(homeDir: string = os.homedir()): string {
	return path.join(getThreadManagerDir(homeDir), "auth-root.json");
}

export function getBrokerPidPath(homeDir: string = os.homedir()): string {
	return path.join(getThreadManagerDir(homeDir), "broker.pid");
}

export function getBrokerSpawnLockPath(homeDir: string = os.homedir()): string {
	return path.join(getThreadManagerDir(homeDir), "broker.spawn.lock");
}

export function getBrokerSocketPath(platform: NodeJS.Platform = process.platform, homeDir: string = os.homedir()): string {
	if (platform === "win32") return `\\\\.\\pipe\\pi-thread-manager-${sanitizePipeSegment(homeDir)}`;
	return path.join(getThreadManagerDir(homeDir), "broker.sock");
}

export function getThreadDirectory(threadId: string, homeDir: string = os.homedir()): string {
	return path.join(getThreadManagerDir(homeDir), "threads", threadId);
}

export function getThreadLogPath(threadId: string, homeDir: string = os.homedir()): string {
	return path.join(getThreadDirectory(threadId, homeDir), "thread.log");
}

export function getThreadSessionDir(threadId: string, homeDir: string = os.homedir()): string {
	return path.join(getThreadDirectory(threadId, homeDir), "sessions");
}
