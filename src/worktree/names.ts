import path from "node:path";

export interface WorktreeEntry {
	path: string;
	head?: string;
	branch?: string;
	detached?: boolean;
	locked?: string | boolean;
	prunable?: string | boolean;
}

export function slugifyThreadName(input: string | undefined): string {
	const slug = (input ?? "thread")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/g, "");
	return slug || "thread";
}

export function shortThreadId(threadId: string): string {
	return threadId.replace(/^thread-/, "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 12) || "thread";
}

export function parseWorktreePorcelain(output: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | undefined;
	const finish = () => {
		if (current?.path) entries.push(current);
		current = undefined;
	};

	for (const line of output.split(/\r?\n/)) {
		if (!line.trim()) {
			finish();
			continue;
		}
		const separator = line.indexOf(" ");
		const key = separator === -1 ? line : line.slice(0, separator);
		const value = separator === -1 ? "" : line.slice(separator + 1);
		if (key === "worktree") {
			finish();
			current = { path: value };
			continue;
		}
		if (!current) continue;
		if (key === "HEAD") current.head = value;
		if (key === "branch") current.branch = value;
		if (key === "detached") current.detached = true;
		if (key === "locked") current.locked = value || true;
		if (key === "prunable") current.prunable = value || true;
	}
	finish();
	return entries;
}

export function localBranchName(ref?: string): string | undefined {
	return ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
}

export function normalizePathForComparison(value: string, platform: NodeJS.Platform = process.platform): string {
	const resolved = path.resolve(value).replace(/[\\/]+$/, "");
	return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function chooseThreadWorktreeNames(input: {
	threadId: string;
	name?: string;
	repoName: string;
	parentDir: string;
	existingBranches: ReadonlySet<string>;
	existingPaths: ReadonlySet<string>;
	platform?: NodeJS.Platform;
}): { branchName: string; worktreeRoot: string } {
	const id = shortThreadId(input.threadId);
	const slug = slugifyThreadName(input.name);
	for (let index = 0; ; index += 1) {
		const suffix = index === 0 ? "" : `-${index + 1}`;
		const branchName = `thread-manager/${id}-${slug}${suffix}`;
		const worktreeRoot = path.join(input.parentDir, `${input.repoName}-thread-${id}-${slug}${suffix}`);
		if (input.existingBranches.has(branchName)) continue;
		if (input.existingPaths.has(normalizePathForComparison(worktreeRoot, input.platform))) continue;
		return { branchName, worktreeRoot };
	}
}
