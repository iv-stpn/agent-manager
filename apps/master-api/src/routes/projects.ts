import { AgentConfigSchema, CreateProjectSchema, DiscordConfigSchema } from "@agent-manager/projects";
import { z } from "zod";

const UpdateSettingsSchema = z.object({
	discord: DiscordConfigSchema.optional(),
	agent: AgentConfigSchema.optional(),
});

import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { HonoMasterEnv } from "../types";

async function enrichProject(
	ctx: Context<HonoMasterEnv>,
	project: Awaited<ReturnType<Context<HonoMasterEnv>["var"]["manager"]["getProject"]>>
) {
	const { docker, projectDb } = ctx.var;
	const [dockerStatus, stats] = await Promise.all([docker.getProjectStatus(project.id), projectDb.getProjectStats(project.id)]);
	return { ...project, dockerStatus, stats };
}

async function proxyToAgent(c: Context<HonoMasterEnv>, projectId: string, upstreamPath: string): Promise<Response> {
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
	c: Context<HonoMasterEnv>,
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
export const projectsRouter = new Hono<HonoMasterEnv>()
	// Master event stream — one connection drives the whole project list without
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
			const { manager, docker, projectDb } = c.var;
			const project = await manager.getProject(projectId);
			const [dockerStatus, stats, logLines] = await Promise.all([
				docker.getProjectStatus(projectId),
				projectDb.getProjectStats(projectId),
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
			const stats = await c.var.projectDb.getProjectStats(projectId);
			return c.json({ stats });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
		}
	})
	// List sessions — falls back to DB when the agent server is stopped
	.get("/:projectId/sessions", async (c) => {
		const projectId = c.req.param("projectId");
		return proxyOrDb(c, projectId, "/api/sessions", async () =>
			c.json(maskActiveSessions(await c.var.projectDb.getSessions(projectId)))
		);
	})
	// All check-ins across every session — always DB-backed (reports tab)
	.get("/:projectId/reports", async (c) => {
		const projectId = c.req.param("projectId");
		return c.json(await c.var.projectDb.getReports(projectId));
	})
	// Update project settings (Discord + Anthropic config)
	.put("/:projectId/settings", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			const updates = UpdateSettingsSchema.parse(await c.req.json());
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
			const s = await c.var.projectDb.getSession(projectId, sessionId);
			return s ? c.json(maskActiveSession(s)) : c.json({ error: "Not found" }, 404);
		});
	})
	.get("/:projectId/sessions/:sessionId/messages", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return proxyOrDb(c, projectId, `/api/sessions/${sessionId}/messages`, async () =>
			c.json(await c.var.projectDb.getMessages(projectId, sessionId))
		);
	})
	.get("/:projectId/sessions/:sessionId/tools", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return proxyOrDb(c, projectId, `/api/sessions/${sessionId}/tools`, async () =>
			c.json(await c.var.projectDb.getToolCalls(projectId, sessionId))
		);
	})
	.get("/:projectId/sessions/:sessionId/checkins", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return proxyOrDb(c, projectId, `/api/sessions/${sessionId}/checkins`, async () =>
			c.json(await c.var.projectDb.getCheckins(projectId, sessionId))
		);
	})
	.get("/:projectId/sessions/:sessionId/questions", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return proxyOrDb(c, projectId, `/api/sessions/${sessionId}/questions`, async () =>
			c.json(await c.var.projectDb.getQuestions(projectId, sessionId))
		);
	})
	.get("/:projectId/sessions/:sessionId/compactions", async (c) => {
		const { projectId, sessionId } = c.req.param();
		return proxyOrDb(c, projectId, `/api/sessions/${sessionId}/compactions`, async () =>
			c.json(await c.var.projectDb.getCompactions(projectId, sessionId))
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
