import { insertMessage, updateSession } from "../../db";
import { sessionEmitter } from "../../emitter";
import type { AgentState } from "../types";

export function setStatus(
	agent: AgentState,
	status: "error" | "running" | "paused" | "compacting" | "completed" | "aborted"
): void {
	updateSession(agent.db, agent.sessionId, { status });
	sessionEmitter.emit(agent.sessionId, { type: "session_updated", data: { id: agent.sessionId, status } });
}

export function emitMessage(
	agent: AgentState,
	data: {
		id: string;
		role: "user" | "assistant" | "system";
		content: unknown;
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		error?: string;
		errorDetails?: string;
		/** Override for when the emitted copy must match a persisted row's
		 * timestamp (e.g. the compaction restart primer). */
		createdAt?: number;
	}
): void {
	sessionEmitter.emit(agent.sessionId, {
		type: "message",
		data: {
			id: data.id,
			sessionId: agent.sessionId,
			role: data.role,
			content: data.content,
			inputTokens: data.inputTokens ?? 0,
			outputTokens: data.outputTokens ?? 0,
			cacheReadTokens: data.cacheReadTokens ?? 0,
			cacheWriteTokens: data.cacheWriteTokens ?? 0,
			error: data.error,
			errorDetails: data.errorDetails,
			createdAt: data.createdAt ?? Date.now(),
		},
	});
}

/**
 * Persist a retry notice as a `system` timeline message and emit it over SSE.
 *
 * Called from callAnthropicApi's onRetry hook so a mid-session LLM retry is
 * visible in the transcript itself — not just as the ephemeral `error_recovered`
 * toast, which vanishes on reload and is invisible to anyone who wasn't watching
 * live. The row is `system`-role so rebuildMessagesFromDb skips it (line 582):
 * it shows in the timeline but never re-enters the Anthropic context, so it can
 * neither break user/assistant alternation nor get re-sent to the model.
 *
 * No `error` field is set: a retry is a recovery-in-progress, not a failure, so
 * it renders as a neutral orange system bubble rather than a red error box. The
 * terminal failure (retries exhausted) is recorded separately by recordFatalError.
 */
export function recordRetryNotice(agent: AgentState, text: string): void {
	const row = insertMessage(agent.db, {
		sessionId: agent.sessionId,
		role: "system",
		content: JSON.stringify([{ type: "text", text }]),
		createdAt: Date.now(),
	});
	emitMessage(agent, { id: row.id, role: "system", content: [{ type: "text", text }] });
}
