import { initGitRepo, isGitRepo } from "./git";
import { executeBash } from "./tools/implementations/commands";
import { listMemories, recall, remember } from "./tools/implementations/memory";

// ── Role documentation injected into the system prompt ───────────────────────

export const MEMORY_SYSTEM_DESCRIPTION = `
## Persistent Vector Memory

Your memory is stored in a shared vector database and persists across sessions.
You interact with it through these tools:

| Tool | Purpose |
|---|---|
| \`remember\` | Store a new entry (decision, plan, memory, context) |
| \`recall\` | Semantic search — find relevant entries by natural language query |
| \`update_memory\` | Modify an existing entry by ID |
| \`delete_memory\` | Remove an outdated entry by ID |
| \`list_memories\` | Browse all entries, optionally filtered by type |

### Entry Types
- **decision** — Architectural or design decisions (append-only mindset: prefer adding new over deleting old)
- **todo** — Pending work items with priority and dependencies
- **plan** — Implementation plans (current and archived)
- **question** — Accumulated questions for the user
- **memory** — General project knowledge (architecture, conventions, tech stack, codebase notes)
- **report** — Progress report summaries
- **context** — Project goals, constraints, stakeholders

### Guidelines
- At session start: \`recall\` your previous context with queries like "project overview", "current plan", "active todos"
- Record decisions as you make them — future sessions depend on this
- Use descriptive titles — they're weighted in search ranking
- Prefer semantic search (\`recall\`) over listing when looking for specific knowledge
`;

// ── Workspace bootstrap ────────────────────────────────────────────────────────

export async function bootstrapWorkspace(workspace: string): Promise<{
	isNewRepo: boolean;
	isNewProject: boolean;
}> {
	const isNew = !(await isGitRepo(workspace));
	if (isNew) await initGitRepo(workspace);

	// Detect whether the workspace already has a real project
	const { stdout } = await executeBash(
		`find "${workspace}" -maxdepth 2 -not -path '*/.git/*' -not -path '*/node_modules/*' -not -name '.gitignore' -type f | head -20`
	);
	const isNewProject = stdout.trim().split("\n").filter(Boolean).length === 0;

	// Seed initial memory entries if the project has no memories yet
	try {
		const existing = await listMemories(undefined, 1);
		if (!existing || existing.length === 0) {
			await remember("context", "Project initialized", "New project workspace created. No context recorded yet.");
		}
	} catch {
		// LanceDB might not be ready yet on first boot — non-fatal
	}

	return { isNewRepo: isNew, isNewProject };
}

// ── Exploration prompt ─────────────────────────────────────────────────────────

export function buildExplorationPrompt(hasExistingMemories: boolean): string {
	if (hasExistingMemories) {
		return `**STARTUP TASK — Codebase Exploration (complete before implementing anything)**

The workspace already contains code. Explore and document it:

1. **Recall** previous memory with \`recall("project overview")\` — restore context from prior sessions.
2. **Check** for active todos: \`list_memories("todo")\` and plans: \`list_memories("plan")\` — carry over unfinished work.
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

export async function buildStartupContext(_workspace: string, task: string, isNewProject: boolean): Promise<string[]> {
	const msgs: string[] = [];

	// Load relevant memories from vector DB (skip for brand-new projects — nothing to recall)
	let hasExistingMemories = false;
	if (!isNewProject) {
		try {
			const context = await recall("project overview architecture current state", undefined, 5);
			if (context.length > 0) {
				hasExistingMemories = true;
				const summary = context.map((e) => `**[${e.type}] ${e.title}:**\n${e.content.slice(0, 500)}`).join("\n\n");
				msgs.push(`**Recalled project context:**\n\n${summary}`);
			}

			const plans = await listMemories("plan", 3);
			if (plans.length > 0) {
				hasExistingMemories = true;
				const planSummary = plans.map((e) => `- **${e.title}:** ${e.content.slice(0, 200)}`).join("\n");
				msgs.push(`**Active plans:**\n\n${planSummary}`);
			}

			const todos = await listMemories("todo", 10);
			if (todos.length > 0) {
				hasExistingMemories = true;
				const todoSummary = todos.map((e) => `- ${e.title}: ${e.content.slice(0, 100)}`).join("\n");
				msgs.push(`**Pending todos:**\n\n${todoSummary}`);
			}
		} catch {
			// LanceDB not available — proceed without memory context
		}

		// Exploration prompt for existing projects
		msgs.push(buildExplorationPrompt(hasExistingMemories));
	}

	// Main task
	msgs.push(
		`**Main task:**\n\n${task}\n\nBefore coding:\n1. Use \`ask_checklist\` to surface all ambiguities.\n2. \`remember("todo", "Task Title", "description")\` to track the task.\n3. \`remember("plan", "Plan: Task Title", "step-by-step plan")\` with a detailed plan.\n4. Then begin implementation.`
	);

	return msgs;
}
