/**
 * Single source of truth for environment variables.
 * Read once at startup — use `c.env` in Hono handlers or import `env` elsewhere.
 */
export const env = {
	HOST_PORT: Number(process.env.HOST_PORT ?? 3100),
	HOST_WEB_URL: process.env.HOST_WEB_URL ?? "http://localhost:3101",
	DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
	DISCORD_TOKEN: process.env.DISCORD_TOKEN,
	DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
	DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID,
	LANCEDB_URL: process.env.LANCEDB_URL ?? "http://localhost:3200",
	CHROMIUM_WS_URL: process.env.CHROMIUM_WS_URL ?? "ws://localhost:3201",
};
