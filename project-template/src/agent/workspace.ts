import { join } from "node:path";
import { initGitRepo, isGitRepo } from "./git";
import { executeBash } from "./tools/implementations/commands";

// ── Fixed directory & file structure ─────────────────────────────────────────

export const AGENT_DIR = ".agent";

/**
 * All canonical paths inside .agent/
 * Never hard-code these strings elsewhere — import from here instead.
 */
export const AGENT_FILES = {
	// Root-level memory index (points into memory/)
	memory: ".agent/MEMORY.md",

	// Sub-memory folder (one file per concern)
	memoryDir: ".agent/memory",

	// Standalone decisions log (separate from per-topic memory)
	decisions: ".agent/DECISIONS.md",

	// Plans
	plansDir: ".agent/plans",
	currentPlan: ".agent/plans/CURRENT_PLAN.md",

	// Top-level tracking files
	todo: ".agent/TODO.md",
	questions: ".agent/QUESTIONS.md",

	// Reports archive
	reports: ".agent/reports",
} as const;

// ── Role documentation injected into the system prompt ───────────────────────

export const AGENT_DIR_STRUCTURE = `
## .agent/ directory — your persistent memory (fixed naming, never rename)

### 🗺 .agent/MEMORY.md  ← START HERE every session
**Root-level memory index.** Points to every sub-memory file with a one-line description of its contents.
- Read this first when resuming any task.
- Update it whenever you create or rename a file inside \`memory/\`.
- Keep the "Quick reference" block current — it's what lets you start fast.

### 📂 .agent/memory/  ← one file per concern
Each file covers exactly one topic. Update the relevant file(s) as you learn or change the codebase.

| File | Role |
|---|---|
| \`architecture.md\` | System design: components, data flow, API boundaries, infrastructure. |
| \`codebase.md\` | Key files and modules: entry points, test locations, config files, important types. |
| \`conventions.md\` | Code style, naming patterns, commit format, how new features are added. |
| \`tech-stack.md\` | Languages, frameworks, build tools, runtimes, versions, CI/CD. |
| \`dependencies.md\` | External libraries: what they do, version constraints, known issues. |
| \`context.md\` | Project goals, non-goals, constraints (perf, security, compatibility), stakeholder requirements. |

You may add files for topics not listed (e.g. \`auth.md\`, \`api-contracts.md\`). Always register them in \`MEMORY.md\`.

### 📓 .agent/DECISIONS.md  ← append-only log
Record every architectural or design decision here. **Never delete entries.**

Format per entry:
\`\`\`markdown
## [Short title] — YYYY-MM-DD
**Context:** Why this decision was needed.
**Decision:** What was decided.
**Rationale:** Why this option over alternatives.
**Consequences:** Trade-offs accepted.
\`\`\`

### 📋 .agent/TODO.md
**The master task queue** — all pending work in one place, ordered by complexity.

Format:
\`\`\`markdown
## 🔴 High Complexity
### TASK-ID: Title
**Complexity:** High | **Tags:** backend, auth
**Plan:**
1. Step one
2. Step two
**Dependencies:** List what must be done first

## 🟡 Medium Complexity
...

## 🟢 Low Complexity
...
\`\`\`

Rules:
- Before starting any task: move it from TODO.md into \`plans/CURRENT_PLAN.md\`
- After completing a task: archive the plan to \`plans/YYYY-MM-DD-slug.md\` and remove the item from TODO.md
- Keep tasks sorted: High → Medium → Low within each section
- Add tasks here as you discover them; do not leave work undocumented

### 📁 .agent/plans/
**Plan archive** — one file per completed or in-progress task.

| File | Role |
|---|---|
| \`CURRENT_PLAN.md\` | **The one active plan** — detailed checklist for what you're working on RIGHT NOW. Update checkboxes as you progress. Only one plan is current at a time. |
| \`YYYY-MM-DD-slug.md\` | Archived plans. When a task completes, copy CURRENT_PLAN.md here with the completion date + summary, then start fresh for the next task. |

\`CURRENT_PLAN.md\` format:
\`\`\`markdown
# Current Plan: [Task Title]
**Status:** In Progress | **Started:** YYYY-MM-DD
**Source task:** TODO.md TASK-ID

## Objective
One-sentence description.

## Steps
- [ ] Step one
- [x] Step two (done)

## Notes / Blockers
Any decisions, blockers, or important context discovered while working.
\`\`\`

### ❓ .agent/QUESTIONS.md
Questions accumulated for the user when \`freeze_ask_mode=never\`. Append-only. Surfaced at total timeout.
`;

