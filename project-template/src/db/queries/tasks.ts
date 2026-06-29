import { tasks } from "@agent-manager/db/project-schema";
import { eq } from "drizzle-orm";
import type { Db } from "../client";

/** List all tasks, optionally filtered by session. */
export function getTasks(db: Db, sessionId?: string) {
	if (sessionId) {
		return db.select().from(tasks).where(eq(tasks.sessionId, sessionId)).all();
	}
	return db.select().from(tasks).all();
}
