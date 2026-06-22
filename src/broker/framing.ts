import type { Socket } from "node:net";

import { DEFAULT_PROTOCOL_LIMITS, type ProtocolLimits } from "../types.ts";

export function writeMessage(socket: Socket, message: unknown, limits: ProtocolLimits = DEFAULT_PROTOCOL_LIMITS): void {
	const payload = Buffer.from(JSON.stringify(message), "utf8");
	if (payload.length > limits.maxFrameBytes) throw new Error(`Thread manager frame exceeds ${limits.maxFrameBytes} bytes`);
	const header = Buffer.alloc(4);
	header.writeUInt32BE(payload.length, 0);
	socket.write(Buffer.concat([header, payload]));
}

export function createMessageReader(
	onMessage: (message: unknown) => void,
	onError: (error: Error) => void,
	limits: ProtocolLimits = DEFAULT_PROTOCOL_LIMITS,
): (data: Buffer) => void {
	let buffer = Buffer.alloc(0);
	return (data: Buffer) => {
		buffer = Buffer.concat([buffer, data]);
		while (buffer.length >= 4) {
			const length = buffer.readUInt32BE(0);
			if (length > limits.maxFrameBytes) {
				onError(new Error(`Thread manager frame exceeds ${limits.maxFrameBytes} bytes`));
				return;
			}
			if (buffer.length < 4 + length) return;
			const payload = buffer.subarray(4, 4 + length);
			buffer = buffer.subarray(4 + length);
			try {
				onMessage(JSON.parse(payload.toString("utf8")));
			} catch (error) {
				onError(new Error(`Failed to parse thread manager message: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
				return;
			}
		}
	};
}
