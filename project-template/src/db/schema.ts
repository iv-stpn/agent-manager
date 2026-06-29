import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// An autonomous agent run within a project. Holds the task, its runtime
// configuration (report/timeout/freeze/compaction policy) and rolled-up token
// totals. All other tables hang off a session.
export const sessions = sqliteTable("sessions", {
	id: text("id").primaryKey(),
	name: text("name"), // Human-friendly session label; null until named.
	task: text("task").notNull(), // The task prompt the agent is working on.
	status: text("status", {
		enum: ["running", "paused", "compacting", "completed", "stopped", "error"],
	})
		.notNull()
		.default("running"), // Current lifecycle state of the session.

	// Report / timeout configuration
	reportIntervalMins: integer("report_interval_mins").notNull().default(15), // Minutes between automatic progress reports.
	totalTimeoutMins: integer("total_timeout_mins").notNull().default(240), // Hard wall-clock cap before the session is stopped.

	// Freeze modes
	freezeReportMode: text("freeze_report_mode", { enum: ["always", "never", "custom"] })
		.notNull()
		.default("never"), // When to pause for a report before continuing.
	freezeReportCustomRule: text("freeze_report_custom_rule"), // Natural-language rule used when freezeReportMode is "custom".
	freezeAskMode: text("freeze_ask_mode", {
		enum: ["always", "requiredOnly", "onReportOnly", "never"],
	})
		.notNull()
		.default("always"), // When the agent is allowed to block on a question.

	// Token thresholds
	compactThresholdTokens: integer("compact_threshold_tokens").notNull().default(80_000), // Context size that triggers a compaction.
	stopThresholdTokens: integer("stop_threshold_tokens").notNull().default(400_000), // Context size that force-stops the session.

	// Always-improve
	alwaysImproveMode: text("always_improve_mode", { enum: ["yes", "no", "custom"] })
		.notNull()
		.default("no"), // Whether the agent keeps improving after the task is "done".
	alwaysImproveScope: text("always_improve_scope"), // Scope describing what to keep improving when mode is "custom".

	// Token tracking
	totalInputTokens: integer("total_input_tokens").notNull().default(0), // Cumulative input tokens across the session.
	totalOutputTokens: integer("total_output_tokens").notNull().default(0), // Cumulative output tokens across the session.
	totalCacheReadTokens: integer("total_cache_read_tokens").notNull().default(0), // Cumulative prompt-cache read tokens.
	totalCacheWriteTokens: integer("total_cache_write_tokens").notNull().default(0), // Cumulative prompt-cache write tokens.

	// Discord
	discordChannelId: text("discord_channel_id"), // Discord channel mirroring this session, if any.

	createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`), // Creation time (epoch ms).
	updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`), // Last update time (epoch ms).
});

// One turn of the conversation transcript for a session: a user or assistant
// message plus its per-message token accounting and any error captured while
// producing it.
export const messages = sqliteTable("messages", {
	id: text("id").primaryKey(),
	sessionId: text("session_id")
		.notNull()
		.references(() => sessions.id), // Owning session.
	role: text("role", { enum: ["user", "assistant", "system"] }).notNull(), // Anthropic message role ("system" = system prompt, stored for the timeline only).
	content: text("content").notNull(), // JSON-serialized Anthropic ContentBlock[].
	inputTokens: integer("input_tokens").default(0), // Input tokens billed for this message.
	outputTokens: integer("output_tokens").default(0), // Output tokens billed for this message.
	cacheReadTokens: integer("cache_read_tokens").default(0), // Prompt-cache read tokens for this message.
	cacheWriteTokens: integer("cache_write_tokens").default(0), // Prompt-cache write tokens for this message.
	error: text("error"), // Short error message if generation failed.
	errorDetails: text("error_details"), // Full error detail / stack, if any.
	createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`), // Creation time (epoch ms).
});

// A single tool invocation made by the assistant within a message, tracked from
// "pending" through to its "success"/"error" outcome.
export const toolCalls = sqliteTable("tool_calls", {
	id: text("id").primaryKey(),
	sessionId: text("session_id")
		.notNull()
		.references(() => sessions.id), // Owning session.
	messageId: text("message_id")
		.notNull()
		.references(() => messages.id), // Assistant message that issued the call.
	toolName: text("tool_name").notNull(), // Name of the invoked tool.
	toolUseId: text("tool_use_id").notNull(), // Anthropic tool_use id correlating call and result.
	input: text("input").notNull(), // JSON-serialized tool input.
	output: text("output"), // JSON-serialized tool output; null until it completes.
	status: text("status", { enum: ["pending", "success", "error"] })
		.notNull()
		.default("pending"), // Execution state of the call.
	createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`), // When the call was issued (epoch ms).
	completedAt: integer("completed_at"), // When the call finished (epoch ms), if done.
});

