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

// ── Exploration prompt ─────────────────────────────────────────────────────────

export function buildExplorationPrompt(hasExistingMemories: boolean): string {
	if (hasExistingMemories) {
		return `**STARTUP TASK — Codebase Exploration (complete before implementing anything)**

The workspace already contains code. Explore and document it:

1. **Recall** previous memory with \`recall("project overview")\` — restore context from prior sessions.
2. **Check** for active tasks: \`list_tasks\` and plans: \`list_memories("plan")\` — carry over unfinished work.
3. **Explore** anything that's changed or unfamiliar — read key files, check for new modules.
4. **Update** memory if you discover anything new or outdated.

Then proceed to the main task.`;
	}

	return `**STARTUP TASK — Codebase Exploration (complete before implementing anything)**

The workspace already contains code but this is your first session. Explore and document it:

1. **Explore** project structure with \`list_directory\` and read key files:
   - Package manifests (package.json, pyproject.toml, go.mod, Cargo.toml, …)
   - README.md, CONTRIBUTING.md, docs/
   - Entry points, main modules, test directories
2. **Remember** what you learn:
   - \`remember("memory", "Architecture", "...")\` — system design, components, data flow
   - \`remember("memory", "Codebase Map", "...")\` — key files, modules, entry points
   - \`remember("memory", "Conventions", "...")\` — coding style, naming, commit format
   - \`remember("memory", "Tech Stack", "...")\` — languages, frameworks, tools
   - \`remember("context", "Project Goals", "...")\` — goals, constraints, stakeholders

Then proceed to the main task.`;
}

// ── Startup context ────────────────────────────────────────────────────────────

export async function buildStartupContext(task: string, isNewProject: boolean): Promise<string[]> {
	const messages: string[] = [];

	// Load relevant memories from vector DB (skip for brand-new projects — nothing to recall)
	let hasExistingMemories = false;
	if (!isNewProject) {
		try {
			const context = await recall("project overview architecture current state", undefined, 5);
			if (context.length > 0) {
				hasExistingMemories = true;
				const summary = context.map((e) => `**[${e.type}] ${e.title}:**\n${e.content.slice(0, 500)}`).join("\n\n");
				messages.push(`**Recalled project context:**\n\n${summary}`);
			}

			const plans = await listMemories("plan", 3);
			if (plans.length > 0) {
				hasExistingMemories = true;
				const planSummary = plans.map((e) => `- **${e.title}:** ${e.content.slice(0, 200)}`).join("\n");
				messages.push(`**Active plans:**\n\n${planSummary}`);
			}
		} catch {
			// LanceDB not available — proceed without memory context
		}

		// Exploration prompt for existing projects
		messages.push(buildExplorationPrompt(hasExistingMemories));
	}

	// Main task
	messages.push(task);
	return messages;
}
