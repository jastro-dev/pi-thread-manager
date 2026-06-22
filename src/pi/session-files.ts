import { promises as fs } from "node:fs";
import path from "node:path";

import { getThreadDirectory, getThreadLogPath, getThreadSessionDir } from "../broker/paths.ts";

export interface ThreadPaths {
	threadDir: string;
	logFile: string;
	sessionDir: string;
}

export async function ensureThreadPaths(threadId: string, homeDir?: string): Promise<ThreadPaths> {
	const threadDir = getThreadDirectory(threadId, homeDir);
	const logFile = getThreadLogPath(threadId, homeDir);
	const sessionDir = getThreadSessionDir(threadId, homeDir);
	return ensurePaths(threadDir, logFile, sessionDir);
}

export async function ensureThreadPathsForManager(threadId: string, managerDir: string): Promise<ThreadPaths> {
	const threadDir = path.join(managerDir, "threads", threadId);
	const logFile = path.join(threadDir, "thread.log");
	const sessionDir = path.join(threadDir, "sessions");
	return ensurePaths(threadDir, logFile, sessionDir);
}

async function ensurePaths(threadDir: string, logFile: string, sessionDir: string): Promise<ThreadPaths> {
	await fs.mkdir(threadDir, { recursive: true, mode: 0o700 });
	await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
	return { threadDir, logFile, sessionDir };
}
