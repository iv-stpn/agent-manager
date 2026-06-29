import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env";
import { buildSystemPrompt } from "./system-prompt";
import { CompactionCircuitBreaker } from "./token-budget";
import type { AgentState, AgentStateConfig } from "./types";

/** All active agent sessions, keyed by session ID. */
export const runners = new Map<string, AgentState>();

type InitAgentParams = { config: AgentStateConfig; sessionId: string; db: import("../db").Db };

/** Create and fully initialize an Agent ready for run() or resume(). */
export function initAgent({ config, sessionId, db }: InitAgentParams): AgentState {
	const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL });
	const systemPrompt = buildSystemPrompt(config);

	const agent: AgentState = {
		db,
		sessionId,
		client,
		config,
		//
		messages: [],
		systemPrompt,
		//
		startTime: Date.now(),
		lastReportTime: null,
		//
		stopped: false,
		circuitBreaker: new CompactionCircuitBreaker(),
		abortController: new AbortController(),
		//
		totalTokensConsumed: 0,
		planMode: false,
		//
		lastApiInputTokens: 0,
		lastUserMessageId: null,
		lastWarningState: "normal",
		pendingQuestions: [],
		//
		injectedMessage: null,
	};

	return agent;
}

// ── Standalone functional API ──────────────────────────────────────────────

/** Stop the agent's current loop immediately. */
export function stopAgent(agent: AgentState): void {
	agent.stopped = true;
	agent.abortController.abort("stop");
}

/** Inject a user message into a running agent's context, interrupting the current API call. */
export function interjectAgent(agent: AgentState, text: string): void {
	agent.injectedMessage = text;
	agent.abortController.abort("interject");
}
