import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import net from "node:net";

import { validateBrokerRequest } from "../protocol.ts";
import { PROTOCOL_VERSION, type BrokerResponse, type DaemonStatus, type ProtocolLimits, type ThreadAction } from "../types.ts";
import { getRootToken } from "./auth.ts";
import { createMessageReader, writeMessage } from "./framing.ts";
import { getBrokerSocketPath } from "./paths.ts";

type PendingRequest = {
	command?: ThreadAction;
	resolve: (value: BrokerResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CREATE_REQUEST_TIMEOUT_MS = 300_000;

export interface ThreadManagerClientOptions {
	socketPath?: string;
	platform?: NodeJS.Platform;
	homeDir?: string;
	token?: string;
	requestTimeoutMs?: number;
	createRequestTimeoutMs?: number;
	limits?: ProtocolLimits;
}

export class ThreadManagerClient extends EventEmitter {
	private socket: net.Socket | null = null;
	private pending = new Map<string, PendingRequest>();
	private connected = false;
	private readonly socketPath: string;
	private readonly token?: string;
	private readonly timeoutMs: number;
	private readonly createTimeoutMs: number;
	private readonly limits?: ProtocolLimits;
	private nextRequest = 1;

	constructor(options: ThreadManagerClientOptions = {}) {
		super();
		this.socketPath = options.socketPath ?? getBrokerSocketPath(options.platform, options.homeDir);
		this.token = options.token ?? getRootToken(options.homeDir);
		this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.createTimeoutMs = options.createRequestTimeoutMs ?? (options.requestTimeoutMs === undefined ? DEFAULT_CREATE_REQUEST_TIMEOUT_MS : options.requestTimeoutMs);
		this.limits = options.limits;
	}

	isConnected(): boolean {
		return Boolean(this.socket && this.connected && !this.socket.destroyed && this.socket.writable);
	}

	async connect(): Promise<DaemonStatus> {
		if (this.socket) throw new Error("Thread manager client is already connected");
		const socket = net.connect(this.socketPath);
		this.socket = socket;
		let settled = false;
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timeout);
				socket.off("error", onConnectError);
			};
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				socket.destroy();
				this.socket = null;
				reject(error);
			};
			const timeout = setTimeout(() => fail(new Error("Thread manager handshake timed out")), this.timeoutMs);
			const onConnectError = (error: Error) => fail(error);
			const reader = createMessageReader((message) => {
				this.handleMessage(message);
			}, (error) => {
				this.disconnect(error);
			}, this.limits);
			socket.on("data", reader);
			socket.on("close", () => this.disconnect(new Error("Thread manager broker disconnected")));
			socket.on("error", onConnectError);
			socket.on("error", (error) => {
				if (this.listenerCount("error") > 0) this.emit("error", error);
			});
			socket.once("connect", () => {
				this.requestRaw<DaemonStatus>({ type: "handshake", id: "handshake", protocolVersion: PROTOCOL_VERSION, token: this.token }, "handshake")
					.then((status) => {
						settled = true;
						this.connected = true;
						cleanup();
						resolve(status);
					}, fail);
			});
		});
	}

	async request<T = unknown>(command: ThreadAction, params: Record<string, unknown> = {}, requestId = `${command}-${this.nextRequest++}-${randomUUID()}`): Promise<T> {
		return this.requestRaw<T>({ type: "request", id: requestId, command, token: this.token, params }, command);
	}

	disconnect(error?: Error): void {
		const socket = this.socket;
		this.socket = null;
		this.connected = false;
		if (socket && !socket.destroyed) socket.destroy();
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error ?? new Error("Thread manager client disconnected"));
		}
		this.pending.clear();
	}

	private requestRaw<T>(request: Parameters<typeof validateBrokerRequest>[0], command?: ThreadAction): Promise<T> {
		validateBrokerRequest(request, this.limits);
		const socket = this.socket;
		if (!socket || socket.destroyed || !socket.writable) return Promise.reject(new Error("Thread manager client is not connected"));
		const id = (request as { id: string }).id;
		return new Promise((resolve, reject) => {
			const timeoutMs = command === "create" ? this.createTimeoutMs : this.timeoutMs;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Thread manager request timed out: ${id}`));
			}, timeoutMs);
			this.pending.set(id, {
				command,
				resolve: (response) => {
					if (response.success) resolve(response.data as T);
					else reject(new Error(response.error));
				},
				reject,
				timer,
			});
			try {
				writeMessage(socket, request, this.limits);
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private handleMessage(message: unknown): void {
		if (typeof message !== "object" || message === null) throw new Error("Invalid thread manager response");
		const response = message as BrokerResponse;
		if (response.type !== "response" || typeof response.id !== "string") throw new Error("Invalid thread manager response");
		const pending = this.pending.get(response.id);
		if (!pending) return;
		if (pending.command && response.command && pending.command !== response.command) throw new Error(`Response command mismatch for ${response.id}`);
		this.pending.delete(response.id);
		clearTimeout(pending.timer);
		pending.resolve(response);
	}
}
