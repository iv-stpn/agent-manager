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

// ── Master Database ──────────────────────────────────────────────────────────

export class MasterDatabase {
	private db: Database;

	constructor(rootDir: string) {
		this.db = new Database(join(rootDir, "master.db"));
		this.db.exec("PRAGMA journal_mode = WAL");
		this.migrate();
	}

	private migrate() {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS templates (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				category TEXT NOT NULL,
				content TEXT NOT NULL DEFAULT '',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
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

	incrementStats(deltas: Partial<Record<"projects" | "sessions" | "messages" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens", number>>) {
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
