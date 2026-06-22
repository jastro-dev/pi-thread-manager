import type { ApprovalRecord, DaemonStatus, ManagedThread, ThreadOperation, ThreadReadResult } from "./types.ts";
import { redactAuthSecrets } from "./broker/auth.ts";

export function formatDaemonStatus(status: DaemonStatus): string {
	const paused = status.pausedReason ? `\nPaused: ${status.pausedReason}` : "";
	return redactSensitiveText([
		`Pi thread manager daemon pid ${status.daemonPid} protocol ${status.protocolVersion}`,
		`Store: ${status.storePath}`,
		`Threads: ${status.threadCount} total, ${status.activeThreadCount} active, ${status.orphanThreadCount} orphan/manual-action`,
		`Worktrees: ${status.isolatedThreadCount ?? 0} isolated, ${status.legacySharedCwdThreadCount ?? 0} legacy shared cwd, ${status.cleanupPendingWorktreeCount ?? 0} cleanup pending, ${status.worktreeManualActionCount ?? 0} manual-action`,
		`Pending: ${status.pendingOperationCount} operations, ${status.pendingApprovalCount} approvals, ${status.activeScheduleCount} schedules`,
	].join("\n") + paused);
}

export function formatThreadList(threads: ManagedThread[]): string {
	if (threads.length === 0) return "No managed Pi threads.";
	return threads.map(formatThreadSummary).join("\n");
}

export function formatThreadSummary(thread: ManagedThread): string {
	const name = thread.name ? ` ${thread.name}` : "";
	const pid = thread.pid ? ` pid=${thread.pid}` : "";
	const op = thread.currentOperationId ? ` op=${thread.currentOperationId}` : "";
	const worktree = formatWorktreeSummary(thread);
	return redactSensitiveText(`${thread.id}${name}: ${thread.status}${pid}${op} cwd=${thread.cwd}${worktree}`);
}

export function formatReadResult(result: ThreadReadResult): string {
	const header = `Thread ${result.threadId} messages ${result.cursor}-${result.nextCursor}${result.truncated ? " (more available)" : ""}`;
	if (result.items.length === 0) return `${header}\n(no messages)`;
	return `${header}\n${result.items.map((item, index) => `${result.cursor + index}: ${formatUnknown(item)}`).join("\n")}`;
}

export function formatOperation(operation: ThreadOperation): string {
	return redactSensitiveText(`${operation.kind} ${operation.id}: ${operation.status}${operation.message ? ` — ${operation.message}` : operation.error ? ` — ${operation.error}` : ""}`);
}

function formatWorktreeSummary(thread: ManagedThread): string {
	if (!thread.worktree) return "";
	if (thread.worktree.mode === "legacy_shared_cwd") return " worktree=legacy shared cwd";
	return [
		` source=${thread.worktree.sourceCwd}`,
		` sourceRepo=${thread.worktree.sourceRepoRoot}`,
		` worktree=${thread.worktree.worktreeRoot}`,
		` branch=${thread.worktree.branchName}`,
		` base=${thread.worktree.baseRef}@${thread.worktree.baseSha.slice(0, 12)}`,
		` allocation=${thread.worktree.allocationState}`,
		` cleanup=${thread.worktree.cleanupState}`,
		thread.worktree.lastCheckedAt ? ` checked=${thread.worktree.lastCheckedAt}` : "",
		thread.worktree.lastError ? ` error=${thread.worktree.lastError}` : "",
	].join("");
}

export function formatApprovals(approvals: ApprovalRecord[]): string {
	if (approvals.length === 0) return "No pending thread-manager approvals.";
	return redactSensitiveText(approvals.map((approval) => `${approval.id}: ${approval.scope.actionType} for ${approval.scope.repo ?? "local repo"}${approval.scope.prNumber ? `#${approval.scope.prNumber}` : ""} (${approval.status})`).join("\n"));
}

export function formatToolResult(value: unknown): string {
	if (isDaemonStatus(value)) return formatDaemonStatus(value);
	if (isApprovalListResult(value)) return formatApprovals(value.approvals);
	if (Array.isArray(value) && value.every(isManagedThread)) return formatThreadList(value);
	if (Array.isArray(value) && value.every(isApprovalRecord)) return formatApprovals(value);
	if (isManagedThread(value)) return formatThreadSummary(value);
	if (isThreadOperation(value)) return formatOperation(value);
	if (isThreadReadResult(value)) return formatReadResult(value);
	return formatUnknown(value);
}

export function redactSensitiveText(text: string): string {
	return redactAuthSecrets(text)
		.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
		.replace(/("[A-Za-z0-9_-]*(?:token|secret|rootToken|authorization|api[_-]?key|access[_-]?key|password|credential)[A-Za-z0-9_-]*"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
		.replace(/([A-Za-z0-9_-]*(?:token|secret|authorization|api[_-]?key|access[_-]?key|password|credential)[A-Za-z0-9_-]*)([=:]\s*)[^\s"',}]+/gi, "$1$2[redacted]")
		.replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted-github-token]")
		.replace(/AKIA[0-9A-Z]{16}/g, "[redacted-aws-key]");
}

function formatUnknown(value: unknown): string {
	return redactSensitiveText(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function isDaemonStatus(value: unknown): value is DaemonStatus {
	return typeof value === "object" && value !== null && typeof (value as DaemonStatus).daemonPid === "number" && typeof (value as DaemonStatus).storePath === "string";
}

function isManagedThread(value: unknown): value is ManagedThread {
	return typeof value === "object" && value !== null && typeof (value as ManagedThread).id === "string" && typeof (value as ManagedThread).status === "string" && typeof (value as ManagedThread).cwd === "string";
}

function isThreadOperation(value: unknown): value is ThreadOperation {
	return typeof value === "object" && value !== null && typeof (value as ThreadOperation).kind === "string" && typeof (value as ThreadOperation).status === "string";
}

function isApprovalRecord(value: unknown): value is ApprovalRecord {
	return typeof value === "object" && value !== null && typeof (value as ApprovalRecord).operationId === "string" && typeof (value as ApprovalRecord).scope === "object";
}

function isApprovalListResult(value: unknown): value is { kind: "approvals"; approvals: ApprovalRecord[] } {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "approvals" && Array.isArray((value as { approvals?: unknown }).approvals);
}

function isThreadReadResult(value: unknown): value is ThreadReadResult {
	return typeof value === "object" && value !== null && Array.isArray((value as ThreadReadResult).items) && typeof (value as ThreadReadResult).threadId === "string";
}
