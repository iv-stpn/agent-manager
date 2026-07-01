import { executeBash } from "./tools/implementations/commands";
import { listMemories, recall, remember } from "./tools/implementations/memory";
import { initGitRepo, isGitRepo } from "./utils/git";

// ── Workspace bootstrap ────────────────────────────────────────────────────────

export async function bootstrapWorkspace(workspace: string): Promise<{
	isNewRepo: boolean;
	isNewProject: boolean;
	isFirstSession: boolean;
}> {
	const isNew = !(await isGitRepo(workspace));
	if (isNew) await initGitRepo(workspace);

	// Detect whether the workspace already has a real project
	const { stdout } = await executeBash(
		`find "${workspace}" -maxdepth 2 -not -path '*/.git/*' -not -path '*/node_modules/*' -not -name '.gitignore' -type f | head -20`
	);
	const isNewProject = stdout.trim().split("\n").filter(Boolean).length === 0;

	// Seed initial memory entries if the project has no memories yet
	let isFirstSession = false;
	try {
		const existing = await listMemories(undefined, 1);
		if (!existing || existing.length === 0) {
			isFirstSession = true;
			await remember("context", "Project initialized", "New project workspace created. No context recorded yet.");
		}
	} catch {
		// LanceDB might not be ready yet on first boot — non-fatal
		isFirstSession = true;
	}

	return { isNewRepo: isNew, isNewProject, isFirstSession };
}

// ── Startup context ────────────────────────────────────────────────────────────

export async function buildStartupContext(task: string, isNewProject: boolean): Promise<string[]> {
	const messages: string[] = [];

	// Load relevant memories from vector DB (skip for brand-new projects — nothing to recall)
	if (!isNewProject) {
		try {
			const context = await recall("project overview architecture current state", undefined, 5);
			if (context.length > 0) {
				const summary = context
					.map((entry) => `**[${entry.type}] ${entry.title}:**\n${entry.content.slice(0, 500)}`)
					.join("\n\n");
				messages.push(`**Recalled project context:**\n\n${summary}`);
			}

			const plans = await listMemories("plan", 3);
			if (plans.length > 0) {
				const planSummary = plans.map((entry) => `- **${entry.title}:** ${entry.content.slice(0, 200)}`).join("\n");
				messages.push(`**Active plans:**\n\n${planSummary}`);
			}
		} catch {
			// LanceDB not available — proceed without memory context
		}
	}

	// Main task
	messages.push(task);
	return messages;
}
