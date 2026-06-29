import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createSchemaSql } from "@agent-manager/db/ddl";
import * as schema from "@agent-manager/db/project-schema";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { env } from "../env";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

let _db: ReturnType<typeof drizzle> | null = null;

function ensureDir(path: string) {
	const dir = dirname(path);
	if (dir && dir !== ".") {
		mkdirSync(dir, { recursive: true });
	}
}

export function getDb(path = env.DATABASE_PATH) {
	if (_db) return _db;
	ensureDir(path);
	const sqlite = new Database(path, { create: true });
	sqlite.exec("PRAGMA journal_mode = WAL;");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	_db = drizzle(sqlite, { schema });
	return _db;
}

export function initDb(path = env.DATABASE_PATH) {
	ensureDir(path);
	const sqlite = new Database(path, { create: true });
	sqlite.exec("PRAGMA journal_mode = WAL;");
	sqlite.exec("PRAGMA foreign_keys = ON;");

	// Create every table straight from the Drizzle schema so the runtime DDL
	// can never drift from the typed definitions.
	sqlite.exec(createSchemaSql(schema));
	return drizzle(sqlite, { schema });
}
