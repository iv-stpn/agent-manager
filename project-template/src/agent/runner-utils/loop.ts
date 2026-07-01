import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import { nanoid } from "nanoid";
import { getMessages, getSession, insertCompaction, insertMessage, updateSession } from "../../db";
import { sessionEmitter } from "../../emitter";
import { env } from "../../env";
import { fetchProjectContext } from "../../external/context";
import { compactMessages, estimateTokens } from "../context";
import { buildSystemPrompt } from "../system-prompt";
import { calculateTokenWarningState, MODEL_CONTEXT_WINDOW } from "../token-budget";
import type { AgentState } from "../types";
import { extractTextContent } from "../utils/content";
import { classifyApiError } from "../utils/errors";
import { bootstrapWorkspace, buildStartupContext } from "../workspace";
import { callAnthropicApi, recordApiTokens, recordAssistantMessage, requestSummary } from "./api";
import { buildImproveMessage, flushQuestionsToDiscord, handleStopThreshold, handleTotalTimeout, triggerReport } from "./reports";
import { emitMessage, setStatus } from "./status";
import { executeTools } from "./tools";

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

// ── Context compaction ─────────────────────────────────────────────────────────────
export async function doCompaction(agent: AgentState): Promise<void> {
	const before = agent.messages.length;
	const estBefore = agent.lastApiInputTokens || estimateTokens(agent.messages);

	// Surface a dedicated "compacting" state while the (potentially slow)
	// summarization round-trip runs, then restore "running".
	setStatus(agent, "compacting");

	let compacted: import("@anthropic-ai/sdk/resources").MessageParam[];
	let summary: string;
	try {
		({ messages: compacted, summary } = await compactMessages(agent.messages, agent.client));
		agent.circuitBreaker.recordSuccess();
	} catch (err) {
		agent.circuitBreaker.recordFailure();
		console.error(`[Agent ${agent.sessionId}] Compaction failed (attempt ${agent.circuitBreaker.failures}):`, err);
		// Restore running state (finally) and continue without compacting
		return;
	} finally {
		setStatus(agent, "running");
	}

	agent.messages = compacted;
	// Reset — message array is restructured after compaction
	agent.lastApiInputTokens = 0;
	const estAfter = estimateTokens(agent.messages);
	console.log(
		`[Agent ${agent.sessionId}] Compacted context: ${before} → ${compacted.length} messages (${estBefore} → ${estAfter} est. tokens)`
	);

	// Record the compaction in its own timeline — entirely separate from
	// check-ins. A compaction is purely a token-threshold-driven context
	// summarization; it never blocks the agent or asks the user anything.
	const compactionId = nanoid();
	const compaction = insertCompaction(agent.db, {
		id: compactionId,
		sessionId: agent.sessionId,
		messagesBefore: before,
		messagesAfter: agent.messages.length,
		tokensBefore: estBefore,
		tokensAfter: estAfter,
		thresholdTokens: agent.config.compactThresholdTokens,
		summary,
		createdAt: Date.now(),
	});
	sessionEmitter.emit(agent.sessionId, {
		type: "compaction",
		data: compaction,
	});

	// Send a check-in with the compaction summary so the user sees
	// the generated memory markdown.
	await triggerReport(
		agent,
		{
			title: "🗜 Context Compacted",
			sections: [
				{ title: "Memory Summary", content: summary },
				{
					title: "Stats",
					content: `Messages: ${before} → ${agent.messages.length}\nTokens: ${estBefore.toLocaleString()} → ${estAfter.toLocaleString()}`,
				},
			],
		},
		"compaction"
	);
}

// ── Main loop ──────────────────────────────────────────────────────────────

