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

	// CREATE TABLE IF NOT EXISTS won't add columns to an already-existing
	// table, so backfill any new columns introduced after a project's agent.db
	// was first created. Each is idempotent — skipped once the column exists.
	migrate(sqlite);

	return drizzle(sqlite, { schema });
}

/** Add columns introduced after the first release to pre-existing agent.db files. */
function migrate(sqlite: Database) {
	const columns = (table: string): Set<string> =>
		new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name));

	// `compacted_out` marks messages summarized out of the active context by a
	// compaction. Old DBs predate the column; add it with the same default as
	// the schema so existing rows read as "still active".
	if (!columns("messages").has("compacted_out")) {
		sqlite.exec("ALTER TABLE messages ADD COLUMN compacted_out INTEGER NOT NULL DEFAULT 0");
	}

	// Token tracking since last compaction — added to track per-compaction-cycle
	// token consumption. Old DBs predate these columns; add them with default 0.
	const sessionCols = columns("sessions");
	if (!sessionCols.has("tokens_input_since_compaction")) {
		sqlite.exec("ALTER TABLE sessions ADD COLUMN tokens_input_since_compaction INTEGER NOT NULL DEFAULT 0");
	}
	if (!sessionCols.has("tokens_output_since_compaction")) {
		sqlite.exec("ALTER TABLE sessions ADD COLUMN tokens_output_since_compaction INTEGER NOT NULL DEFAULT 0");
	}
	if (!sessionCols.has("tokens_cache_read_since_compaction")) {
		sqlite.exec("ALTER TABLE sessions ADD COLUMN tokens_cache_read_since_compaction INTEGER NOT NULL DEFAULT 0");
	}
	if (!sessionCols.has("tokens_cache_write_since_compaction")) {
		sqlite.exec("ALTER TABLE sessions ADD COLUMN tokens_cache_write_since_compaction INTEGER NOT NULL DEFAULT 0");
	}
}
