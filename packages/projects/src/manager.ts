import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CreateProjectInput, ProjectConfig } from "./types";

const PROJECTS_DIR = ".projects";
const BASE_SERVER_PORT = 4000;

/**
 * Resolve the monorepo workspace root, independent of the process cwd.
 *
 * The host API and CLI can be launched from any subdirectory (e.g. the
 * host-api process runs with cwd `apps/host-api`), but projects always
 * live in the repo-root `.projects/` directory. Walking up from a stable
 * anchor and locating the workspace `package.json` (the one declaring
 * `apps/*` workspaces) gives us the repo root regardless of where the
 * process was started from.
 *
 * An explicit `PROJECTS_ROOT` env var (absolute path to the projects
 * directory itself) takes precedence for deployments that want to override.
 */
export function resolveWorkspaceRoot(startDir: string = process.cwd()): string {
	// Explicit override: absolute path to the projects directory.
	const envRoot = process.env.PROJECTS_ROOT;
	if (envRoot && envRoot.trim() !== "") {
		return resolve(envRoot);
	}

	let dir = resolve(startDir);
	while (true) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
				if (Array.isArray(pkg.workspaces) && (pkg.workspaces.includes("apps/*") || pkg.workspaces.includes("packages/*"))) {
					return dir;
				}
			} catch {
				// Invalid package.json — keep walking up.
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break; // reached filesystem root
		dir = parent;
	}

	// Fallback: assume the start directory is the workspace root.
	return resolve(startDir);
}

export class ProjectManager {
	private projectsRoot: string;

	constructor(rootDir: string = resolveWorkspaceRoot()) {
		this.projectsRoot = join(rootDir, PROJECTS_DIR);
	}

	// ── Public accessors ─────────────────────────────────────────────────────

	getProjectsRoot(): string {
		return this.projectsRoot;
	}

	getProjectDir(projectId: string): string {
		return join(this.projectsRoot, projectId);
	}

	getprojectDatabaseManagerPath(projectId: string): string {
		return join(this.getProjectDir(projectId), "data", "agent.db");
	}

	// ── Read ─────────────────────────────────────────────────────────────────

