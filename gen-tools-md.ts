import { AGENT_TOOLS } from "./project-template/src/agent/tools/definitions";
import { readFileSync, writeFileSync } from "fs";

const source = readFileSync("project-template/src/agent/tools/definitions.ts", "utf8");

// Map each tool name → its group by scanning comment headers
const toolGroup = new Map<string, string>();
const groupOrder: string[] = [];
let currentGroup = "General";

for (const line of source.split("\n")) {
	const groupMatch = line.match(/\/\/ ── (.+?) ─+/);
	if (groupMatch) {
		currentGroup = groupMatch[1].trim();
		if (!groupOrder.includes(currentGroup)) groupOrder.push(currentGroup);
	}
	const nameMatch = line.match(/^\s*name:\s*"(.+?)"/);
	if (nameMatch) toolGroup.set(nameMatch[1], currentGroup);
}

// Bucket tools by group, preserving definition order
const grouped = new Map<string, typeof AGENT_TOOLS>(groupOrder.map((g) => [g, []]));
for (const tool of AGENT_TOOLS) {
	grouped.get(toolGroup.get(tool.name) ?? "General")?.push(tool);
}

function renderParams(schema: (typeof AGENT_TOOLS)[number]["input_schema"]): string {
	const props = schema.properties as Record<string, { type?: string; description?: string; enum?: string[] }> | undefined;
	if (!props || Object.keys(props).length === 0) return "";
	const required = new Set((schema.required as string[]) ?? []);
	const rows = Object.entries(props)
		.map(([name, p]) => {
			const type = p.enum ? p.enum.map((v) => `\`${v}\``).join(" \\| ") : `\`${p.type ?? "any"}\``;
			const desc = (p.description ?? "").replace(/\n/g, " ");
			return `| \`${name}\` | ${type} | ${required.has(name) ? "Yes" : ""} | ${desc} |`;
		})
		.join("\n");
	return `\n| Parameter | Type | Required | Description |\n|-----------|------|----------|-------------|\n${rows}\n`;
}

let md = `# Agent Tools Reference

Complete list of tools available to the autonomous agent.

---

`;

for (const group of groupOrder) {
	const tools = grouped.get(group);
	if (!tools?.length) continue;
	md += `## ${group}\n\n`;
	for (const tool of tools) {
		md += `### \`${tool.name}\`\n\n${tool.description}\n${renderParams(tool.input_schema)}\n`;
	}
}

md += `---\n\n*Generated from \`project-template/src/agent/tools/definitions.ts\`*\n`;

writeFileSync("docs/TOOLS.md", md);
console.log(`Generated docs/TOOLS.md — ${AGENT_TOOLS.length} tools across ${groupOrder.length} groups`);
