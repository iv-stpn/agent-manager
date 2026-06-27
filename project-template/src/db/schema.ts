import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
	id: text("id").primaryKey(),
	name: text("name"),
	task: text("task").notNull(),
	status: text("status", {
		enum: ["running", "paused", "compacting", "completed", "stopped", "error"],
	})
		.notNull()
		.default("running"),

	// Report / timeout configuration
	reportIntervalMins: integer("report_interval_mins").notNull().default(15),
	totalTimeoutMins: integer("total_timeout_mins").notNull().default(240),

	// Freeze modes
	freezeReportMode: text("freeze_report_mode", { enum: ["always", "never", "custom"] })
		.notNull()
		.default("never"),
	freezeReportCustomRule: text("freeze_report_custom_rule"),
	freezeAskMode: text("freeze_ask_mode", {
		enum: ["always", "requiredOnly", "onReportOnly", "never"],
	})
		.notNull()
		.default("always"),

	// Token thresholds
	compactThresholdTokens: integer("compact_threshold_tokens").notNull().default(80_000),
	stopThresholdTokens: integer("stop_threshold_tokens").notNull().default(400_000),

	// Always-improve
	alwaysImproveMode: text("always_improve_mode", { enum: ["yes", "no", "custom"] })
		.notNull()
		.default("no"),
	alwaysImproveScope: text("always_improve_scope"),

	// Token tracking
	totalInputTokens: integer("total_input_tokens").notNull().default(0),
	totalOutputTokens: integer("total_output_tokens").notNull().default(0),
	totalCacheReadTokens: integer("total_cache_read_tokens").notNull().default(0),
	totalCacheWriteTokens: integer("total_cache_write_tokens").notNull().default(0),

	// Discord
	discordChannelId: text("discord_channel_id"),

	createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
	updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
});

export const messages = sqliteTable("messages", {
	id: text("id").primaryKey(),
	sessionId: text("session_id")
		.notNull()
		.references(() => sessions.id),
	// role maps to Anthropic message roles + 'tool_result' for tool outputs
	role: text("role", { enum: ["user", "assistant"] }).notNull(),
	// JSON-serialized Anthropic ContentBlock[]
	content: text("content").notNull(),
	inputTokens: integer("input_tokens").default(0),
	outputTokens: integer("output_tokens").default(0),
	cacheReadTokens: integer("cache_read_tokens").default(0),
	cacheWriteTokens: integer("cache_write_tokens").default(0),
	// Error tracking
	error: text("error"),
	errorDetails: text("error_details"),
	createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
});

export const toolCalls = sqliteTable("tool_calls", {
	id: text("id").primaryKey(),
	sessionId: text("session_id")
		.notNull()
		.references(() => sessions.id),
	messageId: text("message_id")
		.notNull()
		.references(() => messages.id),
	toolName: text("tool_name").notNull(),
	toolUseId: text("tool_use_id").notNull(),
	input: text("input").notNull(), // JSON
	output: text("output"), // JSON
	status: text("status", { enum: ["pending", "success", "error"] })
		.notNull()
		.default("pending"),
	createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
	completedAt: integer("completed_at"),
});

export const checkins = sqliteTable("checkins", {
	id: text("id").primaryKey(),
	sessionId: text("session_id")
		.notNull()
		.references(() => sessions.id),
	trigger: text("trigger", {
		enum: ["timer", "urgent", "manual", "completion", "compaction"],
	}).notNull(),
	summary: text("summary").notNull(),
	discordMessageId: text("discord_message_id"),
	status: text("status", { enum: ["pending", "answered", "skipped", "timeout"] })
		.notNull()
		.default("pending"),
	createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
	completedAt: integer("completed_at"),
});

export const questions = sqliteTable("questions", {
	id: text("id").primaryKey(),
	sessionId: text("session_id")
		.notNull()
		.references(() => sessions.id),
	checkinId: text("checkin_id").references(() => checkins.id),
	text: text("text").notNull(),
	context: text("context"),
	suggestions: text("suggestions"), // JSON: Array<{id: string, title: string, subtitle?: string}>
	answer: text("answer"),
	isUrgent: integer("is_urgent", { mode: "boolean" }).notNull().default(false),
	createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
	answeredAt: integer("answered_at"),
});

export const reports = sqliteTable("reports", {
	id: text("id").primaryKey(),
	sessionId: text("session_id")
		.notNull()
		.references(() => sessions.id),
	trigger: text("trigger").notNull(),
	title: text("title").notNull(),
	content: text("content").notNull(), // JSON-serialized ReportData
	createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
});

// Context compaction events. Entirely separate from check-ins: a compaction is
// triggered purely by the conversation reaching the compact token threshold and
// never blocks the agent or asks the user anything. Recorded here for its own
// timeline so users can see when/why the context was summarized.
export const compactions = sqliteTable("compactions", {
	id: text("id").primaryKey(),
	sessionId: text("session_id")
		.notNull()
		.references(() => sessions.id),
	// Message counts before/after the summarization restart.
	messagesBefore: integer("messages_before").notNull(),
	messagesAfter: integer("messages_after").notNull(),
	// Estimated token counts before/after.
	tokensBefore: integer("tokens_before").notNull(),
	tokensAfter: integer("tokens_after").notNull(),
	// The compact threshold that was in effect when this fired.
	thresholdTokens: integer("threshold_tokens").notNull(),
	// The summary memory produced by the compaction (may be empty on failure).
	summary: text("summary").notNull().default(""),
	createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
});

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type ToolCall = typeof toolCalls.$inferSelect;
export type NewToolCall = typeof toolCalls.$inferInsert;
export type Checkin = typeof checkins.$inferSelect;
export type NewCheckin = typeof checkins.$inferInsert;
export type Question = typeof questions.$inferSelect;
export type NewQuestion = typeof questions.$inferInsert;
export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;
export type Compaction = typeof compactions.$inferSelect;
export type NewCompaction = typeof compactions.$inferInsert;
