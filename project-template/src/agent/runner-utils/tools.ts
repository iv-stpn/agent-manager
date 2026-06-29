import type Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { completeToolCall, insertToolCall } from "../../db";
import { sessionEmitter } from "../../emitter";
import { env } from "../../env";
import type { ChecklistItem } from "../../external/discord";
import { sendChecklist } from "../../external/discord";
import { compactMessages } from "../context";
import type { AgentState } from "../runner-types";
import { truncateToolResult } from "../token-budget";
import { buildToolTable } from "../tool-table";
import { isToolName, ToolName } from "../tools/definitions";
import { executeBash } from "../tools/implementations/commands";
import { listMemories, recall } from "../tools/implementations/memory";
import {
	ToolValidationError,
	validateAskChecklist,
	validateBash,
	validateCommitChanges,
	validateExitPlanMode,
	validateListMemories,
	validateRecall,
} from "../tools/validators";
import { commitChanges } from "../utils/git";
import {
	isBashCommandReadOnly,
	isPlanModeToolAllowed,
	PLAN_MODE_BASH_BLOCKED_MESSAGE,
	PLAN_MODE_BLOCKED_MESSAGE,
} from "../utils/plan-mode";
import { handleQueueQuestion, handleSendGraph, handleSendReport, handleUrgentQuestion } from "./question-handlers";

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

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
				input: block.input,
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
		if (!isPlanModeToolAllowed(name)) return PLAN_MODE_BLOCKED_MESSAGE;
		if (name === ToolName.Bash && !isBashCommandReadOnly(typeof input.command === "string" ? input.command : "")) {
			return PLAN_MODE_BASH_BLOCKED_MESSAGE;
		}
	}

	// ── Table-driven dispatch for simple validate → execute tools ─────────────
	const entry = agent.toolTable[name];
	if (entry) {
		entry.validate(input);
		return await entry.execute(input);
	}

	// ── Tools requiring custom control flow ──────────────────────────────────────
	switch (name) {
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
		case ToolName.Bash: {
			validateBash(input);
			const r = await executeBash(input.command, input.timeout_ms ?? 30_000);
			return [r.stdout ? `STDOUT:\n${r.stdout}` : "", r.stderr ? `STDERR:\n${r.stderr}` : "", `Exit code: ${r.exitCode}`]
				.filter(Boolean)
				.join("\n");
		}
		case ToolName.Recall: {
			validateRecall(input);
			const results = await recall(input.query, input.type, input.limit ?? 10);
			return results.length > 0
				? results.map((r) => `[${r.id}] (${r.type}) ${r.title}:\n${r.content}`).join("\n\n---\n\n")
				: "No matching memories found.";
		}
		case ToolName.ListMemories: {
			validateListMemories(input);
			const entries = await listMemories(input.type, input.limit ?? 100);
			return entries.length > 0
				? entries.map((e) => `[${e.id}] (${e.type}) ${e.title}: ${e.content.slice(0, 150)}`).join("\n")
				: "No memories found.";
		}
		case ToolName.CommitChanges: {
			validateCommitChanges(input);
			const result = await commitChanges(WORKSPACE, input.message, !(input.skip_checks as boolean));
			return result.success
				? `Committed: ${result.commit ?? "unknown"}\n\n${result.output.slice(0, 2000)}`
				: `Commit failed:\n\n${result.output.slice(0, 2000)}`;
		}
		case ToolName.CompactContext: {
			const before = agent.messages.length;
			const { messages: compacted } = await compactMessages(agent.messages, agent.client);
			agent.messages = compacted;
			return `Context compacted: ${before} → ${compacted.length} messages.`;
		}
		case ToolName.AskChecklist: {
			validateAskChecklist(input);
			const result = await sendChecklist(
				agent.sessionId,
				input.title,
				input.items as ChecklistItem[],
				agent.abortController.signal
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

/** Build a fresh tool table bound to this agent's question/report handlers. */
export function buildAgentToolTable(agent: AgentState): import("../tool-table").ToolTable {
	return buildToolTable(agent.db, agent.sessionId, {
		queueQuestion: (i) => handleQueueQuestion(agent, i),
		urgentQuestion: (i) => handleUrgentQuestion(agent, i),
		sendReport: (i) => handleSendReport(agent, i),
		sendGraph: (i) => handleSendGraph(agent, i),
	});
}