// ── Workspace bootstrap ────────────────────────────────────────────────────────

export async function bootstrapWorkspace(workspace: string): Promise<{
	isNewRepo: boolean;
	isNewProject: boolean;
}> {
	const isNew = !(await isGitRepo(workspace));
	if (isNew) await initGitRepo(workspace);

	// Create the full .agent/ directory tree
	for (const dir of [
		join(workspace, AGENT_FILES.memoryDir),
		join(workspace, AGENT_FILES.plansDir),
		join(workspace, AGENT_FILES.reports),
	]) {
		await Bun.spawn(["mkdir", "-p", dir]).exited;
	}

	// Seed skeleton files if they don't exist yet
	await seedIfAbsent(join(workspace, AGENT_FILES.memory), MEMORY_INDEX_TEMPLATE);
	await seedIfAbsent(join(workspace, AGENT_FILES.decisions), DECISIONS_TEMPLATE);
	await seedIfAbsent(join(workspace, AGENT_FILES.todo), TODO_TEMPLATE);
	await seedIfAbsent(join(workspace, AGENT_FILES.currentPlan), CURRENT_PLAN_TEMPLATE);

	// Detect whether the workspace already has a real project
	const { stdout } = await executeBash(
		`find "${workspace}" -maxdepth 2 -not -path '*/.git/*' -not -path '*/.agent/*' -not -path '*/node_modules/*' -not -name '.gitignore' -type f | head -20`
	);
	const isNewProject = stdout.trim().split("\n").filter(Boolean).length === 0;

	return { isNewRepo: isNew, isNewProject };
}

async function seedIfAbsent(path: string, content: string): Promise<void> {
	if (!(await Bun.file(path).exists())) {
		await Bun.write(path, content);
	}
}

// ── Skeleton file templates ───────────────────────────────────────────────────

const MEMORY_INDEX_TEMPLATE = `# Memory Index

_Read this file first at the start of every session._
_Register every file you create in \`.agent/memory/\` here._

## Memory files

| File | Contents |
|---|---|
| [memory/architecture.md](memory/architecture.md) | System design, components, data flow |
| [memory/codebase.md](memory/codebase.md) | Key files, modules, entry points, tests |
| [memory/conventions.md](memory/conventions.md) | Code style, naming, commit patterns |
| [memory/tech-stack.md](memory/tech-stack.md) | Languages, frameworks, build tools |
| [memory/dependencies.md](memory/dependencies.md) | External libraries and their purpose |
| [memory/context.md](memory/context.md) | Project goals, constraints, stakeholders |

_Add rows here for any additional files you create in \`memory/\`._

## Quick reference
_Fill this in after exploring the codebase — lets you start fast each session._

- **Project type:** _not yet determined_
- **Entry point(s):** _unknown_
- **Test command:** _unknown_
- **Lint/format command:** _unknown_
- **Key conventions:** _none recorded yet_
`;

const DECISIONS_TEMPLATE = `# Architecture & Design Decisions

_Append-only. Never edit or delete existing entries._
_Record every significant decision here with context and rationale._

---

<!-- Template:
## [Short title] — YYYY-MM-DD
**Context:** Why this decision was needed.
**Decision:** What was decided.
**Rationale:** Why this option over alternatives.
**Consequences:** Trade-offs accepted.
-->
`;

const TODO_TEMPLATE = `# Task Queue

_Master list of all pending work. Ordered High → Medium → Low complexity._
_Before starting a task: copy it to \`.agent/plans/CURRENT_PLAN.md\`._
_After completing a task: archive the plan to \`.agent/plans/YYYY-MM-DD-slug.md\` and remove it here._

---

## 🔴 High Complexity

_Tasks requiring significant design, multiple modules, or high risk of regressions._

<!-- Example:
### TASK-001: Add authentication system
**Complexity:** High | **Tags:** auth, security, backend
**Plan:**
1. Design token schema (access + refresh)
2. Implement login / logout endpoints
3. Add middleware for route protection
4. Write integration tests
**Dependencies:** Database schema must be finalized first
-->

## 🟡 Medium Complexity

_Tasks that span 2-3 files or need moderate design effort._

## 🟢 Low Complexity

_Single-file changes, documentation, small fixes._
`;

