import { SQL } from "drizzle-orm";
import { getTableConfig, SQLiteSyncDialect, type SQLiteTable } from "drizzle-orm/sqlite-core";

// Derive `CREATE TABLE IF NOT EXISTS` DDL straight from the Drizzle table
// definitions so the runtime schema can never drift from the typed schema.
// Used by the project-template server to bootstrap a fresh agent.db without
// hand-maintained SQL.

const dialect = new SQLiteSyncDialect();

function renderDefault(value: unknown): string {
	if (value instanceof SQL) {
		const { sql, params } = dialect.sqlToQuery(value);
		if (params.length === 0) return sql;
		// Inline simple params for the rare default that carries them.
		let i = 0;
		return sql.replace(/\?/g, () => renderLiteral(params[i++]));
	}
	return renderLiteral(value);
}

function renderLiteral(value: unknown): string {
	if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
	if (typeof value === "boolean") return value ? "1" : "0";
	if (value === null || value === undefined) return "NULL";
	return String(value);
}

/** Render one column's definition (`"name" TYPE [PRIMARY KEY] [NOT NULL] …`). */
function renderColumnDef(column: ReturnType<typeof getTableConfig>["columns"][number]): string {
	const parts = [`"${column.name}"`, column.getSQLType()];
	if (column.primary) parts.push("PRIMARY KEY");
	if (column.notNull) parts.push("NOT NULL");
	if (column.isUnique) parts.push("UNIQUE");
	if (column.hasDefault && column.default !== undefined) {
		parts.push(`DEFAULT ${renderDefault(column.default)}`);
	}
	return parts.join(" ");
}

/** Build the `CREATE TABLE IF NOT EXISTS` statement for a single Drizzle table. */
export function createTableSql(table: SQLiteTable): string {
	const config = getTableConfig(table);
	const lines: string[] = [];

	for (const column of config.columns) {
		lines.push(`\t${renderColumnDef(column)}`);
	}

	for (const fk of config.foreignKeys) {
		const reference = fk.reference();

		const from = reference.columns.map((column) => `"${column.name}"`).join(", ");
		const to = reference.foreignColumns.map((column) => `"${column.name}"`).join(", ");

		const target = getTableConfig(reference.foreignTable as SQLiteTable).name;
		lines.push(`\tFOREIGN KEY (${from}) REFERENCES "${target}"(${to})`);
	}

	return `CREATE TABLE IF NOT EXISTS "${config.name}" (\n${lines.join(",\n")}\n);`;
}

/** Build the full DDL for every table in a schema module, in declaration order. */
export function createSchemaSql(schema: Record<string, unknown>): string {
	const statements: string[] = [];
	for (const value of Object.values(schema)) {
		if (isSQLiteTable(value)) statements.push(createTableSql(value));
	}
	return statements.join("\n\n");
}

function isSQLiteTable(value: unknown): value is SQLiteTable {
	return typeof value === "object" && value !== null && Symbol.for("drizzle:IsDrizzleTable") in value;
}

// ── Additive column migrations (schema-driven) ───────────────────────────────
//
// `CREATE TABLE IF NOT EXISTS` bootstraps a fresh DB but never adds a column to
// a table that already exists, so any column introduced after a DB was first
// created is silently missing on that DB. `migrateSchema` closes the gap: it
// diffs each table's live columns (PRAGMA table_info) against the Drizzle
// schema and issues `ALTER TABLE ADD COLUMN` for anything absent. Derived from
// the schema itself, so it stays drift-free — a new column in the schema is
// migrated automatically, no hand-maintained ALTER list (unlike the older
// project-DB migrate.ts). SQLite only allows ADD COLUMN with a constant (or no)
// default, which every additive column here uses.

/** Minimal structural type so this works with any bun:sqlite Database. */
export interface AlterableDb {
	exec(sql: string): void;
	prepare(sql: string): { all(): unknown[] };
}

function liveColumns(db: AlterableDb, table: string): Set<string> {
	// `table` is a schema-derived identifier (never user input), so interpolation
	// here is safe; PRAGMA doesn't accept bound parameters for the table name.
	const rows = db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as { name: string }[];
	return new Set(rows.map((row) => row.name));
}

/**
 * Add every schema column missing from an existing table. Idempotent — a column
 * already present is skipped, and a table that doesn't exist yet is left to
 * `createSchemaSql` (ALTER would throw). A NOT-NULL column with no default can't
 * be added to a populated table in SQLite; such a column is skipped with a
 * warning rather than throwing, since it signals a schema change that needs a
 * hand-written data migration.
 */
export function migrateSchema(db: AlterableDb, schema: Record<string, unknown>): void {
	for (const value of Object.values(schema)) {
		if (!isSQLiteTable(value)) continue;
		const config = getTableConfig(value);
		const existing = liveColumns(db, config.name);
		// Empty set = table absent (fresh DB before its CREATE TABLE ran).
		if (existing.size === 0) continue;
		for (const column of config.columns) {
			if (existing.has(column.name)) continue;
			// SQLite ADD COLUMN can't add PRIMARY KEY / UNIQUE columns, nor a NOT NULL
			// column without a constant default. Any of these signals a change that
			// needs a hand-written data migration — skip with a warning, don't throw.
			const hasConstantDefault = column.hasDefault && column.default !== undefined;
			const blocker = column.primary
				? "PRIMARY KEY"
				: column.isUnique
					? "UNIQUE"
					: column.notNull && !hasConstantDefault
						? "NOT NULL without a default"
						: null;
			if (blocker) {
				console.warn(
					`[db] Cannot auto-add column "${config.name}"."${column.name}" (${blocker}) — ` +
						"needs a hand-written migration; skipping."
				);
				continue;
			}
			db.exec(`ALTER TABLE "${config.name}" ADD COLUMN ${renderColumnDef(column)};`);
		}
	}
}
