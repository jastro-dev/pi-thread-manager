import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PiRpcClient, createJsonlReader } from "../src/pi/rpc-client.ts";

test("JSONL reader preserves UTF-8 characters split across chunks", () => {
	const messages: unknown[] = [];
	const errors: Error[] = [];
	const reader = createJsonlReader((message) => messages.push(message), (error) => errors.push(error));
	const payload = Buffer.from(`${JSON.stringify({ text: "snowman ☃" })}\n`, "utf8");
	const split = payload.indexOf(Buffer.from("☃")) + 1;
	reader(payload.subarray(0, split));
	reader(payload.subarray(split));
	assert.deepEqual(messages, [{ text: "snowman ☃" }]);
	assert.deepEqual(errors, []);
});

test("JSONL reader enforces size limit per line", () => {
	const messages: unknown[] = [];
	const errors: Error[] = [];
	const reader = createJsonlReader((message) => messages.push(message), (error) => errors.push(error), 30);
	reader(Buffer.from(`${JSON.stringify({ ok: 1 })}\n${JSON.stringify({ ok: 2 })}\n`));
	assert.deepEqual(messages, [{ ok: 1 }, { ok: 2 }]);
	assert.equal(errors.length, 0);
	reader(Buffer.from(`${JSON.stringify({ tooLong: "x".repeat(40) })}\n`));
	assert.match(errors[0].message, /exceeds 30/);
});

test("RPC client responds to child UI requests", async () => {
	const child = createFakeChild();
	new PiRpcClient(child as never, 1000, { onUiRequest: (request) => ({ accepted: request.prompt === "Approve?" }) });
	child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "extension_ui_request", id: "ui-1", prompt: "Approve?" })}\n`));
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(JSON.parse(child.writes[0]), { type: "extension_ui_response", id: "ui-1", accepted: true });
});

test("RPC client rejects unsupported child UI requests instead of dropping them", async () => {
	const child = createFakeChild();
	new PiRpcClient(child as never);
	child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "extension_ui_request", id: "ui-1", kind: "approval" })}\n`));
	await new Promise((resolve) => setImmediate(resolve));
	const response = JSON.parse(child.writes[0]) as { type: string; id: string; cancelled: boolean; error: string };
	assert.equal(response.type, "extension_ui_response");
	assert.equal(response.id, "ui-1");
	assert.equal(response.cancelled, true);
	assert.match(response.error, /unsupported UI interaction: approval/);
});

test("RPC client rejects requests after child exit", async () => {
	const child = createFakeChild();
	const client = new PiRpcClient(child as never);
	child.emit("exit");
	await assert.rejects(() => client.request({ type: "get_state" }), /child exited/);
	assert.deepEqual(child.writes, []);
});

function createFakeChild(): EventEmitter & { stdout: EventEmitter; stdin: { write: (chunk: string | Buffer) => boolean }; writes: string[] } {
	const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stdin: { write: (chunk: string | Buffer) => boolean }; writes: string[] };
	child.stdout = new EventEmitter();
	child.writes = [];
	child.stdin = { write: (chunk) => { child.writes.push(String(chunk).trim()); return true; } };
	return child;
}
