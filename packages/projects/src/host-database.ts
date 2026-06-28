import Database from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// ── Template types ───────────────────────────────────────────────────────────

export type TemplateCategory = "tech-stack" | "ui-design" | "best-practices" | "system-prompt";

export interface Template {
	id: string;
	name: string;
	description: string;
	category: TemplateCategory;
	content: string;
	createdAt: number;
	updatedAt: number;
}

// ── Tech stack types ─────────────────────────────────────────────────────────

export interface StackLibrary {
	name: string;
	version?: string;
}

export interface StackEntry {
	label: string;
	libraries: StackLibrary[];
	usagePatterns: string[];
}

export interface TechStack {
	id: string;
	language: string;
	name: string;
	description: string;
	stack: StackEntry[];
	createdAt: number;
	updatedAt: number;
}

// ── Guideline types ──────────────────────────────────────────────────────────

export interface GuidelineCategory {
	id: string;
	name: string;
	description: string;
	color: string;
	createdAt: number;
	updatedAt: number;
}

export interface Guideline {
	id: string;
	name: string;
	description: string;
	categoryId: string | null;
	content: string;
	createdAt: number;
	updatedAt: number;
}

// ── Archive types ────────────────────────────────────────────────────────────

export interface ArchivedProject {
	id: string;
	name: string;
	description: string | null;
	createdAt: string;
	archivedAt: string;
	totalSessions: number;
	totalMessages: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
}

export interface ArchivedSession {
	id: string;
	projectId: string;
	name: string | null;
	task: string;
	status: string;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	createdAt: number;
	updatedAt: number;
}

// ── Statistics types ─────────────────────────────────────────────────────────

export interface GlobalStats {
	totalProjects: number;
	totalArchivedProjects: number;
	totalSessions: number;
	totalMessages: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
}

// ── Host Database ──────────────────────────────────────────────────────────

export class HostDatabase {
	private db: Database;

	constructor(rootDir: string) {
		this.db = new Database(join(rootDir, "host.db"));
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.migrate();
	}

