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
import { z } from "zod";
import { deleteProjectCategory } from "../discord/channels";
import { env } from "../env";
import { getErrorMessage } from "../lib/errors";
import type { HonoOrchestratorEnv } from "../types";
import { resolveAgentLlmClient } from "./llm-client-resolve";
import { setMemoryArchived } from "./memory";
import { createProgressEmitter } from "./progress-stream";

export type WorkspaceFolderStatus = "not_found" | "empty" | "not_empty" | "not_directory" | "protected";

// Cap on how long the orchestrator waits for a project's agent container to
// respond to a proxied request. Without it, an unreachable or hung container
// (network wedged, process deadlocked) leaves the orchestrator request open
// indefinitely, tying up a connection per stuck call. These are all short
// request/response calls (tasks, session control) — never SSE, which the web
// client opens straight to the container — so a bounded timeout is safe.
const AGENT_PROXY_TIMEOUT_MS = 15_000;

// Body schema for the path-inspection / path-clearing routes. These take a
// host filesystem path (an external workspace the operator chose), so the value
// is validated as a non-empty string here and the resolved path is additionally
// gated by isProtectedDirectory + an is-directory check at each call site.
const PathBodySchema = z.object({ path: z.string().min(1, "path is required") });

// Body for the archive toggle. `archived: true` hides the row into the UI's
// "Archived" tab; `false` restores it. Written straight to the project DB (see
// ProjectDatabase.set*Archived) — it's a UI-only column the agent never reads,
// so it works whether or not the container is running.
const ArchiveBodySchema = z.object({ archived: z.boolean() });

