import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { loadOrCreateAuthRoot, redactAuthSecrets } from "../src/broker/auth.ts";
import { getAuthRootPath } from "../src/broker/paths.ts";

const execFileAsync = promisify(execFile);

test("auth root concurrent creators return persisted token", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-auth-"));
	const script = `import { getRootToken } from ${JSON.stringify(new URL("../src/broker/auth.ts", import.meta.url).href)}; console.log(getRootToken(process.argv[1]));`;
	const children = await Promise.all(Array.from({ length: 8 }, () => execFileAsync(process.execPath, ["--import", "tsx", "--eval", script, root], { cwd: process.cwd() })));
	const tokens = children.map((child) => child.stdout.trim());
	const persisted = loadOrCreateAuthRoot(root).rootToken;
	assert.deepEqual(new Set(tokens), new Set([persisted]));
});

test("redaction does not create auth root", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-auth-redact-"));
	assert.equal(redactAuthSecrets("no token here", root), "no token here");
	await assert.rejects(() => fs.stat(getAuthRootPath(root)), /ENOENT/);
});
