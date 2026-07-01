import { messages, type NewMessage, type NewToolCall, toolCalls } from "@agent-manager/db/project-schema";
import { and, asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../client";

export function insertMessage(db: Db, data: Omit<NewMessage, "id">) {
	const id = nanoid();
	db.insert(messages)
		.values({ id, ...data })
		.run();
	const result = db.select().from(messages).where(eq(messages.id, id)).get();
	if (!result) throw new Error("Message not found after insert");
	return result;
}

export function updateMessageTokens(db: Db, id: string, inputTokens: number, cacheWriteTokens: number) {
	db.update(messages).set({ inputTokens, cacheWriteTokens }).where(eq(messages.id, id)).run();
}

export function getMessages(db: Db, sessionId: string) {
	return db.select().from(messages).where(eq(messages.sessionId, sessionId)).orderBy(asc(messages.createdAt)).all();
}

/**
 * Messages still part of the active (post-compaction) context — i.e. not yet
 * summarized out by a compaction. Used to rebuild the Anthropic message history
 * on resume/restart so a compacted session doesn't re-feed the transcript that
 * was already summarized. The full timeline (`getMessages`) still returns every
 * row, including compacted-out ones.
 */
export function getRebuildMessages(db: Db, sessionId: string) {
	return db
		.select()
		.from(messages)
		.where(and(eq(messages.sessionId, sessionId), eq(messages.compactedOut, false)))
		.orderBy(asc(messages.createdAt))
		.all();
}

/**
 * Mark every message in the session as summarized out of the active context.
 * Called at the start of a compaction, before persisting the restart primer —
 * the primer becomes the only active message, so a subsequent resume rebuilds
 * from it rather than from the already-summarized transcript. Rows are kept
 * (the timeline still shows them); only the API rebuild skips them.
 */
export function markSessionMessagesCompacted(db: Db, sessionId: string) {
	db.update(messages).set({ compactedOut: true }).where(eq(messages.sessionId, sessionId)).run();
}

export function insertToolCall(db: Db, data: NewToolCall) {
	db.insert(toolCalls).values(data).run();
}

export function completeToolCall(db: Db, id: string, output: string, status: "success" | "error") {
	db.update(toolCalls).set({ output, status, completedAt: Date.now() }).where(eq(toolCalls.id, id)).run();
}

export function getToolCalls(db: Db, sessionId: string) {
	return db.select().from(toolCalls).where(eq(toolCalls.sessionId, sessionId)).orderBy(asc(toolCalls.createdAt)).all();
}
