/**
 * Single source of truth for environment variables.
 * Read once at startup — use `c.env` in Hono handlers or import `env` elsewhere.
 */
export const env = {
	ORCHESTRATOR_PORT: Number(process.env.ORCHESTRATOR_PORT ?? 3100),
	ORCHESTRATOR_WEB_URL: process.env.ORCHESTRATOR_WEB_URL ?? "http://localhost:3101",
	// Shared secret gating every /api/* route. When set, callers must send
	// `Authorization: Bearer <token>`. Left unset the API is open — acceptable
	// only when bound to loopback on a trusted host (see ORCHESTRATOR_HOST).
	ORCHESTRATOR_API_TOKEN: process.env.ORCHESTRATOR_API_TOKEN,
	// Interface the API binds to. Defaults to loopback so the Docker-controlling,
	// secret-holding API is never exposed on the LAN unless explicitly opened.
	ORCHESTRATOR_HOST: process.env.ORCHESTRATOR_HOST ?? "127.0.0.1",
	// When true, a graceful shutdown (SIGINT/SIGTERM) also stops every running
	// project container. Off by default: under `bun --watch` every code reload
	// sends SIGTERM, so a naive stop-all would kill all containers on each edit.
	// Turn on for a real deployment where the orchestrator owns the containers.
	ORCHESTRATOR_STOP_CONTAINERS_ON_SHUTDOWN: process.env.ORCHESTRATOR_STOP_CONTAINERS_ON_SHUTDOWN === "true",
	DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
	DISCORD_TOKEN: process.env.DISCORD_TOKEN,
	DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
	DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID,
	LANCEDB_URL: process.env.LANCEDB_URL ?? "http://localhost:3200",
	CHROMIUM_WS_URL: process.env.CHROMIUM_WS_URL ?? "ws://localhost:3201",
};
