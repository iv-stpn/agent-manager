// Additive migrations for project `agent.db` files. `CREATE TABLE IF NOT EXISTS`
// (see ddl.ts) bootstraps a fresh DB but never adds columns to a table that
// already exists, so any column introduced after a project's DB was first
// created must be backfilled here. Each step is idempotent — guarded by a
// column-existence check — so running it repeatedly is a no-op.
//
// Shared so both the agent (project-template, on container start) and the
// orchestrator (which reads project DBs directly, without the agent running)
// converge a stale DB to the current schema. Kept runtime-agnostic via a
// minimal structural type so it works with any bun:sqlite Database.

export interface MigratableDb {
	exec(sql: string): void;
	prepare(sql: string): { all(): unknown[] };
}

/** Column names introduced after the first release, per table. */
const ADDED_COLUMNS: Record<string, Array<{ name: string; ddl: string }>> = {
	messages: [
		// Marks messages summarized out of the active context by a compaction.
		// Default 0 so existing rows read as "still active".
		{ name: "compacted_out", ddl: "ALTER TABLE messages ADD COLUMN compacted_out INTEGER NOT NULL DEFAULT 0" },
	],
	sessions: [
		// Per-compaction-cycle token tracking. Default 0 on old rows.
		{ name: "tokens_input_since_compaction", ddl: "ALTER TABLE sessions ADD COLUMN tokens_input_since_compaction INTEGER NOT NULL DEFAULT 0" },
		{ name: "tokens_output_since_compaction", ddl: "ALTER TABLE sessions ADD COLUMN tokens_output_since_compaction INTEGER NOT NULL DEFAULT 0" },
		{ name: "tokens_cache_read_since_compaction", ddl: "ALTER TABLE sessions ADD COLUMN tokens_cache_read_since_compaction INTEGER NOT NULL DEFAULT 0" },
		{ name: "tokens_cache_write_since_compaction", ddl: "ALTER TABLE sessions ADD COLUMN tokens_cache_write_since_compaction INTEGER NOT NULL DEFAULT 0" },
	],
};

function columnNames(sqlite: MigratableDb, table: string): Set<string> {
	const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
	return new Set(rows.map((row) => row.name));
}

/**
 * Report whether any additive migration is outstanding, without writing.
 * Lets a read-only reader decide if it needs a writable pass before opening
 * the DB writable (which it otherwise never should).
 */
export function projectDbNeedsMigration(sqlite: MigratableDb): boolean {
	for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
		const existing = columnNames(sqlite, table);
		// An empty set means the table doesn't exist yet (fresh DB before its
		// CREATE TABLE ran) — nothing to backfill; the DDL will create it whole.
		if (existing.size === 0) continue;
		if (cols.some((col) => !existing.has(col.name))) return true;
	}
	return false;
}

/** Apply every outstanding additive column migration. Idempotent. */
export function migrateProjectDb(sqlite: MigratableDb): void {
	for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
		const existing = columnNames(sqlite, table);
		// Skip tables that don't exist — ALTER would throw. A fresh DB gets these
		// columns from the CREATE TABLE DDL instead.
		if (existing.size === 0) continue;
		for (const col of cols) {
			if (!existing.has(col.name)) sqlite.exec(col.ddl);
		}
	}
}
