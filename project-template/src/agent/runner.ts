import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import { nanoid } from "nanoid";
import {
	addTokens,
	answerQuestion,
	type Checkin,
	completeToolCall,
	type Db,
	getMessages,
	getPendingQuestions,
	getSession,
	insertCheckin,
	insertCompaction,
	insertMessage,
	insertQuestion,
	insertReport,
	insertToolCall,
	type Question,
	updateCheckin,
	updateQuestionCheckin,
	updateSession,
} from "../db";
import { getChannel } from "../discord/bot";
import { sendChecklistForm } from "../discord/forms";
import { type ReportData, sendDiscordReport } from "../discord/report";
import { sessionEmitter } from "../emitter";
import { compactMessages, estimateTokens, UsageAnchor } from "./context";
import type { AgentError } from "./errors";
import { classifyApiError, withRetry } from "./errors";
import { commitChanges, getCurrentCommit } from "./git";
import {
	isBashCommandReadOnly,
	isPlanModeToolAllowed,
	PLAN_MODE_BASH_BLOCKED_MESSAGE,
	PLAN_MODE_BLOCKED_MESSAGE,
} from "./plan-mode";
import {
	BASE_MAX_TOKENS,
	CompactionCircuitBreaker,
	calculateTokenWarningState,
	ESCALATED_MAX_TOKENS,
	type TokenWarningState,
	truncateToolResult,
} from "./token-budget";
import { AGENT_TOOLS } from "./tools/definitions";
import { executeBash, glob, grep } from "./tools/implementations/commands";
import {
	createDirectory,
	deleteFile,
	editFile,
	getFileInfo,
	listDirectory,
	moveFile,
	readFile,
	readFileRange,
	searchFiles,
	writeFile,
} from "./tools/implementations/filesystem";
import { deleteMemory, listMemories, recall, remember, updateMemory } from "./tools/implementations/memory";
import { addTask, getCurrentTask, listTasks, setCurrentTask, updateTask } from "./tools/implementations/task";
import { webFetch, webSearch } from "./tools/implementations/web";
import { bootstrapWorkspace, buildStartupContext, MEMORY_SYSTEM_DESCRIPTION } from "./workspace";

const WORKSPACE = process.env.WORKSPACE_PATH ?? "/workspace";

// ── Types ─────────────────────────────────────────────────────────────────────

export type FreezeReportMode = "always" | "never" | "custom";
export type FreezeAskMode = "always" | "requiredOnly" | "onReportOnly" | "never";
export type AlwaysImproveMode = "yes" | "no" | "custom";

export interface RunnerConfig {
	db: Db;
	sessionId: string;
	reportIntervalMins: number;
	totalTimeoutMins: number;
	discordChannelId: string | null;
	freezeReportMode: FreezeReportMode;
	freezeReportCustomRule: string | null;
	freezeAskMode: FreezeAskMode;
	compactThresholdTokens: number;
	stopThresholdTokens: number;
	alwaysImproveMode: AlwaysImproveMode;
	alwaysImproveScope: string | null;
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(cfg: RunnerConfig): string {
	return `You are an autonomous software engineering agent running unattended in a sandboxed Docker container. Your workspace is /workspace — every file you touch lives there. No human is watching in real time; you report asynchronously and keep working.

Assist with authorized engineering and defensive security work. Refuse to build malware, destructive payloads, or anything designed to cause harm.

# Doing the work
Read before you change. Understand the existing code, conventions, and tests before editing. Match the surrounding style rather than introducing your own.

Solve the task that was asked — no more. Don't over-engineer, don't add abstractions or configurability the task doesn't need, and don't add error handling for cases that can't happen. Don't create files (especially docs) unless they're required for the task.

Plan first: add the task to \`.agent/TODO.md\`, write a checklist in \`.agent/plans/CURRENT_PLAN.md\`, and tick steps off as you go. Work in focused, committable chunks. Keep \`.agent/memory/\` and its \`MEMORY.md\` index current as you learn the codebase; archive finished plans.

# Acting with care
Weigh reversibility and blast radius before each action. Reading files, searching, and editing in the workspace are cheap and reversible — just do them. Pausing to confirm is cheap; an unwanted action (lost work, a bad commit, deleted state) can be expensive.

Commit only completed units of work via \`commit_changes\` (it runs quality checks automatically — never bypass them). Use conventional commit messages: \`type(scope): message\` (feat, fix, refactor, docs, test, chore, perf, style). Be specific.

# Tools
Prefer the dedicated tools over shell equivalents so your work stays observable: \`read_file\` over \`cat\`, \`edit_file\` over \`sed\`, \`grep\`/\`glob\`/\`search_files\` over raw shell search. Reserve \`bash\` for things that genuinely need it.
Make independent tool calls in the same turn so they run in parallel. Call \`compact_context\` before long operations or when the conversation grows large.

Reports are permanent, immutable database records — the only audit trail of your progress. Use \`send_report\` for them; never write reports to files with \`write_file\`. Use the memory tools (\`remember\`, \`recall\`, \`update_memory\`, \`delete_memory\`, \`list_memories\`) for persistent knowledge.

# Questions and reporting
Name the session early with \`set_session_name\` (2-5 words). Front-load clarifying questions with \`ask_checklist\` at the start; later, use \`urgent_question\` only when truly blocked. Send a report at each meaningful milestone, not just when the timer fires.

# Tone
You write for an engineer reading reports asynchronously. Be concise and direct — lead with the result, skip preamble. Use markdown; minimal emoji.

${MEMORY_SYSTEM_DESCRIPTION}

# Settings (current)
Report interval: ${cfg.reportIntervalMins} min (0 = disabled) · Total timeout: ${cfg.totalTimeoutMins} min · compact_threshold: ${cfg.compactThresholdTokens} tokens · stop_threshold: ${cfg.stopThresholdTokens} tokens
freeze_report_mode: ${cfg.freezeReportMode}${cfg.freezeReportCustomRule ? ` (rule "${cfg.freezeReportCustomRule}")` : ""} · freeze_ask_mode: ${cfg.freezeAskMode} · always_improve: ${cfg.alwaysImproveMode}${cfg.alwaysImproveScope ? ` (scope "${cfg.alwaysImproveScope}")` : ""}

always_improve — ${
		cfg.alwaysImproveMode === "no"
			? "stop once the original task is complete."
			: cfg.alwaysImproveMode === "yes"
				? "never declare done; after the initial goal, keep finding improvements (tests, docs, performance, duplication, naming, error handling, security gaps)."
				: `after the initial task, keep improving only within this scope: ${cfg.alwaysImproveScope ?? ""}. Do not work outside it.`
	}

freeze_ask_mode —
- always: queue_question anytime; questions are sent grouped, ASAP
- requiredOnly: urgent_question only when blocked; queue_question accumulates for the next report
- onReportOnly: all questions (including urgent) accumulate until the next report, then asked together
- never: all questions go to QUESTIONS.md; decide autonomously; questions surface at timeout`;
}

// ── AgentRunner ───────────────────────────────────────────────────────────────

export class AgentRunner {
	private client: Anthropic;
	private messages: MessageParam[] = [];

