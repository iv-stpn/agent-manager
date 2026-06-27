import type { Db } from "../client";
import { type NewCompaction } from "../schema";
export declare function insertCompaction(db: Db, data: NewCompaction): {
    id: string;
    createdAt: number;
    sessionId: string;
    summary: string;
    messagesBefore: number;
    messagesAfter: number;
    tokensBefore: number;
    tokensAfter: number;
    thresholdTokens: number;
};
export declare function getCompactions(db: Db, sessionId: string): {
    id: string;
    createdAt: number;
    sessionId: string;
    summary: string;
    messagesBefore: number;
    messagesAfter: number;
    tokensBefore: number;
    tokensAfter: number;
    thresholdTokens: number;
}[];
