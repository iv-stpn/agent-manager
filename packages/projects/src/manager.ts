import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseComposeEnvironment, yamlScalar } from "./compose-format";
import type { CreateProjectInput, LooseOptional, ProjectConfig, ProjectContext } from "./types";
import { isValidBunCreateSource, ProjectContextSchema, parseBunCreateFlags } from "./types";

const PROJECTS_DIR = ".projects";
const BASE_SERVER_PORT = 4000;

/** Optional progress callbacks for `createProject`, used by the streaming create route. */
export interface CreateProjectProgress {
	onStep?: (step: string, status: "running" | "done" | "error", detail?: string) => void;
	onLine?: (step: string, line: string) => void;
}

/** Expand a leading `~` / `~/` in a path to the user's home directory. */
function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? path.replace("~", homedir()) : path;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

/** Accumulates chunks and emits complete lines, matching the buffering style docker.ts uses for its streamed output. */
function makeLineEmitter(onLine?: (line: string) => void) {
	let buffer = "";
	return {
		push(chunk: Buffer) {
			buffer += chunk.toString();
			const parts = buffer.split("\n");
			buffer = parts.pop() ?? "";
			for (const line of parts) if (line.trim()) onLine?.(line);
		},
		flush() {
			if (buffer.trim()) onLine?.(buffer);
		},
	};
}

/**
 * Run a shell command with a hard timeout that kills its whole process
 * group on expiry. `exec`'s built-in `timeout` option only signals the
 * immediate shell process — grandchildren it forked (a package manager's
 * own worker processes, a postinstall script) survive as orphans, which
 * defeats the point of bounding a hung install or clone.
 */
async function execWithTimeout(
	command: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; onLine?: ((line: string) => void) | undefined }
): Promise<void> {
	const { spawn } = await import("node:child_process");
	const [file, ...args] = command;
	if (!file) throw new Error("execWithTimeout: empty command");
	// No `shell: true`: args are passed directly to execvp, so user-controlled
	// values (repo URLs, paths) can never be interpreted as shell syntax.
	const commandLabel = command.join(" ");

	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(file, args, { cwd: options.cwd, env: options.env, detached: true });

		const timer = setTimeout(() => {
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL"); // negative pid: whole process group
				} catch {
					// Process group may already be gone.
				}
			}
			reject(new Error(`Command timed out after ${options.timeoutMs}ms: ${commandLabel}`));
		}, options.timeoutMs);

		let stderr = "";
		const stdoutEmitter = makeLineEmitter(options.onLine);
		const stderrEmitter = makeLineEmitter(options.onLine);
		child.stdout?.on("data", (chunk: Buffer) => stdoutEmitter.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk;
			stderrEmitter.push(chunk);
		});

		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});

		child.on("exit", (code) => {
			clearTimeout(timer);
			stdoutEmitter.flush();
			stderrEmitter.flush();
			if (code === 0) resolvePromise();
			else reject(new Error(`Command failed with exit code ${code}: ${commandLabel}${stderr ? `\n${stderr}` : ""}`));
		});
	});
}

/**
 * Clone a GitHub repository to a destination directory.
 */
async function cloneGitHubRepo(repoUrl: string, dest: string, onLine?: (line: string) => void): Promise<void> {
	// --depth 1: history is discarded right below anyway. GIT_TERMINAL_PROMPT=0
	// and a hard timeout: an unreachable/private repo must fail loudly rather
	// than hang project creation forever with no error surfaced (there's no
	// controlling tty, so a credential prompt would otherwise block forever).
	await execWithTimeout(["git", "clone", "--depth", "1", "--", repoUrl, dest], {
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		timeoutMs: 60_000,
		onLine,
	});

	// Remove .git directory to make it a fresh project
	const gitDir = join(dest, ".git");
	if (existsSync(gitDir)) {
		await rm(gitDir, { recursive: true, force: true });
	}
}

/**
 * Seed a directory by running `bun create <source> <dest> [flags…]` — covers
 * create-* npm scaffolds (e.g. `vite`, `next-app`) and GitHub owner/repo
 * shorthands. Scaffolds are often prompt-driven; CI=true nudges them toward
 * non-interactive defaults, and the hard timeout fails loudly if one insists
 * on input anyway (exec's stdin pipe never answers, mirroring the git-clone
 * rationale above). `source` and `flags` reach the child as separate argv
 * entries — never a shell string — and are pre-validated by
 * isValidBunCreateSource / parseBunCreateFlags. The generous timeout is
 * because many scaffolds install their own dependencies as part of creation.
 */