	// Mutable runtime state
	private reportIntervalMs: number;
	private totalTimeoutMs: number;
	private freezeReportMode: FreezeReportMode;
	private freezeReportCustomRule: string | null;
	private freezeAskMode: FreezeAskMode;
	private compactThresholdTokens: number;
	private stopThresholdTokens: number;
	private alwaysImproveMode: AlwaysImproveMode;
	private alwaysImproveScope: string | null;

	// Tracking
	private startTime = Date.now();
	private lastReportTime = Date.now();
	private lastReportCommit: string | null = null;
	private stopped = false;
	private totalTokensConsumed = 0;
	private currentTask = "";

	// Plan mode
	private planMode = false;

	// Token budget management
	private usageAnchor = new UsageAnchor();
	private circuitBreaker = new CompactionCircuitBreaker();
	private lastWarningState: TokenWarningState = "normal";

	// Abort / interject
	private abortController = new AbortController();
	private injectedMessage: string | null = null;

	// Question accumulation
	private pendingQuestions: Question[] = [];

	private readonly db: Db;
	private readonly sessionId: string;
	private readonly discordChannelId: string | null;
	private readonly systemPrompt: string;

	constructor(config: RunnerConfig) {
		this.client = new Anthropic({
			apiKey: process.env.ANTHROPIC_API_KEY,
			baseURL: process.env.ANTHROPIC_BASE_URL,
		});
		this.db = config.db;
		this.sessionId = config.sessionId;
		this.discordChannelId = config.discordChannelId;
		this.reportIntervalMs = config.reportIntervalMins * 60_000;
		this.totalTimeoutMs = config.totalTimeoutMins * 60_000;
		this.freezeReportMode = config.freezeReportMode;
		this.freezeReportCustomRule = config.freezeReportCustomRule;
		this.freezeAskMode = config.freezeAskMode;
		this.compactThresholdTokens = config.compactThresholdTokens;
		this.stopThresholdTokens = config.stopThresholdTokens;
		this.alwaysImproveMode = config.alwaysImproveMode;
		this.alwaysImproveScope = config.alwaysImproveScope;
		this.systemPrompt = buildSystemPrompt(config);
	}

	stop() {
		this.stopped = true;
		this.abortController.abort("stop");
	}

	interject(text: string) {
		this.injectedMessage = text;
		this.abortController.abort("interject");
	}

	// ── Main loop ──────────────────────────────────────────────────────────────

	async run(task: string): Promise<void> {
		this.currentTask = task;

		// ── Bootstrap workspace ────────────────────────────────────────────
		const { isNewProject } = await bootstrapWorkspace(WORKSPACE);
		this.lastReportCommit = await getCurrentCommit(WORKSPACE);

		// ── Build startup context ──────────────────────────────────────────
		const startupMsgs = await buildStartupContext(WORKSPACE, task, isNewProject);
		this.messages = startupMsgs.map((content, i) => ({
			role: (i % 2 === 0 ? "user" : "user") as "user",
			content,
		}));
		// Ensure last is always 'user' role (task)
		for (const msg of this.messages) {
			this.saveMessage(msg.role as "user" | "assistant", msg.content as string, 0, 0);
		}

		await this.runLoop();
	}

	/** Resume a stopped/completed session with a new user message. */
	async resume(message: string): Promise<void> {
		const session = getSession(this.db, this.sessionId);
		if (!session) throw new Error(`Session ${this.sessionId} not found`);

		this.currentTask = session.task;
		this.lastReportCommit = await getCurrentCommit(WORKSPACE);
		this.stopped = false;
		this.startTime = Date.now();
		this.lastReportTime = Date.now();

		// Rebuild message history from DB, merging consecutive same-role rows
		// (consecutive user rows can occur after an interrupted interject)
		const rows = getMessages(this.db, this.sessionId);
		this.messages = [];
		for (const row of rows) {
			let content: unknown;
			try {
				const parsed = JSON.parse(row.content);
				content = Array.isArray(parsed) ? parsed : row.content;
			} catch {
				content = row.content;
			}
			const role = row.role as "user" | "assistant";
			const last = this.messages[this.messages.length - 1];
			if (last?.role === role) {
				// Merge into the previous turn to keep strict user/assistant alternation
				if (Array.isArray(last.content) && Array.isArray(content)) {
					(last.content as Anthropic.ContentBlockParam[]).push(...(content as Anthropic.ContentBlockParam[]));
				} else if (Array.isArray(last.content)) {
					(last.content as Anthropic.ContentBlockParam[]).push({
						type: "text",
						text: String(content),
					});
				} else {
					last.content = `${last.content}\n\n${String(content)}`;
				}
			} else {
				this.messages.push({ role, content: content as string | Anthropic.ContentBlockParam[] });
			}
		}

		// Append and persist the new user message
		const msgId = this.saveMessage("user", message, 0, 0);
		sessionEmitter.emit(this.sessionId, {
			type: "message",
			data: {
				id: msgId,
				sessionId: this.sessionId,
				role: "user",
				content: message,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				createdAt: Date.now(),
			},
		});
		const last = this.messages[this.messages.length - 1];
		if (last?.role === "user") {
			if (Array.isArray(last.content)) {
				(last.content as Anthropic.ContentBlockParam[]).push({ type: "text", text: message });
			} else {
				last.content = `${last.content}\n\n${message}`;
			}
		} else {
			this.messages.push({ role: "user", content: message });
		}

		updateSession(this.db, this.sessionId, { status: "running" });
		sessionEmitter.emit(this.sessionId, {
			type: "session_updated",
			data: { id: this.sessionId, status: "running" },
		});

		await this.runLoop();
	}

	// ── Main loop ──────────────────────────────────────────────────────────────

