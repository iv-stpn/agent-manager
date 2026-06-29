import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CreateProjectInput, ProjectConfig, ProjectContext } from "./types";
import { ProjectContextSchema } from "./types";

const PROJECTS_DIR = ".projects";
const BASE_SERVER_PORT = 4000;

/** Expand a leading `~` / `~/` in a path to the user's home directory. */
function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? path.replace("~", homedir()) : path;
}

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

	getProjectDatabaseManagerPath(projectId: string): string {
		return join(this.getProjectDir(projectId), "data", "agent.db");
	}

	/** Path to the per-project context selection file (`context.json`). */
	getProjectContextPath(projectId: string): string {
		return join(this.getProjectDir(projectId), "context.json");
	}

	/**
	 * Path to the rendered context markdown. Lives under `data/`, which is
	 * mounted into the container as `/data`, so the agent can read it at
	 * runtime without reaching back to the host DB.
	 */
	getRenderedContextPath(projectId: string): string {
		return join(this.getProjectDir(projectId), "data", "project-context.md");
	}

	// ── Read ─────────────────────────────────────────────────────────────────

	/**
	 * Get project configuration by reading docker-compose.yml.
	 * All config lives in the compose environment block.
	 */
	async getProject(projectId: string): Promise<ProjectConfig> {
		const projectDir = this.getProjectDir(projectId);
		const composePath = join(projectDir, "docker-compose.yml");

		if (!existsSync(composePath)) {
			throw new Error(`Project "${projectId}" does not exist`);
		}

		const compose = readFileSync(composePath, "utf-8");
		const env = this.parseComposeEnvironment(compose);

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

		if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_BASE_URL || env.ANTHROPIC_MODEL) {
			config.agent = {
				...(env.ANTHROPIC_API_KEY && { anthropicApiKey: env.ANTHROPIC_API_KEY }),
				...(env.ANTHROPIC_BASE_URL && { anthropicBaseUrl: env.ANTHROPIC_BASE_URL }),
				...(env.ANTHROPIC_MODEL && { model: env.ANTHROPIC_MODEL }),
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
		const workspace = input.workspacePath
			? { path: resolve(expandHome(input.workspacePath)), type: "external" as const }
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
			agent: input.agent,
			status: "stopped",
		};

		// Create project directory structure
		await mkdir(projectDir, { recursive: true });
		await mkdir(join(projectDir, "data"), { recursive: true });

		if (workspace.type === "internal") {
			await mkdir(workspace.path, { recursive: true });
		}

		// Generate docker-compose.yml (the only config file)
		await this.generateDockerCompose(projectId, config);

		return config;
	}

	// ── Update ───────────────────────────────────────────────────────────────

	/**
	 * Update project configuration.
	 * All changes rewrite docker-compose.yml directly.
	 */
	async updateProject(projectId: string, updates: Partial<Omit<ProjectConfig, "id" | "createdAt">>): Promise<ProjectConfig> {
		const current = await this.getProject(projectId);
		const merged: ProjectConfig = {
			...current,
			...updates,
			agent: updates.agent !== undefined ? updates.agent : current.agent,
			updatedAt: new Date().toISOString(),
		};

		await this.generateDockerCompose(projectId, merged);
		return this.getProject(projectId);
	}

	// ── Project context ────────────────────────────────────────────────────────

	/**
	 * Read the project's context selection (tech stacks / guidelines / local
	 * instructions). Returns empty defaults when no context file exists.
	 */
	async getProjectContext(projectId: string): Promise<ProjectContext> {
		const path = this.getProjectContextPath(projectId);
		if (!existsSync(path)) {
			return { techStackIds: [], guidelineIds: [], instructions: "" };
		}
		try {
			return ProjectContextSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
		} catch {
			return { techStackIds: [], guidelineIds: [], instructions: "" };
		}
	}

	/**
	 * Persist the project's context selection and the markdown the agent reads
	 * at runtime. The caller resolves selected IDs to text (only the host has
	 * the library DB) and passes the rendered markdown here. Empty markdown
	 * removes the file so the prompt stays clean.
	 */
	async setProjectContext(projectId: string, context: ProjectContext, renderedMarkdown: string): Promise<ProjectContext> {
		const projectDir = this.requireProjectDir(projectId);
		const parsed = ProjectContextSchema.parse(context);
		await writeFile(this.getProjectContextPath(projectId), `${JSON.stringify(parsed, null, 2)}\n`);

		await mkdir(join(projectDir, "data"), { recursive: true });
		const renderedPath = this.getRenderedContextPath(projectId);
		if (renderedMarkdown.trim() === "") {
			if (existsSync(renderedPath)) await rm(renderedPath, { force: true });
		} else {
			await writeFile(renderedPath, renderedMarkdown);
		}
		return parsed;
	}

	// ── Delete ───────────────────────────────────────────────────────────────

	async deleteProject(projectId: string): Promise<void> {
		await rm(this.requireProjectDir(projectId), { recursive: true, force: true });
	}

	// ── Helpers ──────────────────────────────────────────────────────────────

	/** Assert a project directory exists, returning its path. Throws otherwise. */
	private requireProjectDir(projectId: string): string {
		const projectDir = this.getProjectDir(projectId);
		if (!existsSync(projectDir)) {
			throw new Error(`Project "${projectId}" does not exist`);
		}
		return projectDir;
	}

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

	private parseComposeEnvironment(compose: string): Record<string, string> {
		const vars: Record<string, string> = {};
		const envBlock = compose.match(/^\s+environment:\n((?:\s+.+\n)*)/m);
		if (!envBlock) return vars;
		for (const line of envBlock[1].split("\n")) {
			const match = line.match(/^\s+([A-Z_]+):\s*"?([^"]*)"?\s*$/);
			if (match) vars[match[1]] = match[2];
		}
		return vars;
	}

	// ── Generators ───────────────────────────────────────────────────────────

	private async generateDockerCompose(projectId: string, config: ProjectConfig): Promise<void> {
		const projectName = this.dockerProjectName(projectId);
		const networkName = `${projectName}_network`;

		const envLines = [
			`      DATABASE_PATH: /data/agent.db`,
			`      WORKSPACE_PATH: /workspace`,
			`      HOST_API_URL: http://host.docker.internal:${process.env.HOST_PORT ?? 3100}`,
			`      PORT: "${config.ports.server}"`,
			`      PROJECT_ID: "${projectId}"`,
			`      PROJECT_NAME: "${config.name}"`,
		];

		if (config.agent?.anthropicApiKey) {
			envLines.push(`      ANTHROPIC_API_KEY: "${config.agent.anthropicApiKey}"`);
		}
		if (config.agent?.anthropicBaseUrl) {
			envLines.push(`      ANTHROPIC_BASE_URL: "${config.agent.anthropicBaseUrl}"`);
		}
		if (config.agent?.model) {
			envLines.push(`      ANTHROPIC_MODEL: "${config.agent.model}"`);
		}

		const dockerCompose = `# Project: ${config.name}
# Created: ${config.createdAt}

name: ${projectName}

services:
  agent:
    build:
      context: ../..
      dockerfile: project-template/Dockerfile
    environment:
${envLines.join("\n")}
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
}
