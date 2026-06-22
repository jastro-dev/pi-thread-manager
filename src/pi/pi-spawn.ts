import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { loadThreadManagerConfig, type ThreadManagerConfig } from "../config.ts";

const require = createRequire(import.meta.url);

export interface PiSpawnDeps {
	platform?: NodeJS.Platform;
	execPath?: string;
	argv0?: string;
	argv1?: string;
	existsSync?: (filePath: string) => boolean;
	readFileSync?: (filePath: string, encoding: "utf-8") => string;
	resolvePackageJson?: () => string;
	resolvePackageEntry?: () => string;
	moduleSearchStartDir?: string;
	piPackageRoot?: string;
	config?: ThreadManagerConfig;
	loadConfig?: () => ThreadManagerConfig;
}

export interface PiSpawnCommand {
	command: string;
	args: string[];
	allowPathCommand?: boolean;
}

export function resolvePiPackageRoot(): string | undefined {
	try {
		const entry = process.argv[1];
		if (!entry) return undefined;
		let dir = dirname(fs.realpathSync(entry));
		while (dir !== dirname(dir)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(joinPath(dir, "package.json"), "utf-8")) as { name?: string };
				if (pkg.name === "@earendil-works/pi-coding-agent") return dir;
			} catch {}
			dir = dirname(dir);
		}
	} catch {}
	return undefined;
}

export function resolvePiCliScript(deps: PiSpawnDeps = {}): string | undefined {
	const existsSync = deps.existsSync ?? fs.existsSync;
	const readFileSync = deps.readFileSync ?? ((filePath, encoding) => fs.readFileSync(filePath, encoding));
	const argv1 = deps.argv1 ?? process.argv[1];

	if (argv1) {
		const argvPath = normalizePath(argv1);
		const piCliPath = resolvePiCliScriptFromPackageRoot(argvPath, readFileSync, existsSync);
		if (piCliPath) return piCliPath;
	}

	try {
		const packageJsonPath = resolvePiPackageJsonPath(deps, readFileSync);
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { bin?: string | Record<string, string> };
		const binField = packageJson.bin;
		const binPath = typeof binField === "string" ? binField : binField?.pi ?? Object.values(binField ?? {})[0];
		if (!binPath) return undefined;
		const candidate = resolvePackageRelativePath(packageJsonPath, binPath);
		if (isRunnableNodeScript(candidate, existsSync)) return candidate;
	} catch {
		return undefined;
	}

	return undefined;
}

export function getPiSpawnCommand(args: string[], deps: PiSpawnDeps = {}): PiSpawnCommand {
	const config = deps.config ?? (deps.loadConfig ?? loadThreadManagerConfig)();
	const piCliPath = resolvePiCliScript(deps);
	if (config.launchCommand) {
		if (!piCliPath) throw new Error("Configured thread-manager launchCommand requires a resolvable Pi CLI script");
		return { command: config.launchCommand, args: [...config.launchArgs, piCliPath, ...args], allowPathCommand: true };
	}

	if (piCliPath) return { command: deps.execPath ?? process.execPath, args: [piCliPath, ...args] };

	const argv0 = deps.argv0 ?? process.argv0;
	if (isLikelyPiExecutable(argv0) && path.isAbsolute(argv0)) return { command: argv0, args };

	const execPath = deps.execPath ?? process.execPath;
	if (isLikelyPiExecutable(execPath) && path.isAbsolute(execPath)) return { command: execPath, args };

	return { command: "pi", args };
}

function isRunnableNodeScript(filePath: string, existsSync: (filePath: string) => boolean): boolean {
	if (!existsSync(filePath)) return false;
	return /\.(?:mjs|cjs|js)$/i.test(filePath);
}

function resolvePiCliScriptFromPackageRoot(scriptPath: string, readFileSync: (filePath: string, encoding: "utf-8") => string, existsSync: (filePath: string) => boolean): string | undefined {
	let dir = dirname(scriptPath);
	while (dir !== dirname(dir)) {
		const packageJsonPath = joinPath(dir, "package.json");
		try {
			const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { name?: string; bin?: string | Record<string, string> };
			if (packageJson.name === "@earendil-works/pi-coding-agent") {
				const binField = packageJson.bin;
				const binPath = typeof binField === "string" ? binField : binField?.pi ?? Object.values(binField ?? {})[0];
				if (!binPath) return undefined;
				const candidate = resolvePackageRelativePath(packageJsonPath, binPath);
				return samePath(candidate, scriptPath) && isRunnableNodeScript(candidate, existsSync) ? candidate : undefined;
			}
		} catch {}
		dir = dirname(dir);
	}
	return undefined;
}

