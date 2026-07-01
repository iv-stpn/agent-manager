import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CreateProjectInput, LooseOptional, ProjectConfig, ProjectContext } from "./types";
import { ProjectContextSchema } from "./types";

const PROJECTS_DIR = ".projects";
const BASE_SERVER_PORT = 4000;

/** Expand a leading `~` / `~/` in a path to the user's home directory. */
function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? path.replace("~", homedir()) : path;
}

/**
 * Check if a path is a protected system directory that should never be deleted.
 * Returns true if the path should be protected from deletion.
 */
export function isProtectedDirectory(path: string): boolean {
	const home = homedir();
	const expanded = path === "~" || path.startsWith("~/") ? path.replace("~", home) : path;
	const resolved = resolve(expanded);

	const protectedPaths = [
		home,
		join(home, "Desktop"),
		join(home, "Downloads"),
		join(home, "Documents"),
		join(home, "Pictures"),
		join(home, "Music"),
		join(home, "Videos"),
		join(home, "Library"),
		join(home, "Applications"),
		"/",
		"/System",
		"/Library",
		"/Applications",
		"/usr",
		"/bin",
		"/sbin",
		"/etc",
		"/var",
		"/tmp",
	];

	return protectedPaths.some((protectedPath) => {
		const resolvedProtected = resolve(protectedPath);
		return resolved === resolvedProtected;
	});
}

/**
 * Recursively copy a directory from source to destination.
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
	const { cp } = await import("node:fs/promises");
	await cp(src, dest, { recursive: true });
}

/**
 * Clone a GitHub repository to a destination directory.
 */
async function cloneGitHubRepo(repoUrl: string, dest: string): Promise<void> {
	const { exec } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const execAsync = promisify(exec);

	// Clone the repo
	await execAsync(`git clone ${repoUrl} "${dest}"`);

	// Remove .git directory to make it a fresh project
	const gitDir = join(dest, ".git");
	if (existsSync(gitDir)) {
		await rm(gitDir, { recursive: true, force: true });
	}
}