async function runBunCreate(source: string, flags: string[], dest: string, onLine?: (line: string) => void): Promise<void> {
	await execWithTimeout(["bun", "create", source, dest, ...flags], {
		env: { ...process.env, CI: "true" },
		timeoutMs: 600_000,
		onLine,
	});

	// Like cloneGitHubRepo: the scaffold's git history (bun create and many
	// create-* CLIs init a repo) isn't wanted in a fresh project workspace.
	const gitDir = join(dest, ".git");
	if (existsSync(gitDir)) {
		await rm(gitDir, { recursive: true, force: true });
	}
}

/**
 * Install dependencies for a freshly seeded template directory. Since the
 * workspace is bind-mounted into the project's container, installing here on
 * the host makes node_modules available to the agent immediately. Always
 * uses bun regardless of the template's own lockfile (pnpm, yarn, npm) —
 * bun reads all of those lockfile formats and is guaranteed to be present on
 * this host. Non-Node templates (no package.json) are left uninstalled, and
 * install failures (e.g. no network) are logged but never abort project
 * creation — the workspace is already usable and the install can be retried
 * manually. A hard timeout backs that guarantee: without one, a stalled
 * fetch or a postinstall script blocked reading stdin (exec's stdin pipe is
 * opened but never closed) would hang forever instead of failing into the
 * catch below. Runs in the background when not awaited by the caller (the
 * plain, non-streaming create path — see call site), so the timeout can
 * afford to be generous: large monorepos can legitimately take minutes on a
 * cold cache. Never throws — returns a result so a streaming caller can
 * report success/failure without the failure aborting project creation.
 */
