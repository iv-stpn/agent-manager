import type Anthropic from "@anthropic-ai/sdk";

/** Extract and join all text blocks from an Anthropic API content array. */
export function extractTextContent(content: Anthropic.Messages.ContentBlock[]): string {
	return content
		.filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}
