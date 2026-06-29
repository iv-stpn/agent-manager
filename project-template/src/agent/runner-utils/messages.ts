import { nanoid } from "nanoid";
import { insertMessage } from "../../db";
import type { AgentState } from "../runner-types";
import { emitMessage } from "./status";

export function saveMessage(
	agent: AgentState,
	role: "user" | "assistant" | "system",
	content: string,
	inputTokens: number,
	outputTokens: number,
	error?: string,
	errorDetails?: string,
	cacheReadTokens?: number,
	cacheWriteTokens?: number
): string {
	const id = nanoid();
	insertMessage(agent.db, {
		id,
		sessionId: agent.sessionId,
		role,
		content,
		inputTokens,
		outputTokens,
		cacheReadTokens: cacheReadTokens ?? 0,
		cacheWriteTokens: cacheWriteTokens ?? 0,
		error,
		errorDetails,
		createdAt: Date.now(),
	});
	return id;
}

/** Append text as a user turn: merge into the last user message (to keep
 * strict user/assistant alternation) or push a new one. */
export function appendUserText(agent: AgentState, text: string): void {
	const last = agent.messages[agent.messages.length - 1];
	if (last?.role === "user") {
		if (Array.isArray(last.content)) {
			last.content.push({ type: "text", text });
		} else {
			last.content = `${last.content}\n\n${text}`;
		}
	} else {
		agent.messages.push({ role: "user", content: text });
	}
}

/** Persist the system prompt once as a "system"-role message so it shows in the timeline.
 * The system prompt is sent to the API as a separate top-level param, so this row is for
 * display only and is skipped when rebuilding the Anthropic message history on resume. */
export function recordSystemPrompt(agent: AgentState): void {
	const id = saveMessage(agent, "system", agent.systemPrompt, 0, 0);
	emitMessage(agent, { id, role: "system", content: agent.systemPrompt });
}

/** Persist a user message, emit it, and append it to the live context. */
export function recordUserMessage(agent: AgentState, text: string): void {
	const id = saveMessage(agent, "user", text, 0, 0);
	agent.lastUserMessageId = id;
	emitMessage(agent, { id, role: "user", content: text });
	appendUserText(agent, text);
}
