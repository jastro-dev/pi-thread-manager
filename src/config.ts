import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ThreadManagerConfig {
	/** Command used to spawn managed child Pi sessions when set (e.g. "pnpx" or "/usr/bin/node"). */
	launchCommand?: string;

	/** Arguments passed to launchCommand before the resolved Pi CLI script and child session arguments. */
	launchArgs: string[];

	/** Non-secret PI_* environment flags injected into managed child Pi sessions. */
	childEnv: Record<string, string>;
}

export interface ThreadManagerConfigDeps {
	configPath?: string;
	existsSync?: (filePath: string) => boolean;
	readFileSync?: (filePath: string, encoding: "utf-8") => string;
	onError?: (message: string, error: unknown) => void;
}

export const CONFIG_PATH = join(homedir(), ".pi/agent/thread-manager/config.json");

export const defaultThreadManagerConfig: ThreadManagerConfig = {
	launchArgs: [],
	childEnv: {},
};

export function loadThreadManagerConfig(deps: ThreadManagerConfigDeps = {}): ThreadManagerConfig {
	const configPath = deps.configPath ?? CONFIG_PATH;
	const exists = deps.existsSync ?? existsSync;
	const read = deps.readFileSync ?? readFileSync;

	if (!exists(configPath)) return cloneDefaultThreadManagerConfig();

	try {
		const raw = read(configPath, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Config must be a JSON object");

		const parsedConfig = parsed as Record<string, unknown>;
		const config: ThreadManagerConfig = cloneDefaultThreadManagerConfig();

		if (Object.hasOwn(parsedConfig, "launchCommand")) {
			if (typeof parsedConfig.launchCommand !== "string") throw new Error(`"launchCommand" must be a string`);
			const launchCommand = parsedConfig.launchCommand.trim();
			if (!launchCommand) throw new Error(`"launchCommand" must not be empty`);
			config.launchCommand = launchCommand;
		}

		if (Object.hasOwn(parsedConfig, "launchArgs")) {
			if (!Array.isArray(parsedConfig.launchArgs)) throw new Error(`"launchArgs" must be an array`);
			const launchArgs: string[] = [];
			for (const arg of parsedConfig.launchArgs) {
				if (typeof arg !== "string") throw new Error(`"launchArgs" items must be strings`);
				launchArgs.push(arg);
			}
			config.launchArgs = launchArgs;
		}

		if (Object.hasOwn(parsedConfig, "childEnv")) {
			if (typeof parsedConfig.childEnv !== "object" || parsedConfig.childEnv === null || Array.isArray(parsedConfig.childEnv)) throw new Error(`"childEnv" must be an object`);
			config.childEnv = parseChildEnv(parsedConfig.childEnv as Record<string, unknown>);
		}

		return config;
	} catch (error) {
		const message = `Failed to load thread-manager config at ${configPath}:`;
		if (deps.onError) deps.onError(message, error);
		else console.error(message, error);
		return cloneDefaultThreadManagerConfig();
	}
}

function cloneDefaultThreadManagerConfig(): ThreadManagerConfig {
	return { ...defaultThreadManagerConfig, childEnv: { ...defaultThreadManagerConfig.childEnv } };
}

function parseChildEnv(input: Record<string, unknown>): Record<string, string> {
	const childEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(input)) {
		if (!/^PI_[A-Z0-9_]+$/.test(key)) throw new Error(`"childEnv" keys must be PI_* environment variable names`);
		if (key === "PI_THREAD_ID") throw new Error(`"childEnv" cannot override PI_THREAD_ID`);
		if (/(TOKEN|SECRET|AUTHORIZATION|PASSWORD|CREDENTIAL|KEY)$/i.test(key)) throw new Error(`"childEnv" must not contain secret-like keys`);
		if (typeof value !== "string") throw new Error(`"childEnv" values must be strings`);
		childEnv[key] = value;
	}
	return childEnv;
}
