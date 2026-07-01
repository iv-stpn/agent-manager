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

	const lines = templates.map((template) => {
		const origin = template.type === "github" ? `GitHub repo ${template.source}` : `Local template "${template.source}"`;
		return `- ${origin}${template.subdirectory ? ` → ./${template.subdirectory}` : ""}`;
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
			const libraries = entry.libraries
				.map((library) => (library.version ? `${library.name}@${library.version}` : library.name))
				.join(", ");
			parts.push(`### ${entry.label}${libraries ? `\nLibraries: ${libraries}` : ""}`);
			if (entry.usagePatterns.length) {
				parts.push(entry.usagePatterns.map((pattern) => `- ${pattern}`).join("\n"));
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
	const languages = [...new Set(techStacks.map((techStack) => techStack.language.toLowerCase()))];
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
	const allLibraries = stacks.flatMap((stack) =>
		stack.stack.flatMap((entry) => entry.libraries.map((library) => library.name.toLowerCase()))
	);
	const hints: string[] = [];

	// TypeScript / JavaScript
	if (languages.some((language) => ["typescript", "javascript", "ts", "js"].includes(language))) {
		hints.push("- Make TypeScript strict. Use `const` over `let`, avoid `any`.");
		if (allLibraries.includes("react") || allLibraries.includes("next") || allLibraries.includes("next.js")) {
			hints.push("- React: prefer functional components, hooks, and composition over inheritance.");
		}
		// Cloudflare and Bun are mutually exclusive runtimes — Cloudflare takes
		// priority when present, since Bun-native APIs are unavailable there.
		const isCloudflare = allLibraries.some((library) =>
			["cloudflare", "cloudflare-workers", "workers", "wrangler", "hono"].includes(library)
		);
		if (isCloudflare) {
			hints.push(
				"- Cloudflare Workers: use the runtime Web APIs (fetch, Request/Response, Headers, ReadableStream, crypto.subtle). Avoid Node.js/Bun built-ins and filesystem APIs — use bindings (KV, D1, Durable Objects, Queues), or infrastructure described by the user, for storage and state. Keep handlers stateless across requests; persist state through bindings."
			);
		} else if (allLibraries.includes("bun") || allLibraries.includes("elysia") || allLibraries.includes("hono")) {
			hints.push("- Use Bun-native APIs where available (Bun.file, Bun.serve, etc.).");
		}
	}

	// Python
	if (languages.includes("python")) {
		hints.push("- Use type hints. Prefer f-strings, dataclasses, and pathlib over older patterns.");
		if (allLibraries.some((library) => ["fastapi", "pydantic"].includes(library))) {
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
You have persistent vector memory across sessions. At startup, \`recall\` previous context ("project overview", "current plan"), check \`list_tasks\` and \`list_memories("plan")\` for unfinished work, then explore anything unfamiliar before implementing. Keep memory updated as you learn.`;

const MEMORY_FIRST_SESSION = `# Memory
This is your first session — memory is empty. If the workspace already has code, explore it first (manifests, README, entry points), then \`remember\` what you learn: architecture, codebase map, conventions, tech stack, goals. Do not attempt to recall on an empty database.`;

// ── Settings rendering ──────────────────────────────────────────────────────

function renderSettings(config: AgentStateConfig): string {
	return `# Settings
await_report: ${config.awaitReportMode}${config.awaitReportCustomRule ? ` ("${config.awaitReportCustomRule}")` : ""} · await_ask: ${config.awaitAskMode} · always_improve: ${config.alwaysImproveMode}${config.alwaysImproveMode === "custom" ? ` (${config.alwaysImproveScope ?? ""})` : ""}`;
}