// A point at which the agent surfaces progress and may block for input. Drives
// the report/ask flow and is mirrored to Discord when configured.
export const checkins = sqliteTable("checkins", {
	id: text("id").primaryKey(),
	sessionId: text("session_id")
		.notNull()
		.references(() => sessions.id), // Owning session.
	trigger: text("trigger", {
		enum: ["timer", "urgent", "manual", "completion", "compaction"],
	}).notNull(), // What caused this check-in.
	summary: text("summary").notNull(), // Human-readable progress summary.
	discordMessageId: text("discord_message_id"), // Mirrored Discord message id, if posted.
	status: text("status", { enum: ["pending", "answered", "skipped", "timeout"] })
		.notNull()
		.default("pending"), // Resolution state of the check-in.
	createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`), // Creation time (epoch ms).
	completedAt: integer("completed_at"), // When resolved (epoch ms), if done.
});

// A question the agent asks the user, optionally attached to a check-in. Holds
// suggested answers and, once provided, the chosen answer.
export const questions = sqliteTable("questions", {
	id: text("id").primaryKey(),
	sessionId: text("session_id")
		.notNull()
		.references(() => sessions.id), // Owning session.
	checkinId: text("checkin_id").references(() => checkins.id), // Check-in this question belongs to, if any.
	text: text("text").notNull(), // The question text.
	context: text("context"), // Extra context shown alongside the question.
	suggestions: text("suggestions"), // JSON: Array<{id, title, subtitle?}> of suggested answers.
	answer: text("answer"), // The user's chosen/typed answer; null until answered.
	isUrgent: integer("is_urgent", { mode: "boolean" }).notNull().default(false), // Whether the question blocks progress.
	createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`), // Creation time (epoch ms).
	answeredAt: integer("answered_at"), // When answered (epoch ms), if done.
});

// A generated progress/summary report for a session, rendered from structured
// JSON content.
export const reports = sqliteTable("reports", {
	id: text("id").primaryKey(),
	sessionId: text("session_id")
		.notNull()
		.references(() => sessions.id), // Owning session.
	trigger: text("trigger").notNull(), // What prompted the report (e.g. timer, completion).
	title: text("title").notNull(), // Report title.
	content: text("content").notNull(), // JSON-serialized ReportData.
	createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`), // Creation time (epoch ms).
});

// Context compaction events. Entirely separate from check-ins: a compaction is
// triggered purely by the conversation reaching the compact token threshold and
// never blocks the agent or asks the user anything. Recorded here for its own
// timeline so users can see when/why the context was summarized.
export const compactions = sqliteTable("compactions", {
	id: text("id").primaryKey(),
	sessionId: text("session_id")
		.notNull()
		.references(() => sessions.id), // Owning session.
	messagesBefore: integer("messages_before").notNull(), // Message count before the summarization restart.
	messagesAfter: integer("messages_after").notNull(), // Message count after the summarization restart.
	tokensBefore: integer("tokens_before").notNull(), // Estimated token count before compaction.
	tokensAfter: integer("tokens_after").notNull(), // Estimated token count after compaction.
	thresholdTokens: integer("threshold_tokens").notNull(), // Compact threshold in effect when this fired.
	summary: text("summary").notNull().default(""), // Summary memory produced (may be empty on failure).
	createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`), // Creation time (epoch ms).
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
// A unit of work the agent coordinates. Tasks are project-wide (not bound to a
// single session) so they survive restarts and are accessible across sessions,
// mirroring how Claude Code Tasks coordinate many pieces of work. Dependencies
// on other tasks are stored in `metadata`, so a task can be blocked until the
// tasks it depends on are done.
export const tasks = sqliteTable("tasks", {
	id: text("id").primaryKey(),
	sessionId: text("session_id").references(() => sessions.id), // Session currently working the task, if any (null = unassigned / cross-session).
	text: text("text").notNull(), // The task description.
	status: text("status", { enum: ["pending", "in_progress", "done", "cancelled"] })
		.notNull()
		.default("pending"), // Progress state of the task.
	metadata: text("metadata"), // JSON: { dependsOn?: string[] } plus arbitrary fields. Null when empty.
	createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`), // Creation time (epoch ms).
	updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`), // Last update time (epoch ms).
});

// Shape of the JSON stored in tasks.metadata.
export type TaskMetadata = {
	dependsOn?: string[]; // IDs of tasks that must be done before this one can start.
	[key: string]: unknown;
};

export type Compaction = typeof compactions.$inferSelect;
export type NewCompaction = typeof compactions.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
