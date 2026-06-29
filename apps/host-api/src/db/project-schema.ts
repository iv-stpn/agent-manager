import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Schema for the per-project agent.db (read-only from the host).

export const sessions = sqliteTable("sessions", {
	id: text("id").primaryKey(),
	name: text("name"),
	task: text("task").notNull().default(""),
	status: text("status").$type<"running" | "paused" | "compacting" | "completed" | "stopped" | "error">().notNull(),
	reportIntervalMins: integer("report_interval_mins").notNull(),
	totalTimeoutMins: integer("total_timeout_mins").notNull(),
	freezeReportMode: text("freeze_report_mode").$type<"always" | "never" | "custom">().notNull(),
	freezeReportCustomRule: text("freeze_report_custom_rule"),
	freezeAskMode: text("freeze_ask_mode").$type<"always" | "requiredOnly" | "onReportOnly" | "never">().notNull(),
	compactThresholdTokens: integer("compact_threshold_tokens").notNull(),
	stopThresholdTokens: integer("stop_threshold_tokens").notNull(),
	alwaysImproveMode: text("always_improve_mode").$type<"yes" | "no" | "custom">().notNull(),
	alwaysImproveScope: text("always_improve_scope"),
	totalInputTokens: integer("total_input_tokens").notNull(),
	totalOutputTokens: integer("total_output_tokens").notNull(),
	totalCacheReadTokens: integer("total_cache_read_tokens").notNull(),
	totalCacheWriteTokens: integer("total_cache_write_tokens").notNull(),
	discordChannelId: text("discord_channel_id"),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

export const messages = sqliteTable("messages", {
	id: text("id").primaryKey(),
	sessionId: text("session_id").notNull(),
	role: text("role").$type<"user" | "assistant" | "system">().notNull(),
	content: text("content").notNull(),
	inputTokens: integer("input_tokens").notNull(),
	outputTokens: integer("output_tokens").notNull(),
	cacheReadTokens: integer("cache_read_tokens").notNull(),
	cacheWriteTokens: integer("cache_write_tokens").notNull(),
	error: text("error"),
	errorDetails: text("error_details"),
	createdAt: integer("created_at").notNull(),
});

export const toolCalls = sqliteTable("tool_calls", {
	id: text("id").primaryKey(),
	sessionId: text("session_id").notNull(),
	messageId: text("message_id").notNull(),
	toolName: text("tool_name").notNull(),
	toolUseId: text("tool_use_id").notNull(),
	input: text("input").notNull(),
	output: text("output"),
	status: text("status").$type<"pending" | "success" | "error">().notNull(),
	createdAt: integer("created_at").notNull(),
	completedAt: integer("completed_at"),
});

export const checkins = sqliteTable("checkins", {
	id: text("id").primaryKey(),
	sessionId: text("session_id").notNull(),
	trigger: text("trigger").$type<"timer" | "urgent" | "manual" | "completion">().notNull(),
	summary: text("summary").notNull(),
	discordMessageId: text("discord_message_id"),
	status: text("status").$type<"pending" | "answered" | "skipped" | "timeout">().notNull(),
	createdAt: integer("created_at").notNull(),
	completedAt: integer("completed_at"),
});

export const questions = sqliteTable("questions", {
	id: text("id").primaryKey(),
	sessionId: text("session_id").notNull(),
	checkinId: text("checkin_id"),
	text: text("text").notNull(),
	answer: text("answer"),
	isUrgent: integer("is_urgent", { mode: "boolean" }).notNull(),
	context: text("context"),
	createdAt: integer("created_at").notNull(),
	answeredAt: integer("answered_at"),
});

export const compactions = sqliteTable("compactions", {
	id: text("id").primaryKey(),
	sessionId: text("session_id").notNull(),
	messagesBefore: integer("messages_before").notNull(),
	messagesAfter: integer("messages_after").notNull(),
	tokensBefore: integer("tokens_before").notNull(),
	tokensAfter: integer("tokens_after").notNull(),
	thresholdTokens: integer("threshold_tokens").notNull(),
	summary: text("summary").notNull(),
	createdAt: integer("created_at").notNull(),
});
