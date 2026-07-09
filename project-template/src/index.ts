import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import z from "zod";
import { deleteTaskById, getTasks, initDb, stopRunningSessions, updateTaskFields } from "./db";
import { sessionEmitter } from "./emitter";
import { env } from "./env";
import { filesRouter } from "./routes/files";
import { sessionsRouter } from "./routes/sessions";
import { globalStreamRouter, streamRouter } from "./routes/stream";
import type { HonoProjectEnv } from "./types";

const UpdateTaskSchema = z.object({
	text: z.string().min(1).optional(),
	status: z.enum(["pending", "in_progress", "done", "cancelled"]).optional(),
});

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
	.put("/api/tasks/:id", async (c) => {
		const id = c.req.param("id");
		let body: z.infer<typeof UpdateTaskSchema>;
		try {
			body = UpdateTaskSchema.parse(await c.req.json());
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
		}
		const updated = updateTaskFields(db, id, body);
		if (!updated) return c.json({ error: "Not found" }, 404);
		// Tasks are project-wide and can be unassigned (sessionId null) — emit
		// unconditionally so the update still reaches the project-wide stream.
		sessionEmitter.emit(updated.sessionId ?? "", { type: "task_updated", data: updated });
		return c.json(updated);
	})
	.delete("/api/tasks/:id", (c) => {
		const deleted = deleteTaskById(db, c.req.param("id"));
		if (!deleted) return c.json({ error: "Not found" }, 404);
		return c.json({ success: true });
	})
	// Project-wide event stream (every session). api restreams this.
	.route("/api/stream", globalStreamRouter)
	.route("/api/files", filesRouter)
	.route("/api/sessions", sessionsRouter)
	.route("/api/sessions", streamRouter);

let server: ReturnType<typeof Bun.serve> | undefined;
try {
	server = Bun.serve({ port: env.PORT, fetch: app.fetch, idleTimeout: 0 });
	console.log(`[Server] API running on http://localhost:${env.PORT}`);
} catch (err) {
	console.error("[Server] Failed to bind:", err);
	process.exit(1);
}

// `docker compose down`/`restart` sends SIGTERM. In WAL mode, writes land in
// agent.db-wal and are only merged into agent.db by a checkpoint — without one,
// an abrupt SIGKILL (after Docker's stop grace period) can leave recent writes
// stuck in a WAL that a fresh connection on the next container start may not
// see as consistently as it should. Checkpointing and closing here makes a
// clean stop deterministic instead of racing the grace period.
let shuttingDown = false;
function shutdown(signal: string) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[Server] Received ${signal}, shutting down...`);
	server?.stop();
	try {
		db.$client.exec("PRAGMA wal_checkpoint(TRUNCATE);");
	} catch (err) {
		console.error("[Server] WAL checkpoint failed:", err);
	}
	db.$client.close();
	process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
