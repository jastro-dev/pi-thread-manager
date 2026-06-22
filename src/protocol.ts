import { realpathSync } from "node:fs";
import path from "node:path";

import {
	DEFAULT_PROTOCOL_LIMITS,
	DEFAULT_RESTART_POLICY,
	DEFAULT_SAFETY_POLICY,
	MIN_READER_VERSION,
	PROTOCOL_VERSION,
	STORE_VERSION,
	type ApprovalRecord,
	type ApprovalScope,
	type BrokerRequest,
	type CapabilityToken,
	type CommandLegality,
	type LaunchProfile,
	type ProtocolLimits,
	type RestartPolicy,
	type SafetyPolicy,
	type ThreadAction,
	type ThreadStatus,
} from "./types.ts";

const THREAD_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/;
const TAG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/;
const BASE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,199}$/;
const THREAD_ACTIONS = new Set<ThreadAction>([
	"handshake",
	"status",
	"list",
	"create",
	"read",
	"send",
	"follow_up",
	"steer",
	"abort",
	"stop",
	"cleanup",
	"schedule",
	"approvals",
	"approve",
	"deny",
	"review_loop",
]);

export function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

export function createProtocolError(message: string): Error {
	return new Error(`Thread manager protocol error: ${message}`);
}

export function normalizeSafetyPolicy(policy: Partial<SafetyPolicy> = {}): SafetyPolicy {
	return validateSafetyPolicy({
		...DEFAULT_SAFETY_POLICY,
		...policy,
		restartPolicy: normalizeRestartPolicy(policy.restartPolicy),
	});
}

export function normalizeRestartPolicy(policy: Partial<RestartPolicy> = {}): RestartPolicy {
	return { ...DEFAULT_RESTART_POLICY, ...policy };
}

export function normalizeLaunchProfile(input: Partial<LaunchProfile> & { cwd: string }): LaunchProfile {
	return {
		cwd: input.cwd,
		model: input.model,
		name: input.name,
		extensionLoading: input.extensionLoading ?? "inherit",
		approvalMode: input.approvalMode ?? "ask",
		inheritedFromParent: input.inheritedFromParent ?? true,
	};
}

export function validateRequestId(requestId: unknown, limits: ProtocolLimits = DEFAULT_PROTOCOL_LIMITS): string {
	if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId) || byteLength(requestId) > limits.maxRequestIdBytes) {
		throw createProtocolError("request id must be a short ASCII token");
	}
	return requestId;
}

export function validateThreadId(threadId: unknown): string {
	if (typeof threadId !== "string" || !THREAD_ID_PATTERN.test(threadId)) {
		throw createProtocolError("thread id must be a stable ASCII token");
	}
	return threadId;
}

export function validateThreadAction(action: unknown): ThreadAction {
	if (typeof action !== "string" || !THREAD_ACTIONS.has(action as ThreadAction)) {
		throw createProtocolError("unknown thread action");
	}
	return action as ThreadAction;
}

export function validateName(name: unknown, limits: ProtocolLimits = DEFAULT_PROTOCOL_LIMITS): string | undefined {
	if (name === undefined) return undefined;
	if (typeof name !== "string" || name.trim() === "" || byteLength(name) > limits.maxNameBytes) {
		throw createProtocolError("thread name must be non-empty and within length limits");
	}
	return name.trim();
}

export function validateTags(tags: unknown, limits: ProtocolLimits = DEFAULT_PROTOCOL_LIMITS): string[] {
	if (tags === undefined) return [];
	if (!Array.isArray(tags)) throw createProtocolError("tags must be an array");
	return tags.map((tag) => {
		if (typeof tag !== "string" || !TAG_PATTERN.test(tag) || byteLength(tag) > limits.maxTagBytes) {
			throw createProtocolError("tags must be short ASCII tokens");
		}
		return tag;
	});
}

export function validateBaseRef(baseRef: unknown): string | undefined {
	if (baseRef === undefined) return undefined;
	if (typeof baseRef !== "string" || !BASE_REF_PATTERN.test(baseRef) || baseRef.includes("..") || baseRef.includes("@{") || baseRef.startsWith("-")) {
		throw createProtocolError("baseRef must be a short git ref or SHA token");
	}
	return baseRef;
}

export function validatePrompt(message: unknown, limits: ProtocolLimits = DEFAULT_PROTOCOL_LIMITS): string {
	if (typeof message !== "string" || message.trim() === "") {
		throw createProtocolError("message must be a non-empty string");
	}
	if (byteLength(message) > limits.maxPromptBytes) {
		throw createProtocolError("message exceeds prompt size limit");
	}
	return message;
}

export function validateReadLimit(limit: unknown, limits: ProtocolLimits = DEFAULT_PROTOCOL_LIMITS): number {
	if (limit === undefined) return 50;
	if (!Number.isInteger(limit) || (limit as number) <= 0 || (limit as number) > limits.maxReadLimit) {
		throw createProtocolError(`read limit must be 1-${limits.maxReadLimit}`);
	}
	return limit as number;
}

