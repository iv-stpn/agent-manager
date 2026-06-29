import type Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { getMessages, getSession, insertCompaction, updateSession } from "../../db";
import { sessionEmitter } from "../../emitter";
import { env } from "../../env";
import { compactMessages, estimateTokens } from "../context";
import type { AgentState } from "../runner-types";
import { calculateTokenWarningState, MODEL_CONTEXT_WINDOW } from "../token-budget";
import { classifyApiError } from "../utils/errors";
import { bootstrapWorkspace, buildStartupContext } from "../workspace";
import { callAnthropicApi, recordApiTokens, recordAssistantMessage, requestSummary } from "./api";
import { recordSystemPrompt, recordUserMessage, saveMessage } from "./messages";
import { buildImproveMessage, flushQuestionsToDiscord, handleStopThreshold, handleTotalTimeout, triggerReport } from "./reports";
import { setStatus } from "./status";
import { executeTools } from "./tools";

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
		while (!agent.stopped) {
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

			console.log("[Compaction]", {
				state: warningInfo.state,
				threshold: warningInfo.autoCompactThreshold,
				tokens: estTokens,
				circuitBreakerOpen: agent.circuitBreaker.isOpen,
			});

			if (agent.circuitBreaker.shouldAutoCompact(estTokens)) {
				await doCompaction(agent);
			}

			// Auto-report interval
			const reportIntervalMs = agent.config.reportIntervalMins * 60_000;
			if (reportIntervalMs > 0 && Date.now() - (agent.lastReportTime ?? agent.startTime) >= reportIntervalMs) {
				const summary = await requestSummary(agent);
				await triggerReport(agent, { title: "⏱ Scheduled Report", sections: [{ title: "Progress", content: summary }] }, "timer");
				agent.lastReportTime = Date.now();
			}

			let response: Anthropic.Messages.Message;
			try {
				response = await callAnthropicApi(agent);
			} catch (err) {
				// A clean abort (stop or interject) should not surface as an error
				if (err instanceof Error && err.name === "AbortError") {
					if (agent.stopped) break;
					// Interject: merge user message into last context turn
					if (agent.injectedMessage) {
						const text = agent.injectedMessage;
						agent.injectedMessage = null;
						recordUserMessage(agent, text);
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

			const msgId = recordAssistantMessage(agent, response.content, outputTokens, cacheReadTokens);

			if (response.stop_reason === "end_turn") {
				const finalText = response.content
					.filter((b) => b.type === "text")
					.map((b) => b.text)
					.join("\n");

				// Always-improve: continue instead of stopping
				if (agent.config.alwaysImproveMode !== "no") {
					const continueMessage = buildImproveMessage(agent);
					agent.messages.push({ role: "assistant", content: response.content });
					agent.messages.push({ role: "user", content: continueMessage });
					agent.lastUserMessageId = saveMessage(agent, "user", continueMessage, 0, 0);
					continue;
				}

				// Completion freeze follows freeze_report_mode (NOT a forced freeze):
				//   always → freeze for a final check-in
				//   never  → post the report and complete without blocking
				//   custom → shouldFreeze's default (freeze) unless the agent
				//            already steered this turn via a continue report
				await triggerReport(
					agent,
					{ title: "✅ Task Complete", sections: [{ title: "Final Summary", content: finalText }] },
					"completion"
				);
				setStatus(agent, "completed");
				break;
			}

			if (response.stop_reason === "tool_use") {
				const toolBlocks = response.content.filter((b) => b.type === "tool_use");
				agent.messages.push({ role: "assistant", content: response.content });

				const toolResults = await executeTools(agent, toolBlocks, msgId);
				agent.messages.push({ role: "user", content: toolResults });
				agent.lastUserMessageId = saveMessage(agent, "user", JSON.stringify(toolResults), 0, 0);

				// In 'always' mode: flush pending questions after each tool batch
				if (agent.config.freezeAskMode === "always" && agent.pendingQuestions.length > 0) {
					await flushQuestionsToDiscord(agent);
				}
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

		const errorMessageId = saveMessage(agent, "assistant", errorData.content, 0, 0, errorData.error, errorData.errorDetails);
		sessionEmitter.emit(agent.sessionId, {
			type: "message",
			data: {
				id: errorMessageId,
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

		// Non-retryable auth errors → "error" status; others → "stopped" (may be resumable)
		const status = classified.retryable ? "stopped" : "error";
		updateSession(agent.db, agent.sessionId, { status });
		sessionEmitter.emit(agent.sessionId, { type: "error", data: { message: errorData.error } });
	}
}

// ── Public entry points ────────────────────────────────────────────────────

const WORKSPACE = env.WORKSPACE_PATH;

export async function run(agent: AgentState, task: string): Promise<void> {
	// ── Bootstrap workspace ────────────────────────────────────────────
	const { isNewProject } = await bootstrapWorkspace(WORKSPACE);

	// ── Build startup context ──────────────────────────────────────────
	recordSystemPrompt(agent);
	const startupMsgs = await buildStartupContext(task, isNewProject);
	agent.messages = startupMsgs.map((content) => ({ role: "user", content }));
	for (const content of startupMsgs) {
		saveMessage(agent, "user", content, 0, 0);
	}

	await runLoop(agent);
}

export async function resume(agent: AgentState, message: string): Promise<void> {
	const session = getSession(agent.db, agent.sessionId);
	if (!session) throw new Error(`Session ${agent.sessionId} not found`);

	agent.stopped = false;
	agent.startTime = Date.now();
	agent.lastReportTime = Date.now();

	// Rebuild message history from DB, merging consecutive same-role rows
	// (consecutive user rows can occur after an interrupted interject)
	const rows = getMessages(agent.db, agent.sessionId);
	agent.messages = [];
	for (const row of rows) {
		// System-prompt rows are display-only; the prompt is sent as a separate API param.
		if (row.role === "system") continue;
		let content: unknown;
		try {
			const parsed = JSON.parse(row.content);
			content = Array.isArray(parsed) ? parsed : row.content;
		} catch {
			content = row.content;
		}
		const role = row.role as "user" | "assistant";
		const last = agent.messages[agent.messages.length - 1];

		if (last?.role === role) {
			// Merge into the previous turn to keep strict user/assistant alternation
			if (Array.isArray(last.content) && Array.isArray(content)) {
				last.content.push(...content);
			} else if (Array.isArray(last.content)) {
				last.content.push({ type: "text", text: String(content) });
			} else {
				last.content = `${last.content}\n\n${String(content)}`;
			}
		} else {
			agent.messages.push({ role, content: content as import("@anthropic-ai/sdk/resources").MessageParam["content"] });
		}
	}

	// Append and persist the new user message
	recordUserMessage(agent, message);

	setStatus(agent, "running");

	await runLoop(agent);
}
