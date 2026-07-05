import { isObj } from "@agent-manager/utils";
import type Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { completeToolCall, insertToolCall } from "../../db";
import { sessionEmitter } from "../../emitter";
import { env } from "../../env";
import { truncateToolResult } from "../token-budget";
import { isToolName, ToolName } from "../tools/definitions";
import { executeBash, glob, grep } from "../tools/implementations/commands";
import {
	createDirectory,
	deleteFile,
	editFile,
	listDirectory,
	moveFile,
	readFile,
	readFileRange,
	searchFiles,
	writeFile,
} from "../tools/implementations/filesystem";
import { deleteMemory, listMemories, recall, remember, updateMemory } from "../tools/implementations/memory";
import { addTask, getCurrentTask, listTasks, setCurrentTask, updateTask } from "../tools/implementations/task";
import { webFetch, webSearch } from "../tools/implementations/web";
import {
	ToolValidationError,
	validateAddTask,
	validateAskUserQuestion,
	validateBash,
	validateCommitChanges,
	validateCreateDirectory,
	validateDeleteFile,
	validateDeleteMemory,
	validateEditFile,
	validateExitPlanMode,
	validateGlob,
	validateGrep,
	validateListDirectory,
	validateListMemories,
	validateListTasks,
	validateMoveFile,
	validateReadFile,
	validateReadFileRange,
	validateRecall,
	validateRemember,
	validateSearchFiles,
	validateSendReport,
	validateSetCurrentTask,
	validateUpdateMemory,
	validateUpdateTask,
	validateWebFetch,
	validateWebSearch,
	validateWriteFile,
} from "../tools/validators";
import type { AgentState } from "../types";
import { commitChanges } from "../utils/git";
import {
	isBashCommandReadOnly,
	PLAN_MODE_BASH_BLOCKED_MESSAGE,
	PLAN_MODE_BLOCKED_MESSAGE,
	PLAN_MODE_TOOLS,
} from "../utils/plan-mode";
import { doCompaction } from "./loop";
import { handleAskUserQuestion, handleSendReport } from "./questions";

const WORKSPACE = env.WORKSPACE_PATH;

export async function executeTools(
	agent: AgentState,
	blocks: Anthropic.ToolUseBlock[],
	messageId: string
): Promise<Anthropic.ToolResultBlockParam[]> {
	const results: Anthropic.ToolResultBlockParam[] = [];

	for (const block of blocks) {
		const toolCallId = nanoid();
		const toolName = block.name;
		const toolUseId = block.id;

		const input = JSON.stringify(block.input);
		const createdAt = Date.now();

		insertToolCall(agent.db, {
			id: toolCallId,
			sessionId: agent.sessionId,
			messageId,
			toolName,
			toolUseId,
			input,
			status: "pending",
			createdAt,
		});
		sessionEmitter.emit(agent.sessionId, {
			type: "tool_call",
			data: {
				id: toolCallId,
				input,
				sessionId: agent.sessionId,
				toolName,
				toolUseId,
				status: "pending",
				createdAt,
			},
		});

		let output: string;
		let status: "success" | "error" = "success";

		try {
			if (!isObj(block.input)) throw new Error("Tool input is not an object.");
			if (!isToolName(block.name)) throw new Error(`Unknown tool: ${block.name}`);

			output = await dispatchTool(agent, block.name, block.input);
			// Truncate oversized tool results to prevent context bloat
			output = truncateToolResult(output);
		} catch (err) {
			// Per-tool validators throw ToolValidationError with a descriptive,
			// self-correctable message; surface it distinctly from runtime errors.
			output = err instanceof ToolValidationError ? `Validation error:\n${err.message}` : `Error: ${err}`;
			status = "error";
		}

		const completedAt = Date.now();
		completeToolCall(agent.db, toolCallId, output, status);
		sessionEmitter.emit(agent.sessionId, {
			type: "tool_call",
			data: {
				id: toolCallId,
				sessionId: agent.sessionId,
				toolName,
				toolUseId,
				input,
				output,
				status,
				completedAt,
			},
		});

		results.push({ type: "tool_result", tool_use_id: block.id, content: output, is_error: status === "error" });
	}
	return results;
}