export function validateScheduleInterval(seconds: unknown, limits: ProtocolLimits = DEFAULT_PROTOCOL_LIMITS): number {
	if (!Number.isInteger(seconds) || (seconds as number) < limits.minScheduleIntervalSeconds) {
		throw createProtocolError(`schedule interval must be at least ${limits.minScheduleIntervalSeconds} seconds`);
	}
	return seconds as number;
}

export function validateRestartPolicy(policy: RestartPolicy): RestartPolicy {
	switch (policy.mode) {
		case "never":
		case "manual":
		case "from_session":
			break;
		default: {
			const exhaustive: never = policy.mode;
			throw createProtocolError(`unknown restart policy ${exhaustive}`);
		}
	}
	if (!Number.isInteger(policy.maxRestarts) || policy.maxRestarts < 0) {
		throw createProtocolError("restart policy maxRestarts must be a non-negative integer");
	}
	if (!Number.isInteger(policy.backoffSeconds) || policy.backoffSeconds < 0) {
		throw createProtocolError("restart policy backoffSeconds must be a non-negative integer");
	}
	if (policy.mode === "from_session" && policy.allowWhenOperationUnknown) {
		throw createProtocolError("from_session restart cannot be allowed when operation outcome is unknown");
	}
	return policy;
}

export function validateSafetyPolicy(policy: SafetyPolicy): SafetyPolicy {
	switch (policy.worktreeMode) {
		case "isolated_required":
		case "shared_cwd_allowed":
		case "read_only":
			break;
		default: {
			const exhaustive: never = policy.worktreeMode;
			throw createProtocolError(`unknown worktree mode ${exhaustive}`);
		}
	}
	switch (policy.queuePolicy) {
		case "reject_when_running":
		case "allow_follow_up":
			break;
		default: {
			const exhaustive: never = policy.queuePolicy;
			throw createProtocolError(`unknown queue policy ${exhaustive}`);
		}
	}
	switch (policy.githubWritePolicy) {
		case "ask":
		case "allow_scoped":
		case "deny":
			break;
		default: {
			const exhaustive: never = policy.githubWritePolicy;
			throw createProtocolError(`unknown GitHub write policy ${exhaustive}`);
		}
	}
	switch (policy.forceKillPolicy) {
		case "deny":
		case "allow_non_windows":
			break;
		default: {
			const exhaustive: never = policy.forceKillPolicy;
			throw createProtocolError(`unknown force kill policy ${exhaustive}`);
		}
	}
	validateRestartPolicy(policy.restartPolicy);
	return policy;
}

export function validateLaunchProfile(profile: LaunchProfile): LaunchProfile {
	if (typeof profile.cwd !== "string" || profile.cwd.trim() === "") {
		throw createProtocolError("launch profile requires cwd");
	}
	if (!path.isAbsolute(profile.cwd)) {
		throw createProtocolError("launch profile cwd must be absolute");
	}
	switch (profile.extensionLoading) {
		case "inherit":
		case "default":
		case "none":
			break;
		default: {
			const exhaustive: never = profile.extensionLoading;
			throw createProtocolError(`unknown extension loading policy ${exhaustive}`);
		}
	}
	switch (profile.approvalMode) {
		case "inherit":
		case "ask":
		case "read_only":
			break;
		default: {
			const exhaustive: never = profile.approvalMode;
			throw createProtocolError(`unknown approval mode ${exhaustive}`);
		}
	}
	return profile;
}

export function validateProtocolVersion(version: number): void {
	if (version !== PROTOCOL_VERSION) {
		throw createProtocolError(`unsupported protocol version ${version}; expected ${PROTOCOL_VERSION}`);
	}
}

export function validateStoreVersion(storeVersion: unknown, minReaderVersion: unknown): void {
	if (storeVersion !== STORE_VERSION || minReaderVersion !== MIN_READER_VERSION) {
		throw new Error(`Unsupported thread manager store version ${String(storeVersion)}/${String(minReaderVersion)}`);
	}
}

