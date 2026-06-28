#!/usr/bin/env bun

import { stdin, stdout } from "node:process";
import * as readline from "node:readline/promises";
import { ProjectDocker, ProjectManager } from "@agent-manager/projects";

const manager = new ProjectManager();
const docker = new ProjectDocker(manager);

/** Prompt for a single line of input, returning the trimmed value (or ""). */
async function prompt(rl: readline.Interface, label: string, opts?: { secret?: boolean }): Promise<string> {
	if (opts?.secret) {
		// readline doesn't mute natively across runtimes; keep it simple — secrets
		// are entered in the clear in the terminal. Acceptable for a local CLI.
		const value = await rl.question(`${label}: `);
		return value.trim();
	}
	const value = await rl.question(`${label}: `);
	return value.trim();
}

interface CollectedSettings {
	agent?: { anthropicApiKey?: string; anthropicBaseUrl?: string; model?: string };
}

/** Interactively collect Anthropic config at project init. */
async function collectSettings(rl: readline.Interface, _skipDiscord: boolean, skipAgent: boolean): Promise<CollectedSettings> {
	const settings: CollectedSettings = {};

	if (!skipAgent) {
		console.log("\n--- Anthropic (per-project agent) ---");
		const anthropicApiKey = await prompt(rl, "Anthropic API key (sk-ant-...)", { secret: true });
		const anthropicBaseUrl = await prompt(rl, "Anthropic base URL (optional, e.g. https://api.anthropic.com)");
		const model = await prompt(rl, "Model (optional, e.g. claude-sonnet-4-6)");
		if (anthropicApiKey || anthropicBaseUrl || model) {
			settings.agent = {
				anthropicApiKey: anthropicApiKey || undefined,
				anthropicBaseUrl: anthropicBaseUrl || undefined,
				model: model || undefined,
			};
		}
	}

	return settings;
}

const commands = {
	async create(name: string, description?: string) {
		const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
		const skipAgent = flags.includes("--skip-agent");

		console.log(`Creating project "${name}"...`);
		const rl = readline.createInterface({ input: stdin, output: stdout });
		try {
			const settings = await collectSettings(rl, false, skipAgent);
			const project = await manager.createProject({
				name,
				description,
				...settings,
			});
			console.log("✅ Project created successfully!");
			console.log(JSON.stringify(project, null, 2));
		} finally {
			rl.close();
		}
	},

	async settings(projectId: string) {
		const project = await manager.getProject(projectId);
		console.log(`Editing settings for "${project.name}" (${projectId})`);
		const rl = readline.createInterface({ input: stdin, output: stdout });
		try {
			const settings = await collectSettings(rl, false, false);
			if (!settings.agent) {
				console.log("No changes entered.");
				return;
			}
			const updated = await manager.updateProject(projectId, { agent: settings.agent });
			console.log("✅ Settings updated. Restart the project for changes to take effect.");
			console.log(JSON.stringify(updated, null, 2));
		} finally {
			rl.close();
		}
	},

	async delete(projectId: string) {
		console.log(`Deleting project "${projectId}"...`);
		// Tear down containers and remove their images before deleting the
		// project directory so nothing is left dangling.
		try {
			await docker.stopProject(projectId, { removeImages: true });
		} catch {
			// Ignore if already stopped or compose file is gone.
		}
		await manager.deleteProject(projectId);
		console.log("✅ Project deleted successfully!");
	},

	async list() {
		const projects = await manager.listProjects();
		if (projects.length === 0) {
			console.log("No projects found.");
			return;
		}

		console.log("\n📦 Projects:\n");
		for (const project of projects) {
			const status = await docker.getProjectStatus(project.id);
			const statusEmoji = status.running ? "🟢" : "⚪";
			console.log(`${statusEmoji} ${project.name} (${project.id})`);
			console.log(`   Server port: ${project.ports.server}`);
			console.log(`   Status: ${project.status}`);
			console.log(`   Anthropic: ${project.agent?.anthropicApiKey ? "configured" : "not set"}`);
			if (project.description) {
				console.log(`   Description: ${project.description}`);
			}
			console.log("");
		}
	},

	async start(projectId: string) {
		console.log(`Starting project "${projectId}"...`);
		await docker.startProject(projectId);
		console.log("✅ Project started!");
		const status = await docker.getProjectStatus(projectId);
		console.log(JSON.stringify(status, null, 2));
	},

	async stop(projectId: string) {
		console.log(`Stopping project "${projectId}"...`);
		await docker.stopProject(projectId);
		console.log("✅ Project stopped!");
	},

	async restart(projectId: string) {
		console.log(`Restarting project "${projectId}"...`);
		await docker.restartProject(projectId);
		console.log("✅ Project restarted!");
	},

	async status(projectId: string) {
		const status = await docker.getProjectStatus(projectId);
		console.log(JSON.stringify(status, null, 2));
	},

	async logs(projectId: string, service?: string) {
		const logs = await docker.getProjectLogs(projectId, service);
		console.log(logs);
	},

	async build(projectId: string) {
		console.log(`Building project "${projectId}"...`);
		await docker.buildProject(projectId);
		console.log("✅ Project built successfully!");
	},

	help() {
		console.log(`
Claude Agent - Project Manager CLI

Usage: bun run projects <command> [options]

Commands:
  create <name> [description]    Create a new project (prompts for Anthropic config)
  settings <projectId>           Edit Anthropic settings for a project
  delete <projectId>             Delete a project
  list                           List all projects
  start <projectId>              Start project containers
  stop <projectId>               Stop project containers
  restart <projectId>            Restart project containers
  status <projectId>             Show project status
  logs <projectId> [service]     Show project logs
  build <projectId>              Build project containers
  help                           Show this help message

Flags:
  --skip-agent                   Skip Anthropic prompts during create

Examples:
  bun run projects create "My Project" "A demo project"
  bun run projects create "Quick Start" --skip-agent
  bun run projects list
  bun run projects settings demo
  bun run projects start demo
  bun run projects logs demo agent
  bun run projects delete demo
		`);
	},
};

// Parse CLI arguments
const [command, ...args] = process.argv.slice(2);

if (!command || command === "help" || !(command in commands)) {
	commands.help();
	process.exit(command ? 1 : 0);
}

// Execute command
try {
	await (commands as Record<string, (...a: unknown[]) => unknown>)[command](...args);
} catch (error) {
	console.error("❌ Error:", error instanceof Error ? error.message : error);
	process.exit(1);
}
