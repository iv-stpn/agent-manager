import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources";

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

		// Only extract text blocks — skip tool_use, tool_result, images, etc.
		const textParts: string[] = [];
		for (const block of msg.content) {
			if (block.type === "text" && (block as Anthropic.TextBlock).text?.trim()) {
				textParts.push((block as Anthropic.TextBlock).text.trim());
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
	if (messages.length <= 4) {
		// Not enough messages to compact meaningfully
		return { messages, summary: "" };
	}

	// Extract only conversational text (no tool calls/results)
	const transcript = extractConversationText(messages);

	if (!transcript.trim()) {
		return { messages, summary: "" };
	}

	const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

	let summary = "";
	try {
		const resp = await client.messages.create({
			model,
			max_tokens: 2048,
			messages: [
				{
					role: "user",
					content: `You are summarizing a past agent conversation to create a memory for the next conversation cycle. Focus ONLY on the dialogue — ignore any tool calls or tool results.

Summarize the following conversation into a structured memory (≤1000 words). Preserve:
- The original task/goal
- Key decisions made and their rationale
- Important discoveries about the codebase
- Current progress and what was completed
- Outstanding issues or next steps
- Any user preferences or corrections expressed

CONVERSATION:
${transcript.slice(0, 50000)}

Provide ONLY the summary — no preamble.`,
				},
			],
		});

		summary = resp.content
			.filter((b) => b.type === "text")
			.map((b) => (b as Anthropic.TextBlock).text)
			.join("\n");
	} catch {
		summary = `[${messages.length} messages compacted — summary unavailable]`;
	}

	// Restart the conversation with just a context primer from the memory
	const restartMessage: MessageParam = {
		role: "user",
		content: `[CONVERSATION MEMORY — This is a continuation of a previous conversation within the same session. Here is what happened before:]

${summary}

[END OF MEMORY — The conversation is now restarting. Continue working on the task from where you left off. Do NOT repeat completed work or send a status report. Pick up from the next incomplete step.]`,
	};

	return {
		messages: [restartMessage],
		summary,
	};
}
