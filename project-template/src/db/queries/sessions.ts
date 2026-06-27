import { desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../client";
import { type NewSession, type Session, sessions } from "../schema";

export function createSession(db: Db, data: NewSession): Session {
	db.insert(sessions).values(data).run();
	const result = db.select().from(sessions).where(eq(sessions.id, data.id)).get();
	if (!result) throw new Error("Session not found after insert");
	return result;
}

export function getSession(db: Db, id: string): Session | undefined {
	return db.select().from(sessions).where(eq(sessions.id, id)).get();
}

export function listSessions(db: Db): Session[] {
	return db.select().from(sessions).orderBy(desc(sessions.createdAt)).all();
}

export function updateSession(db: Db, id: string, data: Partial<Omit<Session, "id" | "createdAt">>): void {
	db.update(sessions)
		.set({ ...data, updatedAt: Date.now() })
		.where(eq(sessions.id, id))
		.run();
}

export function stopRunningSessions(db: Db): void {
	db.update(sessions)
		.set({ status: "stopped", updatedAt: Date.now() })
		.where(inArray(sessions.status, ["running", "compacting"]))
		.run();
}

export function addTokens(
	db: Db,
	id: string,
	inputTokens: number,
	outputTokens: number,
	cacheReadTokens = 0,
	cacheWriteTokens = 0
): void {
	const session = getSession(db, id);
	if (!session) return;
	updateSession(db, id, {
		totalInputTokens: session.totalInputTokens + inputTokens,
		totalOutputTokens: session.totalOutputTokens + outputTokens,
		totalCacheReadTokens: session.totalCacheReadTokens + cacheReadTokens,
		totalCacheWriteTokens: session.totalCacheWriteTokens + cacheWriteTokens,
	});
}
