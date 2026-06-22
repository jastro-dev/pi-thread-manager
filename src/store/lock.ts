import { promises as fs } from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";

export interface LockOptions {
	pidExists?: (pid: number) => boolean | Promise<boolean>;
	now?: () => Date;
	sleep?: (ms: number) => Promise<void>;
	retryIntervalMs?: number;
	maxWaitMs?: number;
}

interface LockFile {
	pid: number;
	hostname: string;
	nonce: string;
	createdAt: string;
}

export async function acquireFileLock(lockPath: string, options: LockOptions = {}): Promise<() => Promise<void>> {
	const now = options.now ?? (() => new Date());
	const sleep = options.sleep ?? defaultSleep;
	const retryIntervalMs = options.retryIntervalMs ?? 50;
	const maxWaitMs = options.maxWaitMs ?? 5000;
	const pidExists = options.pidExists ?? defaultPidExists;
	const startedAt = Date.now();
	const lock: LockFile = {
		pid: process.pid,
		hostname: os.hostname(),
		nonce: randomUUID(),
		createdAt: now().toISOString(),
	};

	for (;;) {
		try {
			await fs.writeFile(lockPath, JSON.stringify(lock), { flag: "wx", mode: 0o600 });
			return async () => {
				try {
					const currentRaw = await fs.readFile(lockPath, "utf8");
					const current = JSON.parse(currentRaw) as Partial<LockFile>;
					if (current.nonce === lock.nonce && current.pid === lock.pid) await fs.unlink(lockPath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}

		if (await removeStaleLock(lockPath, pidExists)) continue;
		if (Date.now() - startedAt >= maxWaitMs) {
			throw new Error(`Timed out waiting for thread manager lock: ${lockPath}. If no Pi thread manager process is active, remove the lock manually.`);
		}
		await sleep(retryIntervalMs);
	}
}

export async function removeStaleLock(lockPath: string, pidExists: (pid: number) => boolean | Promise<boolean> = defaultPidExists): Promise<boolean> {
	let raw: string;
	try {
		raw = await fs.readFile(lockPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		return false;
	}

	let lock: Partial<LockFile>;
	try {
		lock = JSON.parse(raw) as Partial<LockFile>;
	} catch {
		return false;
	}
	const pid = lock.pid;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || typeof lock.nonce !== "string") return false;
	if (await pidExists(pid)) return false;

	try {
		const currentRaw = await fs.readFile(lockPath, "utf8");
		if (currentRaw !== raw) return false;
		await fs.unlink(lockPath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
}

export function defaultPidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function defaultSleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
