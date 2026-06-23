import { promises as fs } from "node:fs";
import path from "node:path";

import type { ThreadWorktree } from "../types.ts";
import { defaultExec, git, requireGit, type GitExec } from "./git.ts";
import { chooseThreadWorktreeNames, localBranchName, normalizePathForComparison, parseWorktreePorcelain, type WorktreeEntry } from "./names.ts";

const WORKTREE_MARKER_FILE = "pi-thread-manager-worktree.json";

export type WorktreeInspection = { ok: true } | { ok: false; reason: string; reservedExists?: boolean };
export type WorktreeCleanupResult = { state: "removed" | "manual_action_required"; message: string; cleanedAt?: string };
type BranchCleanupSafety = { safe: true; branchRef: string; expectedOid: string } | { safe: false; message: string };

export interface ProcessInfo {
	pid: number;
	ppid?: number;
	cwd?: string | null;
}

export interface ThreadWorktreeManagerDeps {
	exec?: GitExec;
	now?: () => Date;
	platform?: NodeJS.Platform;
	processInspector?: () => Promise<ProcessInfo[]>;
	currentPid?: number;
}

export class ThreadWorktreeManager {
	private readonly exec: GitExec;
	private readonly now: () => Date;
	private readonly platform: NodeJS.Platform;
	private readonly processInspector?: () => Promise<ProcessInfo[]>;
	private readonly currentPid: number;

	constructor(deps: ThreadWorktreeManagerDeps = {}) {
		this.exec = deps.exec ?? defaultExec;
		this.now = deps.now ?? (() => new Date());
		this.platform = deps.platform ?? process.platform;
		this.processInspector = deps.processInspector;
		this.currentPid = deps.currentPid ?? process.pid;
	}

