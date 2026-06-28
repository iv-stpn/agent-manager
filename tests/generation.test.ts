#!/usr/bin/env bun

/**
 * Template Generation & Parse Test
 *
 * Verifies that ProjectManager.createProject() copies the project-template
 * verbatim into .projects/<id> and that every generated TypeScript file
 * PARSES under Bun. This directly guards against the class of bug that
 * crashed the agent container (an unterminated template literal in
 * runner.ts that Bun rejected at startup).
 *
 * Run:  bun test tests/generation.test.ts
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ProjectManager } from "../packages/projects/src/index.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const TEST_PROJECT_ID = "gentest";

const manager = new ProjectManager(REPO_ROOT);

/** Recursively collect every .ts file under a directory. */
async function collectTsFiles(dir: string, acc: string[] = []): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return acc;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			// Skip build artifacts and copied packages' node_modules
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") continue;
			await collectTsFiles(full, acc);
		} else if (entry.name.endsWith(".ts")) {
			acc.push(full);
		}
	}
	return acc;
}

/** Parse-check a single TS file with Bun (transpile only, no resolve). Returns true on success. */
async function parsesOk(file: string): Promise<{ ok: boolean; error?: string }> {
	const proc = Bun.spawn(["bun", "build", file, "--no-bundle", "--target=bun"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const code = await proc.exited;
	if (code === 0) return { ok: true };
	const stderr = await new Response(proc.stderr).text();
	return { ok: false, error: stderr.trim().split("\n").slice(0, 4).join("\n") };
}

afterEach(async () => {
	// Ensure no leftover gentest project between runs
	try {
		await manager.deleteProject(TEST_PROJECT_ID);
	} catch {
		// already gone — fine
	}
});

test("createProject copies the template and the generated server parses cleanly", async () => {
	// Clean slate
	try {
		await manager.deleteProject(TEST_PROJECT_ID);
	} catch {}

	const config = await manager.createProject({
		id: TEST_PROJECT_ID,
		name: "Gen Test",
		description: "generation parse check",
	});

	expect(config.id).toBe(TEST_PROJECT_ID);
	expect(config.ports.server).toBeGreaterThanOrEqual(3000);

	const projectDir = manager.getProjectDir(TEST_PROJECT_ID);
	expect(existsSync(join(projectDir, "src", "agent", "runner.ts"))).toBe(true);
	expect(existsSync(join(projectDir, "docker-compose.yml"))).toBe(true);
	expect(existsSync(join(projectDir, ".env"))).toBe(true);

	// Every .ts file in the generated server must parse under Bun.
	const tsFiles = await collectTsFiles(join(projectDir, "src"));
	expect(tsFiles.length).toBeGreaterThan(0);

	const failures: Array<{ file: string; error: string }> = [];
	for (const file of tsFiles) {
		const result = await parsesOk(file);
		if (!result.ok) {
			failures.push({
				file: file.replace(projectDir, "<project>"),
				error: result.error ?? "unknown",
			});
		}
	}

	if (failures.length > 0) {
		console.error(`\n❌ Parse failures in generated project:\n${failures.map((f) => `  ${f.file}\n    ${f.error}`).join("\n")}`);
	}
	expect(failures).toEqual([]);
});

test("generated runner.ts is byte-identical to the template source", async () => {
	const { readFile } = await import("node:fs/promises");
	try {
		await manager.deleteProject(TEST_PROJECT_ID);
	} catch {}
	await manager.createProject({ id: TEST_PROJECT_ID, name: "Gen Test" });

	const projectDir = manager.getProjectDir(TEST_PROJECT_ID);
	const generated = await readFile(join(projectDir, "src", "agent", "runner.ts"), "utf-8");
	const template = await readFile(join(REPO_ROOT, "project-template", "src", "agent", "runner.ts"), "utf-8");
	expect(generated).toBe(template);
});
