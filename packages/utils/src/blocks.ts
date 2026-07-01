import type Anthropic from "@anthropic-ai/sdk";

export interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	input?: Record<string, unknown>;
	id?: string;
	tool_use_id?: string;
	content?: string | ContentBlock[];
	is_error?: boolean;
}

/** Extract and join all text blocks from an Anthropic API content array. */
export function extractTextContent(content: Anthropic.Messages.ContentBlock[]): string {
	return content
		.filter((block): block is Anthropic.Messages.TextBlock => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Convert content blocks or strings to a single string representation. */
export function stringifyResult(content: string | ContentBlock[] | undefined): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	try {
		return content.map((block) => (typeof block === "string" ? block : (block.text ?? JSON.stringify(block)))).join("\n");
	} catch {
		return JSON.stringify(content);
	}
}