export function isCommandAllowed(status: ThreadStatus, action: ThreadAction, safetyPolicy: SafetyPolicy = DEFAULT_SAFETY_POLICY): CommandLegality {
	switch (action) {
		case "handshake":
		case "status":
		case "list":
		case "create":
		case "read":
		case "schedule":
		case "approvals":
		case "approve":
		case "deny":
		case "review_loop":
			return { allowed: true };
		case "cleanup":
			return ["stopped", "failed", "orphan_needs_manual_action"].includes(status)
				? { allowed: true }
				: { allowed: false, reason: `cleanup requires stopped, failed, or orphan_needs_manual_action thread; current status is ${status}` };
		case "send":
			return status === "idle"
				? { allowed: true }
				: { allowed: false, reason: `send requires idle thread; current status is ${status}` };
		case "follow_up":
			return status === "running" && safetyPolicy.queuePolicy === "allow_follow_up"
				? { allowed: true }
				: { allowed: false, reason: "follow_up requires running thread with follow-up queue policy" };
		case "steer":
			return status === "running"
				? { allowed: true }
				: { allowed: false, reason: `steer requires running thread; current status is ${status}` };
		case "abort":
			return status === "running" || status === "stopping"
				? { allowed: true }
				: { allowed: false, reason: `abort requires running/stopping thread; current status is ${status}` };
		case "stop":
			return ["creating", "starting", "idle", "running", "stopping", "crashed", "kill_failed", "orphan_needs_manual_action"].includes(status)
				? { allowed: true }
				: { allowed: false, reason: `stop is not valid for ${status} thread` };
		default: {
			const exhaustive: never = action;
			return { allowed: false, reason: `unknown action ${exhaustive}` };
		}
	}
}

export function validateCapability(
	token: CapabilityToken | undefined,
	secret: string | undefined,
	request: { action: ThreadAction; threadId?: string; cwd?: string; now?: Date },
): CommandLegality {
	if (!token || !secret || token.secret !== secret) return { allowed: false, reason: "invalid daemon capability token" };
	if (token.revokedAt) return { allowed: false, reason: "daemon capability token has been revoked" };
	const now = request.now ?? new Date();
	if (token.expiresAt && new Date(token.expiresAt).getTime() <= now.getTime()) {
		return { allowed: false, reason: "daemon capability token has expired" };
	}
	if (token.actions !== "all" && !token.actions.includes(request.action)) {
		return { allowed: false, reason: `token is not scoped for ${request.action}` };
	}
	if (request.action === "create" && token.threadIds && !request.threadId) {
		return { allowed: false, reason: "thread-scoped token cannot create new threads" };
	}
	if (request.threadId && token.threadIds && !token.threadIds.includes(request.threadId)) {
		return { allowed: false, reason: "token is not scoped for this thread" };
	}
	if (request.threadId && token.cwdRoots && !request.cwd && (!token.threadIds || !token.threadIds.includes(request.threadId))) {
		return { allowed: false, reason: "target thread cwd is unavailable for cwd-scoped token" };
	}
	if (request.cwd && token.cwdRoots && !token.cwdRoots.some((root) => isPathInside(request.cwd ?? "", root))) {
		return { allowed: false, reason: "token is not scoped for this cwd" };
	}
	return { allowed: true };
}

export function validateApprovalScope(current: ApprovalScope, approval: ApprovalRecord): CommandLegality {
	if (approval.status !== "approved") return { allowed: false, reason: `approval is ${approval.status}` };
	if (new Date(approval.expiresAt).getTime() <= Date.now()) return { allowed: false, reason: "approval expired" };
	const expected = approval.scope;
	const mismatches: string[] = [];
	for (const key of ["repo", "prNumber", "headSha", "branch", "actionType", "diffSummary"] as const) {
		if (expected[key] !== current[key]) mismatches.push(key);
	}
	if (!sameStringMultiset(expected.threadIds, current.threadIds)) mismatches.push("threadIds");
	if (!sameStringMultiset(expected.reviewThreadIds ?? [], current.reviewThreadIds ?? [])) mismatches.push("reviewThreadIds");
	return mismatches.length === 0
		? { allowed: true }
		: { allowed: false, reason: `approval scope changed: ${mismatches.join(", ")}` };
}

export function validateBrokerRequest(value: unknown, limits: ProtocolLimits = DEFAULT_PROTOCOL_LIMITS): BrokerRequest {
	if (typeof value !== "object" || value === null) throw createProtocolError("request must be an object");
	const request = value as Partial<BrokerRequest> & Record<string, unknown>;
	if (request.type === "handshake") {
		validateRequestId(request.id, limits);
		if (!Number.isInteger(request.protocolVersion)) throw createProtocolError("protocol version must be an integer");
		validateOptionalToken(request.token);
		return request as BrokerRequest;
	}
	if (request.type !== "request") throw createProtocolError("request type must be handshake or request");
	validateRequestId(request.id, limits);
	validateThreadAction(request.command);
	validateOptionalToken(request.token);
	return request as BrokerRequest;
}

function validateOptionalToken(token: unknown): void {
	if (token !== undefined && typeof token !== "string") throw createProtocolError("token must be a string");
}

export function isPathInside(childPath: string, parentPath: string): boolean {
	const child = realpathOrResolve(childPath);
	const parent = realpathOrResolve(parentPath);
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realpathOrResolve(value: string): string {
	try {
		return realpathSync.native(value);
	} catch {
		return path.resolve(value);
	}
}

function sameStringMultiset(left: string[] = [], right: string[] = []): boolean {
	if (left.length !== right.length) return false;
	const sortedLeft = [...left].sort();
	const sortedRight = [...right].sort();
	return sortedLeft.every((item, index) => item === sortedRight[index]);
}