	/**
	 * Get project configuration by reading docker-compose.yml + .env.
	 * No config.json involved.
	 */
	async getProject(projectId: string): Promise<ProjectConfig> {
		const projectDir = this.getProjectDir(projectId);
		const composePath = join(projectDir, "docker-compose.yml");

		if (!existsSync(composePath)) {
			throw new Error(`Project "${projectId}" does not exist`);
		}

		const compose = readFileSync(composePath, "utf-8");
		const env = this.parseEnvFile(projectId);

		// Parse structural data from docker-compose comments + content
		const nameMatch = compose.match(/^# Project: (.+)$/m);
		const createdMatch = compose.match(/^# Created: (.+)$/m);
		const portMatch = compose.match(/^\s+- "(\d+):\d+"$/m);
		const volumeMatch = compose.match(/^\s+- ([^:]+):\/workspace$/m);
		const workspaceType = volumeMatch?.[1]?.includes("/workspace") ? ("internal" as const) : ("external" as const);

		const serverPort = portMatch ? Number.parseInt(portMatch[1], 10) : BASE_SERVER_PORT;
		const workspacePath = volumeMatch?.[1] ?? join(projectDir, "workspace");

		// Dates: prefer comment, fall back to file stat
		const stat = statSync(composePath);
		const createdAt = createdMatch?.[1] ?? stat.birthtime.toISOString();
		const updatedAt = stat.mtime.toISOString();

		const config: ProjectConfig = {
			id: projectId,
			name: env.PROJECT_NAME || nameMatch?.[1] || projectId,
			description: env.DESCRIPTION || undefined,
			createdAt,
			updatedAt,
			ports: { server: serverPort },
			workspace: { path: workspacePath, type: workspaceType },
			status: "stopped",
		};

		// Runtime config from .env
		if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_BASE_URL || env.ANTHROPIC_MODEL) {
			config.agent = {
				...(env.ANTHROPIC_API_KEY && { anthropicApiKey: env.ANTHROPIC_API_KEY }),
				...(env.ANTHROPIC_BASE_URL && { anthropicBaseUrl: env.ANTHROPIC_BASE_URL }),
				...(env.ANTHROPIC_MODEL && { model: env.ANTHROPIC_MODEL }),
			};
		}
		if (env.DISCORD_TOKEN || env.DISCORD_DEFAULT_CHANNEL_ID) {
			config.discord = {
				...(env.DISCORD_TOKEN && { token: env.DISCORD_TOKEN }),
				...(env.DISCORD_DEFAULT_CHANNEL_ID && { defaultChannelId: env.DISCORD_DEFAULT_CHANNEL_ID }),
			};
		}

		return config;
	}

	/**
	 * List all projects (directories containing docker-compose.yml).
	 */
	async listProjects(): Promise<ProjectConfig[]> {
		if (!existsSync(this.projectsRoot)) {
			return [];
		}

		const { readdirSync } = await import("node:fs");
		const entries = readdirSync(this.projectsRoot, { withFileTypes: true });
		const projects: ProjectConfig[] = [];

		for (const entry of entries) {
			if (entry.isDirectory()) {
				try {
					const config = await this.getProject(entry.name);
					projects.push(config);
				} catch {
					// Skip invalid projects
				}
			}
		}

		return projects.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	// ── Create ───────────────────────────────────────────────────────────────

	async createProject(input: CreateProjectInput): Promise<ProjectConfig> {
		await this.ensureProjectsDir();

		const projectId = input.id
			? input.id.toLowerCase().replace(/[^a-z0-9_-]/g, "-")
			: input.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
		const projectDir = this.getProjectDir(projectId);

		if (existsSync(projectDir)) {
			throw new Error(`Project "${projectId}" already exists`);
		}

		// Allocate server port
		const defaultServerPort = await this.findAvailablePort();
		const ports = { server: input.ports?.server ?? defaultServerPort };

		// Determine workspace configuration
		const expandedPath = input.workspacePath
			? input.workspacePath.startsWith("~/") || input.workspacePath === "~"
				? input.workspacePath.replace("~", homedir())
				: input.workspacePath
			: undefined;
		const workspace = expandedPath
			? { path: resolve(expandedPath), type: "external" as const }
			: { path: join(projectDir, "workspace"), type: "internal" as const };

		const now = new Date().toISOString();
		const config: ProjectConfig = {
			id: projectId,
			name: input.name,
			description: input.description,
			createdAt: now,
			updatedAt: now,
			ports,
			workspace,
			discord: input.discord,
			agent: input.agent,
			status: "stopped",
		};

		// Create project directory structure
		await mkdir(projectDir, { recursive: true });
		await mkdir(join(projectDir, "data"), { recursive: true });

		if (workspace.type === "internal") {
			await mkdir(workspace.path, { recursive: true });
		}

		// Generate docker-compose.yml + .env (the only config files)
		await this.generateDockerCompose(projectId, config);
		await this.generateEnvFile(projectId, config);

		return config;
	}

	// ── Update ───────────────────────────────────────────────────────────────

	/**
	 * Update project configuration.
	 * Structural changes rewrite docker-compose.yml; runtime secrets update .env.
	 */
	async updateProject(projectId: string, updates: Partial<Omit<ProjectConfig, "id" | "createdAt">>): Promise<ProjectConfig> {
		const current = await this.getProject(projectId);
		const { discord, agent, ...structuralUpdates } = updates;

		// Apply structural updates and regenerate docker-compose
		const hasStructural = structuralUpdates.ports || structuralUpdates.workspace || structuralUpdates.name;
		if (hasStructural) {
			const updated: ProjectConfig = { ...current, ...structuralUpdates, updatedAt: new Date().toISOString() };
			await this.generateDockerCompose(projectId, updated);
			// Also update PROJECT_NAME in .env if name changed
			if (structuralUpdates.name) {
				await this.updateEnvVars(projectId, { PROJECT_NAME: structuralUpdates.name });
			}
			if (structuralUpdates.ports?.server) {
				await this.updateEnvVars(projectId, { PORT: String(structuralUpdates.ports.server) });
			}
		}

		// Write runtime settings directly to .env
		if (discord !== undefined || agent !== undefined) {
			await this.updateEnvVars(projectId, {
				...(discord?.token !== undefined && { DISCORD_TOKEN: discord.token || "" }),
				...(discord?.defaultChannelId !== undefined && { DISCORD_DEFAULT_CHANNEL_ID: discord.defaultChannelId || "" }),
				...(agent?.anthropicApiKey !== undefined && { ANTHROPIC_API_KEY: agent.anthropicApiKey || "" }),
				...(agent?.anthropicBaseUrl !== undefined && { ANTHROPIC_BASE_URL: agent.anthropicBaseUrl || "" }),
				...(agent?.model !== undefined && { ANTHROPIC_MODEL: agent.model || "" }),
			});
		}

		return this.getProject(projectId);
	}

	// ── Delete ───────────────────────────────────────────────────────────────

	async deleteProject(projectId: string): Promise<void> {
		const projectDir = this.getProjectDir(projectId);
		if (!existsSync(projectDir)) {
			throw new Error(`Project "${projectId}" does not exist`);
		}
		await rm(projectDir, { recursive: true, force: true });
	}

	// ── Helpers ──────────────────────────────────────────────────────────────

	/**
	 * Derive a Docker-valid project/network name from a project ID.
	 */
	dockerProjectName(projectId: string): string {
		const sanitized = projectId
			.toLowerCase()
			.replace(/[^a-z0-9_-]/g, "-")
			.replace(/^[^a-z0-9]+/g, "")
			.replace(/[^a-z0-9]+$/g, "")
			.replace(/[-_]{2,}/g, "-");
		return sanitized || "project";
	}

	private async ensureProjectsDir(): Promise<void> {
		if (!existsSync(this.projectsRoot)) {
			await mkdir(this.projectsRoot, { recursive: true });
		}
	}

	private async findAvailablePort(): Promise<number> {
		const projects = await this.listProjects();
		const usedPorts = new Set<number>();
		for (const project of projects) {
			usedPorts.add(project.ports.server);
		}
		let serverPort = BASE_SERVER_PORT;
		while (usedPorts.has(serverPort)) {
			serverPort++;
		}
		return serverPort;
	}

	private parseEnvFile(projectId: string): Record<string, string> {
		const envPath = join(this.getProjectDir(projectId), ".env");
		if (!existsSync(envPath)) return {};
		const content = readFileSync(envPath, "utf-8");
		const vars: Record<string, string> = {};
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const idx = trimmed.indexOf("=");
			if (idx === -1) continue;
			vars[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
		}
		return vars;
	}

	// ── Generators ───────────────────────────────────────────────────────────

	private async generateDockerCompose(projectId: string, config: ProjectConfig): Promise<void> {
		const projectName = this.dockerProjectName(projectId);
		const networkName = `${projectName}_network`;
		const dockerCompose = `# Project: ${config.name}
# Created: ${config.createdAt}

name: ${projectName}

services:
  agent:
    build:
      context: ../../project-template
      dockerfile: Dockerfile
    env_file:
      - .env
    environment:
      DATABASE_PATH: /data/agent.db
      WORKSPACE_PATH: /workspace
      HOST_API_URL: http://host.docker.internal:${process.env.HOST_PORT ?? 3100}
      PORT: "${config.ports.server}"
      PROJECT_ID: "${projectId}"
      PROJECT_NAME: "${config.name}"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ${config.workspace.path}:/workspace
      - ./data:/data
    ports:
      - "${config.ports.server}:${config.ports.server}"
    restart: unless-stopped
    networks:
      - ${networkName}

networks:
  ${networkName}:
    driver: bridge
`;

		const composePath = join(this.getProjectDir(projectId), "docker-compose.yml");
		await writeFile(composePath, dockerCompose);
	}

	private async generateEnvFile(projectId: string, config: ProjectConfig): Promise<void> {
		const lines: string[] = [
			`# Project: ${config.name}`,
			`# Created: ${config.createdAt}`,
			"",
			`PROJECT_ID=${projectId}`,
			`PROJECT_NAME=${config.name}`,
			`PORT=${config.ports.server}`,
			"DATABASE_PATH=/data/agent.db",
			"WORKSPACE_PATH=/workspace",
			`HOST_API_URL=http://host.docker.internal:${process.env.HOST_PORT ?? 3100}`,
			"",
			`# Workspace: ${config.workspace.type === "external" ? config.workspace.path : "internal"}`,
			"",
			"# Discord (per-project bot)",
		];

		if (config.discord?.token) {
			lines.push(`DISCORD_TOKEN=${config.discord.token}`);
		} else {
			lines.push("# DISCORD_TOKEN=");
		}
		if (config.discord?.defaultChannelId) {
			lines.push(`DISCORD_DEFAULT_CHANNEL_ID=${config.discord.defaultChannelId}`);
		} else {
			lines.push("# DISCORD_DEFAULT_CHANNEL_ID=");
		}

		lines.push("", "# Anthropic (per-project agent)");
		if (config.agent?.anthropicApiKey) {
			lines.push(`ANTHROPIC_API_KEY=${config.agent.anthropicApiKey}`);
		} else {
			lines.push("# ANTHROPIC_API_KEY=");
		}
		if (config.agent?.anthropicBaseUrl) {
			lines.push(`ANTHROPIC_BASE_URL=${config.agent.anthropicBaseUrl}`);
		} else {
			lines.push("# ANTHROPIC_BASE_URL=");
		}
		if (config.agent?.model) {
			lines.push(`ANTHROPIC_MODEL=${config.agent.model}`);
		} else {
			lines.push("# ANTHROPIC_MODEL=");
		}

		lines.push("");

		const envPath = join(this.getProjectDir(projectId), ".env");
		await writeFile(envPath, lines.join("\n"));
	}

	/**
	 * Update specific variables in a project's .env file in-place.
	 */
	private async updateEnvVars(projectId: string, vars: Record<string, string>): Promise<void> {
		const envPath = join(this.getProjectDir(projectId), ".env");
		if (!existsSync(envPath)) return;

		const content = readFileSync(envPath, "utf-8");
		const lines = content.split("\n");
		const remaining = { ...vars };

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const match = line.match(/^(#\s*)?([A-Z_]+)=(.*)/);
			if (!match) continue;
			const key = match[2];
			if (!(key in remaining)) continue;

			const value = remaining[key];
			lines[i] = value ? `${key}=${value}` : `# ${key}=`;
			delete remaining[key];
		}

		for (const [key, value] of Object.entries(remaining)) {
			lines.push(value ? `${key}=${value}` : `# ${key}=`);
		}

		await writeFile(envPath, lines.join("\n"));
	}
}
