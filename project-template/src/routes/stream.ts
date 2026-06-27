import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getSession, listSessions } from "../db";
import { type AgentEvent, type GlobalAgentEvent, sessionEmitter } from "../emitter";
import type { HonoProjectEnv } from "../types";

// SSE stream for a single session
export const streamRouter = new Hono<HonoProjectEnv>().get("/:id/stream", (c) => {
	const id = c.req.param("id");
	const session = getSession(c.get("db"), id);
	if (!session) return c.json({ error: "Not found" }, 404);

	return streamSSE(c, async (stream) => {
		await stream.writeSSE({
			event: "session_updated",
			data: JSON.stringify(session),
		});

		const listener = async (event: AgentEvent) => {
			try {
				await stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) });
			} catch {
				// Client disconnected
			}
		};

		sessionEmitter.on(id, listener);

		const ping = setInterval(async () => {
			try {
				await stream.writeSSE({ event: "ping", data: String(Date.now()) });
			} catch {
				clearInterval(ping);
			}
		}, 15_000);

		stream.onAbort(() => {
			sessionEmitter.off(id, listener);
			clearInterval(ping);
		});

		await new Promise<void>((resolve) => {
			stream.onAbort(resolve);
		});
	});
});

// Project-wide SSE stream: fans in events from every session
export const globalStreamRouter = new Hono<HonoProjectEnv>().get("/", (c) => {
	return streamSSE(c, async (stream) => {
		await stream.writeSSE({ event: "sessions", data: JSON.stringify(listSessions(c.get("db"))) });

		const listener = async (event: GlobalAgentEvent) => {
			try {
				const { sessionId, type, data } = event;
				await stream.writeSSE({
					event: type,
					data: JSON.stringify({ sessionId, ...(data as Record<string, unknown>) }),
				});
			} catch {
				// Client disconnected
			}
		};

		sessionEmitter.onGlobal(listener);

		const ping = setInterval(async () => {
			try {
				await stream.writeSSE({ event: "ping", data: String(Date.now()) });
			} catch {
				clearInterval(ping);
			}
		}, 15_000);

		stream.onAbort(() => {
			sessionEmitter.offGlobal(listener);
			clearInterval(ping);
		});

		await new Promise<void>((resolve) => {
			stream.onAbort(resolve);
		});
	});
});
