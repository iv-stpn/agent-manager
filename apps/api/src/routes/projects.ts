import {
	CreateProjectSchema,
	isProtectedDirectory,
	ProjectContextSchema,
	type SessionRecord,
	UpdateSettingsSchema,
} from "@agent-manager/projects";
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { deleteProjectCategory } from "../discord/channels";
import { env } from "../env";
import { getErrorMessage } from "../lib/errors";
import type { HonoOrchestratorEnv } from "../types";

export type WorkspaceFolderStatus = "not_found" | "empty" | "not_empty" | "not_directory" | "protected";

function lanceTableName(projectId: string): string {
	return `project_${projectId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

async function dropLanceTable(projectId: string): Promise<void> {
	const name = lanceTableName(projectId);
	const res = await fetch(`${env.LANCEDB_URL}/tables/${name}`, { method: "DELETE" });
	if (!res.ok) {
		// A 404 here means the lancedb service is stale (missing the DELETE route) or
		// unreachable — either way the table was NOT dropped, so surface it rather than
		// silently leaving orphaned `.lance` tables behind on disk.
		const body = await res.text().catch(() => "");
		throw new Error(`Failed to drop lance table "${name}": ${res.status} ${body}`);
	}
}

async function enrichProject(
	ctx: Context<HonoOrchestratorEnv>,
	project: Awaited<ReturnType<Context<HonoOrchestratorEnv>["var"]["manager"]["getProject"]>>
) {
	const { docker, projectDatabaseManager } = ctx.var;
	const [dockerStatus, stats] = await Promise.all([
		docker.getProjectStatus(project.id),
		projectDatabaseManager.getProjectStats(project.id),
	]);
	return { ...project, dockerStatus, stats };
}

async function proxyToAgent(c: Context<HonoOrchestratorEnv>, projectId: string, upstreamPath: string): Promise<Response> {
	const project = await c.var.manager.getProject(projectId);
	const queryString = c.req.query();

	const search = new URLSearchParams(queryString).toString();
	const url = `http://localhost:${project.ports.server}${upstreamPath}${search ? `?${search}` : ""}`;

	const headers = new Headers();
	const contentType = c.req.header("content-type");
	if (contentType) headers.set("content-type", contentType);

	const method = c.req.method;
	const body = method === "GET" || method === "HEAD" ? undefined : await c.req.text();

	try {
		const upstream = await fetch(url, { method, headers, ...(body !== undefined && { body }) });
		const responseHeaders = new Headers();
		for (const key of ["content-type", "cache-control", "connection", "x-accel-buffering"]) {
			const value = upstream.headers.get(key);
			if (value) responseHeaders.set(key, value);
		}
		return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
	} catch (error) {
		return c.json(
			{
				error:
					error instanceof Error
						? `Agent server unreachable: ${error.message}`
						: "Agent server unreachable. Is the project running?",
			},
			502
		);
	}
}

/**
 * Wait until the project is genuinely ready to serve requests: the container must be
 * running AND the agent HTTP server inside it must be accepting connections. Polling
 * only container state (docker.getProjectStatus) is not enough — the container reports
 * "running" a beat before the Bun agent binds its port, so callers that send a request
 * the moment startup "completes" would hit a connection-refused 502.
 */
async function waitForAgentReady(c: Context<HonoOrchestratorEnv>, projectId: string, timeoutMs: number): Promise<boolean> {
	const { docker, manager } = c.var;
	const project = await manager.getProject(projectId);
	const healthUrl = `http://localhost:${project.ports.server}/health`;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const s = await docker.getProjectStatus(projectId);
		if (s.running) {
			try {
				const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
				if (res.ok) return true;
			} catch {
				// Container is up but the agent server isn't listening yet — keep polling.
			}
		}
		await Bun.sleep(1000);
	}
	return false;
}

// Sessions from DB when the project is stopped may still carry an active status from
// a hard shutdown — remap those to "stopped" so the UI reflects reality.
const ACTIVE_STATUSES = new Set(["running", "compacting", "paused"]);
function maskActiveSession<T extends { status: string }>(s: T): T {
	return ACTIVE_STATUSES.has(s.status) ? { ...s, status: "stopped" } : s;
}
function maskActiveSessions<T extends { status: string }>(sessions: T[]): T[] {
	return sessions.map(maskActiveSession);
}

