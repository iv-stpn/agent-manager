import Database, { type SQLQueryBindings } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { ProjectManager } from "./manager";
import type {
	CheckinRecord,
	CompactionRecord,
	MessageRecord,
	ProjectStats,
	QuestionRecord,
	ReportRecord,
	SessionRecord,
	ToolCallRecord,
} from "./records";

export type {
	CheckinRecord,
	CompactionRecord,
	MessageRecord,
	ProjectStats,
	QuestionRecord,
	ReportRecord,
	SessionRecord,
	ToolCallRecord,
} from "./records";

export class ProjectDatabase {
	constructor(private manager: ProjectManager) {}

	/**
	 * Open a project's database
	 */
	openDatabase(projectId: string): Database {
		const dbPath = this.manager.getprojectDatabaseManagerPath(projectId);

		if (!existsSync(dbPath)) {
			throw new Error(`Project "${projectId}" database not found`);
		}

		return new Database(dbPath, { readonly: true });
	}

	/**
	 * Get project statistics from its database
	 */
	async getProjectStats(projectId: string): Promise<ProjectStats> {
		try {
			const db = this.openDatabase(projectId);

			const sessionsResult = db.query("SELECT COUNT(*) as count FROM sessions").get() as { count: number };
			const messagesResult = db.query("SELECT COUNT(*) as count FROM messages").get() as { count: number };
			const reportsResult = db.query("SELECT COUNT(*) as count FROM checkins").get() as { count: number };
			const lastActivityResult = db.query("SELECT MAX(created_at) as last FROM messages").get() as { last: string | null };

			db.close();

			return {
				sessions: sessionsResult.count,
				messages: messagesResult.count,
				lastActivity: lastActivityResult.last,
				reports: reportsResult.count,
			};
		} catch (_error) {
			// If database doesn't exist yet or has no tables, return zeros
			return {
				sessions: 0,
				messages: 0,
				lastActivity: null,
				reports: 0,
			};
		}
	}

	/**
	 * Get recent sessions from a project
	 */
	// biome-ignore lint/suspicious/noExplicitAny: raw SQL query returns untyped rows
	async getProjectSessions(projectId: string, limit = 10): Promise<any[]> {
		try {
			const db = this.openDatabase(projectId);

			const sessions = db
				.query(
					`
        SELECT id, name AS title, created_at, updated_at
        FROM sessions
        ORDER BY updated_at DESC
        LIMIT ?
      `
				)
				.all(limit);

			db.close();

			return sessions;
		} catch (_error) {
			return [];
		}
	}

	/**
	 * Query a project's database directly
	 */
	// biome-ignore lint/suspicious/noExplicitAny: raw SQL pass-through requires dynamic typing
	async queryProject(projectId: string, sql: string, params: any[] = []): Promise<any[]> {
		const db = this.openDatabase(projectId);

		try {
			const results = db.query(sql).all(...params);
			return results;
		} finally {
			db.close();
		}
	}

	// ── Full-shape reads for inspecting a stopped project ────────────────────────
	// Each returns the camelCase shape the agent server returns, so the master-web
	// UI can consume them interchangeably with the live proxy responses. Returns
	// empty arrays / null when the database or table is absent (new project).

	private list<T>(projectId: string, sql: string, params: SQLQueryBindings[] = []): T[] {
		try {
			const db = this.openDatabase(projectId);
			try {
				return db.query(sql).all(...params) as T[];
			} finally {
				db.close();
			}
		} catch {
			return [];
		}
	}

	private one<T>(projectId: string, sql: string, params: SQLQueryBindings[]): T | null {
		try {
			const db = this.openDatabase(projectId);
			try {
				return (db.query(sql).get(...params) as T) ?? null;
			} finally {
				db.close();
			}
		} catch {
			return null;
		}
	}

	async getSessions(projectId: string): Promise<SessionRecord[]> {
		return this.list<SessionRecord>(projectId, SESSION_SQL);
	}

	async getSession(projectId: string, sessionId: string): Promise<SessionRecord | null> {
		return this.one<SessionRecord>(projectId, `${SESSION_SQL} WHERE id = ?`, [sessionId]);
	}

