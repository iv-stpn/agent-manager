import type { Db } from "../client";
import { type NewSession, type Session } from "../schema";
export declare function createSession(db: Db, data: NewSession): Session;
export declare function getSession(db: Db, id: string): Session | undefined;
export declare function listSessions(db: Db): Session[];
export declare function updateSession(db: Db, id: string, data: Partial<Omit<Session, "id" | "createdAt">>): void;
export declare function addTokens(db: Db, id: string, inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number): void;