function resolvePiPackageJsonPath(deps: PiSpawnDeps, readFileSync: (filePath: string, encoding: "utf-8") => string): string {
	if (deps.resolvePackageJson) {
		try {
			return deps.resolvePackageJson();
		} catch {}
	}
	const root = deps.piPackageRoot ?? resolvePiPackageRoot();
	if (root) return joinPath(root, "package.json");
	try {
		return require.resolve("@earendil-works/pi-coding-agent/package.json");
	} catch {
		const nodeModulesPackageJsonPath = findPackageJsonInNodeModules(deps.moduleSearchStartDir ?? dirname(fileURLToPath(import.meta.url)), "@earendil-works/pi-coding-agent", readFileSync);
		if (nodeModulesPackageJsonPath) return nodeModulesPackageJsonPath;
		const entry = (deps.resolvePackageEntry ?? (() => require.resolve("@earendil-works/pi-coding-agent")))();
		const packageJsonPath = findPackageJsonForPackage(dirname(entry), "@earendil-works/pi-coding-agent", readFileSync);
		if (!packageJsonPath) throw new Error("Could not resolve @earendil-works/pi-coding-agent package root");
		return packageJsonPath;
	}
}

function findPackageJsonInNodeModules(startDir: string, packageName: string, readFileSync: (filePath: string, encoding: "utf-8") => string): string | undefined {
	let dir = startDir;
	while (dir !== dirname(dir)) {
		const packageJsonPath = joinPath(joinPath(dir, "node_modules"), `${packageName}/package.json`);
		try {
			const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { name?: string };
			if (packageJson.name === packageName) return packageJsonPath;
		} catch {}
		dir = dirname(dir);
	}
	return undefined;
}

function findPackageJsonForPackage(startDir: string, packageName: string, readFileSync: (filePath: string, encoding: "utf-8") => string): string | undefined {
	let dir = startDir;
	while (dir !== dirname(dir)) {
		const packageJsonPath = joinPath(dir, "package.json");
		try {
			const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { name?: string };
			if (packageJson.name === packageName) return packageJsonPath;
		} catch {}
		dir = dirname(dir);
	}
	return undefined;
}

function normalizePath(filePath: string): string {
	if (isWindowsNativeAbsolutePath(filePath)) return path.win32.normalize(filePath);
	if (isPosixAbsolutePath(filePath)) return path.posix.normalize(filePath);
	return path.resolve(filePath);
}

function resolvePackageRelativePath(packageJsonPath: string, binPath: string): string {
	if (isWindowsNativeAbsolutePath(packageJsonPath)) return path.win32.resolve(path.win32.dirname(packageJsonPath), binPath);
	if (isPosixAbsolutePath(packageJsonPath)) return path.posix.resolve(path.posix.dirname(packageJsonPath), binPath);
	return normalizePath(path.resolve(path.dirname(packageJsonPath), binPath));
}

function isWindowsNativeAbsolutePath(filePath: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\");
}

function isPosixAbsolutePath(filePath: string): boolean {
	return filePath.startsWith("/") && !filePath.startsWith("//");
}

function dirname(filePath: string): string {
	if (isWindowsNativeAbsolutePath(filePath)) return path.win32.dirname(filePath);
	if (isPosixAbsolutePath(filePath)) return path.posix.dirname(filePath);
	return path.dirname(filePath);
}

function joinPath(base: string, segment: string): string {
	if (isWindowsNativeAbsolutePath(base)) return path.win32.join(base, segment);
	if (isPosixAbsolutePath(base)) return path.posix.join(base, segment);
	return path.join(base, segment);
}

function samePath(left: string, right: string): boolean {
	const normalizedLeft = left.replace(/\\/g, "/");
	const normalizedRight = right.replace(/\\/g, "/");
	return process.platform === "win32" ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}

function isLikelyPiExecutable(command: string | undefined): command is string {
	if (!command) return false;
	const baseName = path.basename(command).toLowerCase();
	return baseName === "pi" || baseName === "pi.exe" || baseName.startsWith("pi-");
}
