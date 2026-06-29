import type { Question } from "@agent-manager/db/project-schema";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import type { Db } from "../db";
import type { CompactionCircuitBreaker, TokenWarningState } from "./token-budget";

export type AlwaysImproveMode = "yes" | "no" | "custom";
export type FreezeAskMode = "always" | "requiredOnly" | "onReportOnly" | "never";
export type FreezeReportMode = "always" | "never" | "custom";

/** Runtime configuration for an agent session. Mirrors the session DB columns. */
export type AgentStateConfig = {
	reportIntervalMins: number;
	stopThresholdMins: number;
	//
	alwaysImproveMode: AlwaysImproveMode;
	alwaysImproveScope: string | null;
	//
	freezeReportMode: FreezeReportMode;
	freezeReportCustomRule: string | null;
	freezeAskMode: FreezeAskMode;
	//
	compactThresholdTokens: number;
	stopThresholdTokens: number;
};

/** All mutable runtime state for a single agent session. */
export type AgentState = {
	db: Db;
	sessionId: string;
	client: Anthropic;
	config: AgentStateConfig;
	//
	messages: MessageParam[];
	systemPrompt: string;
	//
	startTime: number;
	lastReportTime: number | null;
	//
	stopped: boolean;
	circuitBreaker: CompactionCircuitBreaker;
	abortController: AbortController;
	//
	totalTokensConsumed: number;
	planMode: boolean;
	//
	lastApiInputTokens: number;
	lastUserMessageId: string | null;
	lastWarningState: TokenWarningState;
	pendingQuestions: Question[];
	//
	injectedMessage: string | null;
};
