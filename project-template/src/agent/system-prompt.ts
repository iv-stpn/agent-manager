import type { ResolvedProjectContext } from "../external/context";
import type { AgentStateConfig } from "./types";

export interface SystemPromptOpts {
	isFirstSession?: boolean | undefined;
	context?: ResolvedProjectContext | undefined;
}

export function buildSystemPrompt(cfg: AgentStateConfig, opts?: SystemPromptOpts): string {
	const sections: string[] = [];

	// ── Core identity ────────────────────────────────────────────────────────────
	sections.push(
		`You are an autonomous software engineering agent running unattended in a sandboxed Docker container. Your workspace is /workspace. No human is watching in real time, but they will get notified when you send reports or questions.`
	);

	// ── Project context (tech stack + guidelines + instructions) ─────────────────
	const contextBlock = renderProjectContext(opts?.context);
	if (contextBlock) sections.push(contextBlock);

	// ── Work philosophy ──────────────────────────────────────────────────────────
	sections.push(`# How to work
Read before you change — understand existing code, conventions, and tests first. Match the surrounding style.
Solve the task that was asked — no more. Don't over-engineer or add unnecessary abstractions.
Plan first: use \`add_task\` to break work into steps, then \`set_current_task\` as you progress. Commit completed units via \`commit_changes\`.
Prefer dedicated tools over shell equivalents. Make independent tool calls in parallel.`);

	// ── Reporting & questions ────────────────────────────────────────────────────
	sections.push(`# Reporting
Reports (\`send_report\`) are immutable database records — the only audit trail. Never write reports to files. Send a report at each meaningful milestone.
Front-load clarifying questions at the start; use \`ask_user_question(urgent: true)\` only when truly blocked.
Tone: concise and direct, lead with results. Markdown, minimal emoji.`);

	// ── Memory (condensed) ───────────────────────────────────────────────────────
	sections.push(opts?.isFirstSession ? MEMORY_FIRST_SESSION : MEMORY_RETURNING);

	// ── Settings ────────────────────────────────────────────────────────────────
	sections.push(renderSettings(cfg));

	return sections.join("\n\n");
}

// ── Project context rendering ────────────────────────────────────────────────

function renderProjectContext(ctx?: ResolvedProjectContext): string | null {
	if (!ctx) return null;
	const { techStacks, guidelines, instructions } = ctx;
	if (!techStacks.length && !guidelines.length && !instructions) return null;

	const parts: string[] = ["# Project Context"];

	// Tech stacks
	for (const stack of techStacks) {
		parts.push(`## Tech Stack: ${stack.name} (${stack.language})`);
		if (stack.description) parts.push(stack.description);
		for (const entry of stack.stack) {
			const libs = entry.libraries.map((l) => (l.version ? `${l.name}@${l.version}` : l.name)).join(", ");
			parts.push(`### ${entry.label}${libs ? `\nLibraries: ${libs}` : ""}`);
			if (entry.usagePatterns.length) {
				parts.push(entry.usagePatterns.map((p) => `- ${p}`).join("\n"));
			}
		}
	}

	// Guidelines
	for (const g of guidelines) {
		parts.push(`## Guideline: ${g.name}`);
		if (g.description) parts.push(g.description);
		if (g.content) parts.push(g.content);
	}

	// Free-form instructions
	if (instructions) {
		parts.push(`## Project Instructions\n${instructions}`);
	}

	// Adaptive hint based on primary language
	const languages = [...new Set(techStacks.map((s) => s.language.toLowerCase()))];
	const hint = buildStackHint(languages, techStacks);
	if (hint) parts.push(hint);

	return parts.join("\n\n");
}

/** Generate language/framework-specific guidance based on the configured stack. */
function buildStackHint(languages: string[], stacks: ResolvedProjectContext["techStacks"]): string | null {
	const allLibs = stacks.flatMap((s) => s.stack.flatMap((e) => e.libraries.map((l) => l.name.toLowerCase())));
	const hints: string[] = [];

	// TypeScript / JavaScript
	if (languages.some((l) => ["typescript", "javascript", "ts", "js"].includes(l))) {
		hints.push("- Prefer strict TypeScript. Use `const` over `let`, avoid `any`.");
		if (allLibs.includes("react") || allLibs.includes("next") || allLibs.includes("next.js")) {
			hints.push("- React: prefer functional components, hooks, and composition over inheritance.");
		}
		if (allLibs.includes("bun") || allLibs.includes("elysia") || allLibs.includes("hono")) {
			hints.push("- Use Bun-native APIs where available (Bun.file, Bun.serve, etc.).");
		}
	}

	// Python
	if (languages.includes("python")) {
		hints.push("- Use type hints. Prefer f-strings, dataclasses, and pathlib over older patterns.");
		if (allLibs.some((l) => ["fastapi", "pydantic"].includes(l))) {
			hints.push("- FastAPI: use Pydantic models for request/response validation.");
		}
	}

	// Rust
	if (languages.includes("rust")) {
		hints.push("- Prefer `Result` over panics. Use `clippy` conventions. Minimize `unwrap()`.");
	}

	// Go
	if (languages.includes("go") || languages.includes("golang")) {
		hints.push("- Follow Go idioms: short variable names, error returns, stdlib where possible.");
	}

	if (!hints.length) return null;
	return `## Stack-Specific Guidance\n${hints.join("\n")}`;
}

// ── Memory sections (condensed) ─────────────────────────────────────────────

const MEMORY_RETURNING = `# Memory
You have persistent vector memory across sessions. At session start, \`recall\` previous context ("project overview", "current plan", "active tasks"). Record decisions and learnings as you go.`;

const MEMORY_FIRST_SESSION = `# Memory
This is your first session — memory is empty. As you explore and work, \`remember\` what you learn: architecture, conventions, decisions, goals. Do not attempt to recall on an empty database.`;

// ── Settings rendering ──────────────────────────────────────────────────────

function renderSettings(cfg: AgentStateConfig): string {
	const improve =
		cfg.alwaysImproveMode === "no"
			? "Stop once the original task is complete."
			: cfg.alwaysImproveMode === "yes"
				? "Never declare done; after the initial goal, keep finding improvements."
				: `After the initial task, keep improving only within: ${cfg.alwaysImproveScope ?? ""}.`;

	const askMode: Record<string, string> = {
		always: "queue anytime, sent grouped ASAP",
		requiredOnly: "urgent only when blocked; others accumulate for next report",
		onReportOnly: "all questions accumulate until next report",
		never: "decide autonomously; questions surface at timeout",
	};

	return `# Settings
Report interval: ${cfg.reportIntervalMins}min · Timeout: ${cfg.stopThresholdMins}min · Compact at: ${cfg.compactThresholdTokens} tokens · Stop at: ${cfg.stopThresholdTokens} tokens
freeze_report: ${cfg.freezeReportMode}${cfg.freezeReportCustomRule ? ` ("${cfg.freezeReportCustomRule}")` : ""} · freeze_ask: ${cfg.freezeAskMode} · always_improve: ${cfg.alwaysImproveMode}

always_improve — ${improve}
freeze_ask — ${askMode[cfg.freezeAskMode] ?? cfg.freezeAskMode}`;
}
