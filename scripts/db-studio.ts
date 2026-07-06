#!/usr/bin/env bun
/**
 * Open a project's agent.db in Drizzle Studio.
 *
 * Usage: bun db:studio <project-name-or-id>
 *
 * Looks the project up under .projects/ by name (case-insensitive) or
 * directory id, then launches `drizzle-kit studio` pointed at its
 * data/agent.db via scripts/drizzle-studio.config.ts.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectManager } from "../packages/projects/src/manager";

const rootDir = resolve(import.meta.dir, "..");
const query = process.argv[2];

if (!query) {
	console.error("Usage: bun db:studio <project-name-or-id>");
	process.exit(1);
}

const manager = new ProjectManager(rootDir);
const projects = await manager.listProjects();
const project = projects.find((p) => p.id === query || p.name.toLowerCase() === query.toLowerCase());

if (!project) {
	console.error(`No project named "${query}".`);
	if (projects.length > 0) {
		console.error("Available projects:");
		for (const p of projects) console.error(`  - ${p.name} (${p.id})`);
	} else {
		console.error("No projects found under .projects/.");
	}
	process.exit(1);
}

const dbPath = manager.getProjectDatabaseManagerPath(project.id);
if (!existsSync(dbPath)) {
	console.error(`Database not found at ${dbPath} — has the project been started?`);
	process.exit(1);
}

console.log(`Opening database of "${project.name}" (${dbPath}) in Drizzle Studio…`);

const proc = Bun.spawn(
	[
		join(rootDir, "node_modules", ".bin", "drizzle-kit"),
		"studio",
		"--config",
		join(rootDir, "scripts", "drizzle-studio.config.ts"),
	],
	{
		cwd: rootDir,
		env: { ...process.env, PROJECT_DB_PATH: dbPath },
		stdio: ["inherit", "inherit", "inherit"],
	}
);

process.exit(await proc.exited);
