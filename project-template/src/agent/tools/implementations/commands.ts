const WORKSPACE = process.env.WORKSPACE_PATH ?? "/workspace";

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

		const timer = setTimeout(() => proc.kill(), timeoutMs);
		const exitCode = await proc.exited;
		clearTimeout(timer);

		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		return { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000), exitCode };
	} catch (err) {
		return { stdout: "", stderr: String(err), exitCode: 1 };
	}
}

export async function grep(pattern: string, path = ".", include?: string, flags = ""): Promise<string> {
	const includeFlag = include ? `--include="${include}"` : "";
	const cmd = `grep -rn ${flags} ${includeFlag} -E "${pattern.replace(/"/g, '\\"')}" "${path}" 2>/dev/null | head -200`;
	const result = await executeBash(cmd, 15_000);
	return result.stdout || "No matches found.";
}

export async function glob(pattern: string, path = "."): Promise<string> {
	const scanner = new Bun.Glob(pattern).scan({ cwd: path, onlyFiles: false });
	const matches: string[] = [];
	for await (const file of scanner) matches.push(file);
	return matches.length ? matches.join("\n") : "No matches found.";
}
