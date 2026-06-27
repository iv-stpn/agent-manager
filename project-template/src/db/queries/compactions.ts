import { asc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { type NewCompaction, compactions } from "../schema";

export function insertCompaction(db: Db, data: NewCompaction) {
	db.insert(compactions).values(data).run();
	const result = db.select().from(compactions).where(eq(compactions.id, data.id)).get();
	if (!result) throw new Error("Compaction not found after insert");
	return result;
}

export function getCompactions(db: Db, sessionId: string) {
	return db.select().from(compactions).where(eq(compactions.sessionId, sessionId)).orderBy(asc(compactions.createdAt)).all();
}
