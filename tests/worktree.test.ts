import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ThreadWorktreeManager } from "../src/worktree/thread-worktrees.ts";
import type { ExecResult, GitExec } from "../src/worktree/git.ts";

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

test("cleanup removes clean allocated worktree and branch when merged into HEAD", async () => {
	const repo = await createGitRepo();
	const manager = new ThreadWorktreeManager({ processInspector: async () => [] });
	const allocated = await manager.createAllocation(await manager.prepareAllocation(repo, { threadId: "thread-clean", name: "cleanup" }));
	const result = await manager.cleanupWorktree(allocated);
	assert.equal(result.state, "removed");
	assert.equal(await exists(allocated.worktreeRoot), false);
	assert.notEqual((await git(repo, ["show-ref", "--verify", `refs/heads/${allocated.branchName}`])).code, 0);
});

test("cleanup removes locally unmerged branch reachable from fork remote-tracking branch", async () => {
	const repo = await createGitRepo();
	const fork = await createBareGitRepo();
	const manager = new ThreadWorktreeManager({ processInspector: async () => [] });
	const allocated = await manager.createAllocation(await manager.prepareAllocation(repo, { threadId: "thread-remote", name: "cleanup" }));
	await fs.writeFile(path.join(allocated.worktreeRoot, "remote.txt"), "remote-backed\n", "utf8");
	await gitOk(allocated.worktreeRoot, ["add", "remote.txt"]);
	await gitOk(allocated.worktreeRoot, ["commit", "-m", "remote backed"]);
	await gitOk(repo, ["remote", "add", "fork", fork]);
	await gitOk(repo, ["push", "fork", `${allocated.branchName}:refs/heads/${allocated.branchName}`]);
	await gitOk(repo, ["fetch", "fork"]);
	await fs.mkdir(path.dirname(path.join(repo, allocated.branchName)), { recursive: true });
	await fs.writeFile(path.join(repo, allocated.branchName), "path collides with branch name\n", "utf8");
	await gitOk(repo, ["add", allocated.branchName]);
	await gitOk(repo, ["commit", "-m", "add branch name path"]);

	const result = await manager.cleanupWorktree(allocated);
	assert.equal(result.state, "removed");
	assert.equal(await exists(allocated.worktreeRoot), false);
	assert.notEqual((await git(repo, ["show-ref", "--verify", `refs/heads/${allocated.branchName}`])).code, 0);
	assert.equal((await git(repo, ["show-ref", "--verify", `refs/remotes/fork/${allocated.branchName}`])).code, 0);
});

test("cleanup refuses locally unmerged branch when only a stale remote-tracking ref contains it", async () => {
	const repo = await createGitRepo();
	const fork = await createBareGitRepo();
	const manager = new ThreadWorktreeManager({ processInspector: async () => [] });
	const allocated = await manager.createAllocation(await manager.prepareAllocation(repo, { threadId: "thread-stale-remote", name: "cleanup" }));
	await fs.writeFile(path.join(allocated.worktreeRoot, "remote.txt"), "remote-backed\n", "utf8");
	await gitOk(allocated.worktreeRoot, ["add", "remote.txt"]);
	await gitOk(allocated.worktreeRoot, ["commit", "-m", "remote backed"]);
	await gitOk(repo, ["remote", "add", "fork", fork]);
	await gitOk(repo, ["push", "fork", `${allocated.branchName}:refs/heads/${allocated.branchName}`]);
	await gitOk(repo, ["fetch", "fork"]);
	await gitOk(repo, ["push", "fork", `:refs/heads/${allocated.branchName}`]);
	const branchTip = await gitOk(repo, ["rev-parse", `refs/heads/${allocated.branchName}`]);
	await gitOk(repo, ["update-ref", `refs/remotes/fork/${allocated.branchName}`, branchTip.stdout.trim()]);
	assert.equal((await git(repo, ["show-ref", "--verify", `refs/remotes/fork/${allocated.branchName}`])).code, 0);

	const result = await manager.cleanupWorktree(allocated);
	assert.equal(result.state, "manual_action_required");
	assert.match(result.message, /not merged into HEAD or reachable from any remote-tracking branch/);
	assert.equal(await exists(allocated.worktreeRoot), true);
	assert.equal((await git(repo, ["show-ref", "--verify", `refs/heads/${allocated.branchName}`])).code, 0);
	assert.notEqual((await git(repo, ["show-ref", "--verify", `refs/remotes/fork/${allocated.branchName}`])).code, 0);
});

