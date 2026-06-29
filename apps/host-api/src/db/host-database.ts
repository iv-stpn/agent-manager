import Database from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type {
	ArchivedProject,
	ArchivedSession,
	DiscordChannel,
	GlobalStats,
	Guideline,
	GuidelineCategory,
	TechStack,
	Template,
} from "./schema";
import * as schema from "./schema";
import {
	archivedProjects,
	archivedSessions,
	discordChannels,
	guidelineCategories,
	guidelines,
	statistics,
	techStacks,
	templates,
} from "./schema";

export type {
	ArchivedProject,
	ArchivedSession,
	DiscordChannel,
	GlobalStats,
	Guideline,
	GuidelineCategory,
	StackEntry,
	StackLibrary,
	TechStack,
	Template,
	TemplateCategory,
} from "./schema";

export class HostDatabase {
	private sqlite: Database;
	private db: ReturnType<typeof drizzle<typeof schema>>;

	constructor(rootDir: string) {
		this.sqlite = new Database(join(rootDir, "host.db"));
		this.sqlite.exec("PRAGMA journal_mode = WAL");
		this.sqlite.exec("PRAGMA foreign_keys = ON");
		this.db = drizzle(this.sqlite, { schema });
		this.migrate();
	}

	private migrate() {
		this.sqlite.exec(`
			CREATE TABLE IF NOT EXISTS templates (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				category TEXT NOT NULL,
				content TEXT NOT NULL DEFAULT '',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS tech_stacks (
				id TEXT PRIMARY KEY,
				language TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				stack TEXT NOT NULL DEFAULT '[]',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS guideline_categories (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL UNIQUE,
				description TEXT NOT NULL DEFAULT '',
				color TEXT NOT NULL DEFAULT '#6b7280',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS guidelines (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				category_id TEXT,
				content TEXT NOT NULL DEFAULT '',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (category_id) REFERENCES guideline_categories(id) ON DELETE SET NULL
			);
			CREATE TABLE IF NOT EXISTS archived_projects (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				description TEXT,
				created_at TEXT NOT NULL,
				archived_at TEXT NOT NULL,
				total_sessions INTEGER NOT NULL DEFAULT 0,
				total_messages INTEGER NOT NULL DEFAULT 0,
				total_input_tokens INTEGER NOT NULL DEFAULT 0,
				total_output_tokens INTEGER NOT NULL DEFAULT 0,
				total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
				total_cache_write_tokens INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS archived_sessions (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				name TEXT,
				task TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'stopped',
				total_input_tokens INTEGER NOT NULL DEFAULT 0,
				total_output_tokens INTEGER NOT NULL DEFAULT 0,
				total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
				total_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (project_id) REFERENCES archived_projects(id) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS statistics (
				id TEXT PRIMARY KEY DEFAULT 'global',
				total_projects_created INTEGER NOT NULL DEFAULT 0,
				total_sessions_started INTEGER NOT NULL DEFAULT 0,
				total_messages_sent INTEGER NOT NULL DEFAULT 0,
				total_input_tokens INTEGER NOT NULL DEFAULT 0,
				total_output_tokens INTEGER NOT NULL DEFAULT 0,
				total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
				total_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS discord_channels (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				session_id TEXT,
				type TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
		`);

		this.db
			.insert(statistics)
			.values({
				id: "global",
				totalProjectsCreated: 0,
				totalSessionsStarted: 0,
				totalMessagesSent: 0,
				totalInputTokens: 0,
				totalOutputTokens: 0,
				totalCacheReadTokens: 0,
				totalCacheWriteTokens: 0,
				updatedAt: Date.now(),
			})
			.onConflictDoNothing()
			.run();

		// Migration: add color column to guideline_categories if missing.
		const cols = this.sqlite.query("PRAGMA table_info(guideline_categories)").all() as { name: string }[];
		if (!cols.some((c) => c.name === "color")) {
			this.sqlite.exec("ALTER TABLE guideline_categories ADD COLUMN color TEXT NOT NULL DEFAULT '#6b7280'");
		}

		this.seedDefaults();
	}

	// ── Seeding ──────────────────────────────────────────────────────────────

