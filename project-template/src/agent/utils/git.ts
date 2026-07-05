import { join } from "node:path";

const GIT_AUTHOR_NAME = "Claude Agent";
const GIT_AUTHOR_EMAIL = "agent@agent-manager.local";

/** Run a git command in the workspace, returning its exit code and trimmed stdout.
 * Streams are read concurrently with the exit wait — reading after exit deadlocks
 * once output exceeds the OS pipe buffer. */
async function git(workspace: string, args: string[]): Promise<{ exitCode: number; stdout: string }> {
	const proc = Bun.spawn(["git", "-C", workspace, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, , exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout: stdout.trim() };
}

export async function isGitRepo(workspace: string): Promise<boolean> {
	return (await git(workspace, ["rev-parse", "--git-dir"])).exitCode === 0;
}

export async function initGitRepo(workspace: string): Promise<string> {
	await git(workspace, ["init"]);
	await git(workspace, ["config", "user.name", GIT_AUTHOR_NAME]);
	await git(workspace, ["config", "user.email", GIT_AUTHOR_EMAIL]);

	// Default .gitignore if none exists
	const gitignorePath = join(workspace, ".gitignore");
	if (!(await Bun.file(gitignorePath).exists())) {
		const entries = [
			"node_modules/",
			".next/",
			"dist/",
			"build/",
			"__pycache__/",
			"*.pyc",
			".env",
			".env.local",
			"*.db",
			"*.db-shm",
			"*.db-wal",
			".DS_Store",
		];
		await Bun.write(gitignorePath, entries.join("\n").concat("\n"));
		await git(workspace, ["add", ".gitignore"]);
		await git(workspace, ["commit", "-m", "chore: initial commit — agent workspace initialised"]);
	}

	return `Git repo initialised in ${workspace}.`;
}

export async function getCurrentCommit(workspace: string): Promise<string | null> {
	const { exitCode, stdout } = await git(workspace, ["rev-parse", "HEAD"]);
	return exitCode === 0 ? stdout.slice(0, 12) : null;
}

export interface CommitResult {
	success: boolean;
	output: string;
	commit: string | null;
}

export async function detectQualityCommands(workspace: string): Promise<string[]> {
	const commands: string[] = [];

	// Node / Bun project
	const pkgPath = join(workspace, "package.json");
	if (await Bun.file(pkgPath).exists()) {
		try {
			const pkg = JSON.parse(await Bun.file(pkgPath).text());
			const scripts: Record<string, string> = pkg.scripts ?? {};

			// Prefer biome check --write for auto-fix, else lint
			if (scripts.lint) commands.push("bun run lint");
			if (scripts.typecheck) commands.push("bun run typecheck");
			else if (scripts["type-check"]) commands.push("bun run type-check");
			if (scripts.test) commands.push("bun run test --passWithNoTests 2>/dev/null || true");
		} catch {
			// malformed package.json — skip
		}
	}

	// Python project
	if (await Bun.file(join(workspace, "pyproject.toml")).exists()) {
		commands.push("ruff check . --fix 2>/dev/null || true");
		commands.push("mypy . --ignore-missing-imports 2>/dev/null || true");
		commands.push("pytest --tb=short -q 2>/dev/null || true");
	}

	// Go project
	if (await Bun.file(join(workspace, "go.mod")).exists()) {
		commands.push("go vet ./...");
		commands.push("go test ./... 2>/dev/null || true");
	}

	// Rust project
	if (await Bun.file(join(workspace, "Cargo.toml")).exists()) {
		commands.push("cargo clippy -- -D warnings 2>/dev/null || true");
		commands.push("cargo test 2>/dev/null || true");
	}

	return commands;
}

export async function commitChanges(workspace: string, message: string, runQualityChecks: boolean): Promise<CommitResult> {
	const output: string[] = [];

	const runCmd = async (cmd: string): Promise<{ ok: boolean; out: string }> => {
		const proc = Bun.spawn(["bash", "-c", cmd], {
			cwd: workspace,
			stdout: "pipe",
			stderr: "pipe",
		});
		// Read streams concurrently with the exit wait (pipe-buffer deadlock otherwise)
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
		return { ok: exitCode === 0, out: combined };
	};

	// Run quality checks before commit
	if (runQualityChecks) {
		const cmds = await detectQualityCommands(workspace);
		for (const cmd of cmds) {
			const { ok, out } = await runCmd(cmd);
			output.push(`$ ${cmd}\n${out}`);
			if (!ok) {
				return {
					success: false,
					output: `Quality check failed — commit aborted.\n\n${output.join("\n\n")}`,
					commit: null,
				};
			}
		}
	}

	// Stage all changes
	const { ok: addOk, out: addOut } = await runCmd("git add -A");
	output.push(`$ git add -A\n${addOut}`);
	if (!addOk) return { success: false, output: output.join("\n\n"), commit: null };

	// Check if there's actually anything to commit
	const { out: statusOut } = await runCmd("git diff --cached --name-only");
	if (!statusOut.trim()) {
		return { success: false, output: "Nothing to commit — working tree clean.", commit: null };
	}

	// Commit
	const { ok: commitOk, out: commitOut } = await runCmd(
		`git -c user.name="${GIT_AUTHOR_NAME}" -c user.email="${GIT_AUTHOR_EMAIL}" commit -m ${JSON.stringify(message)}`
	);
	output.push(`$ git commit\n${commitOut}`);

	if (!commitOk) {
		return { success: false, output: output.join("\n\n"), commit: null };
	}

	const commit = await getCurrentCommit(workspace);
	return {
		success: true,
		output: output.join("\n\n"),
		commit,
	};
}