/**
 * Resolve the monorepo workspace root, independent of the process cwd.
 *
 * The orchestrator API and CLI can be launched from any subdirectory (e.g. the
 * API process runs with cwd `apps/api`), but projects always
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
		const binariesMatch = compose.match(/^# Binaries: (.+)$/m);
		const clientIdMatch = compose.match(/^# LLM Client ID: (.+)$/m);
		const portMatch = compose.match(/^\s+- "(\d+):\d+"$/m);
		const volumeMatch = compose.match(/^\s+- ([^:]+):\/workspace$/m);
		const workspaceType = volumeMatch?.[1]?.includes("/workspace") ? ("internal" as const) : ("external" as const);

		const serverPort = portMatch ? Number.parseInt(portMatch[1], 10) : BASE_SERVER_PORT;
		const workspacePath = volumeMatch?.[1] ?? join(projectDir, "workspace");

		// Dates: prefer comment, fall back to file stat
		const stat = statSync(composePath);
		const createdAt = createdMatch?.[1] ?? stat.birthtime.toISOString();
		const updatedAt = stat.mtime.toISOString();

		// Parse binaries from comment
		const binaries = binariesMatch?.[1]
			? (binariesMatch[1].split(",").map((b) => b.trim()) as Array<"python3" | "workerd" | "cargo">)
			: undefined;

		const config: ProjectConfig = {
			id: projectId,
			name: env.PROJECT_NAME || nameMatch?.[1] || projectId,
			description: env.DESCRIPTION || undefined,
			createdAt,
			updatedAt,
			ports: { server: serverPort },
			workspace: { path: workspacePath, type: workspaceType },
			status: "stopped",
			binaries,
		};

		if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_BASE_URL || env.ANTHROPIC_MODEL || clientIdMatch) {
			config.agent = {
				...(clientIdMatch && { clientId: clientIdMatch[1] }),
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

		// Safety check: prevent deletion of protected directories
		if (input.workspacePath && isProtectedDirectory(workspace.path)) {
			throw new Error(
				`Cannot use "${input.workspacePath}" as workspace: this is a protected system directory that cannot be modified`
			);
		}

		// Handle template initialization if specified
		if (input.templates && input.templates.length > 0) {
			// If the workspace path exists and is not empty, clear its contents first
			// so the template can be cloned into a clean directory.
			if (existsSync(workspace.path)) {
				const entries = await readdir(workspace.path);
				await Promise.all(entries.map((entry) => rm(join(workspace.path, entry), { recursive: true, force: true })));
			}

			// Initialize from templates
			await mkdir(workspace.path, { recursive: true });

			// If multiple templates, each goes into a subdirectory
			// If single template without subdirectory, goes directly into workspace
			const multipleTemplates = input.templates.length > 1;

			for (const template of input.templates) {
				const targetPath =
					multipleTemplates || template.subdirectory
						? join(workspace.path, template.subdirectory || template.source.replace(/[^a-z0-9-]/gi, "-"))
						: workspace.path;

				if (template.type === "local") {
					// Copy from local template
					const templatePath = join(resolveWorkspaceRoot(), "templates", template.source);
					if (!existsSync(templatePath)) {
						throw new Error(`Template "${template.source}" not found`);
					}

					if (targetPath !== workspace.path) {
						await mkdir(targetPath, { recursive: true });
					}

					await copyDirectory(templatePath, targetPath);
				} else if (template.type === "github") {
					// Clone from GitHub
					await mkdir(targetPath, { recursive: true });
					await cloneGitHubRepo(template.source, targetPath);
				}
			}
		}

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
			binaries: input.binaries,
		};

		// Create project directory structure
		await mkdir(projectDir, { recursive: true });
		await mkdir(join(projectDir, "data"), { recursive: true });

		if (workspace.type === "internal" && !input.templates) {
			// Only create empty workspace if no template was used
			await mkdir(workspace.path, { recursive: true });
		}

		// Generate docker-compose.yml (the only config file)
		await this.generateDockerCompose(projectId, config);

		// Persist the templates the project was seeded from into context.json so
		// the agent's system prompt can tell it the workspace started from a
		// template it is free to modify. Other context fields (tech stacks,
		// guidelines, instructions) are empty until set via the context editor.
		if (input.templates && input.templates.length > 0) {
			await this.setProjectContext(projectId, {
				techStackIds: [],
				guidelineIds: [],
				instructions: "",
				templates: input.templates,
			});
		}

		return config;
	}

	// ── Update ───────────────────────────────────────────────────────────────

	/**
	 * Update project configuration.
	 * All changes rewrite docker-compose.yml directly.
	 */
	async updateProject(
		projectId: string,
		updates: LooseOptional<Partial<Omit<ProjectConfig, "id" | "createdAt">>>
	): Promise<ProjectConfig> {
		const current = await this.getProject(projectId);
		const merged = {
			...current,
			...updates,
			agent: updates.agent !== undefined ? updates.agent : current.agent,
			updatedAt: new Date().toISOString(),
		} as ProjectConfig;

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
			return { techStackIds: [], guidelineIds: [], instructions: "", templates: [] };
		}
		try {
			return ProjectContextSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
		} catch {
			return { techStackIds: [], guidelineIds: [], instructions: "", templates: [] };
		}
	}

	/**
	 * Persist the project's context selection.
	 */
	async setProjectContext(projectId: string, context: ProjectContext): Promise<ProjectContext> {
		this.requireProjectDir(projectId);
		const parsed = ProjectContextSchema.parse(context);
		await writeFile(this.getProjectContextPath(projectId), `${JSON.stringify(parsed, null, 2)}\n`);
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
		const projectDir = this.getProjectDir(projectId);

		const envLines = [
			`      DATABASE_PATH: /data/agent.db`,
			`      WORKSPACE_PATH: /workspace`,
			`      ORCHESTRATOR_API_URL: http://host.docker.internal:${process.env.ORCHESTRATOR_PORT ?? 3100}`,
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

		// Generate custom Dockerfile if binaries are specified
		let buildContext = "../..";
		let dockerfilePath = "project-template/Dockerfile";
		if (config.binaries && config.binaries.length > 0) {
			await this.generateCustomDockerfile(projectDir, config.binaries);
			buildContext = "../..";
			dockerfilePath = `.projects/${projectId}/Dockerfile`;
		}

		const binariesComment = config.binaries && config.binaries.length > 0 ? `# Binaries: ${config.binaries.join(", ")}\n` : "";

		const clientIdComment = config.agent?.clientId ? `# LLM Client ID: ${config.agent.clientId}\n` : "";

		const dockerCompose = `# Project: ${config.name}
# Created: ${config.createdAt}
${binariesComment}${clientIdComment}
name: ${projectName}

services:
  agent:
    build:
      context: ${buildContext}
      dockerfile: ${dockerfilePath}
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

	private async generateCustomDockerfile(projectDir: string, binaries: Array<"python3" | "workerd" | "cargo">): Promise<void> {
		// Map binary names to Alpine package names and additional installation commands
		const binaryInstallCommands: string[] = [];
		for (const binary of binaries) {
			switch (binary) {
				case "python3":
					binaryInstallCommands.push("apk add --no-cache python3 py3-pip");
					break;
				case "workerd":
					// workerd needs to be downloaded from GitHub releases
					binaryInstallCommands.push(
						"wget -O /tmp/workerd.gz https://github.com/cloudflare/workerd/releases/latest/download/workerd-linux-64.gz",
						"    gunzip /tmp/workerd.gz",
						"    chmod +x /tmp/workerd",
						"    mv /tmp/workerd /usr/local/bin/workerd"
					);
					break;
				case "cargo":
					binaryInstallCommands.push("apk add --no-cache rust cargo");
					break;
			}
		}

		const installBlock =
			binaryInstallCommands.length > 0
				? `\n# Install additional binaries\nRUN ${binaryInstallCommands.join(" && \\\n    ")}\n`
				: "";

		const dockerfile = `FROM popwers/mini-bun:v1.3.14 AS base
WORKDIR /app

# install git + dependencies
RUN apk add --no-cache git ca-certificates bash${binaries.includes("workerd") ? " wget" : ""}
${installBlock}
# Root workspace manifest for bun to resolve workspace:* deps
COPY package.json ./package.json

# Workspace packages
COPY packages/db/package.json ./packages/db/package.json
COPY packages/db/src ./packages/db/src
COPY packages/utils/package.json ./packages/utils/package.json
COPY packages/utils/src ./packages/utils/src
COPY packages/projects/package.json ./packages/projects/package.json
COPY packages/projects/src ./packages/projects/src

# Project server
COPY project-template/package.json ./project-template/package.json
COPY project-template/src ./project-template/src

# Install dependencies from the workspace root
RUN bun install

WORKDIR /app/project-template

# Expose port
EXPOSE 3010

# Run
CMD ["bun", "run", "src/index.ts"]
`;

		const dockerfilePath = join(projectDir, "Dockerfile");
		await writeFile(dockerfilePath, dockerfile);
	}
}
