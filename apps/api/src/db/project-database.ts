import Database from "bun:sqlite";
import { existsSync } from "node:fs";
import { migrateProjectDb, projectDbNeedsMigration } from "@agent-manager/db/migrate";
import type {
	CheckinRecord,
	CompactionRecord,
	MessageRecord,
	ProjectManager,
	ProjectStats,
	QuestionRecord,
	ReportRecord,
	SessionRecord,
	ToolCallRecord,
} from "@agent-manager/projects";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./project-schema";
import { checkins, compactions, messages, questions, sessions, tasks, toolCalls } from "./project-schema";

export type {
	CheckinRecord,
	CompactionRecord,
	MessageRecord,
	ProjectStats,
	QuestionRecord,
	ReportRecord,
	SessionRecord,
	ToolCallRecord,
} from "@agent-manager/projects";

type ProjectDb = ReturnType<typeof drizzle<typeof schema>>;

export class ProjectDatabase {
	constructor(private manager: ProjectManager) {}

	// Projects whose DB we've already brought up to schema this process. The
	// orchestrator reads project DBs directly (the agent may never run), so it
	// owns the additive column migrations the agent applies on container start —
	// otherwise a stale DB returns garbage for un-migrated columns. Checked once
	// per project, then cached so the hot read path stays read-only.
	private migrated = new Set<string>();

	/**
	 * Bring a project DB up to the current schema if needed. Opens writable only
	 * when a migration is actually outstanding — the common case (already
	 * current) does a single read-only PRAGMA check and no write.
	 */
	private ensureMigrated(projectId: string, dbPath: string): void {
		if (this.migrated.has(projectId)) return;
		const probe = new Database(dbPath, { readonly: true });
		let needs: boolean;
		try {
			needs = projectDbNeedsMigration(probe);
		} finally {
			probe.close();
		}
		if (needs) {
			const writable = new Database(dbPath);
			try {
				migrateProjectDb(writable);
			} finally {
				writable.close();
			}
		}
		this.migrated.add(projectId);
	}

	private open(projectId: string): { db: ProjectDb; sqlite: Database } {
		const dbPath = this.manager.getProjectDatabaseManagerPath(projectId);
		if (!existsSync(dbPath)) throw new Error(`Project "${projectId}" database not found`);
		this.ensureMigrated(projectId, dbPath);
		const sqlite = new Database(dbPath, { readonly: true });
		return { db: drizzle(sqlite, { schema }), sqlite };
	}

	/**
	 * Open the project DB writable for a short-lived mutation (the UI archive
	 * toggle). The orchestrator is normally a read-only reader — the agent owns
	 * writes — but `archived` is a UI-only flag the agent never touches, so a
	 * brief writable connection here can't race the agent on that column, and it
	 * lets a user archive a session/task/report whether or not the container is
	 * running. WAL + a busy timeout keeps the write from failing if the agent
	 * happens to hold the write lock for another column at that instant.
	 */
	private withWritableDb<T>(projectId: string, fn: (db: ProjectDb) => T): T {
		const dbPath = this.manager.getProjectDatabaseManagerPath(projectId);
		if (!existsSync(dbPath)) throw new Error(`Project "${projectId}" database not found`);
		this.ensureMigrated(projectId, dbPath);
		const sqlite = new Database(dbPath);
		sqlite.exec("PRAGMA busy_timeout = 5000;");
		try {
			return fn(drizzle(sqlite, { schema }));
		} finally {
			sqlite.close();
		}
	}

	private withDb<T>(projectId: string, fn: (db: ProjectDb) => T): T {
		const { db, sqlite } = this.open(projectId);
		try {
			return fn(db);
		} finally {
			sqlite.close();
		}
	}

	/**
	 * A project whose agent has never run has no `agent.db` yet — `open()` throws
	 * "database not found" for that, which is the expected empty state, not a
	 * failure. Any other throw (corruption, a failed migration, a locked file) is
	 * a real error that the bare `catch {}` used to hide behind an empty list /
	 * null — making the UI show "no data" for a broken DB. Distinguish them so
	 * real failures at least get logged.
	 */
	private isMissingDb(err: unknown): boolean {
		return err instanceof Error && err.message.includes("database not found");
	}