	private migrate() {
		this.db.exec(`
			-- Reusable prompt/config templates users can apply when creating projects.
			CREATE TABLE IF NOT EXISTS templates (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL, -- Display name of the template.
				description TEXT NOT NULL DEFAULT '', -- Short description shown in the picker.
				category TEXT NOT NULL, -- One of: tech-stack, ui-design, best-practices, system-prompt.
				content TEXT NOT NULL DEFAULT '', -- The template body injected into a project.
				created_at INTEGER NOT NULL, -- Creation time (epoch ms).
				updated_at INTEGER NOT NULL -- Last update time (epoch ms).
			);

			-- Reusable tech stacks scoped to a programming language. The stack column holds a
			-- JSON array of { label, libraries: [{ name, version? }], usagePatterns: string[] }.
			CREATE TABLE IF NOT EXISTS tech_stacks (
				id TEXT PRIMARY KEY,
				language TEXT NOT NULL, -- Programming language the stack targets (e.g. "TypeScript").
				name TEXT NOT NULL, -- Display name of the stack.
				description TEXT NOT NULL DEFAULT '', -- Short description shown in the picker.
				stack TEXT NOT NULL DEFAULT '[]', -- JSON array of labelled library/usage-pattern groups.
				created_at INTEGER NOT NULL, -- Creation time (epoch ms).
				updated_at INTEGER NOT NULL -- Last update time (epoch ms).
			);

			-- Categories used to classify guidelines (e.g. "UI design", "Best practice").
			CREATE TABLE IF NOT EXISTS guideline_categories (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL UNIQUE, -- Unique category name.
				description TEXT NOT NULL DEFAULT '', -- Short description of what the category covers.
				color TEXT NOT NULL DEFAULT '#6b7280', -- Hex color for UI badges/chips.
				created_at INTEGER NOT NULL, -- Creation time (epoch ms).
				updated_at INTEGER NOT NULL -- Last update time (epoch ms).
			);

			-- Reusable guidelines, optionally classified under a guideline category.
			CREATE TABLE IF NOT EXISTS guidelines (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL, -- Display name of the guideline.
				description TEXT NOT NULL DEFAULT '', -- Short description shown in the picker.
				category_id TEXT, -- Owning guideline category, if any.
				content TEXT NOT NULL DEFAULT '', -- The guideline body injected into a project.
				created_at INTEGER NOT NULL, -- Creation time (epoch ms).
				updated_at INTEGER NOT NULL, -- Last update time (epoch ms).
				FOREIGN KEY (category_id) REFERENCES guideline_categories(id) ON DELETE SET NULL
			);

			-- Snapshot of a project kept after it is archived/removed, with rolled-up totals.
			CREATE TABLE IF NOT EXISTS archived_projects (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL, -- Project name at archive time.
				description TEXT, -- Project description, if any.
				created_at TEXT NOT NULL, -- When the project was originally created (ISO string).
				archived_at TEXT NOT NULL, -- When the project was archived (ISO string).
				total_sessions INTEGER NOT NULL DEFAULT 0, -- Number of sessions the project had.
				total_messages INTEGER NOT NULL DEFAULT 0, -- Total messages across all sessions.
				total_input_tokens INTEGER NOT NULL DEFAULT 0, -- Lifetime input tokens.
				total_output_tokens INTEGER NOT NULL DEFAULT 0, -- Lifetime output tokens.
				total_cache_read_tokens INTEGER NOT NULL DEFAULT 0, -- Lifetime prompt-cache read tokens.
				total_cache_write_tokens INTEGER NOT NULL DEFAULT 0 -- Lifetime prompt-cache write tokens.
			);

			-- Per-session snapshot belonging to an archived project.
			CREATE TABLE IF NOT EXISTS archived_sessions (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL, -- Owning archived project.
				name TEXT, -- Session name, if any.
				task TEXT NOT NULL DEFAULT '', -- The task the session worked on.
				status TEXT NOT NULL DEFAULT 'stopped', -- Final status at archive time.
				total_input_tokens INTEGER NOT NULL DEFAULT 0, -- Session input tokens.
				total_output_tokens INTEGER NOT NULL DEFAULT 0, -- Session output tokens.
				total_cache_read_tokens INTEGER NOT NULL DEFAULT 0, -- Session prompt-cache read tokens.
				total_cache_write_tokens INTEGER NOT NULL DEFAULT 0, -- Session prompt-cache write tokens.
				created_at INTEGER NOT NULL, -- Session creation time (epoch ms).
				updated_at INTEGER NOT NULL, -- Session last update time (epoch ms).
				FOREIGN KEY (project_id) REFERENCES archived_projects(id) ON DELETE CASCADE
			);

			-- Single-row ('global') lifetime counters across the whole orchestrator.
			CREATE TABLE IF NOT EXISTS statistics (
				id TEXT PRIMARY KEY DEFAULT 'global', -- Always 'global'; one row.
				total_projects_created INTEGER NOT NULL DEFAULT 0, -- Projects ever created.
				total_sessions_started INTEGER NOT NULL DEFAULT 0, -- Sessions ever started.
				total_messages_sent INTEGER NOT NULL DEFAULT 0, -- Messages ever sent.
				total_input_tokens INTEGER NOT NULL DEFAULT 0, -- Lifetime input tokens.
				total_output_tokens INTEGER NOT NULL DEFAULT 0, -- Lifetime output tokens.
				total_cache_read_tokens INTEGER NOT NULL DEFAULT 0, -- Lifetime prompt-cache read tokens.
				total_cache_write_tokens INTEGER NOT NULL DEFAULT 0, -- Lifetime prompt-cache write tokens.
				updated_at INTEGER NOT NULL -- Last time the counters changed (epoch ms).
			);
		`);

		// Ensure the global stats row exists
		this.db
			.query(
				`INSERT OR IGNORE INTO statistics (id, total_projects_created, total_sessions_started,
				 total_messages_sent, total_input_tokens, total_output_tokens,
				 total_cache_read_tokens, total_cache_write_tokens, updated_at)
				 VALUES ('global', 0, 0, 0, 0, 0, 0, 0, ?)`
			)
			.run(Date.now());

		// Migration: add color column to guideline_categories if missing.
		const cols = this.db.query("PRAGMA table_info(guideline_categories)").all() as { name: string }[];
		if (!cols.some((c) => c.name === "color")) {
			this.db.query("ALTER TABLE guideline_categories ADD COLUMN color TEXT NOT NULL DEFAULT '#6b7280'").run();
		}

		this.seedDefaults();
	}

