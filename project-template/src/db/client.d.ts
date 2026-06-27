import { Database } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
export type Db = BunSQLiteDatabase<typeof schema>;
export declare function getDb(path?: string): BunSQLiteDatabase<Record<string, unknown>> & {
    $client: Database;
};
export declare function initDb(path?: string): BunSQLiteDatabase<typeof schema> & {
    $client: Database;
};