// Chained so `typeof projectsRouter` carries full route schema —
// AppType in index.ts can then be derived without a hand-written stub.
export const projectsRouter = new Hono<HonoOrchestratorEnv>()
	// Main event stream — one connection drives the whole project list without
	// polling. Registered before "/:projectId" so the static path wins.
	.get("/events", (c) => {
		const origin = c.req.header("Origin");
		if (origin) c.header("Access-Control-Allow-Origin", origin);

		return streamSSE(c, async (stream) => {
			const { manager, hub } = c.var;
			try {
				const projects = await manager.listProjects();
				const enriched = await Promise.all(projects.map((project) => enrichProject(c, project)));
				await stream.writeSSE({ event: "projects", data: JSON.stringify(enriched) });
			} catch {
				// snapshot is best-effort; live events still flow
			}

			const listener = async (event: { projectId: string; type: string; data: unknown }) => {
				try {
					await stream.writeSSE({
						event: event.type,
						data: JSON.stringify({ projectId: event.projectId, data: event.data }),
					});
				} catch {
					// client disconnected
				}
			};
			const unsubscribe = hub.subscribe(listener);

			const ping = setInterval(async () => {
				try {
					await stream.writeSSE({ event: "ping", data: String(Date.now()) });
				} catch {
					clearInterval(ping);
				}
			}, 15_000);

			stream.onAbort(() => {
				unsubscribe();
				clearInterval(ping);
			});

			await new Promise<void>((resolve) => stream.onAbort(resolve));
		});
	})
	// List all projects
	.get("/", async (c) => {
		try {
			const projects = await c.var.manager.listProjects();
			const enriched = await Promise.all(projects.map((project) => enrichProject(c, project)));
			return c.json({ projects: enriched });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 500);
		}
	})
	// Check workspace path status (exists? empty?)
	.post("/check-path", async (c) => {
		try {
			let status: WorkspaceFolderStatus = "not_found";

			const { path: targetPath } = await c.req.json<{ path: string }>();
			if (!targetPath) return c.json({ error: "path is required" }, 400);
			const { resolve } = await import("node:path");
			const { stat, readdir } = await import("node:fs/promises");
			const { homedir } = await import("node:os");
			// Expand ~ to the user's home directory
			const expanded = targetPath.startsWith("~/") || targetPath === "~" ? targetPath.replace("~", homedir()) : targetPath;
			const resolved = resolve(expanded);

			// Check if it's a protected directory
			if (isProtectedDirectory(resolved)) {
				return c.json({ status: "protected" as const, path: resolved, error: "This is a protected system directory" }, 400);
			}

			try {
				const s = await stat(resolved);
				if (!s.isDirectory()) {
					status = "not_directory";
					return c.json({ status, path: resolved });
				}

				const entries = await readdir(resolved);
				status = entries.length > 0 ? "not_empty" : "empty";
				return c.json({ status, path: resolved });
			} catch (error: unknown) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return c.json({ status, path: resolved });
				throw error;
			}
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 500);
		}
	})
	// Clear workspace path (for template initialization)
	.post("/clear-path", async (c) => {
		try {
			const { path: targetPath } = await c.req.json<{ path: string }>();
			if (!targetPath) return c.json({ error: "path is required" }, 400);

			const { resolve, join } = await import("node:path");
			const { rm, readdir } = await import("node:fs/promises");
			const { homedir } = await import("node:os");

			const expanded = targetPath.startsWith("~/") || targetPath === "~" ? targetPath.replace("~", homedir()) : targetPath;
			const resolved = resolve(expanded);

			// Safety check: prevent deletion of protected directories
			if (isProtectedDirectory(resolved)) {
				return c.json({ error: "Cannot clear a protected system directory" }, 403);
			}

			// Remove all contents but keep the directory
			const entries = await readdir(resolved);
			await Promise.all(entries.map((entry) => rm(join(resolved, entry), { recursive: true, force: true })));

			return c.json({ success: true, path: resolved });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 500);
		}
	})
	// Create new project
	.post("/", async (c) => {
		try {
			const body = await c.req.json();
			const input = CreateProjectSchema.parse(body);

			// Resolve LLM client if specified
			if (input.agent?.clientId) {
				const client = c.var.orchestratorDb.getLlmClient(input.agent.clientId);
				if (!client) return c.json({ error: "LLM client not found" }, 400);
				input.agent.anthropicApiKey = input.agent.anthropicApiKey || client.apiKey;
				input.agent.anthropicBaseUrl = input.agent.anthropicBaseUrl || client.baseUrl;
				input.agent.model = input.agent.model || client.model;
			}

			const project = await c.var.manager.createProject(input);
			return c.json({ project }, 201);
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 400);
		}
	})
	// Create new project with SSE progress stream (workspace setup, template
	// clone/copy, dependency install). POST (not GET+EventSource) because the
	// body can carry an LLM API key — that shouldn't go in a URL/query string.
	.post("/create-stream", (c) => {
		const origin = c.req.header("Origin");
		if (origin) c.header("Access-Control-Allow-Origin", origin);

		return streamSSE(c, async (stream) => {
			// Writes must reach the client in the same order they were produced —
			// onStep/onLine fire synchronously from createProject's sequential
			// awaits and from process stdout/stderr 'data' events, neither of
			// which wait for the write to actually complete. Chaining every write
			// onto one shared promise serializes them without needing the manager
			// layer to await anything.
			let queue: Promise<void> = Promise.resolve();
			const enqueue = (write: () => Promise<void>) => {
				queue = queue.then(write, write);
				return queue;
			};
			const send = (step: string, status: "running" | "done" | "error", log?: string) =>
				enqueue(async () => {
					await stream.writeSSE({ event: "progress", data: JSON.stringify({ step, status, log }) });
					await stream.sleep(0);
				});
			const delta = (step: string, line: string) =>
				enqueue(async () => {
					await stream.writeSSE({ event: "delta", data: JSON.stringify({ step, line }) });
					await stream.sleep(0);
				});

			try {
				const body = await c.req.json();
				const input = CreateProjectSchema.parse(body);

				if (input.agent?.clientId) {
					const client = c.var.orchestratorDb.getLlmClient(input.agent.clientId);
					if (!client) throw new Error("LLM client not found");
					input.agent.anthropicApiKey = input.agent.anthropicApiKey || client.apiKey;
					input.agent.anthropicBaseUrl = input.agent.anthropicBaseUrl || client.baseUrl;
					input.agent.model = input.agent.model || client.model;
				}

				const project = await c.var.manager.createProject(input, {
					onStep: (step, status, detail) => void send(step, status, detail),
					onLine: (step, l) => void delta(step, l),
				});

				await queue;
				await stream.writeSSE({ event: "complete", data: JSON.stringify({ success: true, project }) });
			} catch (error) {
				const msg = getErrorMessage(error);
				await queue;
				await stream.writeSSE({ event: "complete", data: JSON.stringify({ success: false, error: msg }) });
			}
		});
	})
	.get("/:projectId", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			const { manager, docker, projectDatabaseManager } = c.var;
			const project = await manager.getProject(projectId);
			// Only the two cheap-ish calls the page is gated on: docker `ps` (running
			// indicator) and the DB stats. The agent-log line count for the Logs-tab
			// badge is intentionally NOT fetched here — it spawned a second `docker
			// compose logs` subprocess that contended with `ps` on the daemon and
			// doubled the wait the whole page blocks on. The Logs tab recomputes the
			// count itself when opened, so `logLines` starts null until then.
			const [dockerStatus, stats] = await Promise.all([
				docker.getProjectStatus(projectId),
				projectDatabaseManager.getProjectStats(projectId),
			]);
			return c.json({ project: { ...project, dockerStatus, stats, logLines: null } });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 404);
		}
	})
	// Delete project
	.delete("/:projectId", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			const { docker, manager, hub } = c.var;
			try {
				await docker.stopProject(projectId, { removeImages: true });
			} catch {
				// Ignore if already stopped
			}
			await Promise.all([manager.deleteProject(projectId), dropLanceTable(projectId)]);
			// Best-effort: remove the project's Discord category + channels so the
			// guild doesn't accumulate orphans (no-op when Discord is disabled).
			deleteProjectCategory(projectId).catch(() => {});
			hub.projectStopped(projectId);
			return c.json({ success: true });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 400);
		}
	})
	// Delete project with SSE progress stream
	.get("/:projectId/delete-stream", (c) => {
		const projectId = c.req.param("projectId");
		const origin = c.req.header("Origin");
		if (origin) c.header("Access-Control-Allow-Origin", origin);

		return streamSSE(c, async (stream) => {
			const { docker, manager, hub } = c.var;
			const send = (step: string, status: "running" | "done" | "error", log?: string) =>
				stream.writeSSE({ event: "progress", data: JSON.stringify({ step, status, log }) }).then(() => stream.sleep(0));
			const delta = (step: string, line: string) =>
				stream.writeSSE({ event: "delta", data: JSON.stringify({ step, line }) }).then(() => stream.sleep(0));

			try {
				// Stop containers first if the project is currently running
				let running = false;
				try {
					running = (await docker.getProjectStatus(projectId)).running;
				} catch {
					// Status unavailable — treat as not running
				}
				if (running) {
					await send("stop", "running", "Stopping containers...");
					await docker.stopProjectWithOutput(projectId, {}, async (line) => {
						await delta("stop", line);
					});
					await send("stop", "done", "Containers stopped");
				}

				// Remove Docker resources (containers + built images), best-effort
				await send("delete-docker", "running", "Removing Docker resources...");
				try {
					await docker.stopProject(projectId, { removeImages: true });
				} catch {
					// Already stopped or compose file missing — proceed to data deletion
				}
				await send("delete-docker", "done", "Docker resources removed");

				// Delete project data
				await send("delete-project", "running", "Deleting project...");
				await Promise.all([manager.deleteProject(projectId), dropLanceTable(projectId)]);
				// Best-effort Discord cleanup (no-op when Discord is disabled)
				deleteProjectCategory(projectId).catch(() => {});
				hub.projectStopped(projectId);
				await send("delete-project", "done", "Project deleted");

				await stream.writeSSE({ event: "complete", data: JSON.stringify({ success: true }) });
			} catch (error) {
				const msg = getErrorMessage(error);
				await send("delete-project", "error", msg);
				await stream.writeSSE({ event: "complete", data: JSON.stringify({ success: false, error: msg }) });
			}
		});
	})
	// Start project
	.post("/:projectId/start", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			const { docker, hub } = c.var;
			await docker.startProject(projectId);
			const status = await docker.getProjectStatus(projectId);
			hub.projectStarted(projectId);
			return c.json({ status });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 500);
		}
	})
	// Start project with SSE progress stream
	.get("/:projectId/start-stream", (c) => {
		const projectId = c.req.param("projectId");
		const origin = c.req.header("Origin");
		if (origin) c.header("Access-Control-Allow-Origin", origin);

		return streamSSE(c, async (stream) => {
			const { docker, hub } = c.var;
			const send = (step: string, status: "running" | "done" | "error", log?: string) =>
				stream.writeSSE({ event: "progress", data: JSON.stringify({ step, status, log }) }).then(() => stream.sleep(0));
			const delta = (step: string, line: string) =>
				stream.writeSSE({ event: "delta", data: JSON.stringify({ step, line }) }).then(() => stream.sleep(0));

			let tail: { kill: () => void } | null = null;
			try {
				await send("start", "running", "Starting containers...");
				await docker.startProjectWithOutput(projectId, async (line) => {
					await delta("start", line);
				});
				await send("start", "done");

				// Tail container logs while waiting for health
				tail = docker.tailProjectLogs(projectId, async (line) => {
					await delta("logs", line);
				});
				await send("health", "running", "Waiting for services to become healthy...");
				// Gate on the agent HTTP server actually accepting connections, not just the
				// container being "running" — otherwise a message sent the instant startup
				// completes races the server's port bind and gets dropped as a 502.
				const healthy = await waitForAgentReady(c, projectId, 30000);
				tail.kill();
				if (healthy) {
					hub.projectStarted(projectId);
					await send("health", "done", "Project is running");
					await stream.writeSSE({ event: "complete", data: JSON.stringify({ success: true }) });
				} else {
					const logs = await docker.getProjectLogs(projectId, "agent").catch(() => "");
					await send("health", "error", `Project did not become healthy:\n${logs.slice(-2000)}`);
					await stream.writeSSE({ event: "complete", data: JSON.stringify({ success: false }) });
				}
			} catch (error) {
				tail?.kill();
				const msg = getErrorMessage(error);
				await send("start", "error", msg);
				await stream.writeSSE({ event: "complete", data: JSON.stringify({ success: false, error: msg }) });
			}
		});
	})
	// Stop project
	.post("/:projectId/stop", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			const { docker, hub } = c.var;
			await docker.stopProject(projectId);
			hub.projectStopped(projectId);
			return c.json({ success: true });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 500);
		}
	})
	// Stop project with SSE progress stream
	.get("/:projectId/stop-stream", (c) => {
		const projectId = c.req.param("projectId");
		const origin = c.req.header("Origin");
		if (origin) c.header("Access-Control-Allow-Origin", origin);

		return streamSSE(c, async (stream) => {
			const { docker, hub } = c.var;
			const send = (step: string, status: "running" | "done" | "error", log?: string) =>
				stream.writeSSE({ event: "progress", data: JSON.stringify({ step, status, log }) }).then(() => stream.sleep(0));
			const delta = (step: string, line: string) =>
				stream.writeSSE({ event: "delta", data: JSON.stringify({ step, line }) }).then(() => stream.sleep(0));

			try {
				await send("stop", "running", "Stopping containers...");
				await docker.stopProjectWithOutput(projectId, {}, async (line) => {
					await delta("stop", line);
				});
				hub.projectStopped(projectId);
				await send("stop", "done", "Containers stopped");
				await stream.writeSSE({ event: "complete", data: JSON.stringify({ success: true }) });
			} catch (error) {
				const msg = getErrorMessage(error);
				await send("stop", "error", msg);
				await stream.writeSSE({ event: "complete", data: JSON.stringify({ success: false, error: msg }) });
			}
		});
	})
	// Restart project with SSE progress stream
	.get("/:projectId/restart-stream", (c) => {
		const projectId = c.req.param("projectId");
		const origin = c.req.header("Origin");
		if (origin) c.header("Access-Control-Allow-Origin", origin);

		return streamSSE(c, async (stream) => {
			const { docker, hub } = c.var;
			const send = (step: string, status: "running" | "done" | "error", log?: string) =>
				stream.writeSSE({ event: "progress", data: JSON.stringify({ step, status, log }) }).then(() => stream.sleep(0));
			const delta = (step: string, line: string) =>
				stream.writeSSE({ event: "delta", data: JSON.stringify({ step, line }) }).then(() => stream.sleep(0));

			let tail: { kill: () => void } | null = null;
			try {
				await send("stop", "running", "Stopping containers...");
				await docker.stopProjectWithOutput(projectId, {}, async (line) => {
					await delta("stop", line);
				});
				await send("stop", "done");

				await send("start", "running", "Starting containers...");
				await docker.startProjectWithOutput(projectId, async (line) => {
					await delta("start", line);
				});
				await send("start", "done");

				// Tail container logs while waiting for health
				tail = docker.tailProjectLogs(projectId, async (line) => {
					await delta("logs", line);
				});
				await send("health", "running", "Waiting for services to become healthy...");
				// Gate on the agent HTTP server actually accepting connections, not just the
				// container being "running" — otherwise a message sent the instant startup
				// completes races the server's port bind and gets dropped as a 502.
				const healthy = await waitForAgentReady(c, projectId, 30000);
				tail.kill();
				if (healthy) {
					hub.projectRestarted(projectId);
					await send("health", "done", "Project is running");
					await stream.writeSSE({ event: "complete", data: JSON.stringify({ success: true }) });
				} else {
					const logs = await docker.getProjectLogs(projectId, "agent").catch(() => "");
					await send("health", "error", `Project did not become healthy:\n${logs.slice(-2000)}`);
					await stream.writeSSE({ event: "complete", data: JSON.stringify({ success: false }) });
				}
			} catch (error) {
				tail?.kill();
				const msg = getErrorMessage(error);
				await send("stop", "error", msg);
				await stream.writeSSE({ event: "complete", data: JSON.stringify({ success: false, error: msg }) });
			}
		});
	})
	// Restart project
	.post("/:projectId/restart", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			const { docker, hub } = c.var;
			await docker.restartProject(projectId);
			const status = await docker.getProjectStatus(projectId);
			hub.projectRestarted(projectId);
			return c.json({ status });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 500);
		}
	})
	// Get project logs
	.get("/:projectId/logs", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			const service = c.req.query("service");
			const logs = await c.var.docker.getProjectLogs(projectId, service);
			return c.json({ logs });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 500);
		}
	})
	// Build project
	.post("/:projectId/build", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			await c.var.docker.buildProject(projectId);
			return c.json({ success: true });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 500);
		}
	})
	// Rebuild project image (no-cache) then restart containers, with SSE progress stream
	.get("/:projectId/build-stream", (c) => {
		const projectId = c.req.param("projectId");
		const origin = c.req.header("Origin");
		if (origin) c.header("Access-Control-Allow-Origin", origin);

		return streamSSE(c, async (stream) => {
			const { docker, hub } = c.var;
			const send = (step: string, status: "running" | "done" | "error", log?: string) =>
				stream.writeSSE({ event: "progress", data: JSON.stringify({ step, status, log }) }).then(() => stream.sleep(0));
			const delta = (step: string, line: string) =>
				stream.writeSSE({ event: "delta", data: JSON.stringify({ step, line }) }).then(() => stream.sleep(0));

			let tail: { kill: () => void } | null = null;
			try {
				const wasRunning = (await docker.getProjectStatus(projectId).catch(() => ({ running: false }))).running;

				await send("build", "running", "Rebuilding image (no cache)...");
				await docker.buildProjectWithOutput(projectId, async (line) => {
					await delta("build", line);
				});
				await send("build", "done", "Image rebuilt");

				if (wasRunning) {
					await send("stop", "running", "Stopping containers...");
					await docker.stopProjectWithOutput(projectId, {}, async (line) => {
						await delta("stop", line);
					});
					await send("stop", "done");
				}

				await send("start", "running", "Starting containers...");
				await docker.startProjectWithOutput(projectId, async (line) => {
					await delta("start", line);
				});
				await send("start", "done");

				// Tail container logs while waiting for health
				tail = docker.tailProjectLogs(projectId, async (line) => {
					await delta("logs", line);
				});
				await send("health", "running", "Waiting for services to become healthy...");
				// Gate on the agent HTTP server actually accepting connections, not just the
				// container being "running" — otherwise a message sent the instant startup
				// completes races the server's port bind and gets dropped as a 502.
				const healthy = await waitForAgentReady(c, projectId, 30000);
				tail.kill();
				if (healthy) {
					hub.projectRestarted(projectId);
					await send("health", "done", "Project is running");
					await stream.writeSSE({ event: "complete", data: JSON.stringify({ success: true }) });
				} else {
					const logs = await docker.getProjectLogs(projectId, "agent").catch(() => "");
					await send("health", "error", `Project did not become healthy:\n${logs.slice(-2000)}`);
					await stream.writeSSE({ event: "complete", data: JSON.stringify({ success: false }) });
				}
			} catch (error) {
				tail?.kill();
				const msg = getErrorMessage(error);
				await send("build", "error", msg);
				await stream.writeSSE({ event: "complete", data: JSON.stringify({ success: false, error: msg }) });
			}
		});
	})
	// Get project database stats
	.get("/:projectId/stats", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			const stats = await c.var.projectDatabaseManager.getProjectStats(projectId);
			return c.json({ stats });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 500);
		}
	})
	// List sessions — read straight from the project DB (source of truth, always
	// reachable on the host). Only mask stale active statuses when the container
	// isn't actually running.
	.get("/:projectId/sessions", async (c) => {
		const projectId = c.req.param("projectId");
		const { running } = await c.var.docker.getProjectStatus(projectId);
		const sessions = await c.var.projectDatabaseManager.getSessions(projectId);
		return c.json(running ? sessions : maskActiveSessions(sessions));
	})
	// All check-ins across every session — always DB-backed (reports tab)
	.get("/:projectId/reports", async (c) => {
		const projectId = c.req.param("projectId");
		return c.json(await c.var.projectDatabaseManager.getReports(projectId));
	})
	// Update project settings (Discord + Anthropic config)
	.put("/:projectId/settings", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			const { ports, ...rest } = UpdateSettingsSchema.parse(await c.req.json());

			// Resolve LLM client if specified
			if (rest.agent?.clientId) {
				const client = c.var.orchestratorDb.getLlmClient(rest.agent.clientId);
				if (!client) return c.json({ error: "LLM client not found" }, 400);
				rest.agent.anthropicApiKey = rest.agent.anthropicApiKey || client.apiKey;
				rest.agent.anthropicBaseUrl = rest.agent.anthropicBaseUrl || client.baseUrl;
				rest.agent.model = rest.agent.model || client.model;
			}

			const updates: Parameters<typeof c.var.manager.updateProject>[1] = {
				...rest,
				...(ports?.server && { ports: { server: ports.server } }),
			};
			const project = await c.var.manager.updateProject(projectId, updates);
			return c.json({ project });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 400);
		}
	})
	// Read per-project prompt context (selected tech stacks / guidelines + local instructions)
	.get("/:projectId/context", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			const context = await c.var.manager.getProjectContext(projectId);
			return c.json({ context });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 400);
		}
	})
	// Update per-project prompt context. Resolves selected library IDs to their
	// text here (only the orchestratorhas the library DB), renders the markdown the
	// container reads, and persists both via the manager. Preserves the
	// templates field (set at creation) since the context editor doesn't edit it.
	.put("/:projectId/context", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			const { techStackIds, guidelineIds, instructions } = ProjectContextSchema.parse(await c.req.json());

			const techStacks = techStackIds
				.map((id) => c.var.orchestratorDb.getTechStack(id))
				.filter((techStack): techStack is NonNullable<typeof techStack> => !!techStack);
			const guidelines = guidelineIds
				.map((id) => c.var.orchestratorDb.getGuideline(id))
				.filter((guideline): guideline is NonNullable<typeof guideline> => !!guideline);

			// Carry over templates from the existing context — they're set at
			// creation and not editable from the context panel.
			const existing = await c.var.manager.getProjectContext(projectId);

			const context = await c.var.manager.setProjectContext(projectId, {
				techStackIds: techStacks.map((techStack) => techStack.id),
				guidelineIds: guidelines.map((guideline) => guideline.id),
				instructions,
				templates: existing.templates,
			});
			return c.json({ context });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 400);
		}
	})
	// Resolve per-project context to full objects (tech stacks + guidelines + instructions
	// + templates). Called by the agent container at session start to build its system prompt.
	.get("/:projectId/context/resolved", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			const { techStackIds, guidelineIds, instructions, templates } = await c.var.manager.getProjectContext(projectId);

			const techStacks = techStackIds
				.map((id) => c.var.orchestratorDb.getTechStack(id))
				.filter((techStack): techStack is NonNullable<typeof techStack> => !!techStack);
			const guidelines = guidelineIds
				.map((id) => c.var.orchestratorDb.getGuideline(id))
				.filter((guideline): guideline is NonNullable<typeof guideline> => !!guideline)
				.map((guideline) => ({
					...guideline,
					category: guideline.categoryId ? (c.var.orchestratorDb.getGuidelineCategory(guideline.categoryId)?.name ?? null) : null,
				}));

			return c.json({ techStacks, guidelines, instructions, templates });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 400);
		}
	})
	// Resolve the project's LLM config live from its selected client. The agent
	// container calls this at every session start/restart so a client edit takes
	// effect on the next run without rewriting the compose file or recreating the
	// container. The project's `clientId` is the source of truth; any api key /
	// base url / model baked into the compose env only acts as a fallback.
	.get("/:projectId/agent-config", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			const project = await c.var.manager.getProject(projectId);
			const agent = project.agent;

			// Start from the client record (live), fall back to compose-baked values.
			const client = agent?.clientId ? c.var.orchestratorDb.getLlmClient(agent.clientId) : undefined;
			if (agent?.clientId && !client) return c.json({ error: "LLM client not found" }, 404);

			return c.json({
				apiKey: client?.apiKey || agent?.anthropicApiKey || "",
				baseUrl: client?.baseUrl || agent?.anthropicBaseUrl || "",
				model: client?.model || agent?.model || "",
				smallModel: client?.smallModel || "",
			});
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 400);
		}
	})
	// ---- Agent proxy: forward live agent endpoints to the project's server ----
	.post("/:projectId/sessions", async (c) => {
		const projectId = c.req.param("projectId");
		const project = await c.var.manager.getProject(projectId);
		const qs = c.req.query();

		const search = new URLSearchParams(qs).toString();
		const url = `http://localhost:${project.ports.server}/api/sessions${search ? `?${search}` : ""}`;

		const body = await c.req.text();
		const headers = new Headers();

		const ct = c.req.header("content-type");
		if (ct) headers.set("content-type", ct);

		try {
			const upstream = await fetch(url, { method: "POST", headers, body });
			const data: SessionRecord = await upstream.json();
			return c.json(data, 201);
		} catch (error) {
			return c.json(
				{ error: error instanceof Error ? `Agent server unreachable: ${error.message}` : "Agent server unreachable." },
				502
			);
		}
	})
	.get("/:projectId/sessions/:sessionId", async (c) => {
		const { projectId, sessionId } = c.req.param();
		const s = await c.var.projectDatabaseManager.getSession(projectId, sessionId);
		if (!s) return c.json({ error: "Not found" }, 404);
		const { running } = await c.var.docker.getProjectStatus(projectId);
		return c.json(running ? s : maskActiveSession(s));
	})
	.get("/:projectId/sessions/:sessionId/messages", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return c.json(await c.var.projectDatabaseManager.getMessages(projectId, sessionId));
	})
	.get("/:projectId/sessions/:sessionId/tools", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return c.json(await c.var.projectDatabaseManager.getToolCalls(projectId, sessionId));
	})
	.get("/:projectId/sessions/:sessionId/checkins", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return c.json(await c.var.projectDatabaseManager.getCheckins(projectId, sessionId));
	})
	.get("/:projectId/sessions/:sessionId/questions", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return c.json(await c.var.projectDatabaseManager.getQuestions(projectId, sessionId));
	})
	.get("/:projectId/sessions/:sessionId/compactions", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return c.json(await c.var.projectDatabaseManager.getCompactions(projectId, sessionId));
	})
	.get("/:projectId/tasks", async (c) => {
		const { projectId } = c.req.param();
		const sessionId = c.req.query("sessionId");
		return c.json(await c.var.projectDatabaseManager.getTasks(projectId, sessionId));
	})
	.put("/:projectId/tasks/:taskId", async (c) => {
		const { projectId, taskId } = c.req.param();
		return proxyToAgent(c, projectId, `/api/tasks/${taskId}`);
	})
	.delete("/:projectId/tasks/:taskId", async (c) => {
		const { projectId, taskId } = c.req.param();
		return proxyToAgent(c, projectId, `/api/tasks/${taskId}`);
	})
	.post("/:projectId/sessions/:sessionId/stop", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return proxyToAgent(c, projectId, `/api/sessions/${sessionId}/stop`);
	})
	.post("/:projectId/sessions/:sessionId/pause", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return proxyToAgent(c, projectId, `/api/sessions/${sessionId}/pause`);
	})
	.post("/:projectId/sessions/:sessionId/restart", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return proxyToAgent(c, projectId, `/api/sessions/${sessionId}/restart`);
	})
	.post("/:projectId/sessions/:sessionId/message", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return proxyToAgent(c, projectId, `/api/sessions/${sessionId}/message`);
	})
	.put("/:projectId/sessions/:sessionId/settings", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return proxyToAgent(c, projectId, `/api/sessions/${sessionId}/settings`);
	});
