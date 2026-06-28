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
};

export type CheckinStartedPayload = CheckinRecord & { questions: QuestionRecord[] };

// Session stream: per-session events emitted by runner.ts.
export type SessionStreamEvent =
	| { type: "message"; data: MessageRecord }
	| { type: "text_delta"; data: { text: string } }
	| { type: "tool_call"; data: ToolCallRecord }
	| { type: "token_update"; data: TokenUpdatePayload }
	| { type: "token_warning"; data: TokenWarningPayload }
	| { type: "plan_mode"; data: PlanModePayload }
	| { type: "error_recovered"; data: ErrorRecoveredPayload }
	| { type: "checkin_started"; data: CheckinStartedPayload }
	| { type: "checkin_completed"; data: CheckinRecord }
	| { type: "compaction"; data: CompactionRecord }
	| { type: "session_updated"; data: Pick<SessionRecord, "id" | "status"> }
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
	| { type: "tool_call"; data: WithSession<ToolCallRecord> }
	| { type: "token_update"; data: WithSession<TokenUpdatePayload> }
	| { type: "token_warning"; data: WithSession<TokenWarningPayload> }
	| { type: "plan_mode"; data: WithSession<PlanModePayload> }
	| { type: "error_recovered"; data: WithSession<ErrorRecoveredPayload> }
	| { type: "checkin_started"; data: WithSession<CheckinStartedPayload> }
	| { type: "checkin_completed"; data: WithSession<CheckinRecord> }
	| { type: "compaction"; data: WithSession<CompactionRecord> }
	| { type: "error"; data: WithSession<{ message: string }> }
	| { type: "ping"; data: string };

// ── Event name arrays ─────────────────────────────────────────────────────────

export const SESSION_STREAM_EVENTS = [
	"message",
	"text_delta",
	"tool_call",
	"token_update",
	"token_warning",
	"plan_mode",
	"error_recovered",
	"checkin_started",
	"checkin_completed",
	"compaction",
	"session_updated",
	"error",
	"ping",
] as const satisfies ReadonlyArray<SessionStreamEvent["type"]>;

export const PROJECT_STREAM_EVENTS = [...SESSION_STREAM_EVENTS, "sessions", "session_created"] as const satisfies ReadonlyArray<
	ProjectStreamEvent["type"]
>;

// ── Type guards ───────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

export function isMessageRecord(v: unknown): v is MessageRecord {
	return isObj(v) && typeof v.id === "string" && typeof v.role === "string" && typeof v.sessionId === "string";
}

export function isToolCallRecord(v: unknown): v is ToolCallRecord {
	return isObj(v) && typeof v.id === "string" && typeof v.toolName === "string";
}

export function isTokenUpdatePayload(v: unknown): v is TokenUpdatePayload {
	return isObj(v) && typeof v.inputTokens === "number" && typeof v.totalInputTokens === "number";
}

export function isCheckinRecord(v: unknown): v is CheckinRecord {
	return isObj(v) && typeof v.id === "string" && typeof v.trigger === "string" && typeof v.status === "string";
}

export function isCheckinStartedPayload(v: unknown): v is CheckinStartedPayload {
	return isCheckinRecord(v) && Array.isArray((v as CheckinStartedPayload).questions);
}

export function isCompactionRecord(v: unknown): v is CompactionRecord {
	return isObj(v) && typeof v.id === "string" && typeof v.messagesBefore === "number";
}

export function isSessionRecord(v: unknown): v is SessionRecord {
	return isObj(v) && typeof v.id === "string" && typeof v.status === "string" && typeof v.task === "string";
}

// ── Stream util ───────────────────────────────────────────────────────────────

// All event stream logic lives in event-stream.ts