const CURRENT_PLAN_TEMPLATE = `# Current Plan: (not started)

**Status:** Not started
**Started:** —
**Source task:** —

## Objective
_What are we trying to accomplish?_

## Steps
- [ ] Define the steps here

## Notes / Blockers
_Record decisions, blockers, and important context as you work._
`;

// ── Exploration prompt ─────────────────────────────────────────────────────────

export function buildExplorationPrompt(): string {
	return `**STARTUP TASK — Codebase Exploration (complete before implementing anything)**

The workspace already contains code. You must first explore and document it:

1. **Read** \`.agent/MEMORY.md\` — see if previous memory exists; if so, validate it.
2. **Explore** project structure with \`list_directory\` and read key files:
   - Package manifests (package.json, pyproject.toml, go.mod, Cargo.toml, …)
   - README.md, CONTRIBUTING.md, docs/
   - Entry points, main modules, test directories
3. **Populate** the memory files that are missing or stale:
   - \`.agent/memory/architecture.md\` — system design, components, data flow
   - \`.agent/memory/codebase.md\` — key files, modules, entry points
   - \`.agent/memory/conventions.md\` — coding style, naming, commit format
   - \`.agent/memory/tech-stack.md\` — languages, frameworks, tools
   - \`.agent/memory/dependencies.md\` — external libraries
   - \`.agent/memory/context.md\` — project goals, constraints
4. **Update** \`.agent/MEMORY.md\` — keep the "Quick reference" section current.
5. **Review** \`.agent/TODO.md\` and \`.agent/plans/CURRENT_PLAN.md\` — carry over any unfinished work.
6. Call \`send_report\` with title "Exploration Complete" summarising what you found, then proceed to the main task.`;
}

// ── Startup context ────────────────────────────────────────────────────────────

export async function buildStartupContext(workspace: string, task: string, isNewProject: boolean): Promise<string[]> {
	const msgs: string[] = [];

	// Load existing memory index
	const memIndex = await tryRead(join(workspace, AGENT_FILES.memory));
	if (memIndex && !memIndex.includes("not yet determined")) {
		msgs.push(`**Existing memory index (.agent/MEMORY.md):**\n\n${memIndex.slice(0, 2000)}`);
	}

	// Load current plan
	const currentPlan = await tryRead(join(workspace, AGENT_FILES.currentPlan));
	if (currentPlan && !currentPlan.includes("not started")) {
		msgs.push(`**Active plan (.agent/plans/CURRENT_PLAN.md):**\n\n${currentPlan.slice(0, 2000)}`);
	}

	// Load TODO
	const todo = await tryRead(join(workspace, AGENT_FILES.todo));
	if (todo && todo.trim() !== TODO_TEMPLATE.trim()) {
		msgs.push(`**Task queue (.agent/TODO.md):**\n\n${todo.slice(0, 1500)}`);
	}

	// Exploration prompt for existing projects
	if (!isNewProject) {
		msgs.push(buildExplorationPrompt());
	}

	// Main task
	msgs.push(
		`**Main task:**\n\n${task}\n\nBefore coding:\n1. Use \`ask_checklist\` to surface all ambiguities.\n2. Add the task to \`.agent/TODO.md\` if not already there.\n3. Move it to \`.agent/plans/CURRENT_PLAN.md\` with a detailed step-by-step plan.\n4. Then begin implementation.`
	);

	return msgs;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function tryRead(path: string): Promise<string | null> {
	try {
		return await Bun.file(path).text();
	} catch {
		return null;
	}
}

export async function readMemory(workspace: string): Promise<string | null> {
	return tryRead(join(workspace, AGENT_FILES.memory));
}

export async function readCurrentPlan(workspace: string): Promise<string | null> {
	return tryRead(join(workspace, AGENT_FILES.currentPlan));
}

export async function readTodo(workspace: string): Promise<string | null> {
	return tryRead(join(workspace, AGENT_FILES.todo));
}
