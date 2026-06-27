import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { initDb, stopRunningSessions } from "./db";
import { startDiscordBot } from "./discord/bot";
import { sessionsRouter } from "./routes/sessions";
import { globalStreamRouter, streamRouter } from "./routes/stream";
import type { HonoProjectEnv } from "./types";

const PORT = Number(process.env.PORT ?? 3010);

// Initialize DB (creates tables if needed)
const db = initDb(process.env.DATABASE_PATH ?? "../data/agent.db");

// Any session marked "running" or "compacting" at startup was orphaned by a hard shutdown — stop them now.
stopRunningSessions(db);

const app = new Hono<HonoProjectEnv>();

app.use("*", logger());
app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], allowHeaders: ["*"] }));
app.use("*", (c, next) => {
	c.set("db", db);
	return next();
});

app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

app.route("/api/sessions", sessionsRouter);
app.route("/api/sessions", streamRouter);
// Project-wide event stream (every session). master-api restreams this.
app.route("/api/stream", globalStreamRouter);

// Start the HTTP server first so health checks pass immediately, then bring up
// the Discord bot. The bot talks to Discord over its outbound gateway socket —
// it never needs a public/inbound URL, so there is no tunnel to manage.
try {
	Bun.serve({ port: PORT, fetch: app.fetch });
	console.log(`[Server] API running on http://localhost:${PORT}`);
} catch (err) {
	console.error("[Server] Failed to bind:", err);
	process.exit(1);
}

const discordToken = process.env.DISCORD_TOKEN;
if (discordToken) {
	startDiscordBot(discordToken).catch((err) => console.error("[Discord] Failed to start:", err));
} else {
	console.warn("[Discord] DISCORD_TOKEN not set — bot disabled");
}
