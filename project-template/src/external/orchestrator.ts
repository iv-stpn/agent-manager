import { env } from "../env";

/**
 * Headers for requests back to the orchestrator API. When the orchestrator
 * enforces a bearer token (`ORCHESTRATOR_API_TOKEN`), every call from a project
 * container must carry it — otherwise these requests 401. When the token is
 * empty (loopback-trust mode) this adds nothing, so behaviour is unchanged.
 */
export function orchestratorHeaders(extra: HeadersInit = {}): HeadersInit {
	const headers: Record<string, string> = { ...(extra as Record<string, string>) };
	if (env.ORCHESTRATOR_API_TOKEN) {
		headers.Authorization = `Bearer ${env.ORCHESTRATOR_API_TOKEN}`;
	}
	return headers;
}