export async function runLoop(agent: AgentState): Promise<void> {
	try {
		// ── Main agent loop ────────────────────────────────────────────────
		while (!agent.stopped && !agent.pauseRequested) {
			// Refresh abort controller for this iteration (controllers can't be reused)
			agent.abortController = new AbortController();

			// Total timeout check
			if (Date.now() - agent.startTime >= agent.config.stopThresholdMins * 60_000) {
				await handleTotalTimeout(agent);
				break;
			}

			// Stop threshold check
			if (agent.config.stopThresholdTokens > 0 && agent.totalTokensConsumed >= agent.config.stopThresholdTokens) {
				await handleStopThreshold(agent);
				break;
			}

			// Auto-compact context if too large (using circuit breaker)
			const estTokens = agent.lastApiInputTokens || estimateTokens(agent.messages);

			// Emit token warning state changes
			const warningInfo = calculateTokenWarningState(estTokens);
			if (warningInfo.state !== agent.lastWarningState) {
				agent.lastWarningState = warningInfo.state;
				sessionEmitter.emit(agent.sessionId, {
					type: "token_warning",
					data: {
						state: warningInfo.state,
						estimatedTokens: estTokens,
						threshold: warningInfo.autoCompactThreshold,
						contextWindow: MODEL_CONTEXT_WINDOW,
					},
				});
			}

			// Effective threshold = configured value clamped to the window-safe ceiling.
			const effectiveCompactThreshold =
				agent.config.compactThresholdTokens > 0
					? Math.min(agent.config.compactThresholdTokens, warningInfo.autoCompactThreshold)
					: warningInfo.autoCompactThreshold;

			console.log("[Compaction]", {
				state: warningInfo.state,
				configuredThreshold: agent.config.compactThresholdTokens,
				effectiveThreshold: effectiveCompactThreshold,
				ceiling: warningInfo.autoCompactThreshold,
				tokens: estTokens,
				circuitBreakerOpen: agent.circuitBreaker.isOpen,
			});

			if (agent.circuitBreaker.shouldAutoCompact(estTokens, agent.config.compactThresholdTokens)) {
				await doCompaction(agent);
			}

			// Auto-report interval
			const reportIntervalMs = agent.config.reportIntervalMins * 60_000;
			if (reportIntervalMs > 0 && Date.now() - (agent.lastReportTime ?? agent.startTime) >= reportIntervalMs) {
				const summary = await requestSummary(agent);
				await triggerReport(agent, { title: "⏱ Scheduled Report", sections: [{ title: "Progress", content: summary }] }, "timer");
				agent.lastReportTime = Date.now();
			}

			// ── Drain steering queue (non-disruptive message injection) ────
			// Pick up any messages queued via steerAgent() before calling the LLM.
			while (agent.steeringQueue.length > 0) {
				const text = agent.steeringQueue.shift();
				if (text === undefined) break;
				const steered = insertMessage(agent.db, {
					sessionId: agent.sessionId,
					role: "user",
					content: text,
					createdAt: Date.now(),
				});
				agent.lastUserMessageId = steered.id;
				emitMessage(agent, { id: steered.id, role: "user", content: text });
				pushOrMergeMessage(agent.messages, "user", text);
			}

			// ── Turn start ─────────────────────────────────────────────────
			agent.turnNumber += 1;
			const currentTurn = agent.turnNumber;
			sessionEmitter.emit(agent.sessionId, { type: "turn_start", data: { turnNumber: currentTurn } });

			let response: Anthropic.Messages.Message;
			try {
				response = await callAnthropicApi(agent);
			} catch (err) {
				// A clean abort (stop or interject) should not surface as an error.
				// The signal is the source of truth: the SDK's APIUserAbortError (thrown
				// when its own fetch is aborted) keeps `.name === "Error"` rather than
				// "AbortError", so checking the error name alone misses it.
				if (agent.abortController.signal.aborted) {
					if (agent.stopped) break;
					// Interject: merge user message into last context turn
					if (agent.injectedMessage) {
						const text = agent.injectedMessage;
						agent.injectedMessage = null;
						const injected = insertMessage(agent.db, {
							sessionId: agent.sessionId,
							role: "user",
							content: text,
							createdAt: Date.now(),
						});
						agent.lastUserMessageId = injected.id;
						emitMessage(agent, { id: injected.id, role: "user", content: text });
						pushOrMergeMessage(agent.messages, "user", text);
					}
					continue;
				}
				throw err;
			}

			const inputTokens = response.usage.input_tokens;
			const outputTokens = response.usage.output_tokens;
			const cacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
			const cacheWriteTokens = response.usage.cache_creation_input_tokens ?? 0;

			recordApiTokens(agent, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

			const messageId = recordAssistantMessage(agent, response.content, outputTokens, cacheReadTokens);

			if (response.stop_reason === "end_turn") {
				const finalText = extractTextContent(response.content);

				// Always-improve: continue instead of stopping
				if (agent.config.alwaysImproveMode !== "no") {
					sessionEmitter.emit(agent.sessionId, {
						type: "turn_end",
						data: { turnNumber: currentTurn, hadTools: false, stopReason: "end_turn" },
					});
					const continueMessage = buildImproveMessage(agent);
					agent.messages.push({ role: "assistant", content: response.content });
					agent.messages.push({ role: "user", content: continueMessage });
					const message = insertMessage(agent.db, {
						sessionId: agent.sessionId,
						role: "user",
						content: continueMessage,
						inputTokens: 0,
						outputTokens: 0,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						createdAt: Date.now(),
					});
					agent.lastUserMessageId = message.id;
					continue;
				}

				// ── Follow-up queue: continue if caller queued messages ────
				// Check before the completion report so we don't await/complete prematurely.
				if (agent.followUpQueue.length > 0) {
					sessionEmitter.emit(agent.sessionId, {
						type: "turn_end",
						data: { turnNumber: currentTurn, hadTools: false, stopReason: "end_turn" },
					});
					agent.messages.push({ role: "assistant", content: response.content });
					while (agent.followUpQueue.length > 0) {
						const text = agent.followUpQueue.shift();
						if (text === undefined) break;
						const followUp = insertMessage(agent.db, {
							sessionId: agent.sessionId,
							role: "user",
							content: text,
							createdAt: Date.now(),
						});
						agent.lastUserMessageId = followUp.id;
						emitMessage(agent, { id: followUp.id, role: "user", content: text });
						pushOrMergeMessage(agent.messages, "user", text);
					}
					continue;
				}

				// Completion await follows await_report_mode (NOT a forced await):
				//   always → await for a final check-in
				//   never  → post the report and complete without blocking
				//   custom → shouldAwait's default (await) unless the agent
				//            already steered this turn via a continue report
				await triggerReport(
					agent,
					{ title: "✅ Task Complete", sections: [{ title: "Final Summary", content: finalText }] },
					"completion"
				);
				sessionEmitter.emit(agent.sessionId, {
					type: "turn_end",
					data: { turnNumber: currentTurn, hadTools: false, stopReason: "end_turn" },
				});
				setStatus(agent, "completed");
				break;
			}

			if (response.stop_reason === "tool_use") {
				const toolBlocks = response.content.filter((b) => b.type === "tool_use");
				agent.messages.push({ role: "assistant", content: response.content });

				const toolResults = await executeTools(agent, toolBlocks, messageId);
				agent.messages.push({ role: "user", content: toolResults });

				const message = insertMessage(agent.db, {
					sessionId: agent.sessionId,
					role: "user",
					content: JSON.stringify(toolResults),
					inputTokens,
					cacheReadTokens,
					createdAt: Date.now(),
				});
				agent.lastUserMessageId = message.id;
				// Push the tool-result turn over SSE so live viewers see it without a
				// refetch. Without this emit, the message is persisted but invisible
				// until the next full reload — the intermittent "missing tool results".
				emitMessage(agent, { id: message.id, role: "user", content: toolResults, inputTokens, cacheReadTokens });

				// In 'always' mode: flush pending questions after each tool batch
				if (agent.config.awaitAskMode === "always" && agent.pendingQuestions.length > 0) {
					await flushQuestionsToDiscord(agent);
				}

				sessionEmitter.emit(agent.sessionId, {
					type: "turn_end",
					data: { turnNumber: currentTurn, hadTools: true },
				});
			}
		}

		// A pending pause (pauseAgent()) lets the loop fall out of the `while`
		// condition naturally rather than via one of the `break`s above, none of
		// which run when the exit is a graceful pause — finalize the status here.
		// Other exits (completed, timed out, token budget) already set a terminal
		// status, so only step in if the session is still mid-flight.
		if (agent.pauseRequested) {
			const current = getSession(agent.db, agent.sessionId);
			if (current?.status === "running" || current?.status === "compacting") {
				setStatus(agent, "aborted");
			}
		}
	} catch (err) {
		const classified = classifyApiError(err);
		console.error(`[Agent ${agent.sessionId}] Fatal error [${classified.category}]:`, classified.message);

		// Save error message to database
		const errorStack = err instanceof Error ? err.stack : undefined;
		const errorData = {
			error: classified.message,
			content: JSON.stringify([{ type: "text", text: `An error occurred during execution: ${classified.category}` }]),
			...(errorStack !== undefined && { errorDetails: errorStack }),
		};

		const message = insertMessage(agent.db, {
			sessionId: agent.sessionId,
			role: "assistant",
			content: errorData.content,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			error: errorData.error,
			errorDetails: errorData.errorDetails,
			createdAt: Date.now(),
		});

		sessionEmitter.emit(agent.sessionId, {
			type: "message",
			data: {
				id: message.id,
				sessionId: agent.sessionId,
				role: "assistant",
				content: errorData.content,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				error: errorData.error,
				errorDetails: errorData.errorDetails,
				createdAt: Date.now(),
			},
		});

		// Any error reaching this fatal catch block is a real failure — retries
		// (if the error was retryable) are already exhausted inside callAnthropicApi/withRetry.
		updateSession(agent.db, agent.sessionId, { status: "error" });
		sessionEmitter.emit(agent.sessionId, { type: "error", data: { message: errorData.error } });
	}
}

// ── Public entry points ────────────────────────────────────────────────────

const WORKSPACE = env.WORKSPACE_PATH;

export async function run(agent: AgentState, task: string): Promise<void> {
	// ── Bootstrap workspace ────────────────────────────────────────────
	const { isNewProject, isFirstSession } = await bootstrapWorkspace(WORKSPACE);

	// On first session, rebuild system prompt without recall instructions
	if (isFirstSession) {
		const context = await fetchProjectContext();
		agent.systemPrompt = buildSystemPrompt(agent.config, { isFirstSession: true, context });
	}

	// ── Build startup context ──────────────────────────────────────────
	// Persist the system prompt as a display-only "system" row (skipped when rebuilding
	// Anthropic message history on resume — the prompt is sent as a separate API param).
	const systemMessage = insertMessage(agent.db, {
		sessionId: agent.sessionId,
		role: "system",
		content: agent.systemPrompt,
		createdAt: Date.now(),
	});
	emitMessage(agent, { id: systemMessage.id, role: "system", content: agent.systemPrompt });

	const startupMsgs = await buildStartupContext(task, isNewProject);
	agent.messages = startupMsgs.map((content) => ({ role: "user", content }));
	for (const content of startupMsgs) {
		insertMessage(agent.db, { sessionId: agent.sessionId, role: "user", content, createdAt: Date.now() });
	}

	await runLoop(agent);
}

// Rebuild the Anthropic message history from the DB transcript, merging
// consecutive same-role rows (consecutive user rows can occur after an
// interrupted interject). System-prompt rows are display-only — the prompt is
// sent as a separate API param. Rows recording a failed attempt (assistant
// messages with `error` set) are dropped so a retried/restarted turn doesn't
// replay its own failure back to the model.
function rebuildMessagesFromDb(agent: AgentState): MessageParam[] {
	const rows = getMessages(agent.db, agent.sessionId);
	const messages: MessageParam[] = [];
	for (const row of rows) {
		if (row.role === "system") continue;
		if (row.role === "assistant" && row.error) continue;
		let content: unknown;
		try {
			const parsed = JSON.parse(row.content);
			content = Array.isArray(parsed) ? parsed : row.content;
		} catch {
			content = row.content;
		}
		const role = row.role as "user" | "assistant";
		pushOrMergeMessage(messages, role, content as MessageParam["content"]);
	}
	return messages;
}

export async function resume(agent: AgentState, message: string): Promise<void> {
	const session = getSession(agent.db, agent.sessionId);
	if (!session) throw new Error(`Session ${agent.sessionId} not found`);

	agent.stopped = false;
	agent.startTime = Date.now();
	agent.lastReportTime = Date.now();

	agent.messages = rebuildMessagesFromDb(agent);

	// Append and persist the new user message
	const userMsg = insertMessage(agent.db, { sessionId: agent.sessionId, role: "user", content: message, createdAt: Date.now() });
	agent.lastUserMessageId = userMsg.id;
	emitMessage(agent, { id: userMsg.id, role: "user", content: message });
	pushOrMergeMessage(agent.messages, "user", message);

	setStatus(agent, "running");

	await runLoop(agent);
}

/** Re-attempt the last unanswered user turn after a session was aborted or
 * errored out, without requiring the caller to supply a new message. */
export async function restart(agent: AgentState): Promise<void> {
	const session = getSession(agent.db, agent.sessionId);
	if (!session) throw new Error(`Session ${agent.sessionId} not found`);

	agent.stopped = false;
	agent.startTime = Date.now();
	agent.lastReportTime = Date.now();

	agent.messages = rebuildMessagesFromDb(agent);

	setStatus(agent, "running");

	await runLoop(agent);
}
