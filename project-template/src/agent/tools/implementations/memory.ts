import { join } from "node:path";
import { executeBash } from "./commands";
import { sandboxPath } from "./filesystem";

export const AGENT_DIR = ".agent";
export const MEMORY_DIR = join(AGENT_DIR, "memory");

export async function readMemory(file: string): Promise<string> {
	const memoryPath = file.startsWith(AGENT_DIR) ? file : join(AGENT_DIR, file);
	const abs = sandboxPath(memoryPath);
	try {
		const text = await Bun.file(abs).text();
		return text.slice(0, 50_000);
	} catch (err) {
		throw new Error(`Cannot read memory file ${file}: ${err}`);
	}
}

export async function writeMemory(file: string, content: string, append = false): Promise<string> {
	const memoryPath = file.startsWith(AGENT_DIR) ? file : join(AGENT_DIR, file);
	const abs = sandboxPath(memoryPath);

	try {
		const dir = abs.substring(0, abs.lastIndexOf("/"));
		await executeBash(`mkdir -p "${dir}"`);

		if (append) {
			const existing = await Bun.file(abs)
				.text()
				.catch(() => "");
			await Bun.write(abs, `${existing}\n${content}`);
		} else {
			await Bun.write(abs, content);
		}

		if (file.startsWith("memory/") && !append) await updateMemoryIndex(file);

		return `${append ? "Appended to" : "Written"}: ${file}`;
	} catch (err) {
		throw new Error(`Cannot write memory file ${file}: ${err}`);
	}
}

async function updateMemoryIndex(newFile: string): Promise<void> {
	const indexPath = sandboxPath(join(AGENT_DIR, "MEMORY.md"));
	try {
		const index = await Bun.file(indexPath).text();
		const fileName = newFile.replace("memory/", "");

		if (index.includes(`[${fileName}]`) || index.includes(`(${newFile})`)) return;

		const tableEnd = index.indexOf("\n_Add rows here");
		if (tableEnd > 0) {
			const newRow = `| [${fileName}](${newFile}) | _Add description here_ |\n`;
			await Bun.write(indexPath, index.substring(0, tableEnd) + newRow + index.substring(tableEnd));
		}
	} catch {
		// If MEMORY.md doesn't exist or can't be read, skip index update
	}
}

export async function searchMemory(pattern: string, caseSensitive = false): Promise<string> {
	const agentDir = sandboxPath(AGENT_DIR);
	const caseFlag = caseSensitive ? "" : "-i";

	const cmd = `cd "${agentDir}" && grep -rn ${caseFlag} -E "${pattern.replace(/"/g, '\\"')}" . 2>/dev/null | head -50`;
	const result = await executeBash(cmd, 10_000);

	if (result.exitCode !== 0 && !result.stdout) return "No matches found in memory.";
	return result.stdout || "No matches found in memory.";
}

export async function appendDecision(
	title: string,
	context: string,
	decision: string,
	rationale: string,
	consequences?: string
): Promise<string> {
	const date = new Date().toISOString().split("T")[0];
	const entry = `
## ${title} — ${date}
**Context:** ${context}
**Decision:** ${decision}
**Rationale:** ${rationale}
${consequences ? `**Consequences:** ${consequences}` : ""}
`;
	return await writeMemory("DECISIONS.md", entry, true);
}
