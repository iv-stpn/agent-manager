import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import type { Db } from "../db";
import type { CompactionCircuitBreaker, TokenWarningState } from "./token-budget";

type AlwaysImproveMode = "yes" | "no" | "custom";
type AwaitAskMode = "always" | "requiredOnly" | "onReportOnly" | "never";
type AwaitReportMode = "always" | "never" | "custom";

/** Runtime configuration for an agent session. Mirrors the session DB columns. */
export type AgentStateConfig = {
	reportIntervalMins: number;
	stopThresholdMins: number;
	//
	alwaysImproveMode: AlwaysImproveMode;
	alwaysImproveScope: string | null;
	//
	awaitReportMode: AwaitReportMode;
	awaitReportCustomRule: string | null;
	awaitAskMode: AwaitAskMode;
	//
	compactThresholdTokens: number;
	stopThresholdTokens: number;
};

/** Resolved LLM config for a session — fetched live from the orchestrator at
 * session start/restart so a client edit takes effect on the next run. */
export type AgentLlmConfig = {
	apiKey: string;
	baseUrl: string;
	model: string;
	smallModel: string;
};

/** All mutable runtime state for a single agent session. */
export type AgentState = {
	db: Db;
	sessionId: string;
	client: Anthropic;
	config: AgentStateConfig;
	/** Live-resolved model/key/baseUrl for this session's API calls. */
	llm: AgentLlmConfig;
	//
	messages: MessageParam[];
	systemPrompt: string;
	//
	startTime: number;
	lastReportTime: number | null;
	//
	stopped: boolean;
	/** Set by pauseAgent(): stop the loop after the in-flight message finishes, without aborting it. */
	pauseRequested: boolean;
	circuitBreaker: CompactionCircuitBreaker;
	abortController: AbortController;
	//
	totalTokensConsumed: number;
	planMode: boolean;
	//
	lastApiInputTokens: number;
	/** Output tokens from the last API call. Combined with lastApiInputTokens for the compaction threshold (input + output). */
	lastApiOutputTokens: number;
	lastUserMessageId: string | null;
	lastWarningState: TokenWarningState;
	//
	injectedMessage: string | null;
	/** Messages queued to be injected at the start of the next turn (non-disruptive, no abort). */
	steeringQueue: string[];
	/** Messages queued to continue the agent after it reaches end_turn. */
	followUpQueue: string[];
	/** Monotonically increasing turn counter, emitted with turn_start/turn_end. */
	turnNumber: number;
	/** Consecutive verification-failure rounds sent back to the agent; reset on pass. */
	verificationFailures: number;
};
