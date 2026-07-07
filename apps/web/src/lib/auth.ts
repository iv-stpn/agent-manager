// Auth token for the orchestrator API. The orchestrator gates `/api/*` behind
// `ORCHESTRATOR_API_TOKEN` (see apps/api/src/middleware/auth.ts). When that token
// is configured, the web dashboard must attach it to every orchestrator-bound
// request or it gets a 401.
//
// The token is sourced from `VITE_ORCHESTRATOR_API_TOKEN` at build time. It ends
// up in the client bundle, so this is a loopback-trust convenience gate (keeping
// an accidentally-exposed port from being trivially driven), not a secret kept
// from the browser. When the env var is unset, these helpers are no-ops and the
// UI behaves exactly as before.
//
// Note: only orchestrator-bound calls (port 3100) need this. Session/project SSE
// streams connect straight to the per-project container port and are not gated
// by the orchestrator auth guard.

const AUTH_TOKEN: string | undefined = import.meta.env.VITE_ORCHESTRATOR_API_TOKEN || undefined;

/** Headers to merge into a fetch/hono request. Empty when no token is configured. */
export function authHeaders(): Record<string, string> {
	return AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};
}

/**
 * Append `?token=` to an SSE/EventSource URL. `EventSource` cannot set headers,
 * so the orchestrator accepts the token as a query param for those requests.
 * Returns the URL unchanged when no token is configured.
 */
export function withAuthToken(url: string): string {
	if (!AUTH_TOKEN) return url;
	const separator = url.includes("?") ? "&" : "?";
	return `${url}${separator}token=${encodeURIComponent(AUTH_TOKEN)}`;
}

/** The configured token, or undefined. Prefer the helpers above where possible. */
export const orchestratorApiToken = AUTH_TOKEN;
