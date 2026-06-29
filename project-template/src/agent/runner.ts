import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env";

import type { AgentState, AgentStateConfig } from "./runner-types";

import { handleQueueQuestion, handleSendGraph, handleSendReport, handleUrgentQuestion } from "./runner-utils/question-handlers";
import { buildSystemPrompt } from "./system-prompt";
import { CompactionCircuitBreaker } from "./token-budget";
import { buildToolTable } from "./tool-table";

/** All active agent sessions, keyed by session ID. */
export const runners = new Map<string, AgentState>();

type InitAgentParams = { config: AgentStateConfig; sessionId: string; db: import("../db").Db };

/** Create and fully initialize an Agent ready for run() or resume(). */
export function initAgent({ config, sessionId, db }: InitAgentParams): AgentState {
	const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL });
	const systemPrompt = buildSystemPrompt(config);

	// Build a partial agent first so we can pass it to buildToolTable handlers
	const agent: AgentState = {
		db,
		sessionId,
		client,
		config,
		//
		messages: [],
		systemPrompt,
		toolTable: {}, // filled in below
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

	// Wire the tool table after the agent exists so handlers can close over it
	agent.toolTable = buildToolTable(db, sessionId, {
		queueQuestion: (i) => handleQueueQuestion(agent, i),
		urgentQuestion: (i) => handleUrgentQuestion(agent, i),
		sendReport: (i) => handleSendReport(agent, i),
		sendGraph: (i) => handleSendGraph(agent, i),
	});

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
