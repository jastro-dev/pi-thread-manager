import { promises as fs } from "node:fs";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { validateBrokerRequest } from "../protocol.ts";
import { PROTOCOL_VERSION, type BrokerRequest, type BrokerResponse, type DaemonStatus, type ProtocolLimits, type ThreadAction } from "../types.ts";
import { readThreadStore } from "../store/thread-store.ts";
import { createThreadService } from "../pi/lifecycle.ts";
import { authorizeSecret } from "./auth.ts";
import { createMessageReader, writeMessage } from "./framing.ts";
import { getBrokerPidPath, getBrokerSocketPath, getThreadManagerDir, getThreadStorePath } from "./paths.ts";

export interface BrokerRequestContext {
	clientId: string;
	token?: string;
	requestId?: string;
}

export interface BrokerRequestHandler {
	handle(command: ThreadAction, params: Record<string, unknown>, context: BrokerRequestContext): Promise<unknown>;
	status?(): Promise<Partial<DaemonStatus>> | Partial<DaemonStatus>;
}

export interface ThreadBrokerOptions {
	socketPath?: string;
	pidPath?: string;
	managerDir?: string;
	storePath?: string;
	platform?: NodeJS.Platform;
	protocolVersion?: number;
	daemonEpoch?: string;
	requiredToken?: string;
	homeDir?: string;
	limits?: ProtocolLimits;
	handler: BrokerRequestHandler;
}

export interface ThreadBroker {
	server: Server;
	socketPath: string;
	pidPath: string;
	daemonEpoch: string;
	close(): Promise<void>;
}

export async function startThreadBroker(options: ThreadBrokerOptions): Promise<ThreadBroker> {
	const platform = options.platform ?? process.platform;
	const managerDir = options.managerDir ?? getThreadManagerDir(options.homeDir);
	const socketPath = options.socketPath ?? getBrokerSocketPath(platform, options.homeDir);
	const pidPath = options.pidPath ?? getBrokerPidPath(options.homeDir);
	const storePath = options.storePath ?? getThreadStorePath(options.homeDir);
	const daemonEpoch = options.daemonEpoch ?? randomUUID();
	await fs.mkdir(managerDir, { recursive: true, mode: 0o700 });
	if (platform !== "win32") {
		await unlinkStaleSocket(socketPath);
	}

	const server = net.createServer((socket) => {
		const clientId = randomUUID();
		const handshakeState = { handshaken: false };
		let requestQueue = Promise.resolve();
		const reader = createMessageReader((message) => {
			requestQueue = requestQueue.then(() => handleSocketMessage({ socket, message, clientId, handshakeState, options, daemonEpoch, storePath, managerDir })).catch((error) => {
				writeError(socket, "protocol", error instanceof Error ? error.message : String(error), options.limits);
				socket.destroy();
			});
		}, (error) => {
			writeError(socket, "protocol", error.message, options.limits);
			socket.destroy();
		}, options.limits);
		socket.on("data", reader);
		socket.on("error", () => undefined);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
	await fs.writeFile(pidPath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });

	return {
		server,
		socketPath,
		pidPath,
		daemonEpoch,
		async close() {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
			await fs.unlink(pidPath).catch(() => undefined);
			if (platform !== "win32") await fs.unlink(socketPath).catch(() => undefined);
		},
	};
}

async function handleSocketMessage(args: {
	socket: Socket;
	message: unknown;
	clientId: string;
	handshakeState: { handshaken: boolean };
	options: ThreadBrokerOptions;
	daemonEpoch: string;
	storePath: string;
	managerDir: string;
}): Promise<void> {
	let request: BrokerRequest;
	try {
		request = validateBrokerRequest(args.message, args.options.limits);
	} catch (error) {
		writeError(args.socket, "protocol", error instanceof Error ? error.message : String(error), args.options.limits);
		return;
	}

	if (request.type === "handshake") {
		const handshakeAuth = await authorizeBrokerToken(args.options, request.token, "handshake", {}, args.storePath, args.managerDir);
		if (!handshakeAuth.allowed) {
			writeResponse(args.socket, { type: "response", id: request.id, command: "handshake", success: false, error: handshakeAuth.reason }, args.options.limits);
			return;
		}
		if (request.protocolVersion !== (args.options.protocolVersion ?? PROTOCOL_VERSION)) {
			writeResponse(args.socket, { type: "response", id: request.id, command: "handshake", success: false, error: `unsupported protocol version ${request.protocolVersion}` }, args.options.limits);
			return;
		}
		args.handshakeState.handshaken = true;
		const handlerStatus = await args.options.handler.status?.() ?? {};
		const status: DaemonStatus = {
			...handlerStatus,
			protocolVersion: args.options.protocolVersion ?? PROTOCOL_VERSION,
			daemonPid: process.pid,
			daemonEpoch: args.daemonEpoch,
			storePath: args.storePath,
			threadCount: handlerStatus.threadCount ?? 0,
			activeThreadCount: handlerStatus.activeThreadCount ?? 0,
			orphanThreadCount: handlerStatus.orphanThreadCount ?? 0,
			pendingOperationCount: handlerStatus.pendingOperationCount ?? 0,
			pendingApprovalCount: handlerStatus.pendingApprovalCount ?? 0,
			activeScheduleCount: handlerStatus.activeScheduleCount ?? 0,
		};
		writeResponse(args.socket, { type: "response", id: request.id, command: "handshake", success: true, data: status }, args.options.limits);
		return;
	}

	if (!args.handshakeState.handshaken) {
		writeResponse(args.socket, { type: "response", id: request.id, command: request.command, success: false, error: "handshake required before requests" }, args.options.limits);
		return;
	}
	const auth = await authorizeBrokerToken(args.options, request.token, request.command, request.params, args.storePath, args.managerDir);
	if (!auth.allowed) {
		writeResponse(args.socket, { type: "response", id: request.id, command: request.command, success: false, error: auth.reason }, args.options.limits);
		return;
	}

	try {
		const data = await args.options.handler.handle(request.command, request.params ?? {}, { clientId: args.clientId, token: request.token, requestId: request.id });
		writeResponse(args.socket, { type: "response", id: request.id, command: request.command, success: true, data }, args.options.limits);
	} catch (error) {
		writeResponse(args.socket, { type: "response", id: request.id, command: request.command, success: false, error: error instanceof Error ? error.message : String(error) }, args.options.limits);
	}
}

async function authorizeBrokerToken(options: ThreadBrokerOptions, token: string | undefined, action: ThreadAction, params: Record<string, unknown> = {}, storePath?: string, managerDir?: string): Promise<{ allowed: true } | { allowed: false; reason: string }> {
	if (options.requiredToken) {
		return token === options.requiredToken ? { allowed: true } : { allowed: false, reason: "invalid daemon capability token" };
	}
	const threadIds = extractScopedThreadIds(params);
	if (threadIds.length === 0) {
		return authorizeSecret(token, { action, cwd: typeof params.cwd === "string" ? params.cwd : undefined }, options.homeDir);
	}
	const threadCwds = await resolveThreadCwds(storePath, managerDir ?? options.managerDir, threadIds);
	for (const threadId of threadIds) {
		const auth = authorizeSecret(token, { action, threadId, cwd: threadCwds.get(threadId) }, options.homeDir);
		if (!auth.allowed) return auth;
	}
	return { allowed: true };
}

async function resolveThreadCwds(storePath: string | undefined, managerDir: string | undefined, threadIds: string[]): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	try {
		const document = await readThreadStore(storePath, managerDir);
		for (const threadId of threadIds) {
			const thread = document.threads[threadId];
			const cwd = thread?.worktree?.sourceCwd ?? thread?.cwd;
			if (cwd) result.set(threadId, cwd);
		}
	} catch {}
	return result;
}