	private safeList<T>(projectId: string, fn: (db: ProjectDb) => T[]): T[] {
		try {
			return this.withDb(projectId, fn);
		} catch (err) {
			if (!this.isMissingDb(err)) {
				console.error(`[ProjectDatabase] read failed for project "${projectId}":`, err);
			}
			return [];
		}
	}

	async getProjectStats(projectId: string): Promise<ProjectStats> {
		try {
			return this.withDb(projectId, (db) => {
				const [{ sessions: s }] = db.select({ sessions: sql<number>`COUNT(*)` }).from(sessions).all();
				const [{ messages: m }] = db.select({ messages: sql<number>`COUNT(*)` }).from(messages).all();
				const [{ reports: r }] = db.select({ reports: sql<number>`COUNT(*)` }).from(checkins).all();
				const [{ last }] = db
					.select({ last: sql<string | null>`MAX(${messages.createdAt})` })
					.from(messages)
					.all();
				return { sessions: s, messages: m, reports: r, lastActivity: last };
			});
		} catch (err) {
			if (!this.isMissingDb(err)) {
				console.error(`[ProjectDatabase] stats read failed for project "${projectId}":`, err);
			}
			return { sessions: 0, messages: 0, lastActivity: null, reports: 0 };
		}
	}

	async getSessions(projectId: string): Promise<SessionRecord[]> {
		return this.safeList(projectId, (db) => db.select().from(sessions).all());
	}

	async getSession(projectId: string, sessionId: string): Promise<SessionRecord | null> {
		try {
			return this.withDb(projectId, (db) => db.select().from(sessions).where(eq(sessions.id, sessionId)).get()) ?? null;
		} catch (err) {
			if (!this.isMissingDb(err)) {
				console.error(`[ProjectDatabase] getSession failed for project "${projectId}" session "${sessionId}":`, err);
			}
			return null;
		}
	}

	async getMessages(projectId: string, sessionId: string): Promise<MessageRecord[]> {
		return this.safeList(projectId, (db) =>
			db.select().from(messages).where(eq(messages.sessionId, sessionId)).orderBy(asc(messages.createdAt)).all()
		);
	}

	async getToolCalls(projectId: string, sessionId: string): Promise<ToolCallRecord[]> {
		return this.safeList(projectId, (db) =>
			db.select().from(toolCalls).where(eq(toolCalls.sessionId, sessionId)).orderBy(asc(toolCalls.createdAt)).all()
		);
	}

	async getCheckins(projectId: string, sessionId: string): Promise<CheckinRecord[]> {
		return this.safeList(projectId, (db) =>
			db.select().from(checkins).where(eq(checkins.sessionId, sessionId)).orderBy(asc(checkins.createdAt)).all()
		);
	}

	async getQuestions(projectId: string, sessionId: string): Promise<QuestionRecord[]> {
		return this.safeList(projectId, (db) =>
			db.select().from(questions).where(eq(questions.sessionId, sessionId)).orderBy(asc(questions.createdAt)).all()
		);
	}

	/** All check-ins across every session in a project, newest first. */
	async getReports(projectId: string): Promise<ReportRecord[]> {
		return this.safeList(projectId, (db) =>
			db
				.select({
					id: checkins.id,
					sessionId: checkins.sessionId,
					trigger: checkins.trigger,
					summary: checkins.summary,
					discordMessageId: checkins.discordMessageId,
					status: checkins.status,
					archived: checkins.archived,
					createdAt: checkins.createdAt,
					completedAt: checkins.completedAt,
					sessionName: sessions.name,
					sessionTask: sessions.task,
				})
				.from(checkins)
				.innerJoin(sessions, eq(checkins.sessionId, sessions.id))
				.orderBy(desc(checkins.createdAt))
				.all()
		);
	}

	async getCompactions(projectId: string, sessionId: string): Promise<CompactionRecord[]> {
		return this.safeList(projectId, (db) =>
			db.select().from(compactions).where(eq(compactions.sessionId, sessionId)).orderBy(asc(compactions.createdAt)).all()
		);
	}

