import { customType, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Drizzle definitions for the orchestrator orchestrator's own SQLite database
// (templates, tech stacks, guidelines, archives, global stats, Discord
// channels). The orchestrator db is created from raw SQL in orchestrator-database.ts; these
// definitions provide the typed query surface over it.

// ── Custom JSON column ───────────────────────────────────────────────────────

function json<T>(name: string) {
	return customType<{ data: T; driverData: string }>({
		dataType: () => "text",
		toDriver: (value) => JSON.stringify(value),
		fromDriver: (string) => JSON.parse(string) as T,
	})(name);
}

// ── Nested types (JSON columns) ──────────────────────────────────────────────

/**
 * Recursively allow optional properties to also be explicitly `undefined`.
 *
 * Under `exactOptionalPropertyTypes`, a target `{ x?: string }` rejects a value
 * `{ x: string | undefined }`. Zod's `.optional()` / `.partial()` infer exactly
 * the latter shape, so values parsed from request bodies don't line up with our
 * hand-written row types. Wrapping a boundary param in `LooseOptional<T>` keeps
 * the strictness everywhere internal while accepting zod-parsed inputs.
 */
export type LooseOptional<T> = T extends (infer U)[]
	? LooseOptional<U>[]
	: T extends object
		? { [K in keyof T]: undefined extends T[K] ? LooseOptional<Exclude<T[K], undefined>> | undefined : LooseOptional<T[K]> }
		: T;

export interface StackLibrary {
	name: string;
	version?: string;
}

export interface StackEntry {
	label: string;
	libraries: StackLibrary[];
	usagePatterns: string[];
}

// ── Tables ───────────────────────────────────────────────────────────────────

export const templates = sqliteTable("templates", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	description: text("description").notNull().default(""),
	category: text("category").$type<"tech-stack" | "ui-design" | "best-practices" | "system-prompt">().notNull(),
	content: text("content").notNull().default(""),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

export const techStacks = sqliteTable("tech_stacks", {
	id: text("id").primaryKey(),
	language: text("language").notNull(),
	name: text("name").notNull(),
	description: text("description").notNull().default(""),
	stack: json<StackEntry[]>("stack").notNull(),
	templateGithubUrl: text("template_github_url"),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

export const guidelineCategories = sqliteTable("guideline_categories", {
	id: text("id").primaryKey(),
	name: text("name").notNull().unique(),
	description: text("description").notNull().default(""),
	color: text("color").notNull().default("#6b7280"),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

export const guidelines = sqliteTable("guidelines", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	description: text("description").notNull().default(""),
	categoryId: text("category_id"),
	language: text("language"),
	content: text("content").notNull().default(""),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

export const llmClients = sqliteTable("llm_clients", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	provider: text("provider").notNull().$type<"anthropic" | "openai" | "custom">(),
	apiKey: text("api_key").notNull().default(""),
	baseUrl: text("base_url").notNull().default(""),
	model: text("model").notNull().default(""),
	smallModel: text("small_model").notNull().default(""),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

export const discordChannels = sqliteTable("discord_channels", {
	id: text("id").primaryKey(),
	projectId: text("project_id").notNull(),
	sessionId: text("session_id"),
	type: text("type").notNull().$type<"category" | "summary" | "tasks" | "session" | "archive">(),
	createdAt: integer("created_at").notNull(),
});

// ── Derived types ─────────────────────────────────────────────────────────────

export type TemplateCategory = "tech-stack" | "ui-design" | "best-practices" | "system-prompt";
export type Template = typeof templates.$inferSelect;
export type TechStack = typeof techStacks.$inferSelect;
export type GuidelineCategory = typeof guidelineCategories.$inferSelect;
export type Guideline = typeof guidelines.$inferSelect;
export type LlmClient = typeof llmClients.$inferSelect;
export type LlmProvider = LlmClient["provider"];
export type DiscordChannel = typeof discordChannels.$inferSelect;
