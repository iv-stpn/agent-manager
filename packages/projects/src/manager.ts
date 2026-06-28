import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CreateProjectInput, ProjectConfig } from "./types";
import { ProjectConfigSchema } from "./types";

const PROJECTS_DIR = ".projects";
const BASE_SERVER_PORT = 4000;

/**
 * Resolve the monorepo workspace root, independent of the process cwd.
 *
 * The master API and CLI can be launched from any subdirectory (e.g. the
 * master-api process runs with cwd `apps/master-api`), but projects always
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
	private templatePath: string;

	constructor(rootDir: string = resolveWorkspaceRoot()) {
		this.rootDir = rootDir;
		this.projectsRoot = join(rootDir, PROJECTS_DIR);
		this.templatePath = join(rootDir, "project-template");
	}

	/**
	 * Get the root directory for all projects
	 */
	getProjectsRoot(): string {
		return this.projectsRoot;
	}

	/**
	 * Get the directory path for a specific project
	 */
	getProjectDir(projectId: string): string {
		return join(this.projectsRoot, projectId);
	}

	/**
	 * Get the database path for a specific project
	 */
	getProjectDbPath(projectId: string): string {
		return join(this.getProjectDir(projectId), "data", "agent.db");
	}

	/**
	 * Ensure the .projects directory exists
	 */
	private async ensureProjectsDir(): Promise<void> {
		if (!existsSync(this.projectsRoot)) {
			await mkdir(this.projectsRoot, { recursive: true });
		}
	}

	/**
	 * Find next available server port for a new project
	 */
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

	/**
	 * Create a new project
	 */
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
		const ports = {
			server: input.ports?.server ?? defaultServerPort,
		};

		// Determine workspace configuration
		const workspace = input.workspacePath
			? {
					path: resolve(input.workspacePath),
					type: "external" as const,
				}
			: {
					path: join(projectDir, "workspace"),
					type: "internal" as const,
				};

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

		// Create internal workspace if needed
		if (workspace.type === "internal") {
			await mkdir(workspace.path, { recursive: true });
		}

		// Copy the server template into the project root. The db module is
		// inlined under src/, so the project is self-contained — no workspace
		// packages need to be copied alongside it.
		console.log(`Copying server template to ${projectId}...`);
		await cp(this.templatePath, projectDir, {
			recursive: true,
			filter: (src) => {
				// Skip node_modules, dist, and other build artifacts
				return !src.includes("node_modules") && !src.includes("dist") && !src.includes(".next");
			},
		});

		// Write config
		await this.saveProjectConfig(projectId, config);

		// Generate docker-compose.yml
		await this.generateDockerCompose(projectId, config);

		// Generate .env file
		await this.generateEnvFile(projectId, config);

		return config;
	}

	/**
	 * Delete a project
	 */
	async deleteProject(projectId: string): Promise<void> {
		const projectDir = this.getProjectDir(projectId);

		if (!existsSync(projectDir)) {
			throw new Error(`Project "${projectId}" does not exist`);
		}

		// Remove entire project directory (but not external workspace)
		await rm(projectDir, { recursive: true, force: true });
	}

	/**
	 * Get project configuration
	 */
	async getProject(projectId: string): Promise<ProjectConfig> {
		const configPath = join(this.getProjectDir(projectId), "config.json");

		if (!existsSync(configPath)) {
			throw new Error(`Project "${projectId}" does not exist`);
		}

		const content = await readFile(configPath, "utf-8");
		return ProjectConfigSchema.parse(JSON.parse(content));
	}

	/**
	 * List all projects
	 */
	async listProjects(): Promise<ProjectConfig[]> {
		if (!existsSync(this.projectsRoot)) {
			return [];
		}

		const { readdirSync } = await import("node:fs");
		const entries = readdirSync(this.projectsRoot, { withFileTypes: true });
		const projects: ProjectConfig[] = [];

		// Each project is a subdirectory containing config.json; skip any stray files.
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

	/**
	 * Update project configuration
	 */
	async updateProject(projectId: string, updates: Partial<Omit<ProjectConfig, "id" | "createdAt">>): Promise<ProjectConfig> {
		const config = await this.getProject(projectId);

		const updated: ProjectConfig = {
			...config,
			...updates,
			updatedAt: new Date().toISOString(),
		};

		await this.saveProjectConfig(projectId, updated);

		// Regenerate docker-compose if ports or workspace changed
		if (updates.ports || updates.workspace) {
			await this.generateDockerCompose(projectId, updated);
		}

		// Regenerate .env whenever discord/agent config (or anything else that
		// feeds it) changes, so settings edits take effect on next start.
		if (updates.discord !== undefined || updates.agent !== undefined) {
			await this.generateEnvFile(projectId, updated);
		}

		return updated;
	}

	/**
	 * Save project configuration
	 */
	private async saveProjectConfig(projectId: string, config: ProjectConfig): Promise<void> {
		const configPath = join(this.getProjectDir(projectId), "config.json");
		await writeFile(configPath, JSON.stringify(config, null, 2));
	}

	/**
	 * Derive a Docker-valid project/network name from a project ID.
	 * Docker references must match [a-z0-9][a-z0-9_-]* with no leading/trailing
	 * separators and no consecutive separators, so IDs like "__tests__" are
	 * sanitized to "tests" (the raw ID would produce invalid image tags).
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

	/**
	 * Generate docker-compose.yml for a project
	 */
	private async generateDockerCompose(projectId: string, config: ProjectConfig): Promise<void> {
		const projectName = this.dockerProjectName(projectId);
		const networkName = `${projectName}_network`;
		const dockerCompose = `# Project: ${config.name}
# Generated: ${new Date().toISOString()}

name: ${projectName}

services:
  agent:
    build:
      context: .
      dockerfile: Dockerfile
    env_file:
      - .env
    environment:
      DATABASE_PATH: /data/agent.db
      WORKSPACE_PATH: /workspace
      MASTER_API_URL: http://host.docker.internal:${process.env.MASTER_PORT ?? 3100}
      PORT: "${config.ports.server}"
      PROJECT_ID: "${projectId}"
      PROJECT_NAME: "${config.name}"
    extra_hosts:
      # Let the container reach master-api running on the host (rendering gateway)
      - "host.docker.internal:host-gateway"
    volumes:
      # Mount workspace from configured path
      - ${config.workspace.path}:/workspace
      # Database directory (exposed from .projects)
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

	/**
	 * Generate .env file for a project.
	 *
	 * Discord + Anthropic config come from the project's settings (config.json),
	 * not the global environment — each project carries its own bot token and
	 * API key, set at initialization and editable via the UI/CLI.
	 */
	private async generateEnvFile(projectId: string, config: ProjectConfig): Promise<void> {
		const lines: string[] = [
			`# Project: ${config.name}`,
			`# Generated: ${config.createdAt}`,
			"",
			`PROJECT_ID=${projectId}`,
			`PROJECT_NAME=${config.name}`,
			`PORT=${config.ports.server}`,
			"DATABASE_PATH=/data/agent.db",
			"WORKSPACE_PATH=/workspace",
			`MASTER_API_URL=http://host.docker.internal:${process.env.MASTER_PORT ?? 3100}`,
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
}