	async prepareAllocation(sourceCwd: string, input: { threadId: string; name?: string; baseRef?: string }): Promise<Extract<ThreadWorktree, { mode: "isolated" }>> {
		const sourceRepoRoot = path.normalize((await requireGit(this.exec, sourceCwd, ["rev-parse", "--show-toplevel"], "git rev-parse --show-toplevel")).trim());
		const sourceSubdir = path.relative(sourceRepoRoot, sourceCwd);
		if (sourceSubdir.startsWith("..") || path.isAbsolute(sourceSubdir)) throw new Error(`source cwd is outside git repo root: ${sourceCwd}`);

		const status = await git(this.exec, sourceRepoRoot, ["status", "--porcelain"]);
		if (status.code !== 0) throw new Error(`git status failed: ${status.stderr.trim() || status.stdout.trim() || `exit code ${status.code}`}`);
		if (status.stdout.trim()) throw new Error("source worktree has uncommitted changes; commit/stash or choose a clean base");

		const branch = await git(this.exec, sourceRepoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
		if (branch.code !== 0 && !input.baseRef) throw new Error("source worktree is detached; pass baseRef explicitly to create an isolated thread");

		const baseRef = input.baseRef ?? "HEAD";
		const baseSha = (await requireGit(this.exec, sourceRepoRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`], `git rev-parse ${baseRef}`)).trim();
		const entries = await this.loadWorktrees(sourceRepoRoot);
		const primaryRepoRoot = path.normalize(entries[0]?.path ?? sourceRepoRoot);
		const existingBranches = await this.existingBranches(primaryRepoRoot);
		const existingPaths = new Set(entries.map((entry) => normalizePathForComparison(entry.path, this.platform)));
		const repoName = path.basename(primaryRepoRoot);
		const parentDir = path.dirname(primaryRepoRoot);

		for (;;) {
			const names = chooseThreadWorktreeNames({
				threadId: input.threadId,
				name: input.name,
				repoName,
				parentDir,
				existingBranches,
				existingPaths,
				platform: this.platform,
			});
			if (!(await pathExists(names.worktreeRoot))) {
				return {
					mode: "isolated",
					sourceCwd,
					sourceRepoRoot,
					sourceSubdir,
					primaryRepoRoot,
					worktreeRoot: names.worktreeRoot,
					executionCwd: path.join(names.worktreeRoot, sourceSubdir),
					branchName: names.branchName,
					baseRef,
					baseSha,
					allocationState: "reserved",
					cleanupState: "cleanup_pending",
				};
			}
			existingPaths.add(normalizePathForComparison(names.worktreeRoot, this.platform));
		}
	}

	async createAllocation(worktree: Extract<ThreadWorktree, { mode: "isolated" }>): Promise<Extract<ThreadWorktree, { mode: "isolated" }>> {
		const result = await git(this.exec, worktree.primaryRepoRoot, ["worktree", "add", "-b", worktree.branchName, worktree.worktreeRoot, worktree.baseSha]);
		if (result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
			throw new Error(`git worktree add failed: ${detail}`);
		}
		const allocated = { ...worktree, allocationState: "allocated" as const, cleanupState: "retained" as const, allocatedAt: this.now().toISOString(), lastError: undefined };
		await this.writeOwnershipMarker(allocated);
		return allocated;
	}

	async rollbackAllocation(worktree: Extract<ThreadWorktree, { mode: "isolated" }>): Promise<WorktreeCleanupResult> {
		return await this.cleanupWorktree(worktree, { allowReserved: true });
	}

	async inspectWorktree(worktree: Extract<ThreadWorktree, { mode: "isolated" }>): Promise<WorktreeInspection> {
		if (worktree.allocationState !== "reserved" && (worktree.cleanupState === "cleanup_pending" || worktree.cleanupState === "manual_action_required")) return { ok: false, reason: `worktree cleanup state is ${worktree.cleanupState}` };
		if (worktree.cleanupState === "removed") return { ok: false, reason: "worktree was removed" };
		const validation = await this.validateManagedWorktreeEntry(worktree, { requireMarker: worktree.allocationState !== "reserved", checkOccupancy: true });
		if (!validation.ok) return validation;
		if (worktree.allocationState === "reserved") return { ok: false, reason: "reserved isolated worktree exists after restart", reservedExists: true };
		return { ok: true };
	}

	async cleanupWorktree(worktree: Extract<ThreadWorktree, { mode: "isolated" }>, options: { allowReserved?: boolean } = {}): Promise<WorktreeCleanupResult> {
		if (!options.allowReserved && worktree.allocationState !== "allocated") {
			return { state: "manual_action_required", message: `cleanup requires allocated worktree; allocation state is ${worktree.allocationState}` };
		}
		const validation = await this.validateManagedWorktreeEntry(worktree, { requireMarker: !(options.allowReserved && worktree.allocationState === "reserved"), checkOccupancy: true });
		if (!validation.ok && validation.reason === "isolated worktree is missing") return await this.cleanupMissingWorktree(worktree);
		if (!validation.ok) return { state: "manual_action_required", message: validation.reason };
		const entry = validation.entry;
		if (!entry) return await this.cleanupMissingWorktree(worktree);
		const status = await git(this.exec, worktree.worktreeRoot, ["status", "--porcelain=v1", "--ignored=matching", "--untracked-files=all"]);
		if (status.code !== 0) return { state: "manual_action_required", message: `git status failed in worktree: ${status.stderr.trim() || status.stdout.trim() || `exit code ${status.code}`}` };
		const statusLines = status.stdout.split(/\r?\n/).filter(Boolean);
		if (statusLines.some((line) => !line.startsWith("!! "))) return { state: "manual_action_required", message: "worktree has uncommitted changes; inspect or commit before cleanup" };
		if (statusLines.length > 0) return { state: "manual_action_required", message: "worktree has ignored files; inspect or remove before cleanup" };
		const branchSafety = await this.branchCleanupSafety(worktree.branchName, worktree.primaryRepoRoot);
		if (!branchSafety.safe) return { state: "manual_action_required", message: branchSafety.message };

		const remove = await git(this.exec, worktree.primaryRepoRoot, ["worktree", "remove", worktree.worktreeRoot]);
		if (remove.code !== 0) return { state: "manual_action_required", message: `git worktree remove failed: ${remove.stderr.trim() || remove.stdout.trim() || `exit code ${remove.code}`}` };
		const branchDelete = await git(this.exec, worktree.primaryRepoRoot, ["update-ref", "-d", branchSafety.branchRef, branchSafety.expectedOid]);
		if (branchDelete.code !== 0) return { state: "manual_action_required", message: `branch ${worktree.branchName} changed after cleanup safety check or could not be deleted: ${branchDelete.stderr.trim() || branchDelete.stdout.trim() || `exit code ${branchDelete.code}`}` };
		return { state: "removed", message: `removed worktree ${worktree.worktreeRoot} and branch ${worktree.branchName}`, cleanedAt: this.now().toISOString() };
	}

	private async cleanupMissingWorktree(worktree: Extract<ThreadWorktree, { mode: "isolated" }>): Promise<WorktreeCleanupResult> {
		await git(this.exec, worktree.primaryRepoRoot, ["worktree", "prune"]);
		const branchExists = (await git(this.exec, worktree.primaryRepoRoot, ["show-ref", "--verify", `refs/heads/${worktree.branchName}`])).code === 0;
		if (branchExists) {
			return { state: "manual_action_required", message: `worktree path is missing; inspect and delete branch ${worktree.branchName} manually if safe` };
		}
		return { state: "removed", message: `pruned missing worktree metadata for ${worktree.worktreeRoot}`, cleanedAt: this.now().toISOString() };
	}

	private async loadWorktrees(cwd: string): Promise<WorktreeEntry[]> {
		const stdout = await requireGit(this.exec, cwd, ["worktree", "list", "--porcelain"], "git worktree list");
		const entries = parseWorktreePorcelain(stdout);
		if (entries.length === 0) throw new Error("No git worktrees found for source repository");
		return entries;
	}

	private async findEntry(worktree: Extract<ThreadWorktree, { mode: "isolated" }>): Promise<WorktreeEntry | undefined> {
		const entries = await this.loadWorktrees(worktree.primaryRepoRoot);
		const target = normalizePathForComparison(worktree.worktreeRoot, this.platform);
		return entries.find((entry) => normalizePathForComparison(entry.path, this.platform) === target);
	}

	private async existingBranches(cwd: string): Promise<Set<string>> {
		const stdout = await requireGit(this.exec, cwd, ["branch", "--format=%(refname:short)"], "git branch");
		return new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
	}

	private async branchCleanupSafety(branchName: string, cwd: string): Promise<BranchCleanupSafety> {
		const branchRef = `refs/heads/${branchName}`;
		const tip = await git(this.exec, cwd, ["rev-parse", "--verify", `${branchRef}^{commit}`]);
		if (tip.code !== 0) return { safe: false, message: `branch ${branchName} cannot be resolved: ${tip.stderr.trim() || tip.stdout.trim() || `exit code ${tip.code}`}` };
		const expectedOid = tip.stdout.trim();
		if (await this.isBranchMerged(branchRef, cwd)) return { safe: true, branchRef, expectedOid };
		const refresh = await this.refreshRemoteTrackingBranches(cwd);
		if (!refresh.ok) return { safe: false, message: refresh.message };
		const unreachableFromRemotes = await git(this.exec, cwd, ["log", "--format=%H", branchRef, "--not", "--remotes", "--"]);
		if (unreachableFromRemotes.code !== 0) return { safe: false, message: `branch ${branchName} is not merged into HEAD and remote reachability check failed: ${unreachableFromRemotes.stderr.trim() || unreachableFromRemotes.stdout.trim() || `exit code ${unreachableFromRemotes.code}`}` };
		if (!unreachableFromRemotes.stdout.trim()) return { safe: true, branchRef, expectedOid };
		return { safe: false, message: `branch ${branchName} has commits not merged into HEAD or reachable from any remote-tracking branch; cleanup refused` };
	}

	private async refreshRemoteTrackingBranches(cwd: string): Promise<{ ok: true } | { ok: false; message: string }> {
		const remotes = await git(this.exec, cwd, ["remote"]);
		if (remotes.code !== 0) return { ok: false, message: `remote reachability check failed before fetch: ${remotes.stderr.trim() || remotes.stdout.trim() || `exit code ${remotes.code}`}` };
		if (!remotes.stdout.trim()) return { ok: false, message: "branch is not merged into HEAD or reachable from any remote-tracking branch; no remotes configured for refreshed proof" };
		const fetch = await git(this.exec, cwd, ["fetch", "--all", "--prune"]);
		if (fetch.code !== 0) return { ok: false, message: `remote reachability check failed while refreshing remote-tracking branches: ${fetch.stderr.trim() || fetch.stdout.trim() || `exit code ${fetch.code}`}` };
		return { ok: true };
	}

	private async isBranchMerged(branchRef: string, cwd: string): Promise<boolean> {
		const result = await git(this.exec, cwd, ["merge-base", "--is-ancestor", branchRef, "HEAD"]);
		return result.code === 0;
	}

	private async validateManagedWorktreeEntry(worktree: Extract<ThreadWorktree, { mode: "isolated" }>, options: { requireMarker: boolean; checkOccupancy: boolean }): Promise<{ ok: true; entry: WorktreeEntry } | { ok: false; reason: string; reservedExists?: boolean }> {
		const ownershipError = this.managerOwnershipError(worktree);
		if (ownershipError) return { ok: false, reason: ownershipError };
		const entry = await this.findEntry(worktree);
		if (!entry) return { ok: false, reason: "isolated worktree is missing", reservedExists: false };
		const branch = localBranchName(entry.branch);
		if (branch !== worktree.branchName) return { ok: false, reason: `worktree branch mismatch: expected ${worktree.branchName}, found ${branch ?? entry.branch ?? "none"}` };
		if (entry.locked) return { ok: false, reason: `worktree is locked: ${String(entry.locked)}` };
		if (options.requireMarker) {
			const markerError = await this.ownershipMarkerError(worktree);
			if (markerError) return { ok: false, reason: markerError };
		}
		if (options.checkOccupancy) {
			const occupancy = await this.detectOccupancy(worktree.worktreeRoot);
			if (occupancy.state === "occupied") return { ok: false, reason: `worktree is occupied by pid(s) ${occupancy.pids.join(", ")}` };
			if (occupancy.state === "unknown") return { ok: false, reason: `worktree occupancy is unknown: ${occupancy.reason}` };
		}
		return { ok: true, entry };
	}

	private managerOwnershipError(worktree: Extract<ThreadWorktree, { mode: "isolated" }>): string | undefined {
		if (!worktree.branchName.startsWith("thread-manager/")) return `worktree branch is not manager-owned: ${worktree.branchName}`;
		const primaryParent = normalizePathForComparison(path.dirname(worktree.primaryRepoRoot), this.platform);
		const worktreeParent = normalizePathForComparison(path.dirname(worktree.worktreeRoot), this.platform);
		if (primaryParent !== worktreeParent) return `worktree path is outside manager sibling directory: ${worktree.worktreeRoot}`;
		const expectedPrefix = `${path.basename(worktree.primaryRepoRoot)}-thread-`;
		if (!path.basename(worktree.worktreeRoot).startsWith(expectedPrefix)) return `worktree path is not manager-generated: ${worktree.worktreeRoot}`;
		return undefined;
	}

	private async writeOwnershipMarker(worktree: Extract<ThreadWorktree, { mode: "isolated" }>): Promise<void> {
		const markerPath = await this.ownershipMarkerPath(worktree);
		await fs.writeFile(markerPath, `${JSON.stringify({
			version: 1,
			manager: "pi-thread-manager",
			branchName: worktree.branchName,
			worktreeRoot: worktree.worktreeRoot,
			sourceRepoRoot: worktree.sourceRepoRoot,
			primaryRepoRoot: worktree.primaryRepoRoot,
			baseSha: worktree.baseSha,
			createdAt: this.now().toISOString(),
		})}\n`, { mode: 0o600 });
	}

	private async ownershipMarkerError(worktree: Extract<ThreadWorktree, { mode: "isolated" }>): Promise<string | undefined> {
		let raw: string;
		try {
			raw = await fs.readFile(await this.ownershipMarkerPath(worktree), "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return code === "ENOENT" ? "worktree ownership marker is missing" : `worktree ownership marker cannot be read: ${error instanceof Error ? error.message : String(error)}`;
		}
		let marker: Record<string, unknown>;
		try {
			marker = JSON.parse(raw) as Record<string, unknown>;
		} catch (error) {
			return `worktree ownership marker is invalid: ${error instanceof Error ? error.message : String(error)}`;
		}
		for (const [label, expected] of Object.entries({ manager: "pi-thread-manager", branchName: worktree.branchName, sourceRepoRoot: worktree.sourceRepoRoot, primaryRepoRoot: worktree.primaryRepoRoot, baseSha: worktree.baseSha })) {
			if (marker[label] !== expected) return `worktree ownership marker ${label} mismatch`;
		}
		if (typeof marker.worktreeRoot !== "string" || normalizePathForComparison(marker.worktreeRoot, this.platform) !== normalizePathForComparison(worktree.worktreeRoot, this.platform)) return "worktree ownership marker path mismatch";
		return undefined;
	}

	private async ownershipMarkerPath(worktree: Extract<ThreadWorktree, { mode: "isolated" }>): Promise<string> {
		const gitDir = (await requireGit(this.exec, worktree.worktreeRoot, ["rev-parse", "--git-dir"], "git rev-parse --git-dir")).trim();
		return path.join(path.isAbsolute(gitDir) ? gitDir : path.resolve(worktree.worktreeRoot, gitDir), WORKTREE_MARKER_FILE);
	}

	private async detectOccupancy(worktreeRoot: string): Promise<{ state: "empty" } | { state: "occupied"; pids: number[] } | { state: "unknown"; reason: string }> {
		let processes: ProcessInfo[];
		try {
			processes = this.processInspector ? await this.processInspector() : await defaultProcessInspector(this.platform);
		} catch (error) {
			return { state: "unknown", reason: error instanceof Error ? error.message : String(error) };
		}
		const excluded = excludedProcessIds(processes, this.currentPid);
		const root = normalizePathForComparison(await realpathSafe(worktreeRoot), this.platform);
		const pids: number[] = [];
		for (const processInfo of processes) {
			if (!Number.isInteger(processInfo.pid) || excluded.has(processInfo.pid) || !processInfo.cwd) continue;
			const cwd = normalizePathForComparison(await realpathSafe(processInfo.cwd), this.platform);
			const relative = path.relative(root, cwd);
			if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) pids.push(processInfo.pid);
		}
		return pids.length > 0 ? { state: "occupied", pids } : { state: "empty" };
	}
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fs.access(targetPath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function realpathSafe(targetPath: string): Promise<string> {
	try {
		return await fs.realpath(targetPath);
	} catch {
		return path.resolve(targetPath);
	}
}

async function defaultProcessInspector(platform: NodeJS.Platform): Promise<ProcessInfo[]> {
	if (platform === "win32") return [];
	if (platform !== "linux") throw new Error(`process cwd inspection is unavailable on ${platform}`);
	const entries = await fs.readdir("/proc", { withFileTypes: true });
	const processes: ProcessInfo[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		try {
			const cwd = await fs.readlink(path.join("/proc", entry.name, "cwd"));
			processes.push({
				pid: Number(entry.name),
				ppid: await readLinuxParentPid(entry.name),
				cwd,
			});
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ESRCH") continue;
			throw error;
		}
	}
	return processes;
}

async function readLinuxParentPid(pid: string): Promise<number | undefined> {
	try {
		const status = await fs.readFile(path.join("/proc", pid, "status"), "utf8");
		const match = /^PPid:\s+(\d+)$/m.exec(status);
		return match ? Number(match[1]) : undefined;
	} catch {
		return undefined;
	}
}

function excludedProcessIds(processes: ProcessInfo[], currentPid: number): Set<number> {
	const excluded = new Set<number>([currentPid]);
	const byPid = new Map(processes.map((item) => [item.pid, item]));
	let cursor = byPid.get(currentPid)?.ppid;
	while (cursor && !excluded.has(cursor)) {
		excluded.add(cursor);
		cursor = byPid.get(cursor)?.ppid;
	}
	return excluded;
}
