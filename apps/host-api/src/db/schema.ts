import { customType, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// ── Custom JSON column ───────────────────────────────────────────────────────

function json<T>(name: string) {
	return customType<{ data: T; driverData: string }>({
		dataType: () => "text",
		toDriver: (v) => JSON.stringify(v),
		fromDriver: (s) => JSON.parse(s) as T,
	})(name);
}

// ── Nested types (JSON columns) ──────────────────────────────────────────────

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
	content: text("content").notNull().default(""),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

export const archivedProjects = sqliteTable("archived_projects", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	description: text("description"),
	createdAt: text("created_at").notNull(),
	archivedAt: text("archived_at").notNull(),
	totalSessions: integer("total_sessions").notNull().default(0),
	totalMessages: integer("total_messages").notNull().default(0),
	totalInputTokens: integer("total_input_tokens").notNull().default(0),
	totalOutputTokens: integer("total_output_tokens").notNull().default(0),
	totalCacheReadTokens: integer("total_cache_read_tokens").notNull().default(0),
	totalCacheWriteTokens: integer("total_cache_write_tokens").notNull().default(0),
});

export const archivedSessions = sqliteTable("archived_sessions", {
	id: text("id").primaryKey(),
	projectId: text("project_id").notNull(),
	name: text("name"),
	task: text("task").notNull().default(""),
	status: text("status").notNull().default("stopped"),
	totalInputTokens: integer("total_input_tokens").notNull().default(0),
	totalOutputTokens: integer("total_output_tokens").notNull().default(0),
	totalCacheReadTokens: integer("total_cache_read_tokens").notNull().default(0),
	totalCacheWriteTokens: integer("total_cache_write_tokens").notNull().default(0),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

export const statistics = sqliteTable("statistics", {
	id: text("id").primaryKey().default("global"),
	totalProjectsCreated: integer("total_projects_created").notNull().default(0),
	totalSessionsStarted: integer("total_sessions_started").notNull().default(0),
	totalMessagesSent: integer("total_messages_sent").notNull().default(0),
	totalInputTokens: integer("total_input_tokens").notNull().default(0),
	totalOutputTokens: integer("total_output_tokens").notNull().default(0),
	totalCacheReadTokens: integer("total_cache_read_tokens").notNull().default(0),
	totalCacheWriteTokens: integer("total_cache_write_tokens").notNull().default(0),
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
export type ArchivedProject = typeof archivedProjects.$inferSelect;
export type ArchivedSession = typeof archivedSessions.$inferSelect;
export type DiscordChannel = typeof discordChannels.$inferSelect;

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
