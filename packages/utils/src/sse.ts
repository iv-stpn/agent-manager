import type {
	CheckinRecord,
	CompactionRecord,
	MessageRecord,
	QuestionRecord,
	SessionRecord,
	ToolCallRecord,
} from "@agent-manager/projects";

// ── Payload types ─────────────────────────────────────────────────────────────

export type TokenUpdatePayload = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	tokensInputSinceCompaction: number;
	tokensOutputSinceCompaction: number;
	tokensCacheReadSinceCompaction: number;
	tokensCacheWriteSinceCompaction: number;
	contextTokens: number;
};

export type TokenWarningPayload = {
	state: "normal" | "warning" | "error" | "blocking";
	estimatedTokens: number;
	threshold: number;
	contextWindow: number;
};

export type PlanModePayload = {
	active: boolean;
	summary?: string;
};

export type ErrorRecoveredPayload = {
	attempt: number;
	error: string;
	nextRetryMs: number;
	// Error category from classifyApiError (e.g. "network", "server_crash").
	// Lets the UI distinguish a crashed-backend reboot (long fixed wait) from an
	// ordinary transient blip (short exponential backoff).
	category?: string;
	// Total attempts allowed for this error class, so the UI can show "#N of M".
	maxAttempts?: number;
};

export type CheckinStartedPayload = CheckinRecord & { questions: QuestionRecord[] };

export type TurnStartPayload = { turnNumber: number };
export type TurnEndPayload = { turnNumber: number; hadTools: boolean; stopReason?: string };
export type ThinkingDeltaPayload = { thinking: string };
export type ToolcallStartPayload = { id: string; name: string };
export type ToolcallDeltaPayload = { inputDelta: string };

// Session stream: per-session events emitted by runner.ts.
export type TaskPayload = {
	id: string;
	sessionId: string;
	text: string;
	status: string;
	metadata: string | null;
	createdAt: number;
	updatedAt: number;
};

export type SessionStreamEvent =
	| { type: "message"; data: MessageRecord }
	| { type: "text_delta"; data: { text: string } }
	| { type: "thinking_delta"; data: ThinkingDeltaPayload }
	| { type: "toolcall_start"; data: ToolcallStartPayload }
	| { type: "toolcall_delta"; data: ToolcallDeltaPayload }
	| { type: "turn_start"; data: TurnStartPayload }
	| { type: "turn_end"; data: TurnEndPayload }
	| { type: "tool_call"; data: ToolCallRecord }
	| { type: "token_update"; data: TokenUpdatePayload }
	| { type: "token_warning"; data: TokenWarningPayload }
	| { type: "plan_mode"; data: PlanModePayload }
	| { type: "error_recovered"; data: ErrorRecoveredPayload }
	| { type: "checkin_started"; data: CheckinStartedPayload }
	| { type: "checkin_completed"; data: CheckinRecord }
	| { type: "compaction"; data: CompactionRecord }
	| { type: "session_updated"; data: Pick<SessionRecord, "id" | "status"> }
	| { type: "task_created"; data: TaskPayload }
	| { type: "task_updated"; data: TaskPayload }
	| { type: "error"; data: unknown }
	| { type: "ping"; data: string };

// Global project stream serialises each event as `{ sessionId, ...data }`.
// See project-template/src/routes/stream.ts — globalStreamRouter.
type WithSession<T> = T & { sessionId: string };

// Project stream: session events + session-list events, all with sessionId.
export type ProjectStreamEvent =
	| { type: "sessions"; data: SessionRecord[] }
	| { type: "session_created"; data: WithSession<SessionRecord> }
	| { type: "session_updated"; data: WithSession<Pick<SessionRecord, "id" | "status">> }
	| { type: "message"; data: WithSession<MessageRecord> }
	| { type: "text_delta"; data: WithSession<{ text: string }> }
	| { type: "thinking_delta"; data: WithSession<ThinkingDeltaPayload> }
	| { type: "toolcall_start"; data: WithSession<ToolcallStartPayload> }
	| { type: "toolcall_delta"; data: WithSession<ToolcallDeltaPayload> }
	| { type: "turn_start"; data: WithSession<TurnStartPayload> }
	| { type: "turn_end"; data: WithSession<TurnEndPayload> }
	| { type: "tool_call"; data: WithSession<ToolCallRecord> }
	| { type: "token_update"; data: WithSession<TokenUpdatePayload> }
	| { type: "token_warning"; data: WithSession<TokenWarningPayload> }
	| { type: "plan_mode"; data: WithSession<PlanModePayload> }
	| { type: "error_recovered"; data: WithSession<ErrorRecoveredPayload> }
	| { type: "checkin_started"; data: WithSession<CheckinStartedPayload> }
	| { type: "checkin_completed"; data: WithSession<CheckinRecord> }
	| { type: "compaction"; data: WithSession<CompactionRecord> }
	| { type: "task_created"; data: TaskPayload }
	| { type: "task_updated"; data: TaskPayload }
	| { type: "error"; data: WithSession<{ message: string }> }
	| { type: "ping"; data: string };

// ── Event name arrays ─────────────────────────────────────────────────────────

export const SESSION_STREAM_EVENTS = [
	"message",
	"text_delta",
	"thinking_delta",
	"toolcall_start",
	"toolcall_delta",
	"turn_start",
	"turn_end",
	"tool_call",
	"token_update",
	"token_warning",
	"plan_mode",
	"error_recovered",
	"checkin_started",
	"checkin_completed",
	"compaction",
	"session_updated",
	"task_created",
	"task_updated",
	"error",
	"ping",
] as const satisfies ReadonlyArray<SessionStreamEvent["type"]>;

export const PROJECT_STREAM_EVENTS = [...SESSION_STREAM_EVENTS, "sessions", "session_created"] as const satisfies ReadonlyArray<
	ProjectStreamEvent["type"]
>;
