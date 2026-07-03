import { env } from "../../env";
import { executeBash } from "../tools/implementations/commands";

const WORKSPACE = env.WORKSPACE_PATH;

interface VerificationResult {
	command: string;
	type: "lint" | "typecheck" | "test";
	success: boolean;
	output: string;
	stderr: string;
	exitCode: number;
}

interface VerificationSummary {
	hasErrors: boolean;
	results: VerificationResult[];
	errorMessage: string;
}

/**
 * Detect available lint, typecheck, and test commands in the workspace.
 * Checks package.json for npm/bun scripts with these names.
 */
async function detectVerificationCommands(): Promise<Map<string, string>> {
	const commands = new Map<string, string>();

	try {
		// Read package.json from workspace
		const pkgPath = `${WORKSPACE}/package.json`;
		const file = Bun.file(pkgPath);
		const exists = await file.exists();

		if (!exists) {
			console.log("[Verification] No package.json found in workspace");
			return commands;
		}

		const pkg = await file.json();
		const scripts = pkg.scripts || {};

		// Detect lint commands
		if (scripts.lint) {
			commands.set("lint", "bun runlint");
		} else if (scripts["lint:check"]) {
			commands.set("lint", "bun runlint:check");
		} else if (scripts.eslint) {
			commands.set("lint", "bun runeslint");
		}

		// Detect typecheck commands
		if (scripts.typecheck) {
			commands.set("typecheck", "bun runtypecheck");
		} else if (scripts["type-check"]) {
			commands.set("typecheck", "bun runtype-check");
		} else if (scripts.tsc) {
			commands.set("typecheck", "bun runtsc");
		}

		// Detect test commands
		if (scripts.test) {
			commands.set("test", "bun runtest");
		} else if (scripts["test:unit"]) {
			commands.set("test", "bun runtest:unit");
		}

		console.log(`[Verification] Detected commands: ${Array.from(commands.keys()).join(", ")}`);
	} catch (err) {
		console.warn("[Verification] Failed to detect commands:", err);
	}

	return commands;
}

/**
 * Run a verification command and return the result.
 */
async function runVerificationCommand(
	type: "lint" | "typecheck" | "test",
	command: string
): Promise<VerificationResult> {
	console.log(`[Verification] Running ${type}: ${command}`);

	const result = await executeBash(command, 120_000); // 2 minute timeout for tests

	return {
		command,
		type,
		success: result.exitCode === 0,
		output: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
	};
}

/**
 * Run all available verification commands (lint, typecheck, test) and return a summary.
 * This is called after the agent completes a task to ensure code quality.
 */
export async function runVerificationSuite(): Promise<VerificationSummary> {
	const commands = await detectVerificationCommands();

	if (commands.size === 0) {
		console.log("[Verification] No verification commands found, skipping");
		return {
			hasErrors: false,
			results: [],
			errorMessage: "",
		};
	}

	const results: VerificationResult[] = [];

	// Run commands in order: lint -> typecheck -> test
	const order: Array<"lint" | "typecheck" | "test"> = ["lint", "typecheck", "test"];

	for (const type of order) {
		const command = commands.get(type);
		if (command) {
			const result = await runVerificationCommand(type, command);
			results.push(result);
		}
	}

	// Build error message if any verification failed
	const failures = results.filter((r) => !r.success);
	const hasErrors = failures.length > 0;

	let errorMessage = "";
	if (hasErrors) {
		errorMessage = "🔴 **Verification failed** - Please fix the following issues:\n\n";

		for (const failure of failures) {
			errorMessage += `## ${failure.type.toUpperCase()} Failed\n\n`;
			errorMessage += `**Command:** \`${failure.command}\`\n`;
			errorMessage += `**Exit code:** ${failure.exitCode}\n\n`;

			if (failure.stderr) {
				errorMessage += `**Error output:**\n\`\`\`\n${failure.stderr.slice(0, 3000)}\n\`\`\`\n\n`;
			}

			if (failure.output) {
				errorMessage += `**Output:**\n\`\`\`\n${failure.output.slice(0, 3000)}\n\`\`\`\n\n`;
			}
		}

		errorMessage += "\n---\n\n";
		errorMessage += "Please fix these issues and ensure all verification checks pass.";
	}

	console.log(`[Verification] Summary: ${results.length} commands run, ${failures.length} failed`);

	return {
		hasErrors,
		results,
		errorMessage,
	};
}