	async getTasks(projectId: string, sessionId?: string) {
		return this.safeList(projectId, (db) => {
			if (sessionId) {
				return db.select().from(tasks).where(eq(tasks.sessionId, sessionId)).all();
			}
			return db.select().from(tasks).all();
		});
	}

	// ── Archive writes ─────────────────────────────────────────────────────────
	// The `archived` flag is a UI-only organizing device (no agent behaviour hangs
	// off it), so it's written straight to the project DB here rather than proxied
	// through the running agent — which means archiving works whether or not the
	// container is up. Each write is a single targeted UPDATE of one column; the
	// agent's own updates only ever set their specific columns, so they never race
	// or clobber `archived`. Returns whether a row actually matched.

	async setTaskArchived(projectId: string, taskId: string, archived: boolean): Promise<boolean> {
		return this.withWritableDb(projectId, (db) => {
			const updated = db
				.update(tasks)
				.set({ archived, updatedAt: Date.now() })
				.where(eq(tasks.id, taskId))
				.returning({ id: tasks.id })
				.all();
			return updated.length > 0;
		});
	}

	async setSessionArchived(projectId: string, sessionId: string, archived: boolean): Promise<boolean> {
		return this.withWritableDb(projectId, (db) => {
			const updated = db
				.update(sessions)
				.set({ archived, updatedAt: Date.now() })
				.where(eq(sessions.id, sessionId))
				.returning({ id: sessions.id })
				.all();
			return updated.length > 0;
		});
	}

	// A "report" in the UI is a check-in row (see getReports), so archiving one
	// flips the flag on the underlying check-in.
	async setReportArchived(projectId: string, reportId: string, archived: boolean): Promise<boolean> {
		return this.withWritableDb(projectId, (db) => {
			const updated = db.update(checkins).set({ archived }).where(eq(checkins.id, reportId)).returning({ id: checkins.id }).all();
			return updated.length > 0;
		});
	}

	// ── Bulk "archive finished" ──────────────────────────────────────────────
	// Each archives every not-yet-archived row in a terminal state in one UPDATE,
	// mirroring the "Finished" grouping the UI shows. Returns the count archived.

	// Finished tasks = done or cancelled.
	async archiveFinishedTasks(projectId: string): Promise<number> {
		return this.withWritableDb(projectId, (db) => {
			const updated = db
				.update(tasks)
				.set({ archived: true, updatedAt: Date.now() })
				.where(and(eq(tasks.archived, false), inArray(tasks.status, ["done", "cancelled"])))
				.returning({ id: tasks.id })
				.all();
			return updated.length;
		});
	}

	// Finished sessions = completed, aborted, or error.
	async archiveFinishedSessions(projectId: string): Promise<number> {
		return this.withWritableDb(projectId, (db) => {
			const updated = db
				.update(sessions)
				.set({ archived: true, updatedAt: Date.now() })
				.where(and(eq(sessions.archived, false), inArray(sessions.status, ["completed", "aborted", "error"])))
				.returning({ id: sessions.id })
				.all();
			return updated.length;
		});
	}

	// Reports (check-ins) belonging to a finished session. Resolves the finished
	// session ids first, then archives their un-archived check-ins. Returns the
	// archived check-in ids so the caller can cascade to each one's linked vector
	// memory entry (report_<checkinId>) — the count is `ids.length`.
	async archiveReportsOfFinishedSessions(projectId: string): Promise<string[]> {
		return this.withWritableDb(projectId, (db) => {
			const finished = db
				.select({ id: sessions.id })
				.from(sessions)
				.where(inArray(sessions.status, ["completed", "aborted", "error"]))
				.all()
				.map((row) => row.id);
			if (finished.length === 0) return [];
			const updated = db
				.update(checkins)
				.set({ archived: true })
				.where(and(eq(checkins.archived, false), inArray(checkins.sessionId, finished)))
				.returning({ id: checkins.id })
				.all();
			return updated.map((row) => row.id);
		});
	}
}
