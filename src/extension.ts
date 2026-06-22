import { createHash } from "node:crypto";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ThreadManagerClient } from "./broker/client.ts";
import { spawnBrokerIfNeeded } from "./broker/spawn.ts";
import { formatToolResult } from "./presentation.ts";
import type { ThreadAction } from "./types.ts";

export interface BrokerPort {
	connect(): Promise<unknown>;
	request<T = unknown>(command: ThreadAction, params?: Record<string, unknown>, requestId?: string): Promise<T>;
	disconnect?(): void;
}

export interface ThreadManagerExtensionDeps {
	spawnBroker?: () => Promise<void>;
	createClient?: () => BrokerPort;
}

interface CommandPlan {
	action: ThreadAction;
	params: Record<string, unknown>;
}

export default function threadManagerExtension(pi: ExtensionAPI, deps: ThreadManagerExtensionDeps = {}): void {
	const spawnBroker = deps.spawnBroker ?? (() => spawnBrokerIfNeeded());
	const createClient = deps.createClient ?? (() => new ThreadManagerClient());

	pi.registerCommand("threads", {
		description: "Create, inspect, message, stop, and cleanup daemon-backed Pi threads",
		getArgumentCompletions: (prefix) => ["status", "list", "create", "read", "send", "follow-up", "steer", "stop", "cleanup", "approvals", "approve", "deny", "review-loop"]
			.filter((value) => value.startsWith(prefix))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			try {
				const text = await runThreadCommand(args, ctx, spawnBroker, createClient);
				ctx.ui.notify(text, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "thread",
		label: "Thread",
		description: "Create, inspect, message, stop, and cleanup daemon-backed Pi thread sessions.",
		promptSnippet: "Use thread to manage long-lived daemon-backed Pi sessions by stable thread id.",
		promptGuidelines: [
			"Use list before targeting a thread unless the thread id is already known.",
			"Do not treat delivery acknowledgement as completion; read the thread to inspect progress.",
			"Approval-required results mean the daemon stopped before a write and needs explicit approval.",
			"Isolated create requires a clean Git source cwd; shared-cwd creation is legacy and requires explicit opt-in.",
		],
		parameters: {
			type: "object",
			properties: {
				action: { enum: ["status", "list", "create", "read", "send", "follow_up", "steer", "abort", "stop", "cleanup", "approvals", "approve", "deny", "review_loop"] },
				threadId: { type: "string", description: "Stable managed thread id" },
				message: { type: "string", description: "Prompt, follow-up, or steering message" },
				name: { type: "string", description: "Thread display name" },
				cwd: { type: "string", description: "Source cwd used to allocate an isolated worktree; defaults to the parent session cwd" },
				worktreeMode: { enum: ["isolated_required", "shared_cwd_allowed"], description: "Worktree safety mode for create. Defaults to isolated_required; shared_cwd_allowed is legacy explicit opt-in." },
				baseRef: { type: "string", description: "Optional Git ref/SHA used as the base for an isolated worktree" },
				model: { type: "string", description: "Optional model pattern" },
				limit: { type: "number", description: "Read limit" },
				cursor: { type: "number", description: "Read cursor" },
				approvalId: { type: "string", description: "Approval id for approve/deny" },
				repo: { type: "string", description: "GitHub owner/repo for review_loop" },
				prNumber: { type: "number", description: "Pull request number for review_loop" },
				pr: { type: "number", description: "Alias for prNumber" },
				fixerThreadId: { type: "string", description: "Managed thread id that receives review-loop prompts" },
				intervalSeconds: { type: "number", description: "Review-loop polling interval in seconds" },
				maxIterations: { type: "number", description: "Maximum review-loop iterations" },
			},
			required: ["action"],
		},
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const action = normalizeToolAction(params.action);
			const plan: CommandPlan = { action, params: normalizeToolParams(action, { ...params, cwd: params.cwd ?? ctx.cwd, createdBy: "tool" }) };
			const result = await executePlan(plan, spawnBroker, createClient, toProtocolRequestId(toolCallId));
			const text = formatToolResult(result);
			return { content: [{ type: "text", text }], details: result };
		},
	});
}

function toProtocolRequestId(toolCallId: string): string {
	return `tool-${createHash("sha256").update(toolCallId).digest("hex").slice(0, 32)}`;
}

function normalizeToolParams(action: ThreadAction, params: Record<string, unknown>): Record<string, unknown> {
	if (action === "create" && params.message !== undefined && params.initialPrompt === undefined) return { ...params, initialPrompt: params.message };
	return params;
}

export async function runThreadCommand(
	args: string,
	ctx: ExtensionContext | ExtensionCommandContext,
	spawnBroker: () => Promise<void>,
	createClient: () => BrokerPort,
): Promise<string> {
	const plan = parseThreadCommand(args, ctx.cwd);
	const result = await executePlan(plan, spawnBroker, createClient);
	return formatToolResult(result);
}

export function parseThreadCommand(args: string, cwd: string): CommandPlan {
	const tokens = tokenize(args);
	const rawAction = tokens.shift()?.toLowerCase() ?? "status";
	const action = normalizeCommandAction(rawAction);
	const params: Record<string, unknown> = { cwd, createdBy: "command" };
	consumeLeadingOptions(tokens, params);
	const positional = tokens;
	if (["send", "follow_up", "steer"].includes(action)) {
		params.threadId = params.threadId ?? positional.shift();
		if (positional.length > 0) params.message = positional.join(" ");
		return { action, params };
	}
	if (["read", "abort", "stop", "cleanup"].includes(action)) params.threadId = params.threadId ?? positional.shift();
	if (action === "create") {
		const maybeName = positional.shift();
		if (maybeName) params.name = params.name ?? maybeName;
		if (positional.length > 0) params.initialPrompt = positional.join(" ");
		return { action, params };
	}
	consumeOptions(positional, params);
	if (["approve", "deny"].includes(action)) params.approvalId = positional.shift() ?? params.approvalId;
	return { action, params };
}

async function executePlan(plan: CommandPlan, spawnBroker: () => Promise<void>, createClient: () => BrokerPort, requestId?: string): Promise<unknown> {
	await spawnBroker();
	const client = createClient();
	try {
		await client.connect();
		return await client.request(plan.action, plan.params, requestId);
	} finally {
		client.disconnect?.();
	}
}

function normalizeCommandAction(action: string): ThreadAction {
	switch (action) {
		case "follow-up":
			return "follow_up";
		case "review-loop":
			return "review_loop";
		default:
			return normalizeToolAction(action);
	}
}

function normalizeToolAction(action: unknown): ThreadAction {
	switch (action) {
		case "status":
		case "list":
		case "create":
		case "read":
		case "send":
		case "follow_up":
		case "steer":
		case "abort":
		case "stop":
		case "cleanup":
		case "approvals":
		case "approve":
		case "deny":
		case "review_loop":
			return action;
		default:
			throw new Error(`Unknown thread action: ${String(action)}`);
	}
}

function tokenize(args: string): string[] {
	const tokens: string[] = [];
	const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(args))) tokens.push(match[1] ?? match[2] ?? match[3]);
	return tokens;
}

function consumeLeadingOptions(tokens: string[], params: Record<string, unknown>): void {
	while (tokens.length > 0 && setOption(tokens[0], params)) tokens.shift();
}

function consumeOptions(tokens: string[], params: Record<string, unknown>): void {
	for (let index = 0; index < tokens.length;) {
		if (setOption(tokens[index], params)) tokens.splice(index, 1);
		else index += 1;
	}
}

function setOption(token: string, params: Record<string, unknown>): boolean {
	const match = /^(\w+)=(.*)$/.exec(token);
	if (!match) return false;
	params[match[1]] = coerceCommandValue(match[1], match[2]);
	return true;
}

function coerceCommandValue(key: string, value: string): string | number {
	if (["limit", "cursor", "intervalSeconds", "maxIterations", "prNumber", "pr"].includes(key)) {
		const number = Number(value);
		if (!Number.isFinite(number)) throw new Error(`${key} must be numeric`);
		return number;
	}
	return value;
}
