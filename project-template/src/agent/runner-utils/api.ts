import type Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { addTokens, getSession, insertMessage, updateMessageTokens } from "../../db";
import { sessionEmitter } from "../../emitter";
import { env } from "../../env";
import { BASE_MAX_TOKENS, ESCALATED_MAX_TOKENS } from "../token-budget";
import { AGENT_TOOLS } from "../tools/definitions";
import type { AgentState } from "../types";
import type { AgentError } from "../utils/errors";
import { withRetry } from "../utils/errors";
import { emitMessage } from "./status";

export async function callAnthropicApi(agent: AgentState): Promise<Anthropic.Messages.Message> {
	const makeRequest = async (maxTokens: number): Promise<Anthropic.Messages.Message> => {
		const stream = agent.client.messages.stream(
			{
				model: env.ANTHROPIC_MODEL,
				max_tokens: maxTokens,
				system: agent.systemPrompt,
				tools: AGENT_TOOLS,
				messages: agent.messages,
			},
			{ signal: agent.abortController.signal }
		);

		stream.on("text", (text) => {
			sessionEmitter.emit(agent.sessionId, { type: "text_delta", data: { text } });
		});

		return stream.finalMessage();
	};

	// Retry with exponential backoff for transient errors
	const response = await withRetry(() => makeRequest(BASE_MAX_TOKENS), {
		maxAttempts: 3,
		baseDelayMs: 1000,
		maxDelayMs: 10_000,
		signal: agent.abortController.signal,
		onRetry: (err: AgentError, attempt: number, nextDelayMs: number) => {
			console.log(`[Agent ${agent.sessionId}] API retry #${attempt}: ${err.category} — waiting ${Math.round(nextDelayMs)}ms`);
			sessionEmitter.emit(agent.sessionId, {
				type: "error_recovered",
				data: { attempt, error: err.message, nextRetryMs: Math.round(nextDelayMs) },
			});
		},
	});

	// Output token tier escalation: if truncated, retry with higher limit
	if (response.stop_reason === "max_tokens") {
		console.log(
			`[Agent ${agent.sessionId}] Response truncated at ${BASE_MAX_TOKENS} tokens, retrying with ${ESCALATED_MAX_TOKENS}`
		);
		return withRetry(() => makeRequest(ESCALATED_MAX_TOKENS), {
			maxAttempts: 2,
			baseDelayMs: 1000,
			maxDelayMs: 5000,
			signal: agent.abortController.signal,
		});
	}

	return response;
}

/** Record API response tokens in the DB and emit a token_update event. */
export function recordApiTokens(
	agent: AgentState,
	inputTokens: number,
	outputTokens: number,
	cacheReadTokens: number,
	cacheWriteTokens: number
): void {
	agent.lastApiInputTokens = inputTokens;

	// Attribute input/cache-write tokens to the user message; cache-read to the assistant
	if (agent.lastUserMessageId) {
		updateMessageTokens(agent.db, agent.lastUserMessageId, inputTokens, cacheWriteTokens);
		agent.lastUserMessageId = null;
	}

	agent.totalTokensConsumed += inputTokens + outputTokens;
	addTokens(agent.db, agent.sessionId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
	const totals = getSession(agent.db, agent.sessionId);
	sessionEmitter.emit(agent.sessionId, {
		type: "token_update",
		data: {
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			totalInputTokens: totals?.totalInputTokens ?? 0,
			totalOutputTokens: totals?.totalOutputTokens ?? 0,
			totalCacheReadTokens: totals?.totalCacheReadTokens ?? 0,
			totalCacheWriteTokens: totals?.totalCacheWriteTokens ?? 0,
		},
	});
}

/** Ask the small model to summarise the agent's recent progress. */
export async function requestSummary(agent: AgentState): Promise<string> {
	try {
		const transcript = agent.messages
			.slice(-10)
			.map((m) => {
				const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
				return `[${m.role.toUpperCase()}]: ${content.slice(0, 1000)}`;
			})
			.join("\n\n");

		const resp = await agent.client.messages.create({
			model: env.ANTHROPIC_SMALL_MODEL,
			max_tokens: 512,
			messages: [
				{
					role: "user",
					content: `Summarise your recent progress concisely (≤300 words). Focus on what you did, decisions made, and any blockers.\n\n${transcript}`,
				},
			],
		});

		return resp.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n");
	} catch {
		return "(summary unavailable)";
	}
}

/** Record assistant message in DB and emit it. Returns the message ID. */
export function recordAssistantMessage(
	agent: AgentState,
	content: unknown,
	outputTokens: number,
	cacheReadTokens: number
): string {
	const message = insertMessage(agent.db, {
		sessionId: agent.sessionId,
		role: "assistant",
		content: JSON.stringify(content),
		outputTokens,
		cacheReadTokens,
		createdAt: Date.now(),
	});
	emitMessage(agent, { id: message.id, role: "assistant", content, outputTokens, cacheReadTokens });
	return message.id;
}
