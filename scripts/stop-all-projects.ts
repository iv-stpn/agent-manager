#!/usr/bin/env bun

/**
 * Stop every running project container. Invoked on orchestrator dev shutdown (see
 * scripts/dev.sh) so tearing down the dev stack also tears down all projects.
 */
import { join } from "node:path";

// scripts/ is not a workspace package, so import from source by path.
const projectsSrc = join(import.meta.dir, "..", "packages", "projects", "src");
const { ProjectManager } = await import(join(projectsSrc, "manager.ts"));
const { ProjectDocker } = await import(join(projectsSrc, "docker.ts"));

const manager = new ProjectManager();
const docker = new ProjectDocker(manager);

const stopped = await docker.stopAllProjects();

if (stopped.length === 0) {
	console.log("[stop-all] No running projects.");
} else {
	console.log(`[stop-all] Stopped ${stopped.length} project(s): ${stopped.join(", ")}`);
}

// Force exit to prevent hanging on open handles
process.exit(0);
