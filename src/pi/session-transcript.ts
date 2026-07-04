import path from "node:path";
import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

export interface TranscriptWindow {
	items: unknown[];
	truncated: boolean;
}

export async function realpathCwd(cwd: string): Promise<string> {
	return await realpath(path.resolve(cwd));
}

export async function readSessionTranscript(sessionFile: string, cursor: number, limit: number): Promise<TranscriptWindow> {
	const items: unknown[] = [];
	let lineIndex = 0;
	let truncated = false;
	let sawLine = false;
	const stream = createReadStream(sessionFile, { encoding: "utf8" });
	const reader = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of reader) {
			if (line.trim() === "") continue;
			sawLine = true;
			if (lineIndex >= cursor) {
				if (items.length >= limit) {
					truncated = true;
					break;
				}
				items.push(parseTranscriptLine(line));
			}
			lineIndex += 1;
		}
		if (!sawLine && cursor === 0) items.push({ type: "thread_manager_unavailable", message: "Persisted session transcript is empty" });
		return { items, truncated };
	} catch (error) {
		return { items: [{ type: "thread_manager_unavailable", message: `Could not read persisted session transcript: ${error instanceof Error ? error.message : String(error)}` }], truncated: false };
	} finally {
		reader.close();
		stream.destroy();
	}
}

export async function discoverSessionFile(sessionDir: string, fallback: string | undefined): Promise<string | undefined> {
	let entries: string[];
	try {
		entries = await readdir(sessionDir);
	} catch {
		return fallback;
	}
	let newest: { filePath: string; mtimeMs: number } | undefined;
	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue;
		const filePath = path.join(sessionDir, entry);
		try {
			const info = await stat(filePath);
			if (!info.isFile()) continue;
			if (!newest || info.mtimeMs > newest.mtimeMs) newest = { filePath, mtimeMs: info.mtimeMs };
		} catch {}
	}
	return newest?.filePath ?? fallback;
}

function parseTranscriptLine(line: string): unknown {
	try {
		return JSON.parse(line) as unknown;
	} catch {
		return { type: "session_line", text: line };
	}
}
