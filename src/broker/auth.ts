import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type CapabilityToken, type ThreadAction } from "../types.ts";
import { validateCapability } from "../protocol.ts";
import { getAuthRootPath, getThreadManagerDir } from "./paths.ts";

interface AuthRootFile {
	rootToken: string;
	createdAt: string;
	tokens: CapabilityToken[];
}

export function loadOrCreateAuthRoot(homeDir?: string): AuthRootFile {
	const authPath = getAuthRootPath(homeDir);
	mkdirSync(path.dirname(authPath), { recursive: true, mode: 0o700 });
	try {
		return readAuthRoot(authPath);
	} catch (error) {
		if (!isMissingFileError(error)) return readAuthRootWithRetry(authPath);
	}
	const now = new Date().toISOString();
	const rootToken = randomToken();
	const root: AuthRootFile = {
		rootToken,
		createdAt: now,
		tokens: [{ id: "root", secret: rootToken, clientId: "owner", actions: "all" }],
	};
	try {
		writeFileSync(authPath, `${JSON.stringify(root, null, "\t")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	} catch (error) {
		if (isExistingFileError(error)) return readAuthRootWithRetry(authPath);
		throw error;
	}
	return root;
}

export function getRootToken(homeDir?: string): string {
	return loadOrCreateAuthRoot(homeDir).rootToken;
}

export function authorizeSecret(
	secret: string | undefined,
	request: { action: ThreadAction; threadId?: string; cwd?: string; now?: Date },
	homeDir?: string,
): { allowed: true } | { allowed: false; reason: string } {
	if (!secret) return { allowed: false, reason: "missing daemon capability token" };
	const root = loadOrCreateAuthRoot(homeDir);
	for (const token of root.tokens) {
		if (!constantTimeEqual(secret, token.secret)) continue;
		const legality = validateCapability(token, token.secret, request);
		return legality.allowed ? { allowed: true } : { allowed: false, reason: legality.reason ?? "capability denied" };
	}
	return { allowed: false, reason: "invalid daemon capability token" };
}

export function redactAuthRoot(value: string): string {
	try {
		return redactAuthSecrets(value);
	} catch {
		return value;
	}
}

export function redactAuthSecrets(value: string, homeDir?: string): string {
	let redacted = value;
	try {
		const root = readExistingAuthRoot(homeDir);
		if (!root) return redacted;
		for (const token of [root.rootToken, ...root.tokens.map((entry) => entry.secret)]) {
			redacted = redacted.split(token).join("[redacted-daemon-token]");
		}
	} catch {}
	return redacted;
}

export function getAuthRootDirectory(homeDir?: string): string {
	return getThreadManagerDir(homeDir);
}

function randomToken(): string {
	return randomBytes(32).toString("base64url");
}

function readAuthRoot(authPath: string): AuthRootFile {
	const parsed = JSON.parse(readFileSync(authPath, "utf8")) as AuthRootFile;
	if (!parsed.rootToken || !Array.isArray(parsed.tokens)) throw new Error(`Invalid thread manager auth root: ${authPath}`);
	return parsed;
}

function readExistingAuthRoot(homeDir?: string): AuthRootFile | undefined {
	try {
		return readAuthRoot(getAuthRootPath(homeDir));
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		throw error;
	}
}

function readAuthRootWithRetry(authPath: string): AuthRootFile {
	let lastError: unknown;
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			return readAuthRoot(authPath);
		} catch (error) {
			lastError = error;
			sleepSync(10);
		}
	}
	throw lastError;
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isExistingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function constantTimeEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	if (leftBytes.length !== rightBytes.length) return false;
	return timingSafeEqual(leftBytes, rightBytes);
}
