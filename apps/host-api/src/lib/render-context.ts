import type { Guideline, TechStack } from "../db/schema";

/**
 * Render a project's selected tech stacks, guidelines, and local instructions
 * into the markdown block injected into the agent's system prompt. Returns an
 * empty string when there is nothing to inject (caller removes the file).
 */
export function renderProjectContext(input: { techStacks: TechStack[]; guidelines: Guideline[]; instructions: string }): string {
	const sections: string[] = [];

	for (const ts of input.techStacks) {
		const lines: string[] = [`## Tech stack: ${ts.name} (${ts.language})`];
		if (ts.description.trim()) lines.push(ts.description.trim());
		for (const entry of ts.stack) {
			const libs = entry.libraries.map((l) => (l.version ? `${l.name}@${l.version}` : l.name)).join(", ");
			lines.push(`### ${entry.label}`);
			if (libs) lines.push(`Libraries: ${libs}`);
			for (const pattern of entry.usagePatterns) lines.push(`- ${pattern}`);
		}
		sections.push(lines.join("\n"));
	}

	for (const g of input.guidelines) {
		const lines: string[] = [`## Guideline: ${g.name}`];
		if (g.description.trim()) lines.push(g.description.trim());
		if (g.content.trim()) lines.push(g.content.trim());
		sections.push(lines.join("\n"));
	}

	const instructions = input.instructions.trim();
	if (instructions) sections.push(`## Project instructions\n${instructions}`);

	if (sections.length === 0) return "";

	return `# Project context\n\nThe following tech stacks, guidelines, and instructions apply to this project. Follow them unless a task explicitly overrides them.\n\n${sections.join("\n\n")}\n`;
}
