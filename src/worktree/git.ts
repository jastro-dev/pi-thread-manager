import { execFile } from "node:child_process";

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type GitExec = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<ExecResult>;

export const GIT_TIMEOUT_MS = 30_000;

export async function defaultExec(command: string, args: string[], options: { cwd?: string; timeout?: number } = {}): Promise<ExecResult> {
	return await new Promise((resolve) => {
		execFile(command, args, { cwd: options.cwd, timeout: options.timeout ?? GIT_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
			const errorCode = (error as NodeJS.ErrnoException | null)?.code;
			resolve({
				code: typeof errorCode === "number" ? errorCode : error ? 1 : 0,
				stdout: String(stdout ?? ""),
				stderr: String(stderr ?? ""),
			});
		});
	});
}

export async function git(exec: GitExec, cwd: string, args: string[]): Promise<ExecResult> {
	return await exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
}

export async function requireGit(exec: GitExec, cwd: string, args: string[], description: string): Promise<string> {
	const result = await git(exec, cwd, args);
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		throw new Error(`${description} failed: ${detail}`);
	}
	return result.stdout;
}
