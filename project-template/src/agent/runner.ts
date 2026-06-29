import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Checkin, Question } from "@agent-manager/db/project-schema";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import { nanoid } from "nanoid";
import {
	addTokens,
	answerQuestion,
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
	updateCheckin,
	updateMessageTokens,
	updateQuestionCheckin,
	updateSession,
} from "../db";
import { sessionEmitter } from "../emitter";
import { env } from "../env";
import { compactMessages, estimateTokens } from "./context";
import { type ChecklistItem, type ReportData, sendChecklist, sendReport } from "./discord";
import {
	BASE_MAX_TOKENS,
	CompactionCircuitBreaker,
	calculateTokenWarningState,
	ESCALATED_MAX_TOKENS,
	MODEL_CONTEXT_WINDOW,
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
import {
	type QuestionInput,
	type SendGraphInput,
	type SendReportInput,
	ToolValidationError,
	validateAddTask,
	validateAskChecklist,
	validateBash,
	validateCommitChanges,
	validateCreateDirectory,
	validateDeleteFile,
	validateDeleteMemory,
	validateEditFile,
	validateExitPlanMode,
	validateGetFileInfo,
	validateGlob,
	validateGrep,
	validateListDirectory,
	validateListMemories,
	validateListTasks,
	validateMoveFile,
	validateQuestion,
	validateReadFile,
	validateReadFileRange,
	validateRecall,
	validateRemember,
	validateSearchFiles,
	validateSendGraph,
	validateSendReport,
	validateSetCurrentTask,
	validateUpdateMemory,
	validateUpdateTask,
	validateWebFetch,
	validateWebSearch,
	validateWriteFile,
} from "./tools/validators";
import type { AgentError } from "./utils/errors";
import { classifyApiError, withRetry } from "./utils/errors";
import { commitChanges } from "./utils/git";
import {
	isBashCommandReadOnly,
	isPlanModeToolAllowed,
	PLAN_MODE_BASH_BLOCKED_MESSAGE,
	PLAN_MODE_BLOCKED_MESSAGE,
} from "./utils/plan-mode";
import { bootstrapWorkspace, buildStartupContext, MEMORY_SYSTEM_DESCRIPTION } from "./workspace";

const WORKSPACE = env.WORKSPACE_PATH;

// ── Tool table types ─────────────────────────────────────────────────────────

type Input = Record<string, unknown>;

/** Extract the narrowed type from an assertion function. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Asserted<F> = F extends ((i: any) => asserts i is infer T) ? T : Input;

/** A single tool-table entry: validate narrows, execute receives the narrowed type. */
interface ToolEntry<V extends (i: Input) => void> {
	validate: V;
	execute: (i: Asserted<V>) => Promise<string> | string;
}

/** Helper to build a correctly-typed entry (lets TS infer V per call site). */
function tool<V extends (i: Input) => void>(entry: ToolEntry<V>): ToolEntry<V> {
	return entry;
}

/** The runtime shape used by dispatchTool — erases per-entry generics. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolTable = Record<string, { validate: (i: Input) => void; execute: (i: any) => Promise<string> | string }>;

/** Handlers backed by AgentRunner state that the tool table delegates to. */
interface ToolHandlers {
	queueQuestion: (input: QuestionInput) => Promise<string>;
	urgentQuestion: (input: QuestionInput) => Promise<string>;
	sendReport: (input: SendReportInput) => Promise<string>;
	sendGraph: (input: SendGraphInput) => Promise<string>;
}

function buildToolTable(db: Db, sessionId: string, handlers: ToolHandlers): ToolTable {
		return {
			// ── File system ─────────────────────────────────────────────────────────
			grep: tool({
				validate: validateGrep,
				execute: (i) => grep(i.pattern, i.path ?? ".", i.include, i.flags ?? ""),
			}),
			glob: tool({
				validate: validateGlob,
				execute: (i) => glob(i.pattern, i.path ?? "."),
			}),
			read_file: tool({
				validate: validateReadFile,
				execute: (i) => readFile(i.path),
			}),
			write_file: tool({
				validate: validateWriteFile,
				execute: async (i) => {
					await writeFile(i.path, i.content);
					return `Written to ${i.path}`;
				},
			}),
			list_directory: tool({
				validate: validateListDirectory,
				execute: (i) => listDirectory(i.path ?? ""),
			}),
			search_files: tool({
				validate: validateSearchFiles,
				execute: (i) =>
					searchFiles(i.pattern, i.path ?? ".", i.file_pattern ?? "*", i.case_sensitive ?? false, i.max_results ?? 100),
			}),
			edit_file: tool({
				validate: validateEditFile,
				execute: (i) => editFile(i.path, i.old_string, i.new_string, i.replace_all ?? false),
			}),
			move_file: tool({
				validate: validateMoveFile,
				execute: (i) => moveFile(i.source, i.destination),
			}),
			delete_file: tool({
				validate: validateDeleteFile,
				execute: (i) => deleteFile(i.path, i.recursive ?? false),
			}),
			create_directory: tool({
				validate: validateCreateDirectory,
				execute: (i) => createDirectory(i.path),
			}),
			get_file_info: tool({
				validate: validateGetFileInfo,
				execute: (i) => getFileInfo(i.path),
			}),
			read_file_range: tool({
				validate: validateReadFileRange,
				execute: (i) => readFileRange(i.path, i.start_line, i.end_line),
			}),

			// ── Memory ─────────────────────────────────────────────────────────────
			remember: tool({
				validate: validateRemember,
				execute: (i) => remember(i.type, i.title, i.content, i.metadata),
			}),
			update_memory: tool({
				validate: validateUpdateMemory,
				execute: async (i) => {
					await updateMemory(i.id, {
						title: i.title,
						content: i.content,
						type: i.type,
						metadata: i.metadata,
					});
					return "Memory updated.";
				},
			}),
			delete_memory: tool({
				validate: validateDeleteMemory,
				execute: async (i) => {
					await deleteMemory(i.id);
					return "Memory deleted.";
				},
			}),

			// ── Questions ──────────────────────────────────────────────────────────
			queue_question: tool({
				validate: validateQuestion,
				execute: (i) => handlers.queueQuestion(i),
			}),
			urgent_question: tool({
				validate: validateQuestion,
				execute: (i) => handlers.urgentQuestion(i),
			}),

			// ── Reports ────────────────────────────────────────────────────────────
			send_report: tool({
				validate: validateSendReport,
				execute: (i) => handlers.sendReport(i),
			}),
			send_graph: tool({
				validate: validateSendGraph,
				execute: (i) => handlers.sendGraph(i),
			}),

			// ── Task management ────────────────────────────────────────────────────
			add_task: tool({
				validate: validateAddTask,
				execute: (i) => addTask(db, sessionId, i.text, i.status, i.dependsOn),
			}),
			list_tasks: tool({
				validate: validateListTasks,
				execute: (i) => listTasks(db, i.filter ?? "all"),
			}),
			update_task: tool({
				validate: validateUpdateTask,
				execute: (i) => updateTask(db, sessionId, i.id, i.status, i.text, i.dependsOn),
			}),
			set_current_task: tool({
				validate: validateSetCurrentTask,
				execute: (i) => setCurrentTask(db, sessionId, i.id),
			}),
			get_current_task: tool({
				validate: () => {},
				execute: () => getCurrentTask(db),
			}),

			// ── Web ────────────────────────────────────────────────────────────────
			web_search: tool({
				validate: validateWebSearch,
				execute: (i) => webSearch(i.query, i.limit ?? 8),
			}),
			web_fetch: tool({
				validate: validateWebFetch,
				execute: (i) => webFetch(i.url, i.max_chars ?? 20_000),
			}),
		};
	}

// ── Types ─────────────────────────────────────────────────────────────────────

export type FreezeReportMode = "always" | "never" | "custom";
export type FreezeAskMode = "always" | "requiredOnly" | "onReportOnly" | "never";
export type AlwaysImproveMode = "yes" | "no" | "custom";

export interface RunnerConfig {
	db: Db;
	sessionId: string;
	reportIntervalMins: number;
	totalTimeoutMins: number;
	freezeReportMode: FreezeReportMode;
	freezeReportCustomRule: string | null;
	freezeAskMode: FreezeAskMode;
	compactThresholdTokens: number;
	stopThresholdTokens: number;
	alwaysImproveMode: AlwaysImproveMode;
	alwaysImproveScope: string | null;
}

// ── System prompt ─────────────────────────────────────────────────────────────

/**
 * Read the rendered per-project context (tech stacks / guidelines / local
 * instructions). The host writes it next to the agent DB, which is mounted
 * into the container, so no host-DB round-trip is needed. Returns "" when the
 * project has no context configured.
 */
function readProjectContext(): string {
	try {
		const path = join(dirname(env.DATABASE_PATH), "project-context.md");
		if (!existsSync(path)) return "";
		return readFileSync(path, "utf-8").trim();
	} catch {
		return "";
	}
}

function buildSystemPrompt(cfg: RunnerConfig): string {
	const projectContext = readProjectContext();
	return `You are an autonomous software engineering agent running unattended in a sandboxed Docker container. Your workspace is /workspace — every file you touch lives there. No human is watching in real time; you report asynchronously and keep working.

Assist with authorized engineering and defensive security work. Refuse to build malware, destructive payloads, or anything designed to cause harm.

# Doing the work
Read before you change. Understand the existing code, conventions, and tests before editing. Match the surrounding style rather than introducing your own.

Solve the task that was asked — no more. Don't over-engineer, don't add abstractions or configurability the task doesn't need, and don't add error handling for cases that can't happen. Don't create files (especially docs) unless they're required for the task.

Plan first: use \`add_task\` to break work into trackable steps, then \`set_current_task\` as you progress through them. Work in focused, committable chunks. Use the memory tools to persist what you learn about the codebase across sessions.

# Acting with care
Weigh reversibility and blast radius before each action. Reading files, searching, and editing in the workspace are cheap and reversible — just do them. Pausing to confirm is cheap; an unwanted action (lost work, a bad commit, deleted state) can be expensive.

Commit only completed units of work via \`commit_changes\` (it runs quality checks automatically — never bypass them). Use conventional commit messages: \`type(scope): message\` (feat, fix, refactor, docs, test, chore, perf, style). Be specific.

# Tools
Prefer the dedicated tools over shell equivalents so your work stays observable: \`read_file\` over \`cat\`, \`edit_file\` over \`sed\`, \`grep\`/\`glob\`/\`search_files\` over raw shell search. Reserve \`bash\` for things that genuinely need it.
Make independent tool calls in the same turn so they run in parallel. Call \`compact_context\` before long operations or when the conversation grows large.

Reports are permanent, immutable database records — the only audit trail of your progress. Use \`send_report\` for them; never write reports to files. Use the memory tools (\`remember\`, \`recall\`, \`update_memory\`, \`delete_memory\`, \`list_memories\`) for persistent knowledge across sessions.

# Questions and reporting
Front-load clarifying questions with \`ask_checklist\` at the start; later, use \`urgent_question\` only when truly blocked. Send a report at each meaningful milestone, not just when the timer fires.

# Tone
You write for an engineer reading reports asynchronously. Be concise and direct — lead with the result, skip preamble. Use markdown; minimal emoji.

${MEMORY_SYSTEM_DESCRIPTION}
${projectContext ? `\n${projectContext}\n` : ""}
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
- never: decide autonomously; questions accumulate in memory and surface at timeout`;
}

// ── AgentRunner ───────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}
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
	private stopped = false;
	private totalTokensConsumed = 0;

	// Plan mode
	private planMode = false;

	// Token budget management
	private lastApiInputTokens = 0;
	private lastUserMessageId: string | null = null;
	private circuitBreaker = new CompactionCircuitBreaker();
	private lastWarningState: TokenWarningState = "normal";

	// Abort / interject
	private abortController = new AbortController();
	private injectedMessage: string | null = null;

	// Question accumulation
	private pendingQuestions: Question[] = [];

	private readonly db: Db;
	private readonly sessionId: string;
	private readonly systemPrompt: string;

	constructor(config: RunnerConfig) {
		this.client = new Anthropic({
			apiKey: env.ANTHROPIC_API_KEY,
			baseURL: env.ANTHROPIC_BASE_URL,
		});
		this.db = config.db;
		this.sessionId = config.sessionId;
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
		this.toolTable = buildToolTable(this.db, this.sessionId, {
			queueQuestion: (i) => this.handleQueueQuestion(i),
			urgentQuestion: (i) => this.handleUrgentQuestion(i),
			sendReport: (i) => this.handleSendReport(i),
			sendGraph: (i) => this.handleSendGraph(i),
		});
	}

	stop() {
		this.stopped = true;
		this.abortController.abort("stop");
	}

	interject(text: string) {
		this.injectedMessage = text;
		this.abortController.abort("interject");
	}

	// ── Shared helpers ────────────────────────────────────────────────────────

	/** Update the session status in the DB and notify listeners. */
	private setStatus(status: "error" | "running" | "paused" | "compacting" | "completed" | "stopped"): void {
		updateSession(this.db, this.sessionId, { status });
		sessionEmitter.emit(this.sessionId, {
			type: "session_updated",
			data: { id: this.sessionId, status },
		});
	}

	/** Emit a "message" timeline event, filling in the boilerplate fields. */
	private emitMessage(data: {
		id: string;
		role: "user" | "assistant" | "system";
		content: unknown;
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		error?: string;
		errorDetails?: string;
	}): void {
		sessionEmitter.emit(this.sessionId, {
			type: "message",
			data: {
				id: data.id,
				sessionId: this.sessionId,
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

	/** Append text as a user turn: merge into the last user message (to keep
	 * strict user/assistant alternation) or push a new one. */
	private appendUserText(text: string): void {
		const last = this.messages[this.messages.length - 1];
		if (last?.role === "user") {
			if (Array.isArray(last.content)) {
				last.content.push({ type: "text", text });
			} else {
				last.content = `${last.content}\n\n${text}`;
			}
		} else {
			this.messages.push({ role: "user", content: text });
		}
	}

	/** Persist a user message, emit it, and append it to the live context. */
	/** Persist the system prompt once as a "system"-role message so it shows in the timeline.
	 * The system prompt is sent to the API as a separate top-level param, so this row is for
	 * display only and is skipped when rebuilding the Anthropic message history on resume. */
	private recordSystemPrompt(): void {
		const id = this.saveMessage("system", this.systemPrompt, 0, 0);
		this.emitMessage({ id, role: "system", content: this.systemPrompt });
	}

	private recordUserMessage(text: string): void {
		const id = this.saveMessage("user", text, 0, 0);
		this.lastUserMessageId = id;
		this.emitMessage({ id, role: "user", content: text });
		this.appendUserText(text);
	}

	// ── Public setters for runtime config (used by Discord commands) ──────────

	setCompactThreshold(tokens: number) {
		this.compactThresholdTokens = tokens;
		updateSession(this.db, this.sessionId, { compactThresholdTokens: tokens });
	}

	setStopThreshold(tokens: number) {
		this.stopThresholdTokens = tokens;
		updateSession(this.db, this.sessionId, { stopThresholdTokens: tokens });
	}

	setAlwaysImproveMode(mode: AlwaysImproveMode, scope: string | null) {
		this.alwaysImproveMode = mode;
		this.alwaysImproveScope = scope;
		updateSession(this.db, this.sessionId, { alwaysImproveMode: mode, alwaysImproveScope: scope });
	}

	setTimeout(mins: number) {
		this.totalTimeoutMs = mins * 60_000;
		updateSession(this.db, this.sessionId, { totalTimeoutMins: mins });
	}

	setReportInterval(mins: number) {
		this.reportIntervalMs = mins * 60_000;
		updateSession(this.db, this.sessionId, { reportIntervalMins: mins });
	}

	setFreezeReportMode(mode: FreezeReportMode, customRule: string | null) {
		this.freezeReportMode = mode;
		this.freezeReportCustomRule = customRule;
		updateSession(this.db, this.sessionId, { freezeReportMode: mode, freezeReportCustomRule: customRule });
	}

	setFreezeAskMode(mode: FreezeAskMode) {
		this.freezeAskMode = mode;
		updateSession(this.db, this.sessionId, { freezeAskMode: mode });
	}

	// ── Main loop ──────────────────────────────────────────────────────────────

	async run(task: string): Promise<void> {
		// ── Bootstrap workspace ────────────────────────────────────────────
		const { isNewProject } = await bootstrapWorkspace(WORKSPACE);

		// ── Build startup context ──────────────────────────────────────────
		this.recordSystemPrompt();
		const startupMsgs = await buildStartupContext(task, isNewProject);
		this.messages = startupMsgs.map((content) => ({ role: "user", content }));
		for (const content of startupMsgs) {
			this.saveMessage("user", content, 0, 0);
		}

		await this.runLoop();
	}

	/** Resume a stopped/completed session with a new user message. */
	async resume(message: string): Promise<void> {
		const session = getSession(this.db, this.sessionId);
		if (!session) throw new Error(`Session ${this.sessionId} not found`);

		this.stopped = false;
		this.startTime = Date.now();
		this.lastReportTime = Date.now();

		// Rebuild message history from DB, merging consecutive same-role rows
		// (consecutive user rows can occur after an interrupted interject)
		const rows = getMessages(this.db, this.sessionId);
		this.messages = [];
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
			const last = this.messages[this.messages.length - 1];

			if (last?.role === role) {
				// Merge into the previous turn to keep strict user/assistant alternation
				if (Array.isArray(last.content) && Array.isArray(content)) {
					last.content.push(...content);
				} else if (Array.isArray(last.content)) {
					last.content.push({
						type: "text",
						text: String(content),
					});
				} else {
					last.content = `${last.content}\n\n${String(content)}`;
				}
			} else {
				this.messages.push({ role, content: content as MessageParam["content"] });
			}
		}

		// Append and persist the new user message
		this.recordUserMessage(message);

		this.setStatus("running");

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
				const estTokens = this.lastApiInputTokens || estimateTokens(this.messages);

				// Emit token warning state changes
				const warningInfo = calculateTokenWarningState(estTokens);
				if (warningInfo.state !== this.lastWarningState) {
					this.lastWarningState = warningInfo.state;
					sessionEmitter.emit(this.sessionId, {
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
					circuitBreakerOpen: this.circuitBreaker.isOpen,
				});

				if (this.circuitBreaker.shouldAutoCompact(estTokens)) {
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
							this.recordUserMessage(text);
						}
						continue;
					}
					throw err;
				}

				const inputTokens = response.usage.input_tokens;
				const outputTokens = response.usage.output_tokens;
				const cacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
				const cacheWriteTokens = response.usage.cache_creation_input_tokens ?? 0;

				this.lastApiInputTokens = inputTokens;

				// Attribute input/cache-write tokens to the user message; cache-read to the assistant
				if (this.lastUserMessageId) {
					updateMessageTokens(this.db, this.lastUserMessageId, inputTokens, cacheWriteTokens);
					this.lastUserMessageId = null;
				}

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
					0,
					outputTokens,
					undefined,
					undefined,
					cacheReadTokens
				);
				this.emitMessage({ id: msgId, role: "assistant", content: response.content, outputTokens, cacheReadTokens });

				if (response.stop_reason === "end_turn") {
					const finalText = response.content
						.filter((b) => b.type === "text")
						.map((b) => b.text)
						.join("\n");

					// Always-improve: continue instead of stopping
					if (this.alwaysImproveMode !== "no") {
						const continueMsg = this.buildImproveMessage();
						this.messages.push({ role: "assistant", content: response.content });
						this.messages.push({ role: "user", content: continueMsg });
						this.lastUserMessageId = this.saveMessage("user", continueMsg, 0, 0);
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
					this.setStatus("completed");
					break;
				}

				if (response.stop_reason === "tool_use") {
					const toolBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
					this.messages.push({ role: "assistant", content: response.content });
					const toolResults = await this.executeTools(toolBlocks, msgId);
					this.messages.push({ role: "user", content: toolResults });
					this.lastUserMessageId = this.saveMessage("user", JSON.stringify(toolResults), 0, 0);

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
			const errorContent = JSON.stringify([{ type: "text", text: `An error occurred during execution: ${classified.category}` }]);
			const errorMsgId = this.saveMessage("assistant", errorContent, 0, 0, errorMessage, errorDetails);

			this.emitMessage({ id: errorMsgId, role: "assistant", content: errorContent, error: errorMessage, errorDetails });

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
		const estBefore = this.lastApiInputTokens || estimateTokens(this.messages);

		// Surface a dedicated "compacting" state while the (potentially slow)
		// summarization round-trip runs, then restore "running".
		this.setStatus("compacting");

		let messages: MessageParam[];
		let summary: string;
		try {
			({ messages, summary } = await compactMessages(this.messages, this.client));
			this.circuitBreaker.recordSuccess();
		} catch (err) {
			this.circuitBreaker.recordFailure();
			console.error(`[Agent ${this.sessionId}] Compaction failed (attempt ${this.circuitBreaker.failures}):`, err);
			// Restore running state (finally) and continue without compacting
			return;
		} finally {
			this.setStatus("running");
		}
		this.messages = messages;
		// Reset — message array is restructured after compaction
		this.lastApiInputTokens = 0;
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

	private shouldFreeze(freezeOverride?: "freeze" | "continue"): boolean {
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

		const freeze = forceFreeze || this.shouldFreeze(freezeOverride);
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

		this.setStatus("paused");

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

			const result = await sendReport(this.sessionId, report, trigger, freeze, questionsToAsk, this.abortController.signal);

			if (result?.confirmed) {
				confirmed = true;
				this.injectAnswers(result.answers, pending);
			}
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

			this.setStatus("running");
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
			sections.push({ title: "Accumulated Questions", content: questionsMd });
		}
		await this.triggerReport({ title: "⏰ Total Timeout — Agent Frozen", sections }, "completion", true);
		this.setStatus("stopped");
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
		this.setStatus("stopped");
	}

	private async flushQuestionsToDiscord(): Promise<void> {
		if (this.pendingQuestions.length === 0) return;
		const pending = this.drainPending();

		const result = await sendReport(
			this.sessionId,
			{ title: "❓ Questions", sections: [] },
			"manual",
			true,
			pending,
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

Use \`add_task\` to track new improvements. Keep committing.`;
		}

		// "custom" mode: keep improving, but only within the configured scope
		return `You have completed the initial task. Continue improving within this scope ONLY: ${this.alwaysImproveScope ?? ""}
Do NOT work outside this scope. Use \`add_task\` to track new improvements. Keep committing.`;
	}

	// ── Anthropic API ──────────────────────────────────────────────────────────────
	private async callAnthropicApi(): Promise<Anthropic.Message> {
		const makeRequest = async (maxTokens: number): Promise<Anthropic.Message> => {
			const stream = this.client.messages.stream(
				{
					model: env.ANTHROPIC_MODEL,
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

	// ── Persistence helpers ─────────────────────────────────────────────────────

	private saveMessage(
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

	private makeQuestion(input: QuestionInput, isUrgent: boolean): Question {
		const suggestions = input.suggestions ? JSON.stringify(input.suggestions) : null;
		return {
			id: nanoid(),
			sessionId: this.sessionId,
			checkinId: null,
			text: input.question,
			context: input.context ?? null,
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

	private async executeTools(blocks: Anthropic.ToolUseBlock[], messageId: string): Promise<Anthropic.ToolResultBlockParam[]> {
		const results: Anthropic.ToolResultBlockParam[] = [];
		const sessionId = this.sessionId;

		for (const block of blocks) {
			const toolCallId = nanoid();
			const toolName = block.name;
			const toolUseId = block.id;

			const input = JSON.stringify(block.input);
			const createdAt = Date.now();

			insertToolCall(this.db, { id: toolCallId, sessionId, messageId, toolName, toolUseId, input, status: "pending", createdAt });
			sessionEmitter.emit(this.sessionId, {
				type: "tool_call",
				data: { id: toolCallId, input: block.input, sessionId, toolName, toolUseId, status: "pending", createdAt },
			});

			let output: string;
			let status: "success" | "error" = "success";

			try {
				if (!isObj(block.input)) throw new Error("Tool input is not an object.");
				output = await this.dispatchTool(block.name, block.input);

				// Truncate oversized tool results to prevent context bloat
				output = truncateToolResult(output);
			} catch (err) {
				// Per-tool validators throw ToolValidationError with a descriptive,
				// self-correctable message; surface it distinctly from runtime errors.
				output = err instanceof ToolValidationError ? `Validation error:\n${err.message}` : `Error: ${err}`;
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

	// ── Tool dispatch table ───────────────────────────────────────────────────────
	// Simple tools that follow validate → execute → return string. Keeps dispatchTool focused on
	// cases that need custom control flow (plan mode, formatting, state mutations).

	private readonly toolTable: ToolTable;

	private async dispatchTool(name: string, input: Record<string, unknown>): Promise<string> {
		// ── Plan mode enforcement ────────────────────────────────────────────────────
		if (this.planMode) {
			if (!isPlanModeToolAllowed(name)) {
				return PLAN_MODE_BLOCKED_MESSAGE;
			}
			if (name === "bash" && !isBashCommandReadOnly(typeof input.command === "string" ? input.command : "")) {
				return PLAN_MODE_BASH_BLOCKED_MESSAGE;
			}
		}

		// ── Table-driven dispatch for simple validate → execute tools ─────────────
		const entry = this.toolTable[name];
		if (entry) {
			entry.validate(input);
			return await entry.execute(input);
		}

		// ── Tools requiring custom control flow ──────────────────────────────────────
		switch (name) {
			case "enter_plan_mode": {
				this.planMode = true;
				sessionEmitter.emit(this.sessionId, { type: "plan_mode", data: { active: true } });
				return "Entered plan mode. Only read-only tools are available (grep, glob, read_file, list_directory, search_files, bash read-only commands). Call exit_plan_mode when ready to implement.";
			}
			case "exit_plan_mode": {
				validateExitPlanMode(input);
				this.planMode = false;
				const summary = input.plan_summary;
				sessionEmitter.emit(this.sessionId, { type: "plan_mode", data: { active: false, summary } });
				return summary ? `Exited plan mode. Plan summary recorded:\n${summary}` : "Exited plan mode. Full tool access restored.";
			}
			case "bash": {
				validateBash(input);
				const r = await executeBash(input.command, input.timeout_ms ?? 30_000);
				return [r.stdout ? `STDOUT:\n${r.stdout}` : "", r.stderr ? `STDERR:\n${r.stderr}` : "", `Exit code: ${r.exitCode}`]
					.filter(Boolean)
					.join("\n");
			}
			case "recall": {
				validateRecall(input);
				const results = await recall(input.query, input.type, input.limit ?? 10);
				return results.length > 0
					? results.map((r) => `[${r.id}] (${r.type}) ${r.title}:\n${r.content}`).join("\n\n---\n\n")
					: "No matching memories found.";
			}
			case "list_memories": {
				validateListMemories(input);
				const entries = await listMemories(input.type, input.limit ?? 100);
				return entries.length > 0
					? entries.map((e) => `[${e.id}] (${e.type}) ${e.title}: ${e.content.slice(0, 150)}`).join("\n")
					: "No memories found.";
			}
			case "commit_changes": {
				validateCommitChanges(input);
				const result = await commitChanges(WORKSPACE, input.message, !(input.skip_checks as boolean));
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
			case "ask_checklist": {
				validateAskChecklist(input);
				const result = await sendChecklist(
					this.sessionId,
					input.title,
					input.items as ChecklistItem[],
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
			default:
				return `Unknown tool: ${name}`;
		}
	}

	// ── Question handlers ──────────────────────────────────────────────────────────────

	private async handleQueueQuestion(input: QuestionInput): Promise<string> {
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

	private async handleUrgentQuestion(input: QuestionInput): Promise<string> {
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
						sections: [{ title: "Context", content: input.context ?? "Agent is blocked." }],
					},
					"urgent",
					true
				);
				return q.answer ?? "No answer received — proceeding with best judgment.";
			}
			case "never":
				await this.appendToQuestionsFile(q);
				return "Logged to memory — proceeding with best judgment.";
		}
	}

	private async handleSendReport(input: SendReportInput): Promise<string> {
		const report: ReportData = {
			title: input.title,
			sections: input.sections,
			mermaid_diagrams: input.mermaid_diagrams,
		};

		const freeze = this.shouldFreeze(input.freeze_override);
		const pending = this.drainPending();
		const questionsToAsk = freeze ? pending : [];

		this.setStatus("paused");

		try {
			const result = await sendReport(this.sessionId, report, "manual", freeze, questionsToAsk, this.abortController.signal);

			insertReport(this.db, {
				id: nanoid(),
				sessionId: this.sessionId,
				trigger: "manual",
				title: report.title,
				content: JSON.stringify(report),
			});

			// Record in vector memory for semantic recall
			remember("report", report.title, report.sections.map((s) => `${s.title ?? ""}\n${s.content}`).join("\n\n")).catch(() => {});

			if (result?.confirmed) this.injectAnswers(result.answers, pending);
		} finally {
			this.setStatus("running");
		}

		return freeze ? "Report sent and user acknowledged." : "Report sent (continuing).";
	}

	private async handleSendGraph(input: SendGraphInput): Promise<string> {
		const definition = input.definition;
		const title = input.title || undefined;

		const { renderMermaid } = await import("./mermaid");
		const png = await renderMermaid(definition);

		const { sendGraph } = await import("./discord");
		await sendGraph(this.sessionId, png, title);

		return "Graph sent to Discord.";
	}
}
