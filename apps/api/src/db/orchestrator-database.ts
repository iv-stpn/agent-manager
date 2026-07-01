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
	LlmClient,
	LooseOptional,
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
	llmClients,
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
	LlmClient,
	LlmProvider,
	StackEntry,
	StackLibrary,
	TechStack,
	Template,
	TemplateCategory,
} from "./schema";

export class OrchestratorDatabase {
	private sqlite: Database;
	private db: ReturnType<typeof drizzle<typeof schema>>;

	constructor(rootDir: string) {
		this.sqlite = new Database(join(rootDir, "orchestrator.db"));
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
				template_github_url TEXT,
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
				language TEXT,
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
			CREATE TABLE IF NOT EXISTS llm_clients (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				provider TEXT NOT NULL,
				api_key TEXT NOT NULL DEFAULT '',
				base_url TEXT NOT NULL DEFAULT '',
				model TEXT NOT NULL DEFAULT '',
				small_model TEXT NOT NULL DEFAULT '',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
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

		this.seedDefaults();
	}

	// ── Seeding ──────────────────────────────────────────────────────────────

	private seedDefaults() {
		const now = Date.now();

		const [{ n: catCount }] = this.db.select({ n: sql<number>`COUNT(*)` }).from(guidelineCategories).all();
		if (catCount === 0) {
			const categoryDefaults = [
				{ name: "Code quality", description: "Code structure, reuse, and maintainability.", color: "#8b5cf6" },
				{ name: "Behavior", description: "Communication style and interaction patterns.", color: "#3b82f6" },
				{ name: "UI", description: "User interface design and responsiveness.", color: "#10b981" },
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
					name: "DRY principles",
					description: "Deduplicate logic and centralize reusable utilities.",
					category: "Code quality",
					content:
						"Apply DRY principles anytime you can. Dedupe logic, create small reusable utilities, and centralize them in appropriately grouped modules (e.g. string utils, formatting utils, date utils). If you find yourself writing the same logic twice, extract it.",
				},
				{
					name: "Strict type safety",
					description: "Never use type casts — use type guards instead.",
					category: "Code quality",
					content:
						"Ensure type safety at all times. Never use type casts (as X). Use type guards and narrowing instead whenever you would reach for a cast or any/unknown. Let the type system prove correctness rather than asserting it.",
				},
				{
					name: "No one-off code",
					description: "Only create custom components or utilities for truly unique cases.",
					category: "Code quality",
					content:
						"Never create one-off components or utilities that could otherwise be reusable. Build things generically from the start. Only create custom components and logic for very rare use cases or one-off compositions of existing utilities and components.",
				},
				{
					name: "Be brief",
					description: "Keep responses concise and to the point.",
					category: "Behavior",
					content:
						"Keep responses brief and focused. Avoid unnecessary verbosity or over-explanation. Get straight to the point while maintaining clarity.",
				},
				{
					name: "Make UI responsive",
					description: "Ensure all UI components adapt to different screen sizes.",
					category: "UI",
					content:
						"Build responsive user interfaces that work seamlessly across all device sizes. Use responsive design patterns, flexible layouts, and appropriate breakpoints. Test on mobile, tablet, and desktop viewports.",
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
					name: "TypeScript Full-Stack (Web)",
					description: "Hono on Cloudflare Workers backend, Vite + React + React Router frontend, in a Bun monorepo.",
					templateGithubUrl: null,
					stack: [
						{
							label: "Tooling",
							libraries: [{ name: "biome" }, { name: "vitest" }, { name: "playwright" }],
							usagePatterns: [
								"Use Biome for linting and formatting (no eslint/prettier)",
								"Use Vitest for unit and integration tests",
								"Use Playwright for end-to-end tests",
								"Use Bun workspaces for monorepo package management",
							],
						},
						{
							label: "Workspace",
							libraries: [{ name: "bun" }],
							usagePatterns: [
								"Use a bun monorepo subdivided into /apps and /packages (/packages/utils) for reusable utils between apps",
								"Put scripts in a /scripts folder at the root, with its own tsconfig.json to ensure typesafety",
								"Add `typecheck`, `lint` and `lint:fix` commands to package.json and use them to ensure code quality after major implementations",
							],
						},
						{
							label: "Backend",
							libraries: [{ name: "hono", version: "4" }, { name: "wrangler" }],
							usagePatterns: [
								"Deploy on Cloudflare Workers",
								"Use Hono middleware for CORS, auth, and error handling",
								"Use zod for request validation with @hono/zod-validator",
							],
						},
						{
							label: "Frontend",
							libraries: [{ name: "react", version: "19" }, { name: "react-router", version: "7" }, { name: "vite" }],
							usagePatterns: [
								"Use Vite for bundling and dev server",
								"Use React Router for client-side routing",
								"Use hono/client for the type-safe API client",
							],
						},
					],
				},
				{
					language: "TypeScript",
					name: "TypeScript Full-Stack (Mobile)",
					description: "Hono on Cloudflare Workers backend, Expo for mobile and web, in a Bun monorepo.",
					templateGithubUrl: null,
					stack: [
						{
							label: "Backend",
							libraries: [{ name: "hono", version: "4" }, { name: "wrangler" }],
							usagePatterns: [
								"Deploy on Cloudflare Workers",
								"Use Hono middleware for CORS, auth, and error handling",
								"Use zod for request validation with @hono/zod-validator",
							],
						},
						{
							label: "Mobile & Web",
							libraries: [{ name: "expo" }, { name: "react-native" }],
							usagePatterns: [
								"Use Expo for iOS, Android, and web from a single codebase",
								"Use Expo Router for file-based navigation",
								"Use hono/client for the type-safe API client",
							],
						},
						{
							label: "Tooling",
							libraries: [{ name: "biome" }, { name: "vitest" }, { name: "maestro" }],
							usagePatterns: [
								"Use Biome for linting and formatting (no eslint/prettier)",
								"Use Vitest for unit and integration tests",
								"Use Maestro for end-to-end mobile testing",
								"Use Bun workspaces for monorepo package management",
							],
						},
					],
				},
				{
					language: "TypeScript",
					name: "TypeScript Next.js + Hono API",
					description: "Next.js with TanStack Query frontend, Hono + SQLite backend, in a Bun monorepo.",
					templateGithubUrl: null,
					stack: [
						{
							label: "Tooling",
							libraries: [{ name: "biome" }, { name: "vitest" }, { name: "playwright" }],
							usagePatterns: [
								"Use Biome for linting and formatting (no eslint/prettier)",
								"Use Vitest for unit and integration tests",
								"Use Playwright for end-to-end tests",
								"Use Bun workspaces for monorepo package management",
							],
						},
						{
							label: "Workspace",
							libraries: [{ name: "bun" }],
							usagePatterns: [
								"Use a bun monorepo subdivided into /apps and /packages (/packages/utils) for reusable utils between apps",
								"Put scripts in a /scripts folder at the root, with its own tsconfig.json to ensure typesafety",
								"Add `typecheck`, `lint` and `lint:fix` commands to package.json and use them to ensure code quality after major implementations",
							],
						},
						{
							label: "Backend",
							libraries: [{ name: "hono", version: "4" }, { name: "better-sqlite3" }, { name: "drizzle-orm" }],
							usagePatterns: [
								"Use Hono for the API server with bun serve",
								"Use better-sqlite3 for local SQLite database",
								"Use Drizzle ORM for type-safe database queries",
								"Use Hono middleware for CORS, auth, and error handling",
								"Use zod for request validation with @hono/zod-validator",
							],
						},
						{
							label: "Frontend",
							libraries: [
								{ name: "next", version: "15" },
								{ name: "react", version: "19" },
								{ name: "@tanstack/react-query", version: "5" },
							],
							usagePatterns: [
								"Use Next.js App Router for server and client components",
								"Use TanStack Query for data fetching and caching",
								"Use standard fetch or axios for API requests (no hono/client)",
								"Implement proper loading states and error boundaries",
							],
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

	createTechStack(data: LooseOptional<Omit<TechStack, "id" | "createdAt" | "updatedAt">>): TechStack {
		const row = { ...data, id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now() } as TechStack;
		this.db.insert(techStacks).values(row).run();
		return row;
	}

	updateTechStack(id: string, data: LooseOptional<Partial<Omit<TechStack, "id" | "createdAt">>>): TechStack {
		const [row] = this.db
			.update(techStacks)
			.set({ ...(data as Partial<TechStack>), updatedAt: Date.now() })
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

	updateGuidelineCategory(
		id: string,
		data: LooseOptional<Partial<Omit<GuidelineCategory, "id" | "createdAt">>>
	): GuidelineCategory {
		const [row] = this.db
			.update(guidelineCategories)
			.set({ ...(data as Partial<GuidelineCategory>), updatedAt: Date.now() })
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

	updateGuideline(id: string, data: LooseOptional<Partial<Omit<Guideline, "id" | "createdAt">>>): Guideline {
		const [row] = this.db
			.update(guidelines)
			.set({ ...(data as Partial<Guideline>), updatedAt: Date.now() })
			.where(eq(guidelines.id, id))
			.returning()
			.all();
		if (!row) throw new Error(`Guideline ${id} not found`);
		return row;
	}

	deleteGuideline(id: string) {
		this.db.delete(guidelines).where(eq(guidelines.id, id)).run();
	}

	// ── LLM Clients ──────────────────────────────────────────────────────────

	listLlmClients(): LlmClient[] {
		return this.db.select().from(llmClients).orderBy(desc(llmClients.createdAt)).all();
	}

	getLlmClient(id: string): LlmClient | undefined {
		return this.db.select().from(llmClients).where(eq(llmClients.id, id)).get() ?? undefined;
	}

	createLlmClient(data: LooseOptional<Omit<LlmClient, "id" | "createdAt" | "updatedAt">>): LlmClient {
		const row = { ...data, id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now() } as LlmClient;
		this.db.insert(llmClients).values(row).run();
		return row;
	}

	updateLlmClient(id: string, data: LooseOptional<Partial<Omit<LlmClient, "id" | "createdAt">>>): LlmClient {
		const [row] = this.db
			.update(llmClients)
			.set({ ...(data as Partial<LlmClient>), updatedAt: Date.now() })
			.where(eq(llmClients.id, id))
			.returning()
			.all();
		if (!row) throw new Error(`LLM client ${id} not found`);
		return row;
	}

	deleteLlmClient(id: string) {
		this.db.delete(llmClients).where(eq(llmClients.id, id)).run();
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