async function installTemplateDependencies(
	dir: string,
	onLine?: (line: string) => void
): Promise<{ success: boolean; error?: string }> {
	if (!existsSync(join(dir, "package.json"))) return { success: true };

	try {
		await execWithTimeout(["bun", "install"], { cwd: dir, timeoutMs: 600_000, env: { ...process.env, CI: "true" }, onLine });
		return { success: true };
	} catch (error) {
		console.error(`Failed to install dependencies in "${dir}" with "bun install":`, error);
		return { success: false, error: getErrorMessage(error) };
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

	// Ports handed out by findAvailablePort but not yet visible in listProjects()
	// (its docker-compose.yml isn't written until later in createProject). Two
	// concurrent creates would otherwise both scan the same on-disk state, see the
	// same lowest free port, and collide. Held until initializeProject settles.
	private reservedPorts = new Set<number>();
	// Serialises the scan-and-reserve so two concurrent creates can't pick the
	// same port between one scanning and the next reserving.
	private portAllocation: Promise<unknown> = Promise.resolve();

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
		const env = parseComposeEnvironment(compose);

		// Parse structural data from docker-compose comments + content
		const nameMatch = compose.match(/^# Project: (.+)$/m);
		const createdMatch = compose.match(/^# Created: (.+)$/m);
		const binariesMatch = compose.match(/^# Binaries: (.+)$/m);
		const clientIdMatch = compose.match(/^# LLM Client ID: (.+)$/m);
		const portMatch = compose.match(/^\s+- "(?:[\d.]+:)?(\d+):\d+"$/m);
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
			? (binariesMatch[1].split(",").map((binary) => binary.trim()) as Array<"python3" | "workerd" | "cargo">)
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

	async createProject(input: CreateProjectInput, progress?: CreateProjectProgress): Promise<ProjectConfig> {
		await this.ensureProjectsDir();

		const projectId = input.id
			? input.id.toLowerCase().replace(/[^a-z0-9_-]/g, "-")
			: input.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
		const projectDir = this.getProjectDir(projectId);

		if (existsSync(projectDir)) {
			throw new Error(`Project "${projectId}" already exists`);
		}

		// Allocate server port. When the caller pins a port we skip the scan (and
		// hold no reservation to release); otherwise the reserved port is released
		// in the finally below once the project is on disk or the attempt failed.
		const reservedPort = input.ports?.server === undefined ? await this.findAvailablePort() : undefined;
		const ports = { server: input.ports?.server ?? reservedPort ?? BASE_SERVER_PORT };

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

		try {
			return await this.initializeProject(input, progress, projectId, projectDir, ports, workspace);
		} catch (error) {
			// Nothing above this point touched disk, so any failure from here on can
			// leave behind a partially seeded project: a half-cloned template, a
			// projectDir with no docker-compose.yml, etc. Since projectId was confirmed
			// free at the top of this method, everything under projectDir belongs to
			// this failed attempt — remove it so the id can be retried and no orphaned
			// directory lingers on disk. For an external workspace, projectDir never
			// held the workspace itself, so only clear what this attempt wrote into it.
			await rm(projectDir, { recursive: true, force: true }).catch(() => {});
			if (workspace.type === "external" && existsSync(workspace.path)) {
				const entries = await readdir(workspace.path).catch(() => []);
				await Promise.all(
					entries.map((entry) => rm(join(workspace.path, entry), { recursive: true, force: true }).catch(() => {}))
				);
			}
			throw error;
		} finally {
			// The port is now recorded on disk (compose file) for a successful create,
			// or the attempt was cleaned up — either way listProjects sees the truth,
			// so the in-memory reservation is no longer needed.
			if (reservedPort !== undefined) this.releasePort(reservedPort);
		}
	}

	private async initializeProject(
		input: CreateProjectInput,
		progress: CreateProjectProgress | undefined,
		projectId: string,
		projectDir: string,
		ports: { server: number },
		workspace: { path: string; type: "internal" | "external" }
	): Promise<ProjectConfig> {
		const step = (name: string, status: "running" | "done" | "error", detail?: string) =>
			progress?.onStep?.(name, status, detail);
		const line = (name: string, text: string) => progress?.onLine?.(name, text);

		// Handle template initialization if specified
		if (input.templates && input.templates.length > 0) {
			step("workspace", "running", "Setting up workspace...");

			// If the workspace path exists and is not empty, clear its contents first
			// so the template can be cloned into a clean directory.
			if (existsSync(workspace.path)) {
				const entries = await readdir(workspace.path);
				await Promise.all(entries.map((entry) => rm(join(workspace.path, entry), { recursive: true, force: true })));
			}

			// Initialize from templates
			await mkdir(workspace.path, { recursive: true });
			step("workspace", "done");

			// If multiple templates, each goes into a subdirectory
			// If single template without subdirectory, goes directly into workspace
			const multipleTemplates = input.templates.length > 1;

			for (const template of input.templates) {
				const targetPath =
					multipleTemplates || template.subdirectory
						? join(workspace.path, template.subdirectory || template.source.replace(/[^a-z0-9-]/gi, "-"))
						: workspace.path;

				const seedStep = multipleTemplates ? `seed:${template.source}` : "seed";
				try {
					if (template.type === "local") {
						step(seedStep, "running", `Copying template "${template.source}"...`);
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
						step(seedStep, "running", `Cloning ${template.source}...`);
						// Clone from GitHub
						await mkdir(targetPath, { recursive: true });
						await cloneGitHubRepo(template.source, targetPath, (l) => line(seedStep, l));
					} else if (template.type === "bun-create") {
						// Re-validate here (not just in the API schema) since createProject
						// is also callable programmatically; both values become argv of the
						// spawned command.
						if (!isValidBunCreateSource(template.source)) {
							throw new Error(`Invalid bun create template "${template.source}"`);
						}
						const flags = parseBunCreateFlags(template.flags ?? "");
						if (flags === null) {
							throw new Error(`Invalid flags for bun create template "${template.source}"`);
						}
						step(seedStep, "running", `Running bun create ${template.source}...`);
						await runBunCreate(template.source, flags, targetPath, (l) => line(seedStep, l));
					}
					step(seedStep, "done");
				} catch (error) {
					step(seedStep, "error", getErrorMessage(error));
					throw error;
				}

				// Install dependencies for this template (root workspace, or its own
				// subdirectory when multiple templates are seeded). When a progress
				// callback is given (streaming create), this is awaited so the caller
				// sees real completion; otherwise it's fire-and-forget — this can take
				// minutes for a large monorepo, and the plain create response shouldn't
				// block on it. installTemplateDependencies handles/logs its own failures
				// either way, so a slow/failed install never aborts project creation.
				const installStep = multipleTemplates ? `install:${template.source}` : "install";
				if (progress && existsSync(join(targetPath, "package.json"))) {
					step(installStep, "running", "Installing dependencies...");
					const result = await installTemplateDependencies(targetPath, (l) => line(installStep, l));
					step(installStep, result.success ? "done" : "error", result.error);
				} else {
					void installTemplateDependencies(targetPath);
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

		step("finalize", "running", "Writing project configuration...");

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

		step("finalize", "done");

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

	/** Can we bind 127.0.0.1:<port> right now? Catches ports held by a process
	 * outside our project list (a stale container, another app). Best-effort — a
	 * TOCTOU gap remains vs. the eventual container bind, but it rules out the
	 * common "already in use" case the pure list-scan missed. */
	private static isPortFree(port: number): Promise<boolean> {
		return new Promise((resolve) => {
			const tester = createServer();
			tester.once("error", () => resolve(false));
			tester.once("listening", () => tester.close(() => resolve(true)));
			tester.listen(port, "127.0.0.1");
		});
	}

	/**
	 * Reserve the lowest free server port. Reservation is serialised (via
	 * `portAllocation`) and the chosen port is added to `reservedPorts` before the
	 * next caller scans, so concurrent creates never collide. The caller MUST
	 * `releasePort` once the project is persisted (or its create failed).
	 */
	private async findAvailablePort(): Promise<number> {
		const run = this.portAllocation.then(async () => {
			const projects = await this.listProjects();
			const usedPorts = new Set<number>(this.reservedPorts);
			for (const project of projects) usedPorts.add(project.ports.server);

			let serverPort = BASE_SERVER_PORT;
			// Skip ports used by a known project, already reserved, or bound by any
			// other process on the host.
			while (usedPorts.has(serverPort) || !(await ProjectManager.isPortFree(serverPort))) {
				serverPort++;
			}
			this.reservedPorts.add(serverPort);
			return serverPort;
		});
		// Keep the chain alive even if this attempt throws, so a failed scan doesn't
		// wedge every future allocation.
		this.portAllocation = run.catch(() => undefined);
		return run;
	}

	/** Drop a reservation made by findAvailablePort once the port is either
	 * persisted to a project (visible to listProjects) or no longer wanted. */
	private releasePort(port: number): void {
		this.reservedPorts.delete(port);
	}

	// ── Generators ───────────────────────────────────────────────────────────

	private async generateDockerCompose(projectId: string, config: ProjectConfig): Promise<void> {
		const projectName = this.dockerProjectName(projectId);
		const networkName = `${projectName}_network`;
		const projectDir = this.getProjectDir(projectId);

		// User-controlled values (name, api key, base url, model) are wrapped with
		// yamlScalar (JSON-encoded), which is valid YAML double-quoted-scalar
		// syntax and escapes quotes/backslashes/newlines — so a value containing
		// `"` or a newline can't break out of the string or inject extra compose
		// keys. parseComposeEnvironment reverses this with JSON.parse.
		const envLines = [
			`      DATABASE_PATH: /data/agent.db`,
			`      WORKSPACE_PATH: /workspace`,
			// The container runs as the host uid (see userLine below) so bind-mounted
			// files stay host-owned; that uid has no /etc/passwd entry inside the
			// container, so $HOME must be set explicitly to a writable path.
			`      HOME: /tmp`,
			`      ORCHESTRATOR_API_URL: http://host.docker.internal:${process.env.ORCHESTRATOR_PORT ?? 3100}`,
			`      PORT: ${yamlScalar(String(config.ports.server))}`,
			`      PROJECT_ID: ${yamlScalar(projectId)}`,
			`      PROJECT_NAME: ${yamlScalar(config.name)}`,
		];

		// Forward the orchestrator's bearer token so the container's calls back to
		// the orchestrator API (memory, discord, context, agent-config) authenticate.
		if (process.env.ORCHESTRATOR_API_TOKEN) {
			envLines.push(`      ORCHESTRATOR_API_TOKEN: ${yamlScalar(process.env.ORCHESTRATOR_API_TOKEN)}`);
		}
		if (config.agent?.anthropicApiKey) {
			envLines.push(`      ANTHROPIC_API_KEY: ${yamlScalar(config.agent.anthropicApiKey)}`);
		}
		if (config.agent?.anthropicBaseUrl) {
			envLines.push(`      ANTHROPIC_BASE_URL: ${yamlScalar(config.agent.anthropicBaseUrl)}`);
		}
		if (config.agent?.model) {
			envLines.push(`      ANTHROPIC_MODEL: ${yamlScalar(config.agent.model)}`);
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

		// Run the container as the host user so files the agent creates in the
		// bind-mounted /workspace and /data are host-owned. Without this the
		// container's default root user creates root-owned entries there, which
		// this (non-root) process can then fail to delete with EPERM/EACCES —
		// e.g. in deleteProject below. getuid/getgid are POSIX-only (no-op on Windows).
		const userLine =
			typeof process.getuid === "function" && typeof process.getgid === "function"
				? `    user: "${process.getuid()}:${process.getgid()}"\n`
				: "";

		const dockerCompose = `# Project: ${config.name}
# Created: ${config.createdAt}
${binariesComment}${clientIdComment}
name: ${projectName}

services:
  agent:
    build:
      context: ${buildContext}
      dockerfile: ${dockerfilePath}
${userLine}    environment:
${envLines.join("\n")}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ${config.workspace.path}:/workspace
      - ./data:/data
    ports:
      - "127.0.0.1:${config.ports.server}:${config.ports.server}"
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
