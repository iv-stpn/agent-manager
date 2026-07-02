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
import { asc, desc, eq, sql } from "drizzle-orm";
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

	private withDb<T>(projectId: string, fn: (db: ProjectDb) => T): T {
		const { db, sqlite } = this.open(projectId);
		try {
			return fn(db);
		} finally {
			sqlite.close();
		}
	}

	private safeList<T>(projectId: string, fn: (db: ProjectDb) => T[]): T[] {
		try {
			return this.withDb(projectId, fn);
		} catch {
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
		} catch {
			return { sessions: 0, messages: 0, lastActivity: null, reports: 0 };
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: raw SQL query returns untyped rows
	async getProjectSessions(projectId: string, limit = 10): Promise<any[]> {
		return this.safeList(projectId, (db) =>
			db
				.select({ id: sessions.id, title: sessions.name, created_at: sessions.createdAt, updated_at: sessions.updatedAt })
				.from(sessions)
				.orderBy(desc(sessions.updatedAt))
				.limit(limit)
				.all()
		);
	}

	// biome-ignore lint/suspicious/noExplicitAny: raw SQL pass-through requires dynamic typing
	async queryProject(projectId: string, rawSql: string, params: any[] = []): Promise<any[]> {
		const { sqlite } = this.open(projectId);
		try {
			return sqlite.query(rawSql).all(...params);
		} finally {
			sqlite.close();
		}
	}

	async getSessions(projectId: string): Promise<SessionRecord[]> {
		return this.safeList(projectId, (db) => db.select().from(sessions).all());
	}

	async getSession(projectId: string, sessionId: string): Promise<SessionRecord | null> {
		try {
			return this.withDb(projectId, (db) => db.select().from(sessions).where(eq(sessions.id, sessionId)).get()) ?? null;
		} catch {
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
}
