import type { ResolvedProjectContext, TemplateRef } from "../external/context";
import type { AgentStateConfig } from "./types";

export interface SystemPromptOpts {
	isFirstSession?: boolean | undefined;
	context?: ResolvedProjectContext | undefined;
}

export function buildSystemPrompt(cfg: AgentStateConfig, opts?: SystemPromptOpts): string {
	const sections: string[] = [];

	// ── Core identity ────────────────────────────────────────────────────────────
	sections.push(
		`You are an autonomous software engineer agent working in a Docker container. Your workspace is /workspace. The user will get notified when you send reports or questions.`
	);

	// ── Starting point (templates the workspace was seeded from) ─────────────────
	const startingBlock = renderStartingPoint(opts?.context?.templates);
	if (startingBlock) sections.push(startingBlock);

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
Reports (\`send_report\`) are immutable database records. Never write reports to files. Send a report at each meaningful milestone.
Front-load all necessary clarifying questions at the start; use \`ask_user_question(urgent: true)\` only when truly blocked.
Tone: concise and direct, lead with results. Markdown, minimal emoji.`);

	// ── Memory (condensed) ───────────────────────────────────────────────────────
	sections.push(opts?.isFirstSession ? MEMORY_FIRST_SESSION : MEMORY_RETURNING);

	// ── Settings ────────────────────────────────────────────────────────────────
	sections.push(renderSettings(cfg));

	return sections.join("\n\n");
}

// ── Project context rendering ────────────────────────────────────────────────

/**
 * Render a note about the template(s) the workspace was seeded from. Tells the
 * agent the template is a starting point it is free to modify — not a fixed
 * dependency to preserve.
 */
function renderStartingPoint(templates?: TemplateRef[]): string | null {
	if (!templates?.length) return null;

	const lines = templates.map((t) => {
		const origin = t.type === "github" ? `GitHub repo ${t.source}` : `Local template "${t.source}"`;
		return `- ${origin}${t.subdirectory ? ` → ./${t.subdirectory}` : ""}`;
	});

	const plural = templates.length > 1 ? "s" : "";

	return `# Starting Point
This workspace was seeded from the template${plural} below. Treat them as a starting point, not a fixed foundation — you are free to modify, rename, restructure, or delete any of this code to fit the task. They are not dependencies to preserve.

${lines.join("\n")}`;
}

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

	// Guidelines — compiled into one section, grouped by category.
	const guidelinesBlock = renderGuidelines(guidelines);
	if (guidelinesBlock) parts.push(guidelinesBlock);

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

/**
 * Compile all guidelines into a single "Guidelines" section, grouped by
 * category. Each category becomes a `###` heading with a bullet list of its
 * guidelines; guidelines with no category fall under "General". The meaning
 * of each field is detailed in the tool definitions, so we render values
 * concisely rather than re-explaining them.
 */
function renderGuidelines(guidelines: ResolvedProjectContext["guidelines"]): string | null {
	if (!guidelines.length) return null;

	const groups = new Map<string, typeof guidelines>();
	for (const guideline of guidelines) {
		const key = guideline.category ?? "General";
		const group = groups.get(key);
		if (group) group.push(guideline);
		else groups.set(key, [guideline]);
	}

	const blocks: string[] = ["## Guidelines"];
	for (const [category, items] of groups) {
		blocks.push(`### ${category}`);
		for (const g of items) {
			const lead = `**${g.name}**${g.description ? ` — ${g.description}` : ""}`;
			blocks.push(g.content ? `- ${lead}\n  ${g.content}` : `- ${lead}`);
		}
	}

	return blocks.join("\n");
}

/** Generate language/framework-specific guidance based on the configured stack. */
function buildStackHint(languages: string[], stacks: ResolvedProjectContext["techStacks"]): string | null {
	const allLibs = stacks.flatMap((s) => s.stack.flatMap((e) => e.libraries.map((l) => l.name.toLowerCase())));
	const hints: string[] = [];

	// TypeScript / JavaScript
	if (languages.some((l) => ["typescript", "javascript", "ts", "js"].includes(l))) {
		hints.push("- Make TypeScript strict. Use `const` over `let`, avoid `any`.");
		if (allLibs.includes("react") || allLibs.includes("next") || allLibs.includes("next.js")) {
			hints.push("- React: prefer functional components, hooks, and composition over inheritance.");
		}
		// Cloudflare and Bun are mutually exclusive runtimes — Cloudflare takes
		// priority when present, since Bun-native APIs are unavailable there.
		const isCloudflare = allLibs.some((l) => ["cloudflare", "cloudflare-workers", "workers", "wrangler", "hono"].includes(l));
		if (isCloudflare) {
			hints.push(
				"- Cloudflare Workers: use the runtime Web APIs (fetch, Request/Response, Headers, ReadableStream, crypto.subtle). Avoid Node.js built-ins and filesystem APIs — use bindings (KV, D1, Durable Objects, Queues), or infrastructure described by the user, for storage and state. Keep handlers stateless across requests; persist state through bindings."
			);
		} else if (allLibs.includes("bun") || allLibs.includes("elysia") || allLibs.includes("hono")) {
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
	return `# Settings
await_report: ${cfg.awaitReportMode}${cfg.awaitReportCustomRule ? ` ("${cfg.awaitReportCustomRule}")` : ""} · await_ask: ${cfg.awaitAskMode} · always_improve: ${cfg.alwaysImproveMode}${cfg.alwaysImproveMode === "custom" ? ` (${cfg.alwaysImproveScope ?? ""})` : ""}`;
}
