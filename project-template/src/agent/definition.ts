import Anthropic from "@anthropic-ai/sdk";
import type { AgentLlmConfig } from "../external/agent-config";
import type { ResolvedProjectContext } from "../external/context";
import { buildSystemPrompt } from "./system-prompt";
import { CompactionCircuitBreaker } from "./token-budget";
import type { AgentState, AgentStateConfig } from "./types";

/** All active agent sessions, keyed by session ID. */
export const runners = new Map<string, AgentState>();

type InitAgentParams = {
	config: AgentStateConfig;
	llm: AgentLlmConfig;
	sessionId: string;
	db: import("../db").Db;
	context?: ResolvedProjectContext;
	isFirstSession?: boolean;
};

/** Create and fully initialize an Agent ready for run() or resume(). */
export function initAgent({ config, llm, sessionId, db, context, isFirstSession }: InitAgentParams): AgentState {
	const client = new Anthropic({ apiKey: llm.apiKey, baseURL: llm.baseUrl || undefined });
	const systemPrompt = buildSystemPrompt(config, { context, isFirstSession });

	const agent: AgentState = {
		db,
		sessionId,
		client,
		config,
		llm,
		//
		messages: [],
		systemPrompt,
		//
		startTime: Date.now(),
		lastReportTime: null,
		//
		stopped: false,
		pauseRequested: false,
		circuitBreaker: new CompactionCircuitBreaker(),
		abortController: new AbortController(),
		//
		totalTokensConsumed: 0,
		planMode: false,
		//
		lastApiInputTokens: 0,
		lastApiOutputTokens: 0,
		lastUserMessageId: null,
		lastWarningState: "normal",
		pendingQuestions: [],
		//
		injectedMessage: null,
		steeringQueue: [],
		followUpQueue: [],
		turnNumber: 0,
	};

	return agent;
}

// ── Standalone functional API ──────────────────────────────────────────────

/** Stop the agent's current loop immediately. */
export function stopAgent(agent: AgentState): void {
	agent.stopped = true;
	agent.abortController.abort("stop");
}

/**
 * Request a graceful stop: the agent finishes the message it's currently
 * generating (and any tool calls that message triggers) without aborting the
 * in-flight request, then stops before starting its next turn.
 */
export function pauseAgent(agent: AgentState): void {
	agent.pauseRequested = true;
}

/** Inject a user message into a running agent's context, interrupting the current API call. */
export function interjectAgent(agent: AgentState, text: string): void {
	// The user is actively steering the agent — a pending graceful pause no
	// longer applies, otherwise the injected message would be queued but the
	// loop would exit before ever sending it to the API.
	agent.pauseRequested = false;
	agent.injectedMessage = text;
	agent.abortController.abort("interject");
}

/**
 * Queue a user message to be injected at the start of the next turn.
 * Unlike interjectAgent, this does NOT abort the current API call — the message
 * is picked up non-disruptively before the next LLM request.
 */
export function steerAgent(agent: AgentState, text: string): void {
	agent.pauseRequested = false;
	agent.steeringQueue.push(text);
}

/**
 * Queue a user message to be sent after the agent reaches end_turn.
 * If the agent would stop, it instead processes this message and continues.
 */
export function queueFollowUp(agent: AgentState, text: string): void {
	agent.pauseRequested = false;
	agent.followUpQueue.push(text);
}
