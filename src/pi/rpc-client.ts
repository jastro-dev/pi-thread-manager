import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type PiRpcCommand = Record<string, unknown> & { type: string; id?: string };
export type PiRpcResponse<T = unknown> = {
	type: "response";
	command: string;
	success: boolean;
	id?: string;
	data?: T;
	error?: string;
};
export type PiRpcUiRequest = Record<string, unknown> & { type: "extension_ui_request"; id: string };

export interface PiRpcClientOptions {
	onUiRequest?: (request: PiRpcUiRequest) => unknown | Promise<unknown>;
}

type Pending = {
	resolve: (response: PiRpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

export function createJsonlReader(onMessage: (message: unknown) => void, onError: (error: Error) => void, maxBufferBytes = 1024 * 1024): (chunk: Buffer) => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	return (chunk: Buffer) => {
		buffer += decoder.write(chunk);
		for (;;) {
			const index = buffer.indexOf("\n");
			if (index === -1) {
				if (Buffer.byteLength(buffer, "utf8") > maxBufferBytes) {
					onError(new Error(`Pi RPC line exceeds ${maxBufferBytes} bytes`));
					buffer = "";
				}
				return;
			}
			let line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line) continue;
			if (Buffer.byteLength(line, "utf8") > maxBufferBytes) {
				onError(new Error(`Pi RPC line exceeds ${maxBufferBytes} bytes`));
				buffer = "";
				return;
			}
			try {
				onMessage(JSON.parse(line));
			} catch (error) {
				onError(new Error(`Failed to parse Pi RPC line: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
				return;
			}
		}
	};
}

export interface ChildRpcPort {
	request<T = unknown>(command: PiRpcCommand, timeoutMs?: number): Promise<T>;
	destroy(error?: Error): void;
}

export class PiRpcClient implements ChildRpcPort {
	private pending = new Map<string, Pending>();
	private nextId = 1;
	private terminalError: Error | undefined;

	constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly defaultTimeoutMs = 10_000, private readonly options: PiRpcClientOptions = {}) {
		const reader = createJsonlReader((message) => this.handleMessage(message), (error) => this.destroy(error));
		child.stdout.on("data", reader);
		child.once("exit", () => this.destroy(new Error("Pi RPC child exited")));
		child.once("error", (error) => this.destroy(error));
	}

	request<T = unknown>(command: PiRpcCommand, timeoutMs = this.defaultTimeoutMs): Promise<T> {
		if (this.terminalError) return Promise.reject(this.terminalError);
		const id = command.id ?? `rpc-${this.nextId++}`;
		const payload = { ...command, id };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Pi RPC request timed out: ${command.type}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (response) => {
					if (response.success) resolve(response.data as T);
					else reject(new Error(response.error ?? `${response.command} failed`));
				},
				reject,
				timer,
			});
			this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
		});
	}

	destroy(error = new Error("Pi RPC client destroyed")): void {
		if (!this.terminalError) this.terminalError = error;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(this.terminalError);
		}
		this.pending.clear();
	}

	private handleMessage(message: unknown): void {
		if (!message || typeof message !== "object") return;
		if (isUiRequest(message)) {
			void this.handleUiRequest(message);
			return;
		}
		const response = message as Partial<PiRpcResponse>;
		if (response.type !== "response" || typeof response.id !== "string") return;
		const pending = this.pending.get(response.id);
		if (!pending) return;
		this.pending.delete(response.id);
		clearTimeout(pending.timer);
		pending.resolve(response as PiRpcResponse);
	}

	private async handleUiRequest(request: PiRpcUiRequest): Promise<void> {
		try {
			if (!this.options.onUiRequest) throw new Error(`Pi RPC child requested unsupported UI interaction: ${describeUiRequest(request)}`);
			const data = await this.options.onUiRequest(request);
			this.writeUiResponse(request.id, true, data);
		} catch (error) {
			this.writeUiResponse(request.id, false, undefined, error instanceof Error ? error.message : String(error));
		}
	}

	private writeUiResponse(id: string, success: boolean, data?: unknown, error?: string): void {
		const payload = success ? normalizeUiResponse(data) : { cancelled: true, error };
		this.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, ...payload })}\n`, "utf8");
	}
}

function isUiRequest(message: unknown): message is PiRpcUiRequest {
	return Boolean(message && typeof message === "object" && (message as { type?: unknown }).type === "extension_ui_request" && typeof (message as { id?: unknown }).id === "string");
}

function describeUiRequest(request: PiRpcUiRequest): string {
	const label = request.method ?? request.kind ?? request.requestType ?? request.name ?? request.id;
	return typeof label === "string" ? label : request.id;
}

function normalizeUiResponse(data: unknown): Record<string, unknown> {
	if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
	return { value: data };
}