	private seedDefaults() {
		const now = Date.now();

		const [{ n: catCount }] = this.db.select({ n: sql<number>`COUNT(*)` }).from(guidelineCategories).all();
		if (catCount === 0) {
			const categoryDefaults = [
				{ name: "UI design", description: "Visual design, layout, and interaction patterns.", color: "#8b5cf6" },
				{ name: "Best practice", description: "Recommended engineering practices and conventions.", color: "#10b981" },
				{ name: "Behavior", description: "How the agent should behave while working.", color: "#f59e0b" },
				{ name: "Rule", description: "Hard constraints the agent must always follow.", color: "#ef4444" },
			];
			const catIds: Record<string, string> = {};
			for (const cat of categoryDefaults) {
				const id = randomUUID();
				catIds[cat.name] = id;
				this.db
					.insert(guidelineCategories)
					.values({ id, ...cat, createdAt: now, updatedAt: now })
					.run();
			}

			const guidelineDefaults = [
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
			for (const g of guidelineDefaults) {
				this.db
					.insert(guidelines)
					.values({
						id: randomUUID(),
						name: g.name,
						description: g.description,
						categoryId: catIds[g.category],
						content: g.content,
						createdAt: now,
						updatedAt: now,
					})
					.run();
			}
		}

		const [{ n: stackCount }] = this.db.select({ n: sql<number>`COUNT(*)` }).from(techStacks).all();
		if (stackCount === 0) {
			const defaults: Omit<TechStack, "id" | "createdAt" | "updatedAt">[] = [
				{
					language: "TypeScript",
					name: "TypeScript Full-Stack",
					description: "Hono backend with a React frontend sharing a typed API client.",
					stack: [
						{ label: "Backend", libraries: [{ name: "hono", version: "4" }], usagePatterns: ["serverless"] },
						{
							label: "Frontend",
							libraries: [{ name: "react", version: "19" }],
							usagePatterns: ["use hono/client for the API client"],
						},
					],
				},
			];
			for (const s of defaults) {
				this.db
					.insert(techStacks)
					.values({ id: randomUUID(), ...s, createdAt: now, updatedAt: now })
					.run();
			}
		}
	}

	// ── Templates ────────────────────────────────────────────────────────────

	listTemplates(): Template[] {
		return this.db.select().from(templates).orderBy(desc(templates.createdAt)).all();
	}

	getTemplate(id: string): Template | undefined {
		return this.db.select().from(templates).where(eq(templates.id, id)).get() ?? undefined;
	}

	createTemplate(data: Omit<Template, "id" | "createdAt" | "updatedAt">): Template {
		const row = { ...data, id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now() };
		this.db.insert(templates).values(row).run();
		return row;
	}

	updateTemplate(id: string, data: Partial<Omit<Template, "id" | "createdAt">>): Template {
		const [row] = this.db
			.update(templates)
			.set({ ...data, updatedAt: Date.now() })
			.where(eq(templates.id, id))
			.returning()
			.all();
		if (!row) throw new Error(`Template ${id} not found`);
		return row;
	}

	deleteTemplate(id: string) {
		this.db.delete(templates).where(eq(templates.id, id)).run();
	}

	// ── Tech stacks ───────────────────────────────────────────────────────────

	listTechStacks(): TechStack[] {
		return this.db.select().from(techStacks).orderBy(desc(techStacks.createdAt)).all();
	}

	getTechStack(id: string): TechStack | undefined {
		return this.db.select().from(techStacks).where(eq(techStacks.id, id)).get() ?? undefined;
	}

	createTechStack(data: Omit<TechStack, "id" | "createdAt" | "updatedAt">): TechStack {
		const row = { ...data, id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now() };
		this.db.insert(techStacks).values(row).run();
		return row;
	}

	updateTechStack(id: string, data: Partial<Omit<TechStack, "id" | "createdAt">>): TechStack {
		const [row] = this.db
			.update(techStacks)
			.set({ ...data, updatedAt: Date.now() })
			.where(eq(techStacks.id, id))
			.returning()
			.all();
		if (!row) throw new Error(`Tech stack ${id} not found`);
		return row;
	}

	deleteTechStack(id: string) {
		this.db.delete(techStacks).where(eq(techStacks.id, id)).run();
	}

	// ── Guideline categories ──────────────────────────────────────────────────

	listGuidelineCategories(): GuidelineCategory[] {
		return this.db.select().from(guidelineCategories).orderBy(guidelineCategories.name).all();
	}

	getGuidelineCategory(id: string): GuidelineCategory | undefined {
		return this.db.select().from(guidelineCategories).where(eq(guidelineCategories.id, id)).get() ?? undefined;
	}

	createGuidelineCategory(data: Omit<GuidelineCategory, "id" | "createdAt" | "updatedAt">): GuidelineCategory {
		const row = { ...data, id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now() };
		this.db.insert(guidelineCategories).values(row).run();
		return row;
	}

	updateGuidelineCategory(id: string, data: Partial<Omit<GuidelineCategory, "id" | "createdAt">>): GuidelineCategory {
		const [row] = this.db
			.update(guidelineCategories)
			.set({ ...data, updatedAt: Date.now() })
			.where(eq(guidelineCategories.id, id))
			.returning()
			.all();
		if (!row) throw new Error(`Guideline category ${id} not found`);
		return row;
	}

	deleteGuidelineCategory(id: string) {
		this.db.delete(guidelineCategories).where(eq(guidelineCategories.id, id)).run();
	}

	// ── Guidelines ────────────────────────────────────────────────────────────

	listGuidelines(): Guideline[] {
		return this.db.select().from(guidelines).orderBy(desc(guidelines.createdAt)).all();
	}

	getGuideline(id: string): Guideline | undefined {
		return this.db.select().from(guidelines).where(eq(guidelines.id, id)).get() ?? undefined;
	}

	createGuideline(data: Omit<Guideline, "id" | "createdAt" | "updatedAt">): Guideline {
		const row = { ...data, id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now() };
		this.db.insert(guidelines).values(row).run();
		return row;
	}

	updateGuideline(id: string, data: Partial<Omit<Guideline, "id" | "createdAt">>): Guideline {
		const [row] = this.db
			.update(guidelines)
			.set({ ...data, updatedAt: Date.now() })
			.where(eq(guidelines.id, id))
			.returning()
			.all();
		if (!row) throw new Error(`Guideline ${id} not found`);
		return row;
	}

	deleteGuideline(id: string) {
		this.db.delete(guidelines).where(eq(guidelines.id, id)).run();
	}

	// ── Archive ───────────────────────────────────────────────────────────────

	archiveProject(project: Omit<ArchivedProject, "archivedAt">, sessions: Omit<ArchivedSession, "projectId">[] = []) {
		this.db.transaction((tx) => {
			tx.insert(archivedProjects)
				.values({ ...project, archivedAt: new Date().toISOString() })
				.onConflictDoUpdate({ target: archivedProjects.id, set: { ...project, archivedAt: new Date().toISOString() } })
				.run();
			for (const session of sessions) {
				tx.insert(archivedSessions)
					.values({ ...session, projectId: project.id })
					.onConflictDoUpdate({ target: archivedSessions.id, set: { ...session, projectId: project.id } })
					.run();
			}
		});
	}

	listArchivedProjects(): ArchivedProject[] {
		return this.db.select().from(archivedProjects).orderBy(desc(archivedProjects.archivedAt)).all();
	}

	getArchivedProject(id: string): ArchivedProject | undefined {
		return this.db.select().from(archivedProjects).where(eq(archivedProjects.id, id)).get() ?? undefined;
	}

	getArchivedSessions(projectId: string): ArchivedSession[] {
		return this.db
			.select()
			.from(archivedSessions)
			.where(eq(archivedSessions.projectId, projectId))
			.orderBy(desc(archivedSessions.createdAt))
			.all();
	}

	deleteArchivedProject(id: string) {
		this.db.delete(archivedSessions).where(eq(archivedSessions.projectId, id)).run();
		this.db.delete(archivedProjects).where(eq(archivedProjects.id, id)).run();
	}

	// ── Statistics ────────────────────────────────────────────────────────────

	getStats(): GlobalStats {
		const [row] = this.db
			.select({
				totalProjects: statistics.totalProjectsCreated,
				totalArchivedProjects: sql<number>`(SELECT COUNT(*) FROM archived_projects)`,
				totalSessions: statistics.totalSessionsStarted,
				totalMessages: statistics.totalMessagesSent,
				totalInputTokens: statistics.totalInputTokens,
				totalOutputTokens: statistics.totalOutputTokens,
				totalCacheReadTokens: statistics.totalCacheReadTokens,
				totalCacheWriteTokens: statistics.totalCacheWriteTokens,
			})
			.from(statistics)
			.where(eq(statistics.id, "global"))
			.all();
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
			.update(statistics)
			.set({
				totalProjectsCreated: sql`${statistics.totalProjectsCreated} + ${deltas.projects ?? 0}`,
				totalSessionsStarted: sql`${statistics.totalSessionsStarted} + ${deltas.sessions ?? 0}`,
				totalMessagesSent: sql`${statistics.totalMessagesSent} + ${deltas.messages ?? 0}`,
				totalInputTokens: sql`${statistics.totalInputTokens} + ${deltas.inputTokens ?? 0}`,
				totalOutputTokens: sql`${statistics.totalOutputTokens} + ${deltas.outputTokens ?? 0}`,
				totalCacheReadTokens: sql`${statistics.totalCacheReadTokens} + ${deltas.cacheReadTokens ?? 0}`,
				totalCacheWriteTokens: sql`${statistics.totalCacheWriteTokens} + ${deltas.cacheWriteTokens ?? 0}`,
				updatedAt: Date.now(),
			})
			.where(eq(statistics.id, "global"))
			.run();
	}

	// ── Discord channels ──────────────────────────────────────────────────────

	getDiscordChannel(id: string): DiscordChannel | undefined {
		return this.db.select().from(discordChannels).where(eq(discordChannels.id, id)).get() ?? undefined;
	}

	getDiscordChannelByProjectAndType(projectId: string, type: DiscordChannel["type"]): DiscordChannel | undefined {
		return (
			this.db
				.select()
				.from(discordChannels)
				.where(eq(discordChannels.projectId, projectId) && eq(discordChannels.type, type))
				.get() ?? undefined
		);
	}

	getDiscordChannelBySession(sessionId: string): DiscordChannel | undefined {
		return this.db.select().from(discordChannels).where(eq(discordChannels.sessionId, sessionId)).get() ?? undefined;
	}

	saveDiscordChannel(data: DiscordChannel) {
		this.db.insert(discordChannels).values(data).onConflictDoUpdate({ target: discordChannels.id, set: data }).run();
	}

	deleteDiscordChannel(id: string) {
		this.db.delete(discordChannels).where(eq(discordChannels.id, id)).run();
	}

	listDiscordChannelsByProject(projectId: string): DiscordChannel[] {
		return this.db.select().from(discordChannels).where(eq(discordChannels.projectId, projectId)).all();
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	close() {
		this.sqlite.close();
	}
}
