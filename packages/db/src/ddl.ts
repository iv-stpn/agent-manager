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

/** Build the `CREATE TABLE IF NOT EXISTS` statement for a single Drizzle table. */
export function createTableSql(table: SQLiteTable): string {
	const config = getTableConfig(table);
	const lines: string[] = [];

	for (const column of config.columns) {
		const parts = [`"${column.name}"`, column.getSQLType()];
		if (column.primary) parts.push("PRIMARY KEY");
		if (column.notNull) parts.push("NOT NULL");
		if (column.isUnique) parts.push("UNIQUE");
		if (column.hasDefault && column.default !== undefined) {
			parts.push(`DEFAULT ${renderDefault(column.default)}`);
		}
		lines.push(`\t${parts.join(" ")}`);
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
