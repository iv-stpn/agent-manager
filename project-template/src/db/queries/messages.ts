import { asc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { type NewMessage, type NewToolCall, messages, toolCalls } from "../schema";

export function insertMessage(db: Db, data: NewMessage) {
	db.insert(messages).values(data).run();
	const result = db.select().from(messages).where(eq(messages.id, data.id)).get();
	if (!result) throw new Error("Message not found after insert");
	return result;
}

export function getMessages(db: Db, sessionId: string) {
	return db.select().from(messages).where(eq(messages.sessionId, sessionId)).orderBy(asc(messages.createdAt)).all();
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
