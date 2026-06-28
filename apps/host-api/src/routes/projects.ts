import { CreateProjectSchema, UpdateSettingsSchema } from "@agent-manager/projects";

import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { HonoHostEnv } from "../types";

async function enrichProject(
	ctx: Context<HonoHostEnv>,
	project: Awaited<ReturnType<Context<HonoHostEnv>["var"]["manager"]["getProject"]>>
) {
	const { docker, projectDatabaseManager } = ctx.var;
	const [dockerStatus, stats] = await Promise.all([
		docker.getProjectStatus(project.id),
		projectDatabaseManager.getProjectStats(project.id),
	]);
	return { ...project, dockerStatus, stats };
}

async function proxyToAgent(c: Context<HonoHostEnv>, projectId: string, upstreamPath: string): Promise<Response> {
	const project = await c.var.manager.getProject(projectId);
	const qs = c.req.query();
	const search = new URLSearchParams(qs).toString();
	const url = `http://localhost:${project.ports.server}${upstreamPath}${search ? `?${search}` : ""}`;

	const headers = new Headers();
	const ct = c.req.header("content-type");
	if (ct) headers.set("content-type", ct);

	const method = c.req.method;
	const body = method === "GET" || method === "HEAD" ? undefined : await c.req.text();

	try {
		const upstream = await fetch(url, { method, headers, body });
		const respHeaders = new Headers();
		for (const key of ["content-type", "cache-control", "connection", "x-accel-buffering"]) {
			const v = upstream.headers.get(key);
			if (v) respHeaders.set(key, v);
		}
		return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
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

async function proxyOrDb(
	c: Context<HonoHostEnv>,
	projectId: string,
	upstreamPath: string,
	dbFallback: () => Response | Promise<Response>
): Promise<Response> {
	const resp = await proxyToAgent(c, projectId, upstreamPath);
	if (resp.status !== 502) return resp;
	return dbFallback();
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
export const projectsRouter = new Hono<HonoHostEnv>()
	// Main event stream — one connection drives the whole project list without
	// polling. Registered before "/:projectId" so the static path wins.
	.get("/events", (c) => {
		const origin = c.req.header("Origin");
		if (origin) c.header("Access-Control-Allow-Origin", origin);

		return streamSSE(c, async (stream) => {
			const { manager, hub } = c.var;
			try {
				const projects = await manager.listProjects();
				const enriched = await Promise.all(projects.map((p) => enrichProject(c, p)));
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
			const enriched = await Promise.all(projects.map((p) => enrichProject(c, p)));
			return c.json({ projects: enriched });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
		}
	})
	// Check workspace path status (exists? empty?)
	.post("/check-path", async (c) => {
		try {
			const { path: targetPath } = await c.req.json<{ path: string }>();
			if (!targetPath) return c.json({ error: "path is required" }, 400);
			const { resolve } = await import("node:path");
			const { stat, readdir } = await import("node:fs/promises");
			const { homedir } = await import("node:os");
			// Expand ~ to the user's home directory
			const expanded = targetPath.startsWith("~/") || targetPath === "~" ? targetPath.replace("~", homedir()) : targetPath;
			const resolved = resolve(expanded);
			try {
				const s = await stat(resolved);
				if (!s.isDirectory()) return c.json({ status: "not_directory", path: resolved });
				const entries = await readdir(resolved);
				return c.json({ status: entries.length > 0 ? "not_empty" : "empty", path: resolved });
			} catch (e: any) {
				if (e.code === "ENOENT") return c.json({ status: "not_found", path: resolved });
				throw e;
			}
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
		}
	})
	// Create new project
	.post("/", async (c) => {
		try {
			const body = await c.req.json();
			const input = CreateProjectSchema.parse(body);
			const project = await c.var.manager.createProject(input);
			return c.json({ project }, 201);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 400);
		}
	})
	.get("/:projectId", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			const { manager, docker, projectDatabaseManager } = c.var;
			const project = await manager.getProject(projectId);
			const [dockerStatus, stats, logLines] = await Promise.all([
				docker.getProjectStatus(projectId),
				projectDatabaseManager.getProjectStats(projectId),
				docker.getProjectLogs(projectId, "agent").then(
					(text) => (text.trim() ? text.trim().split("\n").length : 0),
					() => null
				),
			]);
			return c.json({ project: { ...project, dockerStatus, stats, logLines } });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 404);
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
			await manager.deleteProject(projectId);
			hub.projectStopped(projectId);
			return c.json({ success: true });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 400);
		}
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
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
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
				let healthy = false;
				for (let i = 0; i < 30; i++) {
					const s = await docker.getProjectStatus(projectId);
					if (s.running) {
						healthy = true;
						break;
					}
					await Bun.sleep(1000);
				}
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
				const msg = error instanceof Error ? error.message : "Unknown error";
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
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
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
				const msg = error instanceof Error ? error.message : "Unknown error";
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
				let healthy = false;
				for (let i = 0; i < 30; i++) {
					const s = await docker.getProjectStatus(projectId);
					if (s.running) {
						healthy = true;
						break;
					}
					await Bun.sleep(1000);
				}
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
				const msg = error instanceof Error ? error.message : "Unknown error";
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
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
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
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
		}
	})
	// Build project
	.post("/:projectId/build", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			await c.var.docker.buildProject(projectId);
			return c.json({ success: true });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
		}
	})
	// Get project database stats
	.get("/:projectId/stats", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			const stats = await c.var.projectDatabaseManager.getProjectStats(projectId);
			return c.json({ stats });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
		}
	})
	// List sessions — falls back to DB when the agent server is stopped
	.get("/:projectId/sessions", async (c) => {
		const projectId = c.req.param("projectId");
		return proxyOrDb(c, projectId, "/api/sessions", async () =>
			c.json(maskActiveSessions(await c.var.projectDatabaseManager.getSessions(projectId)))
		);
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
			const updates: Parameters<typeof c.var.manager.updateProject>[1] = {
				...rest,
				...(ports?.server && { ports: { server: ports.server } }),
			};
			const project = await c.var.manager.updateProject(projectId, updates);
			return c.json({ project });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 400);
		}
	})
	// ---- Agent proxy: forward live agent endpoints to the project's server ----
	.post("/:projectId/sessions", async (c) => {
		const projectId = c.req.param("projectId");
		return proxyToAgent(c, projectId, "/api/sessions");
	})
	.get("/:projectId/sessions/:sessionId", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return proxyOrDb(c, projectId, `/api/sessions/${sessionId}`, async () => {
			const s = await c.var.projectDatabaseManager.getSession(projectId, sessionId);
			return s ? c.json(maskActiveSession(s)) : c.json({ error: "Not found" }, 404);
		});
	})
	.get("/:projectId/sessions/:sessionId/messages", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return proxyOrDb(c, projectId, `/api/sessions/${sessionId}/messages`, async () =>
			c.json(await c.var.projectDatabaseManager.getMessages(projectId, sessionId))
		);
	})
	.get("/:projectId/sessions/:sessionId/tools", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return proxyOrDb(c, projectId, `/api/sessions/${sessionId}/tools`, async () =>
			c.json(await c.var.projectDatabaseManager.getToolCalls(projectId, sessionId))
		);
	})
	.get("/:projectId/sessions/:sessionId/checkins", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return proxyOrDb(c, projectId, `/api/sessions/${sessionId}/checkins`, async () =>
			c.json(await c.var.projectDatabaseManager.getCheckins(projectId, sessionId))
		);
	})
	.get("/:projectId/sessions/:sessionId/questions", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return proxyOrDb(c, projectId, `/api/sessions/${sessionId}/questions`, async () =>
			c.json(await c.var.projectDatabaseManager.getQuestions(projectId, sessionId))
		);
	})
	.get("/:projectId/sessions/:sessionId/compactions", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return proxyOrDb(c, projectId, `/api/sessions/${sessionId}/compactions`, async () =>
			c.json(await c.var.projectDatabaseManager.getCompactions(projectId, sessionId))
		);
	})
	.post("/:projectId/sessions/:sessionId/stop", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return proxyToAgent(c, projectId, `/api/sessions/${sessionId}/stop`);
	})
	.post("/:projectId/sessions/:sessionId/message", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return proxyToAgent(c, projectId, `/api/sessions/${sessionId}/message`);
	});
