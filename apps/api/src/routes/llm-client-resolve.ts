import type { LlmClient } from "../db";

/**
 * The subset of an agent config that carries LLM connection details. Properties
 * are `T | undefined` (not just optional) to match the zod-inferred agent types
 * under `exactOptionalPropertyTypes`, which distinguishes absent from `undefined`.
 */
export interface ResolvableAgent {
	clientId?: string | undefined;
	anthropicApiKey?: string | undefined;
	anthropicBaseUrl?: string | undefined;
	model?: string | undefined;
}

/**
 * Fill an agent's Anthropic connection fields from its selected LLM client.
 *
 * The stored client record is the live source of truth, but any value the
 * caller set explicitly wins — fields are only backfilled when blank. A no-op
 * when the agent has no `clientId`. Throws when a `clientId` is set but no such
 * client exists; every call site sits inside a try/catch that maps the throw to
 * a 400 (or an SSE `complete` error frame), preserving the prior behavior.
 *
 * `getClient` is injected (rather than the DB) so this stays a pure function.
 */
export function resolveAgentLlmClient<T extends ResolvableAgent>(
	agent: T | undefined,
	getClient: (id: string) => LlmClient | undefined
): void {
	if (!agent?.clientId) return;
	const client = getClient(agent.clientId);
	if (!client) throw new Error("LLM client not found");
	agent.anthropicApiKey = agent.anthropicApiKey || client.apiKey;
	agent.anthropicBaseUrl = agent.anthropicBaseUrl || client.baseUrl;
	agent.model = agent.model || client.model;
}
