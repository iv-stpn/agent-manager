/**
 * Resolve the project's LLM config (api key, base URL, model, small model) from
 * the orchestrator at session start/restart.
 *
 * The orchestrator resolves the project's selected LLM client live, so editing
 * a client in the library takes effect on the next session run — no compose
 * rewrite or container recreate needed. This is deliberately NOT cached for the
 * process lifetime: every session start/restart re-fetches so a mid-run client
 * edit is picked up by the next run. Falls back to the container's baked env
 * vars if the orchestrator is unreachable, so a session can still start.
 */

import type { AgentLlmConfig } from "../agent/types";
import { env } from "../env";
import { orchestratorHeaders } from "./orchestrator";

export type { AgentLlmConfig } from "../agent/types";

const ORCHESTRATOR_API_URL = env.ORCHESTRATOR_API_URL;
const PROJECT_ID = env.PROJECT_ID;

/** Baked env vars — the fallback when the orchestrator can't be reached. */
function envFallback(): AgentLlmConfig {
	return {
		apiKey: env.ANTHROPIC_API_KEY,
		baseUrl: env.ANTHROPIC_BASE_URL ?? "",
		model: env.ANTHROPIC_MODEL,
		smallModel: env.ANTHROPIC_SMALL_MODEL,
	};
}

/**
 * Fetch the resolved LLM config from the orchestrator. Falls back to baked env
 * vars for any field the orchestrator leaves empty (or if it's unreachable), so
 * the agent always has a usable model + key.
 */
export async function fetchAgentConfig(): Promise<AgentLlmConfig> {
	const fallback = envFallback();
	if (!PROJECT_ID) return fallback;

	try {
		const res = await fetch(`${ORCHESTRATOR_API_URL}/api/projects/${PROJECT_ID}/agent-config`, {
			headers: orchestratorHeaders(),
		});
		if (!res.ok) return fallback;
		const data = (await res.json()) as Partial<AgentLlmConfig>;
		return {
			apiKey: data.apiKey || fallback.apiKey,
			baseUrl: data.baseUrl || fallback.baseUrl,
			model: data.model || fallback.model,
			smallModel: data.smallModel || fallback.smallModel,
		};
	} catch {
		return fallback;
	}
}