	async getMessages(projectId: string, sessionId: string): Promise<MessageRecord[]> {
		return this.list<MessageRecord>(projectId, `${MESSAGE_SQL} WHERE session_id = ? ORDER BY created_at ASC`, [sessionId]);
	}

	async getToolCalls(projectId: string, sessionId: string): Promise<ToolCallRecord[]> {
		return this.list<ToolCallRecord>(projectId, `${TOOL_SQL} WHERE session_id = ? ORDER BY created_at ASC`, [sessionId]);
	}

	async getCheckins(projectId: string, sessionId: string): Promise<CheckinRecord[]> {
		return this.list<CheckinRecord>(projectId, `${CHECKIN_SQL} WHERE session_id = ? ORDER BY created_at ASC`, [sessionId]);
	}

	async getQuestions(projectId: string, sessionId: string): Promise<QuestionRecord[]> {
		const rows = this.list<Omit<QuestionRecord, "isUrgent"> & { isUrgent: number }>(
			projectId,
			`${QUESTION_SQL} WHERE session_id = ? ORDER BY created_at ASC`,
			[sessionId]
		);
		return rows.map((r) => ({ ...r, isUrgent: Boolean(r.isUrgent) }));
	}

	/** All check-ins across every session in a project, newest first. */
	async getReports(projectId: string): Promise<ReportRecord[]> {
		return this.list<ReportRecord>(
			projectId,
			`SELECT c.id, c.session_id AS sessionId, c.trigger, c.summary,
				c.discord_message_id AS discordMessageId, c.status,
				c.created_at AS createdAt, c.completed_at AS completedAt,
				s.name AS sessionName, s.task AS sessionTask
			 FROM checkins c
			 JOIN sessions s ON s.id = c.session_id
			 ORDER BY c.created_at DESC`
		);
	}

	async getCompactions(projectId: string, sessionId: string): Promise<CompactionRecord[]> {
		return this.list<CompactionRecord>(projectId, `${COMPACTION_SQL} WHERE session_id = ? ORDER BY created_at ASC`, [sessionId]);
	}
}

const SESSION_SQL = `SELECT id, name, task, status,
	report_interval_mins AS reportIntervalMins,
	total_timeout_mins AS totalTimeoutMins,
	freeze_report_mode AS freezeReportMode,
	freeze_report_custom_rule AS freezeReportCustomRule,
	freeze_ask_mode AS freezeAskMode,
	compact_threshold_tokens AS compactThresholdTokens,
	stop_threshold_tokens AS stopThresholdTokens,
	always_improve_mode AS alwaysImproveMode,
	always_improve_scope AS alwaysImproveScope,
	total_input_tokens AS totalInputTokens,
	total_output_tokens AS totalOutputTokens,
	total_cache_read_tokens AS totalCacheReadTokens,
	total_cache_write_tokens AS totalCacheWriteTokens,
	discord_channel_id AS discordChannelId,
	created_at AS createdAt,
	updated_at AS updatedAt
	FROM sessions`;

const MESSAGE_SQL = `SELECT id, session_id AS sessionId, role, content,
	input_tokens AS inputTokens, output_tokens AS outputTokens,
	cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens,
	error, error_details AS errorDetails, created_at AS createdAt
	FROM messages`;

const TOOL_SQL = `SELECT id, session_id AS sessionId, message_id AS messageId,
	tool_name AS toolName, tool_use_id AS toolUseId, input, output, status,
	created_at AS createdAt, completed_at AS completedAt
	FROM tool_calls`;

const CHECKIN_SQL = `SELECT id, session_id AS sessionId, trigger, summary,
	discord_message_id AS discordMessageId, status,
	created_at AS createdAt, completed_at AS completedAt
	FROM checkins`;

const QUESTION_SQL = `SELECT id, session_id AS sessionId, checkin_id AS checkinId,
	text, answer, is_urgent AS isUrgent, context,
	created_at AS createdAt, answered_at AS answeredAt
	FROM questions`;

const COMPACTION_SQL = `SELECT id, session_id AS sessionId,
	messages_before AS messagesBefore, messages_after AS messagesAfter,
	tokens_before AS tokensBefore, tokens_after AS tokensAfter,
	threshold_tokens AS thresholdTokens, summary, created_at AS createdAt
	FROM compactions`;