function lanceTableName(projectId: string): string {
	return `project_${projectId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/**
 * Set the CORS origin header for a streamed (SSE) response, but ONLY echo the
 * request's Origin when it matches the configured web origin. Reflecting an
 * arbitrary Origin (the previous behaviour) let any page the operator visited
 * drive these endpoints — several of which mutate state — defeating the
 * allowlist the global `cors()` middleware sets for normal responses.
 */
function applyCorsOrigin(c: Context<HonoOrchestratorEnv>): void {
	const origin = c.req.header("Origin");
	if (origin && origin === env.ORCHESTRATOR_WEB_URL) {
		c.header("Access-Control-Allow-Origin", origin);
	}
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
		const upstream = await fetch(url, {
			method,
			headers,
			...(body !== undefined && { body }),
			signal: AbortSignal.timeout(AGENT_PROXY_TIMEOUT_MS),
		});
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
		applyCorsOrigin(c);

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
			const parsed = PathBodySchema.safeParse(await c.req.json().catch(() => ({})));
			if (!parsed.success) return c.json({ error: "path is required" }, 400);
			const targetPath = parsed.data.path;

			const { resolve, join } = await import("node:path");
			const { rm, readdir, stat } = await import("node:fs/promises");
			const { homedir } = await import("node:os");

			const expanded = targetPath.startsWith("~/") || targetPath === "~" ? targetPath.replace("~", homedir()) : targetPath;
			const resolved = resolve(expanded);

			// Safety check: prevent deletion of protected directories
			if (isProtectedDirectory(resolved)) {
				return c.json({ error: "Cannot clear a protected system directory" }, 403);
			}

			// Only ever clear an actual directory — never follow the path to a file
			// (or a symlink target) and recursively remove it.
			const s = await stat(resolved);
			if (!s.isDirectory()) return c.json({ error: "Path is not a directory" }, 400);

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

			// Backfill Anthropic config from the selected LLM client (throws → 400 below).
			resolveAgentLlmClient(input.agent, (id) => c.var.orchestratorDb.getLlmClient(id));

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
		applyCorsOrigin(c);

		return streamSSE(c, async (stream) => {
			// The emitter serializes every write onto one queue so frames reach the
			// client in order — onStep/onLine fire synchronously from createProject's
			// sequential awaits and from process stdout/stderr 'data' events, neither
			// of which wait for the write to flush.
			const { send, delta, complete } = createProgressEmitter(stream);

			try {
				const body = await c.req.json();
				const input = CreateProjectSchema.parse(body);
				resolveAgentLlmClient(input.agent, (id) => c.var.orchestratorDb.getLlmClient(id));

				const project = await c.var.manager.createProject(input, {
					onStep: (step, status, detail) => void send(step, status, detail),
					onLine: (step, l) => void delta(step, l),
				});

				// `complete` is enqueued too, so it lands after every buffered progress
				// frame — no need to drain the queue first.
				await complete({ success: true, project });
			} catch (error) {
				await complete({ success: false, error: getErrorMessage(error) });
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
		applyCorsOrigin(c);

		return streamSSE(c, async (stream) => {
			const { docker, manager, hub } = c.var;
			const { send, delta, complete } = createProgressEmitter(stream);

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

				await complete({ success: true });
			} catch (error) {
				const msg = getErrorMessage(error);
				await send("delete-project", "error", msg);
				await complete({ success: false, error: msg });
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
		applyCorsOrigin(c);

		return streamSSE(c, async (stream) => {
			const { docker, hub } = c.var;
			const { send, delta, complete } = createProgressEmitter(stream);

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
					await complete({ success: true });
				} else {
					const logs = await docker.getProjectLogs(projectId, "agent").catch(() => "");
					await send("health", "error", `Project did not become healthy:\n${logs.slice(-2000)}`);
					await complete({ success: false });
				}
			} catch (error) {
				tail?.kill();
				const msg = getErrorMessage(error);
				await send("start", "error", msg);
				await complete({ success: false, error: msg });
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
		applyCorsOrigin(c);

		return streamSSE(c, async (stream) => {
			const { docker, hub } = c.var;
			const { send, delta, complete } = createProgressEmitter(stream);

			try {
				await send("stop", "running", "Stopping containers...");
				await docker.stopProjectWithOutput(projectId, {}, async (line) => {
					await delta("stop", line);
				});
				hub.projectStopped(projectId);
				await send("stop", "done", "Containers stopped");
				await complete({ success: true });
			} catch (error) {
				const msg = getErrorMessage(error);
				await send("stop", "error", msg);
				await complete({ success: false, error: msg });
			}
		});
	})
	// Restart project with SSE progress stream
	.get("/:projectId/restart-stream", (c) => {
		const projectId = c.req.param("projectId");
		applyCorsOrigin(c);

		return streamSSE(c, async (stream) => {
			const { docker, hub } = c.var;
			const { send, delta, complete } = createProgressEmitter(stream);

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
					await complete({ success: true });
				} else {
					const logs = await docker.getProjectLogs(projectId, "agent").catch(() => "");
					await send("health", "error", `Project did not become healthy:\n${logs.slice(-2000)}`);
					await complete({ success: false });
				}
			} catch (error) {
				tail?.kill();
				const msg = getErrorMessage(error);
				await send("stop", "error", msg);
				await complete({ success: false, error: msg });
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
		applyCorsOrigin(c);

		return streamSSE(c, async (stream) => {
			const { docker, hub } = c.var;
			const { send, delta, complete } = createProgressEmitter(stream);

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
					await complete({ success: true });
				} else {
					const logs = await docker.getProjectLogs(projectId, "agent").catch(() => "");
					await send("health", "error", `Project did not become healthy:\n${logs.slice(-2000)}`);
					await complete({ success: false });
				}
			} catch (error) {
				tail?.kill();
				const msg = getErrorMessage(error);
				await send("build", "error", msg);
				await complete({ success: false, error: msg });
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

			// Resolve LLM client if specified (throws → 400 via the outer catch)
			resolveAgentLlmClient(rest.agent, (id) => c.var.orchestratorDb.getLlmClient(id));

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
			const upstream = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(AGENT_PROXY_TIMEOUT_MS) });
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
	})
	// ── Live workspace files (browse + edit) ─────────────────────────────────
	// All proxied to the agent container, which reads/writes the real /workspace
	// behind the shared sandbox guard. `proxyToAgent` forwards the `path` query
	// string and JSON bodies verbatim, so these stay one-liners. They only work
	// while the container is running (a stopped project returns 502) — the web
	// Files tab gates editing on the running state accordingly.
	.get("/:projectId/files/tree", async (c) => {
		return proxyToAgent(c, c.req.param("projectId"), "/api/files/tree");
	})
	.get("/:projectId/files/content", async (c) => {
		return proxyToAgent(c, c.req.param("projectId"), "/api/files/content");
	})
	.put("/:projectId/files/content", async (c) => {
		return proxyToAgent(c, c.req.param("projectId"), "/api/files/content");
	})
	.post("/:projectId/files/entry", async (c) => {
		return proxyToAgent(c, c.req.param("projectId"), "/api/files/entry");
	})
	.delete("/:projectId/files/entry", async (c) => {
		return proxyToAgent(c, c.req.param("projectId"), "/api/files/entry");
	})
	.post("/:projectId/files/move", async (c) => {
		return proxyToAgent(c, c.req.param("projectId"), "/api/files/move");
	})
	// ── Archive toggles ────────────────────────────────────────────────────
	// Written directly to the project DB (not proxied to the agent): `archived`
	// is a UI-only column the agent never touches, so this works whether the
	// container is running or stopped.
	.post("/:projectId/tasks/:taskId/archive", async (c) => {
		const { projectId, taskId } = c.req.param();
		const parsed = ArchiveBodySchema.safeParse(await c.req.json().catch(() => ({})));
		if (!parsed.success) return c.json({ error: "archived (boolean) is required" }, 400);
		try {
			const ok = await c.var.projectDatabaseManager.setTaskArchived(projectId, taskId, parsed.data.archived);
			if (!ok) return c.json({ error: "Not found" }, 404);
			return c.json({ success: true, archived: parsed.data.archived });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 500);
		}
	})
	.post("/:projectId/sessions/:sessionId/archive", async (c) => {
		const { projectId, sessionId } = c.req.param();
		const parsed = ArchiveBodySchema.safeParse(await c.req.json().catch(() => ({})));
		if (!parsed.success) return c.json({ error: "archived (boolean) is required" }, 400);
		try {
			const ok = await c.var.projectDatabaseManager.setSessionArchived(projectId, sessionId, parsed.data.archived);
			if (!ok) return c.json({ error: "Not found" }, 404);
			return c.json({ success: true, archived: parsed.data.archived });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 500);
		}
	})
	.post("/:projectId/reports/:reportId/archive", async (c) => {
		const { projectId, reportId } = c.req.param();
		const parsed = ArchiveBodySchema.safeParse(await c.req.json().catch(() => ({})));
		if (!parsed.success) return c.json({ error: "archived (boolean) is required" }, 400);
		try {
			const ok = await c.var.projectDatabaseManager.setReportArchived(projectId, reportId, parsed.data.archived);
			if (!ok) return c.json({ error: "Not found" }, 404);
			// Cascade to the report's linked vector-memory entry (report_<checkinId>)
			// so an archived report also leaves the agent's recall set. Best-effort:
			// the report row is already flipped; a memory-service hiccup or a report
			// with no memory entry (pre-dates the link) must not fail the request.
			await setMemoryArchived(projectId, `report_${reportId}`, parsed.data.archived).catch((err) =>
				console.error(`[projects] report memory archive cascade failed for ${reportId}:`, getErrorMessage(err))
			);
			return c.json({ success: true, archived: parsed.data.archived });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 500);
		}
	})
	// ── Bulk "archive finished" actions ──────────────────────────────────────
	// Archive every finished-but-not-yet-archived row in one DB write. "Finished"
	// mirrors the UI's grouping: tasks = done/cancelled, sessions =
	// completed/aborted/error, reports = check-ins whose session is finished.
	.post("/:projectId/tasks/archive-finished", async (c) => {
		const { projectId } = c.req.param();
		try {
			const count = await c.var.projectDatabaseManager.archiveFinishedTasks(projectId);
			return c.json({ success: true, count });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 500);
		}
	})
	.post("/:projectId/sessions/archive-finished", async (c) => {
		const { projectId } = c.req.param();
		try {
			const count = await c.var.projectDatabaseManager.archiveFinishedSessions(projectId);
			return c.json({ success: true, count });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 500);
		}
	})
	.post("/:projectId/reports/archive-finished", async (c) => {
		const { projectId } = c.req.param();
		try {
			const archivedIds = await c.var.projectDatabaseManager.archiveReportsOfFinishedSessions(projectId);
			// Cascade each archived check-in to its linked memory entry. Best-effort
			// and parallel — a memory miss for any single report must not fail the
			// batch, and the DB rows are already flipped.
			await Promise.allSettled(archivedIds.map((id) => setMemoryArchived(projectId, `report_${id}`, true)));
			return c.json({ success: true, count: archivedIds.length });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 500);
		}
	});
