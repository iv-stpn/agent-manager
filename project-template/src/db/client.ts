import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createSchemaSql } from "@agent-manager/db/ddl";
import { migrateProjectDb } from "@agent-manager/db/migrate";
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

	// CREATE TABLE IF NOT EXISTS won't add columns to an already-existing
	// table, so backfill any new columns introduced after a project's agent.db
	// was first created. Each is idempotent — skipped once the column exists.
	migrateProjectDb(sqlite);

	return drizzle(sqlite, { schema });
}