test("cleanup refuses locally unmerged branch when remote refresh fails", async () => {
	const repo = await createGitRepo();
	const fork = await createBareGitRepo();
	const missingRemote = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "missing-remote-")), "deleted.git");
	const manager = new ThreadWorktreeManager({ processInspector: async () => [] });
	const allocated = await manager.createAllocation(await manager.prepareAllocation(repo, { threadId: "thread-refresh-fails", name: "cleanup" }));
	await fs.writeFile(path.join(allocated.worktreeRoot, "remote.txt"), "remote-backed\n", "utf8");
	await gitOk(allocated.worktreeRoot, ["add", "remote.txt"]);
	await gitOk(allocated.worktreeRoot, ["commit", "-m", "remote backed"]);
	await gitOk(repo, ["remote", "add", "fork", fork]);
	await gitOk(repo, ["push", "fork", `${allocated.branchName}:refs/heads/${allocated.branchName}`]);
	await gitOk(repo, ["fetch", "fork"]);
	await gitOk(repo, ["remote", "set-url", "fork", missingRemote]);

	const result = await manager.cleanupWorktree(allocated);
	assert.equal(result.state, "manual_action_required");
	assert.match(result.message, /refreshing remote-tracking branches/);
	assert.equal(await exists(allocated.worktreeRoot), true);
	assert.equal((await git(repo, ["show-ref", "--verify", `refs/heads/${allocated.branchName}`])).code, 0);
});

test("cleanup refuses to delete a remote-backed branch when its tip changes after safety check", async () => {
	const repo = await createGitRepo();
	const fork = await createBareGitRepo();
	let allocatedBranch = "";
	let advanced = false;
	const exec: GitExec = async (command, args, options = {}) => {
		const result = await execGit(command, args, options.cwd);
		if (!advanced && result.code === 0 && options.cwd === repo && args[0] === "worktree" && args[1] === "remove") {
			advanced = true;
			const newCommit = await gitOk(repo, ["commit-tree", "HEAD^{tree}", "-p", `refs/heads/${allocatedBranch}`, "-m", "late local work"]);
			await gitOk(repo, ["update-ref", `refs/heads/${allocatedBranch}`, newCommit.stdout.trim()]);
		}
		return result;
	};
	const manager = new ThreadWorktreeManager({ exec, processInspector: async () => [] });
	const allocated = await manager.createAllocation(await manager.prepareAllocation(repo, { threadId: "thread-race", name: "cleanup" }));
	allocatedBranch = allocated.branchName;
	await fs.writeFile(path.join(allocated.worktreeRoot, "remote.txt"), "remote-backed\n", "utf8");
	await gitOk(allocated.worktreeRoot, ["add", "remote.txt"]);
	await gitOk(allocated.worktreeRoot, ["commit", "-m", "remote backed"]);
	await gitOk(repo, ["remote", "add", "fork", fork]);
	await gitOk(repo, ["push", "fork", `${allocated.branchName}:refs/heads/${allocated.branchName}`]);
	await gitOk(repo, ["fetch", "fork"]);

	const result = await manager.cleanupWorktree(allocated);
	assert.equal(result.state, "manual_action_required");
	assert.match(result.message, /changed after cleanup safety check/);
	assert.equal(await exists(allocated.worktreeRoot), false);
	assert.equal((await git(repo, ["show-ref", "--verify", `refs/heads/${allocated.branchName}`])).code, 0);
	assert.notEqual((await git(repo, ["log", "--format=%H", `refs/heads/${allocated.branchName}`, "--not", "--remotes", "--"])).stdout.trim(), "");
});

test("cleanup refuses locally unmerged branch with commits unreachable from remotes", async () => {
	const repo = await createGitRepo();
	const manager = new ThreadWorktreeManager({ processInspector: async () => [] });
	const allocated = await manager.createAllocation(await manager.prepareAllocation(repo, { threadId: "thread-unpushed", name: "cleanup" }));
	await fs.writeFile(path.join(allocated.worktreeRoot, "unpushed.txt"), "unpushed\n", "utf8");
	await gitOk(allocated.worktreeRoot, ["add", "unpushed.txt"]);
	await gitOk(allocated.worktreeRoot, ["commit", "-m", "unpushed"]);

	const result = await manager.cleanupWorktree(allocated);
	assert.equal(result.state, "manual_action_required");
	assert.match(result.message, /not merged into HEAD or reachable from any remote-tracking branch/);
	assert.equal(await exists(allocated.worktreeRoot), true);
	assert.equal((await git(repo, ["show-ref", "--verify", `refs/heads/${allocated.branchName}`])).code, 0);
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

async function createBareGitRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "thread-git-remote-"));
	await gitOk(repo, ["init", "--bare"]);
	return await fs.realpath(repo);
}

async function gitOk(cwd: string, args: string[]): Promise<ExecResult> {
	const result = await git(cwd, args);
	if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	return result;
}

async function git(cwd: string, args: string[]): Promise<ExecResult> {
	return await execGit("git", args, cwd);
}

async function execGit(command: string, args: string[], cwd?: string): Promise<ExecResult> {
	return await new Promise((resolve) => {
		execFile(command, args, { cwd }, (error, stdout, stderr) => {
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
