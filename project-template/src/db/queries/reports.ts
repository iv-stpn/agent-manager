import { type NewReport, type Report, reports } from "@agent-manager/db/project-schema";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../client";

export function insertReport(db: Db, data: NewReport): void {
	db.insert(reports).values(data).run();
}

export function listReports(db: Db, sessionId: string): Report[] {
	return db.select().from(reports).where(eq(reports.sessionId, sessionId)).orderBy(desc(reports.createdAt)).all();
}
