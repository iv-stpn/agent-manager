import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import { env } from "../env";
import { extractTextContent } from "./utils/content";

// Rough token estimate: 1 token ≈ 4 chars
export function estimateTokens(messages: MessageParam[]): number {
	return Math.ceil(messages.reduce((acc, m) => acc + JSON.stringify(m.content).length, 0) / 4);
}

/**
 * Extract only the conversational text from messages, ignoring tool_use and
 * tool_result blocks. Returns a readable transcript of just the human/assistant
 * dialogue.
 */
function extractConversationText(messages: MessageParam[]): string {
	const lines: string[] = [];

	for (const msg of messages) {
		const role = msg.role.toUpperCase();

		if (typeof msg.content === "string") {
			const trimmed = msg.content.trim();
			if (trimmed) lines.push(`[${role}]: ${trimmed.slice(0, 3000)}`);
			continue;
		}

		if (!Array.isArray(msg.content)) continue;

		const textParts: string[] = [];
		for (const block of msg.content) {
			if (block.type === "text" && block.text?.trim()) {
				textParts.push(block.text.trim());
			} else if (block.type === "tool_use") {
				const toolBlock = block;
				textParts.push(`[Tool call: ${toolBlock.name}]`);
			} else if (block.type === "tool_result") {
				const resultBlock = block as { type: "tool_result"; is_error?: boolean };
				const status = resultBlock.is_error ? "error" : "success";
				textParts.push(`[Tool result: ${status}]`);
			}
		}
		if (textParts.length > 0) {
			lines.push(`[${role}]: ${textParts.join("\n").slice(0, 3000)}`);
		}
	}

	return lines.join("\n\n");
}

/**
 * Compact the conversation by summarizing it into a memory, then restarting
 * the message array with only a brief context primer. The session remains
 * visually the same (same timeline/session ID) but is technically a fresh
 * conversation with the memory of what came before.
 *
 * Returns the new (restarted) messages array and the summary that was created.
 */
export async function compactMessages(
	messages: MessageParam[],
	client: Anthropic
): Promise<{ messages: MessageParam[]; summary: string }> {
	// Not enough messages to compact meaningfully
	if (messages.length <= 4) return { messages, summary: "" };

	// Extract only conversational text (no tool calls/results)
	const transcript = extractConversationText(messages);
	if (!transcript.trim()) return { messages, summary: "" };

	const model = env.ANTHROPIC_MODEL;

	let summary = "";
	try {
		const resp = await client.messages.create({
			model,
			max_tokens: 2048,
			messages: [
				{
					role: "user",
					content: `Create a structured memory (≤1000 words) from this conversation for the next session.

Include: initial goal, key decisions, discoveries, progress, remaining work, and user preferences/corrections.

<conversation>
${transcript}
</conversation>

Output only the summary.`,
				},
			],
		});

		summary = extractTextContent(resp.content);
	} catch {
		summary = `[${messages.length} messages compacted — summary unavailable]`;
	}

	// Restart the conversation with just a context primer from the memory
	const restartMessage: MessageParam = {
		role: "user",
		content: `<previous_context>
${summary}
</previous_context>

Resume the active task or, if none is active, the next pending one.`,
	};

	return { messages: [restartMessage], summary };
}