function extractScopedThreadIds(params: Record<string, unknown>): string[] {
	const threadIds: string[] = [];
	for (const key of ["threadId", "fixerThreadId"]) {
		if (typeof params[key] === "string") threadIds.push(params[key]);
	}
	if (Array.isArray(params.threadIds)) {
		for (const threadId of params.threadIds) {
			if (typeof threadId === "string") threadIds.push(threadId);
		}
	}
	if (params.scope && typeof params.scope === "object" && Array.isArray((params.scope as { threadIds?: unknown[] }).threadIds)) {
		for (const threadId of (params.scope as { threadIds: unknown[] }).threadIds) {
			if (typeof threadId === "string") threadIds.push(threadId);
		}
	}
	return [...new Set(threadIds)];
}

function writeResponse(socket: Socket, response: BrokerResponse, limits?: ProtocolLimits): void {
	writeMessage(socket, response, limits);
}

function writeError(socket: Socket, id: string, error: string, limits?: ProtocolLimits): void {
	writeResponse(socket, { type: "response", id, success: false, error }, limits);
}

async function main(): Promise<void> {
	const daemonEpoch = randomUUID();
	const homeDir = process.env.PI_THREAD_MANAGER_HOME;
	const service = createThreadService({ daemonEpoch, homeDir });
	const status = await service.status();
	if (!status.pausedReason) {
		try {
			await service.reconcileAfterRestart();
			service.startAutomationLoop();
		} catch (error) {
			console.error(`Thread manager automation disabled: restart reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	await startThreadBroker({ handler: service, daemonEpoch, homeDir });
}

async function unlinkStaleSocket(socketPath: string): Promise<void> {
	const live = await canConnectToSocket(socketPath);
	if (live) throw new Error(`Broker socket already in use: ${socketPath}`);
	await fs.unlink(socketPath).catch((error) => {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	});
}

async function canConnectToSocket(socketPath: string): Promise<boolean> {
	return await new Promise((resolve, reject) => {
		const socket = net.connect(socketPath);
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`Timed out probing broker socket: ${socketPath}`));
		}, 500);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(true);
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			socket.destroy();
			if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) {
				resolve(false);
				return;
			}
			reject(error);
		});
	});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.stack ?? error.message : String(error));
		process.exitCode = 1;
	});
}
