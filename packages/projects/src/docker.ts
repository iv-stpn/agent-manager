import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import type { ProjectManager } from "./manager";

export class ProjectDocker {
	constructor(private manager: ProjectManager) {}

	/**
	 * Start a project's Docker containers
	 */
	async startProject(projectId: string): Promise<void> {
		const projectDir = this.manager.getProjectDir(projectId);
		const composePath = join(projectDir, "docker-compose.yml");

		if (!existsSync(composePath)) {
			throw new Error(`Project "${projectId}" docker-compose.yml not found`);
		}

		// Load environment file if exists
		const envPath = join(projectDir, ".env");
		const envArgs = existsSync(envPath) ? ["--env-file", envPath] : [];

		await $`docker compose -f ${composePath} ${envArgs} up -d`.cwd(projectDir);

		await this.manager.updateProject(projectId, { status: "active" });
	}

	/**
	 * Start with captured output
	 */
	async startProjectWithOutput(projectId: string, onLine?: (line: string) => void | Promise<void>): Promise<string> {
		const projectDir = this.manager.getProjectDir(projectId);
		const composePath = join(projectDir, "docker-compose.yml");

		if (!existsSync(composePath)) {
			throw new Error(`Project "${projectId}" docker-compose.yml not found`);
		}

		const envPath = join(projectDir, ".env");
		const envArgs = existsSync(envPath) ? ["--env-file", envPath] : [];

		const proc = Bun.spawn(["docker", "compose", "-f", composePath, ...envArgs, "up", "-d"], {
			cwd: projectDir,
			stdout: "pipe",
			stderr: "pipe",
		});

		const lines: string[] = [];
		const readStream = async (stream: ReadableStream<Uint8Array>) => {
			const reader = stream.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split("\n");
				buffer = parts.pop() || "";
				for (const line of parts) {
					if (line.trim()) {
						lines.push(line);
						await onLine?.(line);
					}
				}
			}
			if (buffer.trim()) {
				lines.push(buffer);
				await onLine?.(buffer);
			}
		};