	// ── Seeding ──────────────────────────────────────────────────────────────

	private seedDefaults() {
		const now = Date.now();

		// Default guideline categories — only seeded when the table is empty.
		const categoryCount = (this.db.query("SELECT COUNT(*) AS n FROM guideline_categories").get() as { n: number }).n;
		if (categoryCount === 0) {
			const categoryDefaults: { name: string; description: string; color: string }[] = [
				{ name: "UI design", description: "Visual design, layout, and interaction patterns.", color: "#8b5cf6" },
				{ name: "Best practice", description: "Recommended engineering practices and conventions.", color: "#10b981" },
				{ name: "Behavior", description: "How the agent should behave while working.", color: "#f59e0b" },
				{ name: "Rule", description: "Hard constraints the agent must always follow.", color: "#ef4444" },
			];
			const catIds: Record<string, string> = {};
			const insertCat = this.db.query(
				`INSERT INTO guideline_categories (id, name, description, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
			);
			for (const cat of categoryDefaults) {
				const id = randomUUID();
				catIds[cat.name] = id;
				insertCat.run(id, cat.name, cat.description, cat.color, now, now);
			}

			// Default guidelines — seeded alongside categories.
			const guidelineDefaults: { name: string; description: string; category: string; content: string }[] = [
				{
					name: "Consistent spacing",
					description: "Use consistent spacing and padding across components.",
					category: "UI design",
					content: "Use a 4px/8px spacing scale. Prefer gap utilities over margin for flex/grid layouts.",
				},
				{
					name: "Accessible color contrast",
					description: "Ensure text meets WCAG AA contrast ratios.",
					category: "UI design",
					content:
						"All text must meet WCAG AA contrast (4.5:1 for normal text, 3:1 for large text). Test with browser dev tools.",
				},
				{
					name: "Error handling",
					description: "Handle errors explicitly rather than silently swallowing them.",
					category: "Best practice",
					content: "Never use empty catch blocks. Log or propagate errors. Show user-facing messages for recoverable failures.",
				},
				{
					name: "Small focused commits",
					description: "Keep commits small and focused on a single change.",
					category: "Best practice",
					content: "Each commit should represent one logical change. Separate refactors from feature work.",
				},
				{
					name: "Explain before coding",
					description: "Explain your plan before writing code.",
					category: "Behavior",
					content:
						"Before implementing, briefly describe your approach and which files you'll change. Ask for confirmation on non-trivial changes.",
				},
				{
					name: "No unrelated changes",
					description: "Don't modify files unrelated to the task.",
					category: "Rule",
					content:
						"Only touch files directly related to the current task. Do not refactor, reformat, or 'improve' unrelated code.",
				},
			];
			const insertGuideline = this.db.query(
				`INSERT INTO guidelines (id, name, description, category_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
			);
			for (const g of guidelineDefaults) {
				insertGuideline.run(randomUUID(), g.name, g.description, catIds[g.category], g.content, now, now);
			}
		}

		// Default tech stacks — only seeded when the table is empty.
		const stackCount = (this.db.query("SELECT COUNT(*) AS n FROM tech_stacks").get() as { n: number }).n;
		if (stackCount === 0) {
			const defaults: Omit<TechStack, "id" | "createdAt" | "updatedAt">[] = [
				{
					language: "TypeScript",
					name: "TypeScript Full-Stack",
					description: "Hono backend with a React frontend sharing a typed API client.",
					stack: [
						{
							label: "Backend",
							libraries: [{ name: "hono", version: "4" }],
							usagePatterns: ["serverless"],
						},
						{
							label: "Frontend",
							libraries: [{ name: "react", version: "19" }],
							usagePatterns: ["use hono/client for the API client"],
						},
					],
				},
			];
			const insert = this.db.query(
				`INSERT INTO tech_stacks (id, language, name, description, stack, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
			);
			for (const s of defaults) {
				insert.run(randomUUID(), s.language, s.name, s.description, JSON.stringify(s.stack), now, now);
			}
		}
	}

	// ── Templates ────────────────────────────────────────────────────────────

	listTemplates(): Template[] {
		return this.db
			.query(
				`SELECT id, name, description, category, content,
				 created_at AS createdAt, updated_at AS updatedAt
				 FROM templates ORDER BY created_at DESC`
			)
			.all() as Template[];
	}

	getTemplate(id: string): Template | undefined {
		return (
			(this.db
				.query(
					`SELECT id, name, description, category, content,
				 created_at AS createdAt, updated_at AS updatedAt
				 FROM templates WHERE id = ?`
				)
				.get(id) as Template | undefined) ?? undefined
		);
	}

	createTemplate(data: Omit<Template, "id" | "createdAt" | "updatedAt">): Template {
		const id = randomUUID();
		const now = Date.now();
		this.db
			.query(
				`INSERT INTO templates (id, name, description, category, content, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.run(id, data.name, data.description, data.category, data.content, now, now);
		return { ...data, id, createdAt: now, updatedAt: now };
	}

	updateTemplate(id: string, data: Partial<Omit<Template, "id" | "createdAt">>): Template {
		const existing = this.getTemplate(id);
		if (!existing) throw new Error(`Template ${id} not found`);

		const updated = { ...existing, ...data, updatedAt: Date.now() };
		this.db
			.query(
				`UPDATE templates SET name = ?, description = ?, category = ?, content = ?, updated_at = ?
				 WHERE id = ?`
			)
			.run(updated.name, updated.description, updated.category, updated.content, updated.updatedAt, id);
		return updated;
	}

	deleteTemplate(id: string) {
		this.db.query("DELETE FROM templates WHERE id = ?").run(id);
	}

	// ── Tech stacks ────────────────────────────────────────────────────────────

	private rowToTechStack(row: Record<string, unknown>): TechStack {
		return {
			id: row.id as string,
			language: row.language as string,
			name: row.name as string,
			description: row.description as string,
			stack: JSON.parse((row.stack as string) || "[]") as StackEntry[],
			createdAt: row.createdAt as number,
			updatedAt: row.updatedAt as number,
		};
	}

	listTechStacks(): TechStack[] {
		const rows = this.db
			.query(
				`SELECT id, language, name, description, stack,
				 created_at AS createdAt, updated_at AS updatedAt
				 FROM tech_stacks ORDER BY language ASC, created_at DESC`
			)
			.all() as Record<string, unknown>[];
		return rows.map((r) => this.rowToTechStack(r));
	}

	getTechStack(id: string): TechStack | undefined {
		const row = this.db
			.query(
				`SELECT id, language, name, description, stack,
				 created_at AS createdAt, updated_at AS updatedAt
				 FROM tech_stacks WHERE id = ?`
			)
			.get(id) as Record<string, unknown> | undefined;
		return row ? this.rowToTechStack(row) : undefined;
	}

	createTechStack(data: Omit<TechStack, "id" | "createdAt" | "updatedAt">): TechStack {
		const id = randomUUID();
		const now = Date.now();
		this.db
			.query(
				`INSERT INTO tech_stacks (id, language, name, description, stack, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.run(id, data.language, data.name, data.description, JSON.stringify(data.stack), now, now);
		return { ...data, id, createdAt: now, updatedAt: now };
	}

	updateTechStack(id: string, data: Partial<Omit<TechStack, "id" | "createdAt">>): TechStack {
		const existing = this.getTechStack(id);
		if (!existing) throw new Error(`Tech stack ${id} not found`);

		const updated = { ...existing, ...data, updatedAt: Date.now() };
		this.db
			.query(
				`UPDATE tech_stacks SET language = ?, name = ?, description = ?, stack = ?, updated_at = ?
				 WHERE id = ?`
			)
			.run(updated.language, updated.name, updated.description, JSON.stringify(updated.stack), updated.updatedAt, id);
		return updated;
	}

	deleteTechStack(id: string) {
		this.db.query("DELETE FROM tech_stacks WHERE id = ?").run(id);
	}

	// ── Guideline categories ─────────────────────────────────────────────────

	listGuidelineCategories(): GuidelineCategory[] {
		return this.db
			.query(
				`SELECT id, name, description, color, created_at AS createdAt, updated_at AS updatedAt
				 FROM guideline_categories ORDER BY name ASC`
			)
			.all() as GuidelineCategory[];
	}

	getGuidelineCategory(id: string): GuidelineCategory | undefined {
		return (
			(this.db
				.query(
					`SELECT id, name, description, color, created_at AS createdAt, updated_at AS updatedAt
					 FROM guideline_categories WHERE id = ?`
				)
				.get(id) as GuidelineCategory | undefined) ?? undefined
		);
	}

	createGuidelineCategory(data: Omit<GuidelineCategory, "id" | "createdAt" | "updatedAt">): GuidelineCategory {
		const id = randomUUID();
		const now = Date.now();
		this.db
			.query(
				`INSERT INTO guideline_categories (id, name, description, color, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(id, data.name, data.description, data.color, now, now);
		return { ...data, id, createdAt: now, updatedAt: now };
	}

	updateGuidelineCategory(id: string, data: Partial<Omit<GuidelineCategory, "id" | "createdAt">>): GuidelineCategory {
		const existing = this.getGuidelineCategory(id);
		if (!existing) throw new Error(`Guideline category ${id} not found`);

		const updated = { ...existing, ...data, updatedAt: Date.now() };
		this.db
			.query(`UPDATE guideline_categories SET name = ?, description = ?, color = ?, updated_at = ? WHERE id = ?`)
			.run(updated.name, updated.description, updated.color, updated.updatedAt, id);
		return updated;
	}

	deleteGuidelineCategory(id: string) {
		this.db.query("DELETE FROM guideline_categories WHERE id = ?").run(id);
	}

	// ── Guidelines ───────────────────────────────────────────────────────────

	listGuidelines(): Guideline[] {
		return this.db
			.query(
				`SELECT id, name, description, category_id AS categoryId, content,
				 created_at AS createdAt, updated_at AS updatedAt
				 FROM guidelines ORDER BY created_at DESC`
			)
			.all() as Guideline[];
	}

	getGuideline(id: string): Guideline | undefined {
		return (
			(this.db
				.query(
					`SELECT id, name, description, category_id AS categoryId, content,
					 created_at AS createdAt, updated_at AS updatedAt
					 FROM guidelines WHERE id = ?`
				)
				.get(id) as Guideline | undefined) ?? undefined
		);
	}

	createGuideline(data: Omit<Guideline, "id" | "createdAt" | "updatedAt">): Guideline {
		const id = randomUUID();
		const now = Date.now();
		this.db
			.query(
				`INSERT INTO guidelines (id, name, description, category_id, content, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.run(id, data.name, data.description, data.categoryId, data.content, now, now);
		return { ...data, id, createdAt: now, updatedAt: now };
	}

	updateGuideline(id: string, data: Partial<Omit<Guideline, "id" | "createdAt">>): Guideline {
		const existing = this.getGuideline(id);
		if (!existing) throw new Error(`Guideline ${id} not found`);

		const updated = { ...existing, ...data, updatedAt: Date.now() };
		this.db
			.query(
				`UPDATE guidelines SET name = ?, description = ?, category_id = ?, content = ?, updated_at = ?
				 WHERE id = ?`
			)
			.run(updated.name, updated.description, updated.categoryId, updated.content, updated.updatedAt, id);
		return updated;
	}

	deleteGuideline(id: string) {
		this.db.query("DELETE FROM guidelines WHERE id = ?").run(id);
	}

	// ── Archive ──────────────────────────────────────────────────────────────

	archiveProject(project: Omit<ArchivedProject, "archivedAt">, sessions: Omit<ArchivedSession, "projectId">[] = []) {
		const tx = this.db.transaction(() => {
			this.db
				.query(
					`INSERT OR REPLACE INTO archived_projects
					 (id, name, description, created_at, archived_at, total_sessions, total_messages,
					  total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_write_tokens)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					project.id,
					project.name,
					project.description,
					project.createdAt,
					new Date().toISOString(),
					project.totalSessions,
					project.totalMessages,
					project.totalInputTokens,
					project.totalOutputTokens,
					project.totalCacheReadTokens,
					project.totalCacheWriteTokens
				);

			for (const session of sessions) {
				this.db
					.query(
						`INSERT OR REPLACE INTO archived_sessions
						 (id, project_id, name, task, status, total_input_tokens, total_output_tokens,
						  total_cache_read_tokens, total_cache_write_tokens, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.run(
						session.id,
						project.id,
						session.name,
						session.task,
						session.status,
						session.totalInputTokens,
						session.totalOutputTokens,
						session.totalCacheReadTokens,
						session.totalCacheWriteTokens,
						session.createdAt,
						session.updatedAt
					);
			}
		});
		tx();
	}

	listArchivedProjects(): ArchivedProject[] {
		return this.db
			.query(
				`SELECT id, name, description, created_at AS createdAt, archived_at AS archivedAt,
				 total_sessions AS totalSessions, total_messages AS totalMessages,
				 total_input_tokens AS totalInputTokens, total_output_tokens AS totalOutputTokens,
				 total_cache_read_tokens AS totalCacheReadTokens, total_cache_write_tokens AS totalCacheWriteTokens
				 FROM archived_projects ORDER BY archived_at DESC`
			)
			.all() as ArchivedProject[];
	}

	getArchivedProject(id: string): ArchivedProject | undefined {
		return (
			(this.db
				.query(
					`SELECT id, name, description, created_at AS createdAt, archived_at AS archivedAt,
				 total_sessions AS totalSessions, total_messages AS totalMessages,
				 total_input_tokens AS totalInputTokens, total_output_tokens AS totalOutputTokens,
				 total_cache_read_tokens AS totalCacheReadTokens, total_cache_write_tokens AS totalCacheWriteTokens
				 FROM archived_projects WHERE id = ?`
				)
				.get(id) as ArchivedProject | undefined) ?? undefined
		);
	}

	getArchivedSessions(projectId: string): ArchivedSession[] {
		return this.db
			.query(
				`SELECT id, project_id AS projectId, name, task, status,
				 total_input_tokens AS totalInputTokens, total_output_tokens AS totalOutputTokens,
				 total_cache_read_tokens AS totalCacheReadTokens, total_cache_write_tokens AS totalCacheWriteTokens,
				 created_at AS createdAt, updated_at AS updatedAt
				 FROM archived_sessions WHERE project_id = ? ORDER BY created_at DESC`
			)
			.all(projectId) as ArchivedSession[];
	}

	deleteArchivedProject(id: string) {
		this.db.query("DELETE FROM archived_sessions WHERE project_id = ?").run(id);
		this.db.query("DELETE FROM archived_projects WHERE id = ?").run(id);
	}

	// ── Statistics ───────────────────────────────────────────────────────────

	getStats(): GlobalStats {
		const row = this.db
			.query(
				`SELECT total_projects_created AS totalProjects,
				 (SELECT COUNT(*) FROM archived_projects) AS totalArchivedProjects,
				 total_sessions_started AS totalSessions,
				 total_messages_sent AS totalMessages,
				 total_input_tokens AS totalInputTokens,
				 total_output_tokens AS totalOutputTokens,
				 total_cache_read_tokens AS totalCacheReadTokens,
				 total_cache_write_tokens AS totalCacheWriteTokens
				 FROM statistics WHERE id = 'global'`
			)
			.get() as GlobalStats;
		return row;
	}

	incrementStats(
		deltas: Partial<
			Record<
				"projects" | "sessions" | "messages" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens",
				number
			>
		>
	) {
		this.db
			.query(
				`UPDATE statistics SET
				 total_projects_created = total_projects_created + ?,
				 total_sessions_started = total_sessions_started + ?,
				 total_messages_sent = total_messages_sent + ?,
				 total_input_tokens = total_input_tokens + ?,
				 total_output_tokens = total_output_tokens + ?,
				 total_cache_read_tokens = total_cache_read_tokens + ?,
				 total_cache_write_tokens = total_cache_write_tokens + ?,
				 updated_at = ?
				 WHERE id = 'global'`
			)
			.run(
				deltas.projects ?? 0,
				deltas.sessions ?? 0,
				deltas.messages ?? 0,
				deltas.inputTokens ?? 0,
				deltas.outputTokens ?? 0,
				deltas.cacheReadTokens ?? 0,
				deltas.cacheWriteTokens ?? 0,
				Date.now()
			);
	}

	// ── Lifecycle ────────────────────────────────────────────────────────────

	close() {
		this.db.close();
	}
}
