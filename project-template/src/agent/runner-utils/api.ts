import { extractTextContent } from "@agent-manager/utils/blocks";
import type Anthropic from "@anthropic-ai/sdk";
import { addTokens, getSession, insertMessage, updateMessageTokens } from "../../db";
import { sessionEmitter } from "../../emitter";
import { BASE_MAX_TOKENS, ESCALATED_MAX_TOKENS } from "../token-budget";
import { AGENT_TOOLS } from "../tools/definitions";
import type { AgentState } from "../types";
import { type AgentError, LLM_CALL_RETRY, withRetry } from "../utils/errors";
import { emitMessage, recordRetryNotice } from "./status";

/**
 * Fire the SSE `error_recovered` event AND persist a `system` timeline message
 * for one retry attempt. Shared by both makeRequest passes (base + escalated
 * max_tokens) so every LLM retry — network blip or crashed-backend reboot — is
 * visible live (toast) and durably in the transcript (survives reload).
 */
function reportRetry(agent: AgentState, err: AgentError, attempt: number, nextDelayMs: number, maxAttempts: number): void {
	const waitSec = Math.round(nextDelayMs / 1000);
	const waitLabel = waitSec >= 60 ? `${Math.round(waitSec / 60)}m` : `${waitSec}s`;
	const reason =
		err.category === "server_crash" ? "LLM server connection lost (socket closed)" : `LLM call failed (${err.category})`;
	console.log(
		`[Agent ${agent.sessionId}] API retry #${attempt}/${maxAttempts}: ${err.category} — waiting ${Math.round(nextDelayMs)}ms`
	);

	recordRetryNotice(agent, `⚠️ ${reason}. Retrying (attempt ${attempt} of ${maxAttempts}) in ${waitLabel}…\n${err.message}`);

	sessionEmitter.emit(agent.sessionId, {
		type: "error_recovered",
		data: { attempt, error: err.message, nextRetryMs: Math.round(nextDelayMs), category: err.category, maxAttempts },
	});
}

export async function callAnthropicApi(agent: AgentState): Promise<Anthropic.Messages.Message> {
	const makeRequest = async (maxTokens: number): Promise<Anthropic.Messages.Message> => {
		const stream = agent.client.messages.stream(
			{
				model: agent.llm.model,
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

		// Extended thinking deltas (fires only when thinking is enabled on the model)
		stream.on("thinking", (thinking) => {
			sessionEmitter.emit(agent.sessionId, { type: "thinking_delta", data: { thinking } });
		});

		// Tool call streaming: emit toolcall_start when a tool_use block begins,
		// and toolcall_delta for each partial JSON input chunk.
		stream.on("streamEvent", (event) => {
			if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
				sessionEmitter.emit(agent.sessionId, {
					type: "toolcall_start",
					data: { id: event.content_block.id, name: event.content_block.name },
				});
			} else if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
				sessionEmitter.emit(agent.sessionId, {
					type: "toolcall_delta",
					data: { inputDelta: event.delta.partial_json },
				});
			}
		});

		return stream.finalMessage();
	};

	// Retry with exponential backoff for transient errors
	const response = await withRetry(() => makeRequest(BASE_MAX_TOKENS), {
		...LLM_CALL_RETRY,
		signal: agent.abortController.signal,
		onRetry: (err, attempt, nextDelayMs, maxAttempts) => reportRetry(agent, err, attempt, nextDelayMs, maxAttempts),
	});

	// Output token tier escalation: if truncated, retry with higher limit
	if (response.stop_reason === "max_tokens") {
		console.log(
			`[Agent ${agent.sessionId}] Response truncated at ${BASE_MAX_TOKENS} tokens, retrying with ${ESCALATED_MAX_TOKENS}`
		);

		// The truncated first attempt was still billed by the API. Record its usage
		// against the session totals before discarding its content — otherwise every
		// escalation silently drops a full BASE_MAX_TOKENS worth of billed output
		// (and its input) from the accounting. Only billing totals are affected here;
		// the loop derives its live context estimate from the returned (escalated)
		// response's usage via recordApiTokens.
		const firstUsage = response.usage;
		addTokens(
			agent.db,
			agent.sessionId,
			firstUsage.input_tokens,
			firstUsage.output_tokens,
			firstUsage.cache_read_input_tokens ?? 0,
			firstUsage.cache_creation_input_tokens ?? 0
		);

		// The truncated attempt already streamed its partial text/thinking/tool-call
		// deltas to the client. Reset the live streaming buffers (via turn_start)
		// before re-streaming so the escalated response replaces the partial output
		// rather than appending to it — without this the UI shows the truncated text
		// followed by the full text, concatenated.
		sessionEmitter.emit(agent.sessionId, { type: "turn_start", data: { turnNumber: agent.turnNumber } });

		return withRetry(() => makeRequest(ESCALATED_MAX_TOKENS), {
			...LLM_CALL_RETRY,
			signal: agent.abortController.signal,
			onRetry: (err, attempt, nextDelayMs, maxAttempts) => reportRetry(agent, err, attempt, nextDelayMs, maxAttempts),
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
	// Total context occupying the window = uncached input + cache reads + cache writes.
	// With prompt caching, `inputTokens` alone is only the uncached delta (new user
	// message + response that didn't hit cache), while the bulk of the context lives
	// in `cacheReadTokens`. If we only tracked `inputTokens`, compaction would never
	// fire because the estimate would be 5k when the real context is 630k+.
	agent.lastApiInputTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
	// Output tokens occupy the same context window (max_tokens reserves space
	// for them). The compaction threshold is input + output, so track this
	// alongside the input estimate above.
	agent.lastApiOutputTokens = outputTokens;

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
			tokensInputSinceCompaction: totals?.tokensInputSinceCompaction ?? 0,
			tokensOutputSinceCompaction: totals?.tokensOutputSinceCompaction ?? 0,
			tokensCacheReadSinceCompaction: totals?.tokensCacheReadSinceCompaction ?? 0,
			tokensCacheWriteSinceCompaction: totals?.tokensCacheWriteSinceCompaction ?? 0,
			contextTokens: totals?.contextTokens ?? 0,
		},
	});
}

/** Ask the small model to summarise the agent's recent progress. */
export async function requestSummary(agent: AgentState): Promise<string> {
	try {
		const transcript = agent.messages
			.slice(-10)
			.map((message) => {
				const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
				return `[${message.role.toUpperCase()}]: ${content.slice(0, 1000)}`;
			})
			.join("\n\n");

		const resp = await withRetry(
			() =>
				agent.client.messages.create({
					model: agent.llm.smallModel,
					// Room for thinking models to finish their thinking block and
					// still emit text — at 512 they hit max_tokens mid-thought and
					// the response contains no text at all.
					max_tokens: 4096,
					messages: [
						{
							role: "user",
							content: `Summarise your recent progress concisely (≤300 words). Focus on what you did, decisions made, and any blockers.\n\n${transcript}`,
						},
					],
				}),
			LLM_CALL_RETRY
		);

		const text = extractTextContent(resp.content).trim();
		return text || "(summary unavailable)";
	} catch (err) {
		console.error(`[Agent ${agent.sessionId}] requestSummary call failed:`, err);
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
