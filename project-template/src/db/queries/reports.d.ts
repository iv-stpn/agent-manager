import type { Db } from "../client";
import { type NewReport, type Report } from "../schema";
export declare function insertReport(db: Db, data: NewReport): void;
export declare function listReports(db: Db, sessionId: string): Report[];
