import { updateSession } from "../../db";
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
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		error?: string;
		errorDetails?: string;
	}
): void {
	sessionEmitter.emit(agent.sessionId, {
		type: "message",
		data: {
			id: data.id,
			sessionId: agent.sessionId,
			role: data.role,
			content: data.content,
			inputTokens: 0,
			outputTokens: data.outputTokens ?? 0,
			cacheReadTokens: data.cacheReadTokens ?? 0,
			cacheWriteTokens: data.cacheWriteTokens ?? 0,
			error: data.error,
			errorDetails: data.errorDetails,
			createdAt: Date.now(),
		},
	});
}
