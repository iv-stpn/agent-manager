import { type NewReport, reports } from "@agent-manager/db/project-schema";
import type { Db } from "../client";

export function insertReport(db: Db, data: NewReport): void {
	db.insert(reports).values(data).run();
}
