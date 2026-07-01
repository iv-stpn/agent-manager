import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { getTasks, initDb, stopRunningSessions } from "./db";
import { env } from "./env";
import { sessionsRouter } from "./routes/sessions";
import { globalStreamRouter, streamRouter } from "./routes/stream";
import type { HonoProjectEnv } from "./types";

// Initialize DB (creates tables if needed)
const db = initDb(env.DATABASE_PATH);

// Any session marked "running" or "compacting" at startup was orphaned by a hard shutdown — stop them now.
stopRunningSessions(db);

const app = new Hono<HonoProjectEnv>();

app.use("*", logger());
app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], allowHeaders: ["*"] }));
app.use("*", (c, next) => {
	c.set("db", db);
	return next();
});

app
	.get("/", (c) => c.text(`Hello from project ${env.PROJECT_NAME}!`))
	.get("/health", (c) => c.json({ ok: true, ts: Date.now() }))
	.get("/api/tasks", (c) => {
		const sessionId = c.req.query("sessionId");
		const rows = getTasks(db, sessionId || undefined);
		return c.json(rows);
	})
	// Project-wide event stream (every session). orchestrator-api restreams this.
	.route("/api/stream", globalStreamRouter)
	.route("/api/sessions", sessionsRouter)
	.route("/api/sessions", streamRouter);

try {
	Bun.serve({ port: env.PORT, fetch: app.fetch, idleTimeout: 0 });
	console.log(`[Server] API running on http://localhost:${env.PORT}`);
} catch (err) {
	console.error("[Server] Failed to bind:", err);
	process.exit(1);
}
