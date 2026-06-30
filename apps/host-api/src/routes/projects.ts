import {
	type CheckinRecord,
	type CompactionRecord,
	CreateProjectSchema,
	type MessageRecord,
	ProjectContextSchema,
	type QuestionRecord,
	type SessionRecord,
	type ToolCallRecord,
	UpdateSettingsSchema,
} from "@agent-manager/projects";

import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getErrorMessage } from "../lib/errors";
import type { HonoHostEnv } from "../types";

export type WorkspaceFolderStatus = "not_found" | "empty" | "not_empty" | "not_directory";

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
		const upstream = await fetch(url, { method, headers, ...(body !== undefined && { body }) });
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

/** Fetch JSON from the agent server; returns null if unreachable (502). */
async function fetchAgentJson<T>(c: Context<HonoHostEnv>, projectId: string, upstreamPath: string): Promise<T | null> {
	const resp = await proxyToAgent(c, projectId, upstreamPath);
	if (resp.status === 502) return null;
	return resp.json();
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
	// Create new project
	.post("/", async (c) => {
		try {
			const body = await c.req.json();
			const input = CreateProjectSchema.parse(body);

			// Resolve LLM client if specified
			if (input.agent?.clientId) {
				const client = c.var.hostDb.getLlmClient(input.agent.clientId);
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
			await manager.deleteProject(projectId);
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
				await manager.deleteProject(projectId);
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
	// List sessions — falls back to DB when the agent server is stopped
	.get("/:projectId/sessions", async (c) => {
		const projectId = c.req.param("projectId");
		const upstream = await fetchAgentJson<SessionRecord[]>(c, projectId, "/api/sessions");
		if (upstream) return c.json(upstream);
		return c.json(maskActiveSessions(await c.var.projectDatabaseManager.getSessions(projectId)));
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
				const client = c.var.hostDb.getLlmClient(rest.agent.clientId);
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
	// text here (only the host has the library DB), renders the markdown the
	// container reads, and persists both via the manager.
	.put("/:projectId/context", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			const { techStackIds, guidelineIds, instructions } = ProjectContextSchema.parse(await c.req.json());

			const techStacks = techStackIds.map((id) => c.var.hostDb.getTechStack(id)).filter((t): t is NonNullable<typeof t> => !!t);
			const guidelines = guidelineIds.map((id) => c.var.hostDb.getGuideline(id)).filter((g): g is NonNullable<typeof g> => !!g);

			const context = await c.var.manager.setProjectContext(
				projectId,
				{ techStackIds: techStacks.map((t) => t.id), guidelineIds: guidelines.map((g) => g.id), instructions }
			);
			return c.json({ context });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 400);
		}
	})
	// Resolve per-project context to full objects (tech stacks + guidelines + instructions).
	// Called by the agent container at session start to build its system prompt.
	.get("/:projectId/context/resolved", async (c) => {
		try {
			const projectId = c.req.param("projectId");
			const { techStackIds, guidelineIds, instructions } = await c.var.manager.getProjectContext(projectId);

			const techStacks = techStackIds.map((id) => c.var.hostDb.getTechStack(id)).filter((t): t is NonNullable<typeof t> => !!t);
			const guidelines = guidelineIds.map((id) => c.var.hostDb.getGuideline(id)).filter((g): g is NonNullable<typeof g> => !!g);

			return c.json({ techStacks, guidelines, instructions });
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
		const upstream = await fetchAgentJson<SessionRecord>(c, projectId, `/api/sessions/${sessionId}`);
		if (upstream) return c.json(upstream);

		const s = await c.var.projectDatabaseManager.getSession(projectId, sessionId);
		return s ? c.json(maskActiveSession(s)) : c.json({ error: "Not found" }, 404);
	})
	.get("/:projectId/sessions/:sessionId/messages", async (c) => {
		const { projectId, sessionId } = c.req.param();
		const upstream = await fetchAgentJson<MessageRecord[]>(c, projectId, `/api/sessions/${sessionId}/messages`);
		if (upstream) return c.json(upstream);
		return c.json(await c.var.projectDatabaseManager.getMessages(projectId, sessionId));
	})
	.get("/:projectId/sessions/:sessionId/tools", async (c) => {
		const { projectId, sessionId } = c.req.param();
		const upstream = await fetchAgentJson<ToolCallRecord[]>(c, projectId, `/api/sessions/${sessionId}/tools`);
		if (upstream) return c.json(upstream);
		return c.json(await c.var.projectDatabaseManager.getToolCalls(projectId, sessionId));
	})
	.get("/:projectId/sessions/:sessionId/checkins", async (c) => {
		const { projectId, sessionId } = c.req.param();
		const upstream = await fetchAgentJson<CheckinRecord[]>(c, projectId, `/api/sessions/${sessionId}/checkins`);
		if (upstream) return c.json(upstream);
		return c.json(await c.var.projectDatabaseManager.getCheckins(projectId, sessionId));
	})
	.get("/:projectId/sessions/:sessionId/questions", async (c) => {
		const { projectId, sessionId } = c.req.param();
		const upstream = await fetchAgentJson<QuestionRecord[]>(c, projectId, `/api/sessions/${sessionId}/questions`);
		if (upstream) return c.json(upstream);
		return c.json(await c.var.projectDatabaseManager.getQuestions(projectId, sessionId));
	})
	.get("/:projectId/sessions/:sessionId/compactions", async (c) => {
		const { projectId, sessionId } = c.req.param();
		const upstream = await fetchAgentJson<CompactionRecord[]>(c, projectId, `/api/sessions/${sessionId}/compactions`);
		if (upstream) return c.json(upstream);
		return c.json(await c.var.projectDatabaseManager.getCompactions(projectId, sessionId));
	})
	.get("/:projectId/tasks", async (c) => {
		const { projectId } = c.req.param();
		const sessionId = c.req.query("sessionId");
		const query = sessionId ? `?sessionId=${sessionId}` : "";
		const upstream = await fetchAgentJson<unknown[]>(c, projectId, `/api/tasks${query}`);
		if (upstream) return c.json(upstream);
		return c.json([]);
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
	});
