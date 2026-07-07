import type { MiddlewareHandler } from "hono";
import { env } from "../env";
import type { HonoOrchestratorEnv } from "../types";

/**
 * Bearer-token gate for the orchestrator API.
 *
 * The orchestrator can create/delete projects, run `docker`, hand out LLM API
 * keys and recursively clear host directories, so an open port is remote
 * control of the host. When `ORCHESTRATOR_API_TOKEN` is set, every `/api/*`
 * request must carry `Authorization: Bearer <token>` (or `?token=` for
 * EventSource, which cannot set headers). `/` and `/health` stay open so
 * liveness probes don't need the secret.
 *
 * The token is optional so existing loopback-only setups keep working, but we
 * warn loudly at startup when it's unset (see index.ts) — an unauthenticated
 * orchestrator should be a deliberate choice, not an accident.
 */

/** Constant-time string compare to avoid leaking the token via timing. */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}

function extractToken(authHeader: string | undefined, queryToken: string | undefined): string | undefined {
	if (authHeader) {
		const match = /^Bearer\s+(.+)$/i.exec(authHeader);
		if (match?.[1]) return match[1].trim();
	}
	// EventSource / <img> style clients can't set headers — allow ?token= as a
	// fallback. These requests should be same-origin over loopback anyway.
	return queryToken ?? undefined;
}

export const authGuard: MiddlewareHandler<HonoOrchestratorEnv> = async (c, next) => {
	const expected = env.ORCHESTRATOR_API_TOKEN;
	// No token configured → auth disabled (loopback-trust mode). The startup
	// warning in index.ts makes this visible.
	if (!expected) return next();

	const provided = extractToken(c.req.header("Authorization"), c.req.query("token"));
	if (!provided || !safeEqual(provided, expected)) {
		return c.json({ error: "unauthorized" }, 401);
	}
	return next();
};
