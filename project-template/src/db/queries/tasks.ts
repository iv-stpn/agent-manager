import { tasks } from "@agent-manager/db/project-schema";
import { eq } from "drizzle-orm";
import type { Db } from "../client";

type TaskStatus = "pending" | "in_progress" | "done" | "cancelled";

/** List all tasks, optionally filtered by session. */
export function getTasks(db: Db, sessionId?: string) {
	if (sessionId) {
		return db.select().from(tasks).where(eq(tasks.sessionId, sessionId)).all();
	}
	return db.select().from(tasks).all();
}

/** Manual edit of a task's text/status from the UI. Returns null if the task doesn't exist. */
export function updateTaskFields(db: Db, id: string, changes: { text?: string | undefined; status?: TaskStatus | undefined }) {
	const updates: Partial<typeof tasks.$inferInsert> = { updatedAt: Date.now() };
	if (changes.text !== undefined) updates.text = changes.text;
	if (changes.status !== undefined) updates.status = changes.status;
	const [updated] = db.update(tasks).set(updates).where(eq(tasks.id, id)).returning().all();
	return updated ?? null;
}

/** Manual deletion of a task from the UI. Returns false if the task didn't exist. */
export function deleteTaskById(db: Db, id: string): boolean {
	const deleted = db.delete(tasks).where(eq(tasks.id, id)).returning().all();
	return deleted.length > 0;
}
