import { type NewSession, type Session, sessions } from "@agent-manager/db/project-schema";
import { desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../client";

export function createSession(db: Db, data: NewSession): Session {
	db.insert(sessions)
		.values({ ...data, updatedAt: data.createdAt })
		.run();
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
		.set({ status: "aborted", updatedAt: Date.now() })
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
	// The prompt occupying the window this call. Invariant to cache behavior:
	// a cache miss only shifts tokens from cacheRead into input, the sum stays
	// the same — so deltas derived from it never re-count re-read context.
	const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
	// New prompt tokens added since the previous call (user/tool-result content).
	// The previous contextTokens already includes the previous output, which the
	// current prompt re-contains as an assistant message, so the delta is purely
	// what was appended. Clamped: the prompt shrinks on restart (error rows are
	// dropped from the rebuild), which must not produce negative additions.
	const inputAdded = Math.max(0, promptTokens - session.contextTokens);
	updateSession(db, id, {
		// Totals stay billing sums: what the API actually charged per call.
		totalInputTokens: session.totalInputTokens + inputTokens,
		totalOutputTokens: session.totalOutputTokens + outputTokens,
		totalCacheReadTokens: session.totalCacheReadTokens + cacheReadTokens,
		totalCacheWriteTokens: session.totalCacheWriteTokens + cacheWriteTokens,
		// Since-compaction input/output track context composition, not billing:
		// input added + output generated ≈ current context size, so these read
		// directly against compactThresholdTokens. Cache counters remain billing
		// sums (a per-call metric has no context interpretation).
		tokensInputSinceCompaction: session.tokensInputSinceCompaction + inputAdded,
		tokensOutputSinceCompaction: session.tokensOutputSinceCompaction + outputTokens,
		tokensCacheReadSinceCompaction: session.tokensCacheReadSinceCompaction + cacheReadTokens,
		tokensCacheWriteSinceCompaction: session.tokensCacheWriteSinceCompaction + cacheWriteTokens,
		// Live context size: everything this call put in the window. This is the
		// metric the auto-compaction trigger compares against compactThresholdTokens.
		contextTokens: promptTokens + outputTokens,
	});
}
