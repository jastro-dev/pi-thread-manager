import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ThreadWorktreeManager } from "../src/worktree/thread-worktrees.ts";
import type { ExecResult } from "../src/worktree/git.ts";

test("allocates isolated worktree from clean source subdir", async () => {
	const repo = await createGitRepo();
	const sourceCwd = path.join(repo, "src");
	const manager = new ThreadWorktreeManager();
	const reserved = await manager.prepareAllocation(sourceCwd, { threadId: "thread-abc123", name: "Fix Reviews" });
	assert.equal(reserved.sourceRepoRoot, repo);
	assert.equal(reserved.sourceSubdir, "src");
	assert.equal(reserved.executionCwd, path.join(reserved.worktreeRoot, "src"));
	assert.match(reserved.branchName, /^thread-manager\/abc123-fix-reviews/);
	const allocated = await manager.createAllocation(reserved);
	assert.equal(allocated.allocationState, "allocated");
	assert.equal(allocated.cleanupState, "retained");
	assert.equal((await git(repo, ["rev-parse", "--verify", allocated.branchName])).code, 0);
	assert.equal(await exists(allocated.executionCwd), true);
});

test("generates suffix when branch and path already exist", async () => {
	const repo = await createGitRepo();
	const manager = new ThreadWorktreeManager();
	const first = await manager.createAllocation(await manager.prepareAllocation(repo, { threadId: "thread-same", name: "task" }));
	const second = await manager.prepareAllocation(repo, { threadId: "thread-same", name: "task" });
	assert.notEqual(second.branchName, first.branchName);
	assert.match(second.branchName, /-2$/);
});

test("rejects non-git, dirty source, detached source without baseRef, and invalid base", async () => {
	const manager = new ThreadWorktreeManager();
	const nonGit = await fs.mkdtemp(path.join(os.tmpdir(), "thread-non-git-"));
	await assert.rejects(() => manager.prepareAllocation(nonGit, { threadId: "thread-1" }), /not a git repository|rev-parse/);

	const dirty = await createGitRepo();
	await fs.writeFile(path.join(dirty, "dirty.txt"), "dirty", "utf8");
	await assert.rejects(() => manager.prepareAllocation(dirty, { threadId: "thread-1" }), /uncommitted changes/);

	const detached = await createGitRepo();
	await gitOk(detached, ["checkout", "--detach", "HEAD"]);
	await assert.rejects(() => manager.prepareAllocation(detached, { threadId: "thread-1" }), /detached/);
	await assert.rejects(() => manager.prepareAllocation(detached, { threadId: "thread-1", baseRef: "missing-ref" }), /rev-parse/);
});

test("cleanup removes clean allocated worktree and branch", async () => {
	const repo = await createGitRepo();
	const manager = new ThreadWorktreeManager({ processInspector: async () => [] });
	const allocated = await manager.createAllocation(await manager.prepareAllocation(repo, { threadId: "thread-clean", name: "cleanup" }));
	const result = await manager.cleanupWorktree(allocated);
	assert.equal(result.state, "removed");
	assert.equal(await exists(allocated.worktreeRoot), false);
	assert.notEqual((await git(repo, ["show-ref", "--verify", `refs/heads/${allocated.branchName}`])).code, 0);
});

test("cleanup refuses dirty worktrees", async () => {
	const repo = await createGitRepo();
	const manager = new ThreadWorktreeManager({ processInspector: async () => [] });
	const allocated = await manager.createAllocation(await manager.prepareAllocation(repo, { threadId: "thread-dirty", name: "cleanup" }));
	await fs.writeFile(path.join(allocated.worktreeRoot, "dirty.txt"), "dirty", "utf8");
	const result = await manager.cleanupWorktree(allocated);
	assert.equal(result.state, "manual_action_required");
	assert.match(result.message, /uncommitted changes/);
	assert.equal(await exists(allocated.worktreeRoot), true);
});

test("cleanup refuses non-manager-owned worktree metadata", async () => {
	const repo = await createGitRepo();
	const manager = new ThreadWorktreeManager({ processInspector: async () => [] });
	const allocated = await manager.createAllocation(await manager.prepareAllocation(repo, { threadId: "thread-owned", name: "cleanup" }));
	const result = await manager.cleanupWorktree({ ...allocated, branchName: "feature/not-owned" });
	assert.equal(result.state, "manual_action_required");
	assert.match(result.message, /not manager-owned/);
});

test("cleanup refuses worktrees without manager ownership marker", async () => {
	const repo = await createGitRepo();
	const manager = new ThreadWorktreeManager({ processInspector: async () => [] });
	const allocated = await manager.createAllocation(await manager.prepareAllocation(repo, { threadId: "thread-unmarked", name: "cleanup" }));
	await fs.rm(path.join(await gitDir(allocated.worktreeRoot), "pi-thread-manager-worktree.json"));
	const result = await manager.cleanupWorktree(allocated);
	assert.equal(result.state, "manual_action_required");
	assert.match(result.message, /ownership marker is missing/);
});

test("inspection refuses unknown occupancy", async () => {
	const repo = await createGitRepo();
	const creator = new ThreadWorktreeManager({ processInspector: async () => [] });
	const allocated = await creator.createAllocation(await creator.prepareAllocation(repo, { threadId: "thread-unknown", name: "inspect" }));
	const inspector = new ThreadWorktreeManager({ processInspector: async () => { throw new Error("process scan unavailable"); } });
	const result = await inspector.inspectWorktree(allocated);
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.reason, /occupancy is unknown/);
});

test("default Windows occupancy inspection does not block cleanup", async () => {
	const repo = await createGitRepo();
	const manager = new ThreadWorktreeManager({ platform: "win32" });
	const allocated = await manager.createAllocation(await manager.prepareAllocation(repo, { threadId: "thread-win", name: "cleanup" }));
	assert.deepEqual(await manager.inspectWorktree(allocated), { ok: true });
	const result = await manager.cleanupWorktree(allocated);
	assert.equal(result.state, "removed");
});

async function createGitRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "thread-git-"));
	await gitOk(repo, ["init", "-b", "main"]);
	await gitOk(repo, ["config", "user.email", "test@example.com"]);
	await gitOk(repo, ["config", "user.name", "Test User"]);
	await fs.mkdir(path.join(repo, "src"));
	await fs.writeFile(path.join(repo, "src", "file.txt"), "hello\n", "utf8");
	await gitOk(repo, ["add", "."]);
	await gitOk(repo, ["commit", "-m", "initial"]);
	return await fs.realpath(repo);
}

async function gitOk(cwd: string, args: string[]): Promise<ExecResult> {
	const result = await git(cwd, args);
	if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	return result;
}

async function git(cwd: string, args: string[]): Promise<ExecResult> {
	return await new Promise((resolve) => {
		execFile("git", args, { cwd }, (error, stdout, stderr) => {
			const errorCode = (error as NodeJS.ErrnoException | null)?.code;
			const code = typeof errorCode === "number" ? errorCode : error ? 1 : 0;
			resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

async function gitDir(cwd: string): Promise<string> {
	const result = await gitOk(cwd, ["rev-parse", "--git-dir"]);
	const gitDirPath = result.stdout.trim();
	return path.isAbsolute(gitDirPath) ? gitDirPath : path.resolve(cwd, gitDirPath);
}

async function exists(targetPath: string): Promise<boolean> {
	try {
		await fs.access(targetPath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
