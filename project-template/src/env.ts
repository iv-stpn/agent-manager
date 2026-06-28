/**
 * Single source of truth for environment variables.
 * Read once at startup — use `c.env` in Hono handlers or import `env` elsewhere.
 */
export const env = {
	PORT: Number(process.env.PORT ?? 3010),
	DATABASE_PATH: process.env.DATABASE_PATH ?? "../data/agent.db",
	HOST_API_URL: process.env.HOST_API_URL ?? "http://host.docker.internal:3100",
	PROJECT_ID: process.env.PROJECT_ID ?? "",
	ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
	ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
	ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
	ANTHROPIC_SMALL_MODEL: process.env.ANTHROPIC_SMALL_MODEL ?? "claude-haiku-4-5-20251001",
	WORKSPACE_PATH: process.env.WORKSPACE_PATH ?? "/workspace",
	AGENT_MAX_CONTEXT_TOKENS: process.env.AGENT_MAX_CONTEXT_TOKENS,
} as const;

export type Env = typeof env;
