import type { MessageParam } from "@anthropic-ai/sdk/resources";
import { insertMessage } from "../../db";
import type { AgentState } from "../types";
import { emitMessage } from "./status";

/** Push a message onto the list, merging same-role consecutive turns to keep
 * strict user/assistant alternation required by the Anthropic API. */
export function pushOrMergeMessage(messages: MessageParam[], role: "user" | "assistant", content: MessageParam["content"]): void {
	const last = messages[messages.length - 1];
	if (last?.role === role) {
		// Merge into the previous turn
		if (Array.isArray(last.content) && Array.isArray(content)) {
			last.content.push(...content);
		} else if (Array.isArray(last.content)) {
			last.content.push({ type: "text", text: String(content) });
		} else {
			last.content = `${last.content}\n\n${String(content)}`;
		}
	} else {
		messages.push({ role, content });
	}
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

/** Persist a user message, emit it, and append it to the live context. */
export function recordUserMessage(agent: AgentState, text: string): void {
	const message = insertMessage(agent.db, { sessionId: agent.sessionId, role: "user", content: text, createdAt: Date.now() });
	agent.lastUserMessageId = message.id;
	emitMessage(agent, { id: message.id, role: "user", content: text });

	pushOrMergeMessage(agent.messages, "user", text);
}