	private async runLoop(): Promise<void> {
		try {
			// ── Main agent loop ────────────────────────────────────────────────
			while (!this.stopped) {
				// Refresh abort controller for this iteration (controllers can't be reused)
				this.abortController = new AbortController();

				// Total timeout check
				if (Date.now() - this.startTime >= this.totalTimeoutMs) {
					await this.handleTotalTimeout();
					break;
				}

				// Stop threshold check
				if (this.stopThresholdTokens > 0 && this.totalTokensConsumed >= this.stopThresholdTokens) {
					await this.handleStopThreshold();
					break;
				}

				// Auto-compact context if too large (using circuit breaker)
				const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
				const estTokens = this.usageAnchor.estimate(this.messages);

				// Emit token warning state changes
				const warningInfo = calculateTokenWarningState(estTokens, model);
				if (warningInfo.state !== this.lastWarningState) {
					this.lastWarningState = warningInfo.state;
					sessionEmitter.emit(this.sessionId, {
						type: "token_warning",
						data: {
							state: warningInfo.state,
							estimatedTokens: estTokens,
							threshold: warningInfo.autoCompactThreshold,
							contextWindow: warningInfo.contextWindow,
						},
					});
				}

				console.log("[Compaction]", {
					state: warningInfo.state,
					threshold: warningInfo.autoCompactThreshold,
					tokens: estTokens,
					circuitBreakerOpen: this.circuitBreaker.isOpen,
				});

				if (this.circuitBreaker.shouldAutoCompact(estTokens, model)) {
					await this.doCompaction();
				}

				// Auto-report interval
				if (this.reportIntervalMs > 0 && Date.now() - this.lastReportTime >= this.reportIntervalMs) {
					await this.triggerAutoReport();
					this.lastReportTime = Date.now();
				}

				let response: Anthropic.Message;
				try {
					response = await this.callAnthropicApi();
				} catch (err) {
					// A clean abort (stop or interject) should not surface as an error
					if (err instanceof Error && err.name === "AbortError") {
						if (this.stopped) break;
						// Interject: merge user message into last context turn
						if (this.injectedMessage) {
							const text = this.injectedMessage;
							this.injectedMessage = null;
							const msgId = this.saveMessage("user", text, 0, 0);
							sessionEmitter.emit(this.sessionId, {
								type: "message",
								data: {
									id: msgId,
									sessionId: this.sessionId,
									role: "user",
									content: text,
									inputTokens: 0,
									outputTokens: 0,
									cacheReadTokens: 0,
									cacheWriteTokens: 0,
									createdAt: Date.now(),
								},
							});
							// Merge into last user turn to avoid consecutive user messages
							const last = this.messages[this.messages.length - 1];
							if (last?.role === "user") {
								if (Array.isArray(last.content)) {
									(last.content as Anthropic.ContentBlockParam[]).push({ type: "text", text });
								} else {
									last.content = `${last.content}\n\n${text}`;
								}
							} else {
								this.messages.push({ role: "user", content: text });
							}
						}
						continue;
					}
					throw err;
				}

				const inputTokens = response.usage.input_tokens;
				const outputTokens = response.usage.output_tokens;
				const cacheReadTokens = (response.usage as unknown as Record<string, number>).cache_read_input_tokens ?? 0;
				const cacheWriteTokens = (response.usage as unknown as Record<string, number>).cache_creation_input_tokens ?? 0;

				// Update usage anchor for efficient token estimation
				this.usageAnchor.update(this.messages.length - 1, inputTokens);

				this.totalTokensConsumed += inputTokens + outputTokens;
				addTokens(this.db, this.sessionId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
				const totals = getSession(this.db, this.sessionId);
				sessionEmitter.emit(this.sessionId, {
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

				const msgId = this.saveMessage(
					"assistant",
					JSON.stringify(response.content),
					inputTokens,
					outputTokens,
					undefined,
					undefined,
					cacheReadTokens,
					cacheWriteTokens
				);
				sessionEmitter.emit(this.sessionId, {
					type: "message",
					data: {
						id: msgId,
						sessionId: this.sessionId,
						role: "assistant",
						content: response.content,
						inputTokens,
						outputTokens,
						cacheReadTokens,
						cacheWriteTokens,
						createdAt: Date.now(),
					},
				});

				if (response.stop_reason === "end_turn") {
					const finalText = response.content
						.filter((b) => b.type === "text")
						.map((b) => (b as Anthropic.TextBlock).text)
						.join("\n");

					// Always-improve: continue instead of stopping
					if (this.alwaysImproveMode !== "no") {
						const continueMsg = this.buildImproveMessage();
						this.messages.push({ role: "assistant", content: response.content });
						this.messages.push({ role: "user", content: continueMsg });
						this.saveMessage("user", continueMsg, 0, 0);
						continue;
					}

					// Completion freeze follows freeze_report_mode (NOT a forced freeze):
					//   always → freeze for a final check-in
					//   never  → post the report and complete without blocking
					//   custom → shouldFreeze's default (freeze) unless the agent
					//            already steered this turn via a continue report
					await this.triggerReport(
						{
							title: "✅ Task Complete",
							sections: [{ title: "Final Summary", content: finalText }],
						},
						"completion"
					);
					updateSession(this.db, this.sessionId, { status: "completed" });
					sessionEmitter.emit(this.sessionId, {
						type: "session_updated",
						data: { id: this.sessionId, status: "completed" },
					});
					break;
				}

				if (response.stop_reason === "tool_use") {
					const toolBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
					this.messages.push({ role: "assistant", content: response.content });
					const toolResults = await this.executeTools(toolBlocks, msgId);
					this.messages.push({ role: "user", content: toolResults });
					this.saveMessage("user", JSON.stringify(toolResults), 0, 0);

					// In 'always' mode: flush pending questions after each tool batch
					if (this.freezeAskMode === "always" && this.pendingQuestions.length > 0) {
						await this.flushQuestionsToDiscord();
					}
				}
			}
		} catch (err) {
			const classified = classifyApiError(err);
			console.error(`[Agent ${this.sessionId}] Fatal error [${classified.category}]:`, classified.message);

			// Save error message to database
			const errorMessage = classified.message;
			const errorDetails = err instanceof Error ? err.stack : undefined;
			const errorMsgId = this.saveMessage(
				"assistant",
				JSON.stringify([{ type: "text", text: `An error occurred during execution: ${classified.category}` }]),
				0,
				0,
				errorMessage,
				errorDetails
			);

			sessionEmitter.emit(this.sessionId, {
				type: "message",
				data: {
					id: errorMsgId,
					sessionId: this.sessionId,
					role: "assistant",
					content: JSON.stringify([{ type: "text", text: `An error occurred during execution: ${classified.category}` }]),
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					error: errorMessage,
					errorDetails,
				},
			});

			// Non-retryable auth errors → "error" status; others → "stopped" (may be resumable)
			const finalStatus = classified.retryable ? "stopped" : "error";
			updateSession(this.db, this.sessionId, { status: finalStatus });
			sessionEmitter.emit(this.sessionId, {
				type: "error",
				data: { message: errorMessage },
			});
		}
	}

	// ── Context compaction ─────────────────────────────────────────────────────────────

	private async doCompaction(): Promise<void> {
		const before = this.messages.length;
		const estBefore = this.usageAnchor.estimate(this.messages);

		// Surface a dedicated "compacting" state while the (potentially slow)
		// summarization round-trip runs, then restore "running".
		updateSession(this.db, this.sessionId, { status: "compacting" });
		sessionEmitter.emit(this.sessionId, {
			type: "session_updated",
			data: { id: this.sessionId, status: "compacting" },
		});

		let messages: MessageParam[];
		let summary: string;
		try {
			({ messages, summary } = await compactMessages(this.messages, this.client));
			this.circuitBreaker.recordSuccess();
		} catch (err) {
			this.circuitBreaker.recordFailure();
			console.error(`[Agent ${this.sessionId}] Compaction failed (attempt ${this.circuitBreaker.failures}):`, err);
			// Restore running state and continue without compacting
			updateSession(this.db, this.sessionId, { status: "running" });
			sessionEmitter.emit(this.sessionId, {
				type: "session_updated",
				data: { id: this.sessionId, status: "running" },
			});
			return;
		} finally {
			updateSession(this.db, this.sessionId, { status: "running" });
			sessionEmitter.emit(this.sessionId, {
				type: "session_updated",
				data: { id: this.sessionId, status: "running" },
			});
		}
		this.messages = messages;
		// Invalidate anchor — message array is restructured
		this.usageAnchor.invalidate();
		const estAfter = estimateTokens(this.messages);
		console.log(
			`[Agent ${this.sessionId}] Compacted context: ${before} → ${messages.length} messages (${estBefore} → ${estAfter} est. tokens)`
		);

		// Record the compaction in its own timeline — entirely separate from
		// check-ins. A compaction is purely a token-threshold-driven context
		// summarization; it never blocks the agent or asks the user anything.
		const compactionId = nanoid();
		const compaction = insertCompaction(this.db, {
			id: compactionId,
			sessionId: this.sessionId,
			messagesBefore: before,
			messagesAfter: messages.length,
			tokensBefore: estBefore,
			tokensAfter: estAfter,
			thresholdTokens: this.compactThresholdTokens,
			summary,
			createdAt: Date.now(),
		});
		sessionEmitter.emit(this.sessionId, {
			type: "compaction",
			data: compaction,
		});

		// Send a check-in with the compaction summary so the user sees
		// the generated memory markdown.
		await this.triggerReport(
			{
				title: "🗜 Context Compacted",
				sections: [
					{
						title: "Memory Summary",
						content: summary,
					},
					{
						title: "Stats",
						content: `Messages: ${before} → ${messages.length}\nTokens: ${estBefore.toLocaleString()} → ${estAfter.toLocaleString()}`,
					},
				],
			},
			"compaction"
		);
	}

	// ── Report helpers ─────────────────────────────────────────────────────────────

	private shouldFreeze(_trigger: string, freezeOverride?: "freeze" | "continue"): boolean {
		if (freezeOverride === "freeze") return true;
		if (freezeOverride === "continue") return false;
		if (this.freezeReportMode === "always") return true;
		if (this.freezeReportMode === "never") return false;
		return true; // custom: agent passes freeze_override; default freeze if not specified
	}

	private async triggerReport(
		report: ReportData,
		trigger: string,
		forceFreeze = false,
		freezeOverride?: "freeze" | "continue"
	): Promise<void> {
		console.log("[Report]", trigger, JSON.stringify(report, null, 2));

		const freeze = forceFreeze || this.shouldFreeze(trigger, freezeOverride);
		const pending = this.drainPending();
		const questionsToAsk = freeze ? pending : [];

		// Normalize the trigger to the checkin timeline's vocabulary so every
		// report path (timer, completion, total-timeout, token budget, urgent,
		// manual) shows up in the UI — not just compaction.
		const checkinTrigger: Checkin["trigger"] =
			trigger === "timer" || trigger === "urgent" || trigger === "manual" || trigger === "completion" || trigger === "compaction"
				? trigger
				: "manual";
		const summary = report.sections.map((s) => `**${s.title}**\n${s.content}`).join("\n\n");

		// Record the check-in BEFORE any Discord round-trip so the timeline
		// reflects the event even when there is no channel (e.g. token budget
		// exhausted with Discord disabled).
		const checkinId = nanoid();
		insertCheckin(this.db, {
			id: checkinId,
			sessionId: this.sessionId,
			trigger: checkinTrigger,
			summary,
			status: "pending",
			createdAt: Date.now(),
		});
		// Link any questions being asked to this check-in so they render under it.
		for (const q of questionsToAsk) {
			updateQuestionCheckin(this.db, q.id, checkinId);
			q.checkinId = checkinId;
		}
		sessionEmitter.emit(this.sessionId, {
			type: "checkin_started",
			data: {
				id: checkinId,
				sessionId: this.sessionId,
				trigger: checkinTrigger,
				summary,
				status: "pending",
				createdAt: Date.now(),
				questions: questionsToAsk,
			},
		});

		updateSession(this.db, this.sessionId, { status: "paused" });
		sessionEmitter.emit(this.sessionId, {
			type: "session_updated",
			data: { id: this.sessionId, status: "paused" },
		});

		let confirmed = false;
		try {
			// Persist the immutable report record regardless of Discord delivery.
			insertReport(this.db, {
				id: nanoid(),
				sessionId: this.sessionId,
				trigger,
				title: report.title,
				content: JSON.stringify(report),
			});

			const channel = this.discordChannelId ? await getChannel(this.discordChannelId) : null;

			if (channel) {
				const result = await sendDiscordReport(
					channel,
					report,
					this.sessionId,
					trigger,
					freeze,
					questionsToAsk,
					{
						workspace: WORKSPACE,
						task: this.currentTask,
						sinceCommit: this.lastReportCommit,
					},
					this.abortController.signal
				);

				if (result?.confirmed) {
					confirmed = true;
					this.injectAnswers(result.answers, pending);
				}
			} else {
				// No Discord channel — nothing to wait on; auto-confirm.
				confirmed = true;
			}

			// Update last-report commit after report
			this.lastReportCommit = await getCurrentCommit(WORKSPACE);
		} finally {
			updateCheckin(this.db, checkinId, {
				status: confirmed ? "answered" : "skipped",
				completedAt: Date.now(),
			});
			sessionEmitter.emit(this.sessionId, {
				type: "checkin_completed",
				data: {
					id: checkinId,
					sessionId: this.sessionId,
					trigger: checkinTrigger,
					summary,
					status: confirmed ? "answered" : "skipped",
					completedAt: Date.now(),
					confirmed,
				},
			});

			updateSession(this.db, this.sessionId, { status: "running" });
			sessionEmitter.emit(this.sessionId, {
				type: "session_updated",
				data: { id: this.sessionId, status: "running" },
			});
		}
	}

	private async triggerAutoReport(): Promise<void> {
		const summary = await this.requestSummary();
		await this.triggerReport({ title: "⏱ Scheduled Report", sections: [{ title: "Progress", content: summary }] }, "timer");
	}

	private async handleTotalTimeout(): Promise<void> {
		const summary = await this.requestSummary();
		const questionsMd = await this.buildQuestionsFile();
		const sections: ReportData["sections"] = [{ title: "Progress at timeout", content: summary }];
		if (questionsMd) {
			sections.push({ title: "Accumulated Questions (QUESTIONS.md)", content: questionsMd });
		}
		await this.triggerReport({ title: "⏰ Total Timeout — Agent Frozen", sections }, "completion", true);
		updateSession(this.db, this.sessionId, { status: "stopped" });
		sessionEmitter.emit(this.sessionId, {
			type: "session_updated",
			data: { id: this.sessionId, status: "stopped" },
		});
	}

	private async handleStopThreshold(): Promise<void> {
		const summary = await this.requestSummary();
		const t = getSession(this.db, this.sessionId);
		const tokenLine = `input: ${(t?.totalInputTokens ?? 0).toLocaleString()}, output: ${(t?.totalOutputTokens ?? 0).toLocaleString()}, cache_read: ${(t?.totalCacheReadTokens ?? 0).toLocaleString()}, cache_write: ${(t?.totalCacheWriteTokens ?? 0).toLocaleString()}`;
		await this.triggerReport(
			{
				title: "🛑 Token Budget Exhausted — Agent Stopped",
				sections: [
					{ title: "Summary", content: summary },
					{
						title: "Token Usage",
						content: `${tokenLine}\nBudget: ${this.stopThresholdTokens.toLocaleString()}`,
					},
				],
			},
			"completion",
			true
		);
		updateSession(this.db, this.sessionId, { status: "stopped" });
		sessionEmitter.emit(this.sessionId, {
			type: "session_updated",
			data: { id: this.sessionId, status: "stopped" },
		});
	}

	private async flushQuestionsToDiscord(): Promise<void> {
		if (!this.discordChannelId || this.pendingQuestions.length === 0) return;
		const pending = this.drainPending();
		const channel = await getChannel(this.discordChannelId);
		if (!channel) return;

		const result = await sendDiscordReport(
			channel,
			{ title: "❓ Questions", sections: [] },
			this.sessionId,
			"manual",
			true,
			pending,
			{ workspace: WORKSPACE, task: this.currentTask, sinceCommit: null },
			this.abortController.signal
		);
		if (result?.confirmed) {
			this.injectAnswers(result.answers, pending);
		}
	}

	private buildImproveMessage(): string {
		if (this.alwaysImproveMode === "yes") {
			return `You have completed the initial task. Do NOT declare yourself done.

Continue to improve the codebase. For example, look for opportunities to:

- Refactor duplicated or unclear code
- Strengthen error handling and resilience
- Improve performance (obvious wins only)
- Identify and address security gaps
- Add or improve tests (unit, integration, edge cases)
- Improve documentation (README, inline comments where genuinely needed)

Add new improvement tasks to \`.agent/TODO.md\` and update \`.agent/plans/CURRENT_PLAN.md\`. Keep committing.`;
		}

		// "custom" mode: keep improving, but only within the configured scope
		return `You have completed the initial task. Continue improving within this scope ONLY: ${this.alwaysImproveScope ?? ""}
Do NOT work outside this scope. Add tasks to \`.agent/TODO.md\` and update \`.agent/plans/CURRENT_PLAN.md\`. Keep committing.`;
	}

	// ── Anthropic API ──────────────────────────────────────────────────────────────
	private async callAnthropicApi(): Promise<Anthropic.Message> {
		const makeRequest = async (maxTokens: number): Promise<Anthropic.Message> => {
			const stream = this.client.messages.stream(
				{
					model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
					max_tokens: maxTokens,
					system: this.systemPrompt,
					tools: AGENT_TOOLS,
					messages: this.messages,
				},
				{ signal: this.abortController.signal }
			);

			stream.on("text", (text) => {
				sessionEmitter.emit(this.sessionId, { type: "text_delta", data: { text } });
			});

			return stream.finalMessage();
		};

		// Retry with exponential backoff for transient errors
		const response = await withRetry(() => makeRequest(BASE_MAX_TOKENS), {
			maxAttempts: 3,
			baseDelayMs: 1000,
			maxDelayMs: 10_000,
			signal: this.abortController.signal,
			onRetry: (err: AgentError, attempt: number, nextDelayMs: number) => {
				console.log(`[Agent ${this.sessionId}] API retry #${attempt}: ${err.category} — waiting ${Math.round(nextDelayMs)}ms`);
				sessionEmitter.emit(this.sessionId, {
					type: "error_recovered",
					data: { attempt, error: err.message, nextRetryMs: Math.round(nextDelayMs) },
				});
			},
		});

		// Output token tier escalation: if truncated, retry with higher limit
		if (response.stop_reason === "max_tokens") {
			console.log(
				`[Agent ${this.sessionId}] Response truncated at ${BASE_MAX_TOKENS} tokens, retrying with ${ESCALATED_MAX_TOKENS}`
			);
			return withRetry(() => makeRequest(ESCALATED_MAX_TOKENS), {
				maxAttempts: 2,
				baseDelayMs: 1000,
				maxDelayMs: 5000,
				signal: this.abortController.signal,
			});
		}

		return response;
	}

	private async requestSummary(): Promise<string> {
		try {
			const transcript = this.messages
				.slice(-10)
				.map((m) => {
					const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
					return `[${m.role.toUpperCase()}]: ${content.slice(0, 1000)}`;
				})
				.join("\n\n");

			const resp = await this.client.messages.create({
				model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
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
				.map((b) => (b as Anthropic.TextBlock).text)
				.join("\n");
		} catch {
			return "(summary unavailable)";
		}
	}

	// ── Persistence helpers ─────────────────────────────────────────────────────

	private saveMessage(
		role: "user" | "assistant",
		content: string,
		inputTokens: number,
		outputTokens: number,
		error?: string,
		errorDetails?: string,
		cacheReadTokens?: number,
		cacheWriteTokens?: number
	): string {
		const id = nanoid();
		insertMessage(this.db, {
			id,
			sessionId: this.sessionId,
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

	// ── Question helpers ────────────────────────────────────────────────────────

	private makeQuestion(input: Record<string, unknown>, isUrgent: boolean): Question {
		const suggestions = input.suggestions ? JSON.stringify(input.suggestions) : null;
		return {
			id: nanoid(),
			sessionId: this.sessionId,
			checkinId: null,
			text: (input.question as string) ?? (input.text as string) ?? "",
			context: (input.context as string) ?? null,
			suggestions,
			answer: null,
			isUrgent,
			createdAt: Date.now(),
			answeredAt: null,
		};
	}

	private drainPending(): Question[] {
		const pending = this.pendingQuestions;
		this.pendingQuestions = [];
		return pending;
	}

	private injectAnswers(answers: Array<{ questionId: string; answer: string }>, pending: Question[]): void {
		for (const a of answers) {
			answerQuestion(this.db, a.questionId, a.answer);
			const q = pending.find((p) => p.id === a.questionId);
			if (q) q.answer = a.answer;
			// Append answer to the question's vector memory entry
			recall(a.questionId, "question", 1)
				.then((results) => {
					const entry = results.find((r) => r.metadata?.questionId === a.questionId);
					if (entry) {
						updateMemory(entry.id, {
							content: `${entry.content}\n\n**Answer:** ${a.answer}`,
							metadata: { ...entry.metadata, status: "answered" },
						}).catch(() => {});
					}
				})
				.catch(() => {});
		}
	}

	private async appendToQuestionsFile(q: Question): Promise<void> {
		const entry = `${q.isUrgent ? "🚨 Urgent" : "❓ Question"} (${new Date(q.createdAt).toISOString()})\n${q.text}${q.context ? `\n\nContext: ${q.context}` : ""}`;
		try {
			await remember("question", q.text.slice(0, 100), entry);
		} catch {
			// Non-fatal if memory service is unavailable
		}
	}

	private async buildQuestionsFile(): Promise<string> {
		const qs = getPendingQuestions(this.db, this.sessionId);
		if (qs.length === 0) return "";
		return qs
			.map((q, i) => `### ${i + 1}. ${q.isUrgent ? "🚨 " : ""}${q.text}${q.context ? `\n   Context: ${q.context}` : ""}`)
			.join("\n\n");
	}

	// ── Tool dispatch ──────────────────────────────────────────────────────────────

	private async executeTools(blocks: Anthropic.ToolUseBlock[], parentMsgId: string): Promise<Anthropic.ToolResultBlockParam[]> {
		const results: Anthropic.ToolResultBlockParam[] = [];

		for (const block of blocks) {
			const toolCallId = nanoid();
			const input = block.input as Record<string, unknown>;

			insertToolCall(this.db, {
				id: toolCallId,
				sessionId: this.sessionId,
				messageId: parentMsgId,
				toolName: block.name,
				toolUseId: block.id,
				input: JSON.stringify(input),
				status: "pending",
				createdAt: Date.now(),
			});
			sessionEmitter.emit(this.sessionId, {
				type: "tool_call",
				data: {
					id: toolCallId,
					sessionId: this.sessionId,
					toolName: block.name,
					toolUseId: block.id,
					input,
					status: "pending",
					createdAt: Date.now(),
				},
			});

			let output: string;
			let status: "success" | "error" = "success";
			try {
				output = await this.dispatchTool(block.name, input);
				// Truncate oversized tool results to prevent context bloat
				output = truncateToolResult(output);
			} catch (err) {
				output = `Error: ${err}`;
				status = "error";
			}

			completeToolCall(this.db, toolCallId, output, status);
			sessionEmitter.emit(this.sessionId, {
				type: "tool_call",
				data: {
					id: toolCallId,
					sessionId: this.sessionId,
					toolName: block.name,
					toolUseId: block.id,
					input,
					output,
					status,
					completedAt: Date.now(),
				},
			});

			results.push({
				type: "tool_result",
				tool_use_id: block.id,
				content: output,
				is_error: status === "error",
			});
		}
		return results;
	}

	private async dispatchTool(name: string, input: Record<string, unknown>): Promise<string> {
		// ── Plan mode enforcement ────────────────────────────────────────────────────
		if (this.planMode) {
			if (name === "exit_plan_mode") {
				this.planMode = false;
				const summary = (input.plan_summary as string) ?? undefined;
				sessionEmitter.emit(this.sessionId, { type: "plan_mode", data: { active: false, summary } });
				return summary ? `Exited plan mode. Plan summary recorded:\n${summary}` : "Exited plan mode. Full tool access restored.";
			}
			if (!isPlanModeToolAllowed(name)) {
				return PLAN_MODE_BLOCKED_MESSAGE;
			}
			// For bash in plan mode, check if the command is read-only
			if (name === "bash" && !isBashCommandReadOnly((input.command as string) ?? "")) {
				return PLAN_MODE_BASH_BLOCKED_MESSAGE;
			}
		}

		switch (name) {
			// ── Plan mode ────────────────────────────────────────────────────────────────
			case "enter_plan_mode": {
				this.planMode = true;
				sessionEmitter.emit(this.sessionId, { type: "plan_mode", data: { active: true } });
				return "Entered plan mode. Only read-only tools are available (grep, glob, read_file, list_directory, search_files, bash read-only commands). Call exit_plan_mode when ready to implement.";
			}
			case "exit_plan_mode": {
				this.planMode = false;
				const summary = (input.plan_summary as string) ?? undefined;
				sessionEmitter.emit(this.sessionId, { type: "plan_mode", data: { active: false, summary } });
				return summary ? `Exited plan mode. Plan summary recorded:\n${summary}` : "Exited plan mode. Full tool access restored.";
			}

			// ── File system ──────────────────────────────────────────────────────────────
			case "bash": {
				const r = await executeBash(input.command as string, (input.timeout_ms as number) ?? 30_000);
				return [r.stdout ? `STDOUT:\n${r.stdout}` : "", r.stderr ? `STDERR:\n${r.stderr}` : "", `Exit code: ${r.exitCode}`]
					.filter(Boolean)
					.join("\n");
			}
			case "grep":
				return await grep(
					input.pattern as string,
					(input.path as string) ?? ".",
					input.include as string | undefined,
					(input.flags as string) ?? ""
				);
			case "glob":
				return await glob(input.pattern as string, (input.path as string) ?? ".");
			case "read_file":
				return await readFile(input.path as string);
			case "write_file": {
				const p = input.path as string;
				if (/^\.?agent\//i.test(p) || p.includes(".agent/")) {
					return "Error: The .agent/ directory is no longer used. Use the memory tools (remember, recall, update_memory, delete_memory, list_memories) instead.";
				}
				await writeFile(p, input.content as string);
				return `Written to ${p}`;
			}
			case "list_directory":
				return await listDirectory((input.path as string) ?? "");
			case "search_files":
				return await searchFiles(
					input.pattern as string,
					(input.path as string) ?? ".",
					(input.file_pattern as string) ?? "*",
					(input.case_sensitive as boolean) ?? false,
					(input.max_results as number) ?? 100
				);
			case "edit_file": {
				const ep = input.path as string;
				if (/^\.?agent\//i.test(ep) || ep.includes(".agent/")) {
					return "Error: The .agent/ directory is no longer used. Use the memory tools instead.";
				}
				return await editFile(
					ep,
					input.old_string as string,
					input.new_string as string,
					(input.replace_all as boolean) ?? false
				);
			}
			case "move_file": {
				const dest = input.destination as string;
				if (/^\.?agent\//i.test(dest) || dest.includes(".agent/")) {
					return "Error: The .agent/ directory is no longer used. Use the memory tools instead.";
				}
				return await moveFile(input.source as string, dest);
			}
			case "delete_file":
				return await deleteFile(input.path as string, (input.recursive as boolean) ?? false);
			case "create_directory":
				return await createDirectory(input.path as string);
			case "get_file_info":
				return await getFileInfo(input.path as string);
			case "read_file_range":
				return await readFileRange(input.path as string, input.start_line as number, input.end_line as number);

			// ── Memory Management ────────────────────────────────────────────────────────
			case "remember":
				return await remember(input.type as any, input.title as string, input.content as string, input.metadata as any);
			case "recall": {
				const results = await recall(input.query as string, input.type as any, (input.limit as number) ?? 10);
				return results.length > 0
					? results.map((r) => `[${r.id}] (${r.type}) ${r.title}:\n${r.content}`).join("\n\n---\n\n")
					: "No matching memories found.";
			}
			case "update_memory":
				await updateMemory(input.id as string, {
					title: input.title as any,
					content: input.content as any,
					type: input.type as any,
					metadata: input.metadata as any,
				});
				return "Memory updated.";
			case "delete_memory":
				await deleteMemory(input.id as string);
				return "Memory deleted.";
			case "list_memories": {
				const entries = await listMemories(input.type as any, (input.limit as number) ?? 100);
				return entries.length > 0
					? entries.map((e) => `[${e.id}] (${e.type}) ${e.title}: ${e.content.slice(0, 150)}`).join("\n")
					: "No memories found.";
			}

			// ── Questions ───────────────────────────────────────────────────────────────
			case "queue_question":
				return await this.handleQueueQuestion(input);
			case "urgent_question":
				return await this.handleUrgentQuestion(input);

			// ── Reports ──────────────────────────────────────────────────────────────
			case "send_report":
				return await this.handleSendReport(input);

			// ── Git ──────────────────────────────────────────────────────────────
			case "commit_changes": {
				const result = await commitChanges(WORKSPACE, input.message as string, !(input.skip_checks as boolean));
				return result.success
					? `Committed: ${result.commit ?? "unknown"}\n\n${result.output.slice(0, 2000)}`
					: `Commit failed:\n\n${result.output.slice(0, 2000)}`;
			}
			case "compact_context": {
				const before = this.messages.length;
				const { messages } = await compactMessages(this.messages, this.client);
				this.messages = messages;
				return `Context compacted: ${before} → ${messages.length} messages.`;
			}
			case "change_compact_threshold": {
				const tokens = Math.max(0, Number(input.tokens));
				this.compactThresholdTokens = tokens;
				updateSession(this.db, this.sessionId, { compactThresholdTokens: tokens });
				return tokens === 0 ? "Auto-compaction disabled." : `Compact threshold set to ${tokens.toLocaleString()} tokens.`;
			}
			case "change_stop_threshold": {
				const tokens = Math.max(0, Number(input.tokens));
				this.stopThresholdTokens = tokens;
				updateSession(this.db, this.sessionId, { stopThresholdTokens: tokens });
				return tokens === 0 ? "Token stop threshold disabled." : `Stop threshold set to ${tokens.toLocaleString()} tokens.`;
			}
			case "change_always_improve_mode": {
				const mode = input.mode as AlwaysImproveMode;
				const scope = (input.scope as string) ?? null;
				this.alwaysImproveMode = mode;
				this.alwaysImproveScope = scope;
				updateSession(this.db, this.sessionId, {
					alwaysImproveMode: mode,
					alwaysImproveScope: scope,
				});
				return `always_improve set to '${mode}'${scope ? ` (scope: "${scope}")` : ""}.`;
			}
			case "change_freeze_report_mode": {
				const mode = input.mode as FreezeReportMode;
				this.freezeReportMode = mode;
				this.freezeReportCustomRule = (input.custom_rule as string) ?? null;
				updateSession(this.db, this.sessionId, {
					freezeReportMode: mode,
					freezeReportCustomRule: this.freezeReportCustomRule,
				});
				return `freeze_report_mode set to '${mode}'.`;
			}
			case "change_freeze_ask_mode": {
				const mode = input.mode as FreezeAskMode;
				this.freezeAskMode = mode;
				updateSession(this.db, this.sessionId, { freezeAskMode: mode });
				return `freeze_ask_mode set to '${mode}'.`;
			}

			// ── Session management ──────────────────────────────────────────────────────
			case "set_session_name": {
				const name = input.name as string;
				updateSession(this.db, this.sessionId, { name });
				sessionEmitter.emit(this.sessionId, {
					type: "session_updated",
					data: { id: this.sessionId, name },
				});
				return `Session named: "${name}"`;
			}

			// ── Checklist ───────────────────────────────────────────────────────────────
			case "ask_checklist": {
				if (!this.discordChannelId) {
					return "No Discord channel configured — skipping checklist. Proceed with best judgment.";
				}
				const channel = await getChannel(this.discordChannelId);
				if (!channel) return "Discord channel unavailable — proceeding with best judgment.";
				const result = await sendChecklistForm(
					channel,
					(input.title as string) ?? "Implementation Checklist",
					input.items as import("../discord/forms").ChecklistItem[],
					this.sessionId,
					this.abortController.signal
				);
				if (result.completed) {
					const answersText = Object.entries(result.answers)
						.map(([id, answer]) => `- ${id}: ${answer}`)
						.join("\n");
					return `Checklist answers received:\n${answersText}`;
				}
				return "Checklist sent but no response received — proceeding with best judgment.";
			}

			// ── Task Management ─────────────────────────────────────────────────────────
			case "add_task":
				return await addTask(
					this.db,
					this.sessionId,
					input.text as string,
					input.status as "pending" | "in_progress" | "done" | "cancelled" | undefined,
					input.dependsOn as string[] | undefined
				);
			case "list_tasks":
				return await listTasks(this.db, this.sessionId, (input.filter as string) ?? "all");
			case "update_task":
				return await updateTask(
					this.db,
					this.sessionId,
					input.id as string,
					input.status as "pending" | "in_progress" | "done" | "cancelled" | undefined,
					input.text as string | undefined,
					input.dependsOn as string[] | undefined
				);
			case "set_current_task":
				return await setCurrentTask(this.db, this.sessionId, input.id as string);
			case "get_current_task":
				return await getCurrentTask(this.db, this.sessionId);

			// ── Web ───────────────────────────────────────────────────────────────────────
			case "web_search":
				return await webSearch(input.query as string, (input.limit as number) ?? 8);
			case "web_fetch":
				return await webFetch(input.url as string, (input.max_chars as number) ?? 20_000);

			// ── Timeout/interval changes ────────────────────────────────────────────────
			case "change_timeout": {
				const mins = Math.max(1, Math.min(1440, Number(input.minutes)));
				this.totalTimeoutMs = mins * 60_000;
				updateSession(this.db, this.sessionId, { totalTimeoutMins: mins });
				return `Total timeout set to ${mins} minutes.`;
			}

			case "change_report_time_interval": {
				const mins = Math.max(0, Number(input.minutes));
				this.reportIntervalMs = mins * 60_000;
				updateSession(this.db, this.sessionId, { reportIntervalMins: mins });
				return mins === 0 ? "Automatic reports disabled." : `Report interval set to ${mins} minutes.`;
			}

			default:
				return `Unknown tool: ${name}`;
		}
	}

	// ── Question handlers ──────────────────────────────────────────────────────────────

	private async handleQueueQuestion(input: Record<string, unknown>): Promise<string> {
		const q = this.makeQuestion(input, false);
		insertQuestion(this.db, q);
		remember("question", q.text.slice(0, 100), `${q.text}${q.context ? `\n\nContext: ${q.context}` : ""}`, {
			questionId: q.id,
			status: "pending",
		}).catch(() => {});

		switch (this.freezeAskMode) {
			case "always":
				this.pendingQuestions.push(q);
				return "Question queued — will be sent to Discord shortly.";
			case "requiredOnly":
			case "onReportOnly":
				this.pendingQuestions.push(q);
				return "Question queued for next report.";
			case "never":
				await this.appendToQuestionsFile(q);
				return "Question logged to memory.";
		}
	}

	private async handleUrgentQuestion(input: Record<string, unknown>): Promise<string> {
		const q = this.makeQuestion(input, true);
		insertQuestion(this.db, q);
		remember("question", `🚨 ${q.text.slice(0, 95)}`, `${q.text}${q.context ? `\n\nContext: ${q.context}` : ""}`, {
			questionId: q.id,
			status: "pending",
			urgent: true,
		}).catch(() => {});

		switch (this.freezeAskMode) {
			case "always":
			case "requiredOnly": {
				this.pendingQuestions.push(q);
				await this.flushQuestionsToDiscord();
				return q.answer ?? "No answer received — proceeding with best judgment.";
			}
			case "onReportOnly": {
				this.pendingQuestions.push(q);
				await this.triggerReport(
					{
						title: "🚨 Urgent Question",
						sections: [{ title: "Context", content: (input.context as string) ?? "Agent is blocked." }],
					},
					"urgent",
					true
				);
				return q.answer ?? "No answer received — proceeding with best judgment.";
			}
			case "never":
				await this.appendToQuestionsFile(q);
				return "Logged to QUESTIONS.md — proceeding with best judgment.";
		}
	}

	private async handleSendReport(input: Record<string, unknown>): Promise<string> {
		const report: ReportData = {
			title: (input.title as string) ?? "Report",
			sections: (input.sections as ReportData["sections"]) ?? [],
			mermaid_diagrams: input.mermaid_diagrams as ReportData["mermaid_diagrams"],
			screenshot_targets: input.screenshot_targets as ReportData["screenshot_targets"],
		};

		const freezeOverride = input.freeze_override as "freeze" | "continue" | undefined;
		const freeze = this.shouldFreeze("manual", freezeOverride);
		const pending = this.drainPending();
		const questionsToAsk = freeze ? pending : [];

		if (this.discordChannelId) {
			const channel = await getChannel(this.discordChannelId);
			if (!channel) return "Report failed: Discord channel unavailable.";

			updateSession(this.db, this.sessionId, { status: "paused" });
			sessionEmitter.emit(this.sessionId, {
				type: "session_updated",
				data: { id: this.sessionId, status: "paused" },
			});

			try {
				const result = await sendDiscordReport(
					channel,
					report,
					this.sessionId,
					"manual",
					freeze,
					questionsToAsk,
					{ workspace: WORKSPACE, task: this.currentTask, sinceCommit: null },
					this.abortController.signal
				);

				insertReport(this.db, {
					id: nanoid(),
					sessionId: this.sessionId,
					trigger: "manual",
					title: report.title,
					content: JSON.stringify(report),
				});

				// Record in vector memory for semantic recall
				remember("report", report.title, report.sections.map((s) => `${s.title ?? ""}\n${s.content}`).join("\n\n")).catch(
					() => {}
				);

				this.lastReportCommit = await getCurrentCommit(WORKSPACE);
				if (result?.confirmed) this.injectAnswers(result.answers, pending);
			} finally {
				updateSession(this.db, this.sessionId, { status: "running" });
				sessionEmitter.emit(this.sessionId, {
					type: "session_updated",
					data: { id: this.sessionId, status: "running" },
				});
			}
		}

		return freeze ? "Report sent and user acknowledged." : "Report sent (continuing).";
	}
}
