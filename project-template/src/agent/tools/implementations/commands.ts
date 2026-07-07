import { env } from "../../../env";
import { sandboxPath } from "./sandbox";

const WORKSPACE = env.WORKSPACE_PATH;

export async function executeBash(
	command: string,
	timeoutMs = 30_000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	try {
		const proc = Bun.spawn(["bash", "-c", command], {
			cwd: WORKSPACE,
			stdout: "pipe",
			stderr: "pipe",
		});

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, timeoutMs);

		// Read both streams while waiting for exit. Reading only after exit
		// deadlocks any command whose output exceeds the OS pipe buffer: the
		// process blocks on a full pipe and never exits, so the timeout kill is
		// the only way out.
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		clearTimeout(timer);

		const stderrOut = timedOut ? `Command timed out after ${timeoutMs}ms and was killed.\n${stderr}` : stderr;
		return { stdout: stdout.slice(0, 8000), stderr: stderrOut.slice(0, 2000), exitCode };
	} catch (err) {
		return { stdout: "", stderr: String(err), exitCode: 1 };
	}
}

export interface GrepOptions {
	path?: string;
	include?: string;
	extraFlags?: string[];
	caseSensitive?: boolean;
	maxResults?: number;
	timeoutMs?: number;
}

/**
 * Run grep with an argv array (no shell) so patterns containing quotes,
 * `$`, backticks, etc. are passed through verbatim instead of being
 * re-interpreted — the previous shell-string interpolation broke on any
 * pattern with unescaped shell metacharacters.
 */
export async function runGrep(pattern: string, options: GrepOptions = {}): Promise<string> {
	const { path = ".", include, extraFlags = [], caseSensitive = true, maxResults = 200, timeoutMs = 15_000 } = options;

	const args = ["-rn", "--binary-files=without-match"];
	if (!caseSensitive) args.push("-i");
	if (include) args.push(`--include=${include}`);
	args.push(...extraFlags, "-E", pattern, path);

	try {
		const proc = Bun.spawn(["grep", ...args], { cwd: WORKSPACE, stdout: "pipe", stderr: "pipe" });

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, timeoutMs);

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		clearTimeout(timer);

		if (timedOut) return `Search timed out after ${timeoutMs}ms.`;
		// grep exits 1 on "no matches", ≥2 on real errors (bad pattern, missing path)
		if (exitCode > 1) return `Search failed: ${stderr.trim() || `grep exited with code ${exitCode}`}`;

		const lines = stdout.split("\n").filter(Boolean);
		if (lines.length === 0) return "No matches found.";
		const shown = lines.slice(0, maxResults);
		const suffix = lines.length > shown.length ? `\n\n[${lines.length - shown.length} more matches truncated]` : "";
		return shown.join("\n") + suffix;
	} catch (err) {
		return `Search failed: ${String(err)}`;
	}
}

export async function grep(pattern: string, path = ".", include?: string, flags = ""): Promise<string> {
	const extraFlags = flags.split(/\s+/).filter(Boolean);
	// Constrain the search root to the workspace sandbox — an absolute or `../`
	// path would otherwise let grep read arbitrary host files.
	const options: GrepOptions = { path: sandboxPath(path), extraFlags };
	if (include !== undefined) options.include = include;
	return runGrep(pattern, options);
}

export async function glob(pattern: string, path = "."): Promise<string> {
	// Resolve + sandbox the search root: a bare relative path would scan from the
	// server cwd, and an absolute/`../` path would escape the workspace entirely.
	const cwd = sandboxPath(path);
	const scanner = new Bun.Glob(pattern).scan({ cwd, onlyFiles: false });
	const matches: string[] = [];
	for await (const file of scanner) matches.push(file);
	return matches.length ? matches.join("\n") : "No matches found.";
}