export async function dispatchTool(agent: AgentState, name: ToolName, input: Record<string, unknown>): Promise<string> {
	// ── Plan mode enforcement ────────────────────────────────────────────────────
	if (agent.planMode) {
		if (!PLAN_MODE_TOOLS.has(name)) return PLAN_MODE_BLOCKED_MESSAGE;
		if (name === ToolName.Bash && !isBashCommandReadOnly(typeof input.command === "string" ? input.command : "")) {
			return PLAN_MODE_BASH_BLOCKED_MESSAGE;
		}
	}

	switch (name) {
		// ── File system ────────────────────────────────────────────────────────
		case ToolName.Grep: {
			validateGrep(input);
			return await grep(input.pattern, input.path ?? ".", input.include, input.flags ?? "");
		}
		case ToolName.Glob: {
			validateGlob(input);
			return await glob(input.pattern, input.path ?? ".");
		}
		case ToolName.ReadFile: {
			validateReadFile(input);
			return await readFile(input.path);
		}
		case ToolName.WriteFile: {
			validateWriteFile(input);
			await writeFile(input.path, input.content);
			return `Written to ${input.path}`;
		}
		case ToolName.ListDirectory: {
			validateListDirectory(input);
			return await listDirectory(input.path ?? "");
		}
		case ToolName.SearchFiles: {
			validateSearchFiles(input);
			return await searchFiles(
				input.pattern,
				input.path ?? ".",
				input.file_pattern ?? "*",
				input.case_sensitive ?? false,
				input.max_results ?? 100
			);
		}
		case ToolName.EditFile: {
			validateEditFile(input);
			return await editFile(input.path, input.old_string, input.new_string, input.replace_all ?? false);
		}
		case ToolName.MoveFile: {
			validateMoveFile(input);
			return await moveFile(input.source, input.destination);
		}
		case ToolName.DeleteFile: {
			validateDeleteFile(input);
			return await deleteFile(input.path, input.recursive ?? false);
		}
		case ToolName.CreateDirectory: {
			validateCreateDirectory(input);
			return await createDirectory(input.path);
		}
		case ToolName.ReadFileRange: {
			validateReadFileRange(input);
			return await readFileRange(input.path, input.start_line, input.end_line);
		}

		// ── Memory ─────────────────────────────────────────────────────────────
		case ToolName.Remember: {
			validateRemember(input);
			return await remember(input.type, input.title, input.content, input.metadata);
		}
		case ToolName.UpdateMemory: {
			validateUpdateMemory(input);
			await updateMemory(input.id, {
				...(input.title !== undefined && { title: input.title }),
				...(input.content !== undefined && { content: input.content }),
				...(input.type !== undefined && { type: input.type }),
				...(input.metadata !== undefined && { metadata: input.metadata }),
			});
			return "Memory updated.";
		}
		case ToolName.DeleteMemory: {
			validateDeleteMemory(input);
			await deleteMemory(input.id);
			return "Memory deleted.";
		}
		case ToolName.Recall: {
			validateRecall(input);
			const results = await recall(input.query, input.type, input.limit ?? 10);
			return results.length > 0
				? results.map((result) => `[${result.id}] (${result.type}) ${result.title}:\n${result.content}`).join("\n\n---\n\n")
				: "No matching memories found.";
		}
		case ToolName.ListMemories: {
			validateListMemories(input);
			const entries = await listMemories(input.type, input.limit ?? 100);
			return entries.length > 0
				? entries.map((entry) => `[${entry.id}] (${entry.type}) ${entry.title}: ${entry.content.slice(0, 150)}`).join("\n")
				: "No memories found.";
		}

		// ── Questions ──────────────────────────────────────────────────────────
		case ToolName.AskUserQuestion: {
			validateAskUserQuestion(input);
			return await handleAskUserQuestion(agent, input);
		}

		// ── Reports ────────────────────────────────────────────────────────────
		case ToolName.SendReport: {
			validateSendReport(input);
			return await handleSendReport(agent, input);
		}

		// ── Task management ────────────────────────────────────────────────────
		case ToolName.AddTask: {
			validateAddTask(input);
			return await addTask(agent.db, agent.sessionId, input.text, input.status, input.dependsOn);
		}
		case ToolName.ListTasks: {
			validateListTasks(input);
			return await listTasks(agent.db, input.filter ?? "all");
		}
		case ToolName.UpdateTask: {
			validateUpdateTask(input);
			return await updateTask(agent.db, agent.sessionId, input.id, input.status, input.text, input.dependsOn);
		}
		case ToolName.SetCurrentTask: {
			validateSetCurrentTask(input);
			return await setCurrentTask(agent.db, agent.sessionId, input.id);
		}
		case ToolName.GetCurrentTask: {
			return await getCurrentTask(agent.db);
		}

		// ── Web ────────────────────────────────────────────────────────────────
		case ToolName.WebSearch: {
			validateWebSearch(input);
			return await webSearch(input.query, input.limit ?? 8);
		}
		case ToolName.WebFetch: {
			validateWebFetch(input);
			return await webFetch(input.url, input.max_chars ?? 20_000);
		}

		// ── Plan mode ──────────────────────────────────────────────────────────
		case ToolName.EnterPlanMode: {
			agent.planMode = true;
			sessionEmitter.emit(agent.sessionId, { type: "plan_mode", data: { active: true } });
			return "Entered plan mode. Only read-only tools are available (grep, glob, read_file, list_directory, search_files, bash read-only commands). Call exit_plan_mode when ready to implement.";
		}
		case ToolName.ExitPlanMode: {
			validateExitPlanMode(input);
			agent.planMode = false;
			const summary = input.plan_summary;
			sessionEmitter.emit(agent.sessionId, { type: "plan_mode", data: { active: false, summary } });
			return summary ? `Exited plan mode. Plan summary recorded:\n${summary}` : "Exited plan mode. Full tool access restored.";
		}

		// ── Shell ──────────────────────────────────────────────────────────────
		case ToolName.Bash: {
			validateBash(input);
			const r = await executeBash(input.command, input.timeout_ms ?? 30_000);
			return [r.stdout ? `STDOUT:\n${r.stdout}` : "", r.stderr ? `STDERR:\n${r.stderr}` : "", `Exit code: ${r.exitCode}`]
				.filter(Boolean)
				.join("\n");
		}

		// ── Utilities ──────────────────────────────────────────────────────────
		case ToolName.CommitChanges: {
			validateCommitChanges(input);
			const result = await commitChanges(WORKSPACE, input.message, !(input.skip_checks as boolean));
			return result.success
				? `Committed: ${result.commit ?? "unknown"}\n\n${result.output.slice(0, 2000)}`
				: `Commit failed:\n\n${result.output.slice(0, 2000)}`;
		}
		case ToolName.CompactContext: {
			const before = agent.messages.length;
			// Route through the same path as the automatic threshold-triggered
			// compaction so the DB bookkeeping (compactedOut flags, the compaction
			// row, token counters) stays in sync — without it, a later resume/restart
			// would rebuild from the full pre-compaction transcript instead of the
			// summary, since nothing marked the old messages as summarized out.
			await doCompaction(agent);
			// doCompaction can bail (too little to summarize) or fail (summarization
			// error) without touching agent.messages — don't claim success then.
			return agent.messages.length < before
				? `Context compacted: ${before} → ${agent.messages.length} messages.`
				: "Compaction skipped: not enough content to summarize (or summarization failed — it will retry automatically).";
		}

		default:
			return `Unknown tool: ${name}`;
	}
}