		await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new Error(lines.join("\n") || `docker compose up failed with exit code ${exitCode}`);
		}

		await this.manager.updateProject(projectId, { status: "active" });
		return lines.join("\n");
	}

	/**
	 * Stop a project's Docker containers.
	 *
	 * When `removeImages` is set, the containers are torn down with
	 * `--remove-orphans` and the project's built images are removed by their
	 * compose-project label — used on cleanup/delete so nothing is left
	 * dangling. A plain stop keeps images around for fast restarts.
	 *
	 * Removing by label (rather than `down --rmi local`) is deliberate:
	 * `--rmi local` only removes the image *currently tagged* for the project.
	 * Once a rebuild has untagged a previous build, or the project folder is
	 * deleted, those layers become `<none>` images that compose no longer
	 * tracks — but they keep the `com.docker.compose.project` label, so a
	 * label-scoped `docker image rm` reaps them reliably.
	 */
	async stopProject(projectId: string, options: { removeImages?: boolean } = {}): Promise<void> {
		const projectDir = this.manager.getProjectDir(projectId);
		const composePath = join(projectDir, "docker-compose.yml");

		if (!existsSync(composePath)) {
			throw new Error(`Project "${projectId}" docker-compose.yml not found`);
		}

		const downArgs = options.removeImages ? ["--remove-orphans"] : [];
		await $`docker compose -f ${composePath} down ${downArgs}`.cwd(projectDir);

		if (options.removeImages) {
			await this.removeProjectImages(projectId);
		}

		await this.manager.updateProject(projectId, { status: "stopped" });
	}

	/**
	 * Stop with captured output
	 */
	async stopProjectWithOutput(projectId: string, options: { removeImages?: boolean } = {}, onLine?: (line: string) => void | Promise<void>): Promise<string> {
		const projectDir = this.manager.getProjectDir(projectId);
		const composePath = join(projectDir, "docker-compose.yml");

		if (!existsSync(composePath)) {
			throw new Error(`Project "${projectId}" docker-compose.yml not found`);
		}

		const downArgs = options.removeImages ? ["--remove-orphans"] : [];
		const proc = Bun.spawn(["docker", "compose", "-f", composePath, "down", ...downArgs], {
			cwd: projectDir,
			stdout: "pipe",
			stderr: "pipe",
		});

		const lines: string[] = [];
		const readStream = async (stream: ReadableStream<Uint8Array>) => {
			const reader = stream.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split("\n");
				buffer = parts.pop() || "";
				for (const line of parts) {
					if (line.trim()) {
						lines.push(line);
						await onLine?.(line);
					}
				}
			}
			if (buffer.trim()) {
				lines.push(buffer);
				await onLine?.(buffer);
			}
		};

		await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new Error(lines.join("\n") || `docker compose down failed with exit code ${exitCode}`);
		}

		if (options.removeImages) {
			await this.removeProjectImages(projectId);
		}

		await this.manager.updateProject(projectId, { status: "stopped" });
		return lines.join("\n");
	}

	/**
	 * Remove every image built for a project — tagged or dangling — by matching
	 * the `com.docker.compose.project` label Compose stamps on each build. This
	 * works even after the compose file or project folder is gone, which is
	 * exactly when `compose down --rmi` can no longer find them. Best-effort:
	 * failures (e.g. an image still in use) are swallowed so cleanup proceeds.
	 */
	async removeProjectImages(projectId: string): Promise<void> {
		const projectName = this.manager.dockerProjectName(projectId);
		const label = `com.docker.compose.project=${projectName}`;

		try {
			// `-a` is required: without it `image ls` hides untagged (`<none>`)
			// images even when they match the label filter — which is precisely
			// the dangling layers left by prior rebuilds that we need to reap.
			const ids = (await $`docker image ls -a --filter label=${label} --quiet --no-trunc`.text())
				.split("\n")
				.map((id) => id.trim())
				.filter(Boolean);

			// Deduplicate — `image ls` lists each tag, so a multi-tagged image repeats.
			const uniqueIds = [...new Set(ids)];
			if (uniqueIds.length === 0) return;

			await $`docker image rm --force ${uniqueIds}`.quiet();
		} catch {
			// Best-effort cleanup — never block stop/delete on image removal.
		}
	}

	/**
	 * Restart a project's Docker containers
	 */
	async restartProject(projectId: string): Promise<void> {
		await this.stopProject(projectId);
		await this.startProject(projectId);
	}

	/**
	 * Stop every project that is currently running. Used on master shutdown so
	 * downing the dev script also tears down all project containers.
	 */
	async stopAllProjects(): Promise<string[]> {
		const projects = await this.manager.listProjects();
		const stopped: string[] = [];

		await Promise.all(
			projects.map(async (project) => {
				try {
					const status = await this.getProjectStatus(project.id);
					if (!status.running) return;
					await this.stopProject(project.id);
					stopped.push(project.id);
				} catch {
					// Best-effort during shutdown — ignore individual failures.
				}
			})
		);

		return stopped;
	}

	/**
	 * Get project logs
	 */
	async getProjectLogs(projectId: string, service?: string): Promise<string> {
		const projectDir = this.manager.getProjectDir(projectId);
		const composePath = join(projectDir, "docker-compose.yml");

		if (!existsSync(composePath)) {
			throw new Error(`Project "${projectId}" docker-compose.yml not found`);
		}

		const serviceArg = service ? [service] : [];
		const result = await $`docker compose -f ${composePath} logs --tail=100 ${serviceArg}`.cwd(projectDir).text();

		return result;
	}

	/**
	 * Get project status
	 */
	async getProjectStatus(projectId: string): Promise<{
		running: boolean;
		containers: Array<{ name: string; status: string; ports: string }>;
	}> {
		const projectDir = this.manager.getProjectDir(projectId);
		const composePath = join(projectDir, "docker-compose.yml");

		if (!existsSync(composePath)) {
			return { running: false, containers: [] };
		}

		try {
			const result = await $`docker compose -f ${composePath} ps --format json`.cwd(projectDir).text();

			const containers = result
				.trim()
				.split("\n")
				.filter((line) => line)
				.map((line) => JSON.parse(line));

			interface ContainerInfo {
				State: string;
				Service: string;
				Publishers?: Array<{ PublishedPort: number; TargetPort: number }>;
			}
			const running = containers.some((c: ContainerInfo) => c.State === "running");

			return {
				running,
				containers: containers.map((c: ContainerInfo) => ({
					name: c.Service,
					status: c.State,
					ports: c.Publishers?.map((p) => `${p.PublishedPort}:${p.TargetPort}`).join(", ") || "",
				})),
			};
		} catch {
			return { running: false, containers: [] };
		}
	}

	/**
	 * Execute a command in a project container
	 */
	async execInProject(projectId: string, service: string, command: string[]): Promise<string> {
		const projectDir = this.manager.getProjectDir(projectId);
		const composePath = join(projectDir, "docker-compose.yml");

		if (!existsSync(composePath)) {
			throw new Error(`Project "${projectId}" docker-compose.yml not found`);
		}

		const result = await $`docker compose -f ${composePath} exec ${service} ${command}`.cwd(projectDir).text();

		return result;
	}

	/**
	 * Tail logs from a running project in real-time.
	 * Returns a kill function to stop the tail process.
	 */
	tailProjectLogs(projectId: string, onLine: (line: string) => void | Promise<void>, service?: string): { kill: () => void } {
		const projectDir = this.manager.getProjectDir(projectId);
		const composePath = join(projectDir, "docker-compose.yml");

		const serviceArgs = service ? [service] : [];
		const proc = Bun.spawn(
			["docker", "compose", "-f", composePath, "logs", "-f", "--tail=0", ...serviceArgs],
			{ cwd: projectDir, stdout: "pipe", stderr: "pipe" }
		);

		const readStream = async (stream: ReadableStream<Uint8Array>) => {
			const reader = stream.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					const parts = buffer.split("\n");
					buffer = parts.pop() || "";
					for (const line of parts) {
						if (line.trim()) await onLine(line);
					}
				}
				if (buffer.trim()) await onLine(buffer);
			} catch {
				// Process killed, expected
			}
		};

		readStream(proc.stdout);
		readStream(proc.stderr);

		return { kill: () => proc.kill() };
	}

	/**
	 * Build project containers
	 */
	async buildProject(projectId: string): Promise<void> {
		const projectDir = this.manager.getProjectDir(projectId);
		const composePath = join(projectDir, "docker-compose.yml");

		if (!existsSync(composePath)) {
			throw new Error(`Project "${projectId}" docker-compose.yml not found`);
		}

		await $`docker compose -f ${composePath} build --no-cache --pull`.cwd(projectDir);
	}
}
