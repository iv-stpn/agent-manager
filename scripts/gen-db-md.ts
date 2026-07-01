#!/usr/bin/env bun

/**
 * Generate database documentation in docs/DATABASE.md.
 *
 * There are two databases in this project:
 *   - Orchestrator — the orchestrator's own SQLite db (templates, archives, global
 *               stats). Schema lives as raw `CREATE TABLE` SQL in
 *               apps/api/src/db/orchestrator-database.ts.
 *   - Project — one SQLite db per managed project, holding a project's sessions,
 *               messages, tool calls, etc. Schema is a Drizzle definition in
 *               packages/db/src/project-schema.ts.
 *
 * Structure (columns, types, constraints) is read by introspecting each schema
 * at runtime so the docs always match what actually gets created. Human-readable
 * descriptions come from the `//` / `--` comments written next to each table and
 * column in those schema files — so to document a column, just comment it.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PROJECT_SCHEMA_SRC = join(ROOT, "packages", "db", "src", "project-schema.ts");
const ORCHESTRATOR_DB_SRC = join(ROOT, "apps", "api", "src", "db", "orchestrator-database.ts");
const OUT_FILE = join(ROOT, "docs", "DATABASE.md");

// ── Shared types ─────────────────────────────────────────────────────────────

interface ColumnDoc {
	name: string;
	type: string;
	notNull: boolean;
	primaryKey: boolean;
	default?: string;
	enumValues?: string[];
	references?: string; // "table.column"
	comment?: string;
}

interface TableDoc {
	name: string;
	comment?: string;
	columns: ColumnDoc[];
}

/**
 * Build a ColumnDoc, only setting optional fields when their value is defined.
 * Needed because `exactOptionalPropertyTypes` forbids assigning `undefined` to
 * an optional `string` field — the raw schema lookups all return `| undefined`.
 */
function makeColumn(c: {
	name: string;
	type: string;
	notNull: boolean;
	primaryKey: boolean;
	default: string | undefined;
	enumValues?: string[] | undefined;
	references: string | undefined;
	comment: string | undefined;
}): ColumnDoc {
	const doc: ColumnDoc = { name: c.name, type: c.type, notNull: c.notNull, primaryKey: c.primaryKey };
	if (c.default !== undefined) doc.default = c.default;
	if (c.enumValues !== undefined) doc.enumValues = c.enumValues;
	if (c.references !== undefined) doc.references = c.references;
	if (c.comment !== undefined) doc.comment = c.comment;
	return doc;
}

/** Build a TableDoc, only setting `comment` when defined (see makeColumn). */
function makeTable(name: string, comment: string | undefined, columns: ColumnDoc[]): TableDoc {
	const t: TableDoc = { name, columns };
	if (comment !== undefined) t.comment = comment;
	return t;
}

// Comments parsed out of a schema source file, keyed by table then column.
// The special "" column key holds the table-level description.
type CommentMap = Map<string, Map<string, string>>;

// ── Comment parsing ──────────────────────────────────────────────────────────
// Pull leading/trailing line comments out of a schema source file. Works for
// both `//` (TypeScript) and `--` (SQL) comment markers.

function stripComment(line: string, marker: string): string | undefined {
	const idx = line.indexOf(marker);
	if (idx === -1) return undefined;
	const text = line.slice(idx + marker.length).trim();
	return text.length ? text : undefined;
}

/**
 * Walk a block of source lines, associating each column with its comment.
 * A column is identified by `columnNameOf(line)` returning its name. A column's
 * description is taken, in priority order, from: a trailing comment on any line
 * of its (possibly multi-line) definition, then a leading comment line directly
 * above it. Bare leading comments before the first column are dropped — table
 * descriptions are captured separately by `leadingComment`.
 */
function collectColumnComments(
	lines: string[],
	marker: string,
	columnNameOf: (line: string) => string | undefined
): Map<string, string> {
	const out = new Map<string, string>();
	let pending: string | undefined; // leading comment awaiting its column
	let current: string | undefined; // column whose definition we're inside
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith(marker)) {
			pending = stripComment(trimmed, marker);
			continue;
		}
		const col = columnNameOf(line);
		const trailing = stripComment(line, marker);
		if (col) {
			current = col;
			const desc = trailing ?? pending;
			if (desc) out.set(col, desc);
			pending = undefined;
		} else if (current && trailing) {
			// Trailing comment on a continuation line of the current column wins
			// over any section-banner leading comment.
			out.set(current, trailing);
		}
	}
	return out;
}

/** Leading comment lines immediately above `index`, joined into one string. */
function leadingComment(lines: string[], index: number, marker: string): string | undefined {
	const collected: string[] = [];
	for (let i = index - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line.startsWith(marker)) {
			const comment = stripComment(line, marker);
			if (comment) collected.unshift(comment);
		} else if (line === "") {
			if (collected.length) break;
		} else {
			break;
		}
	}
	return collected.length ? collected.join(" ") : undefined;
}

// ── Project schema (Drizzle) ─────────────────────────────────────────────────

async function buildProjectTables(): Promise<TableDoc[]> {
	// drizzle-orm is a project-template dependency, not a root one — resolve it there.
	const { getTableConfig } = (await import(
		join(ROOT, "project-template", "node_modules", "drizzle-orm", "sqlite-core", "index.js")
	)) as typeof import("drizzle-orm/sqlite-core");
	const schema = await import(PROJECT_SCHEMA_SRC);

	const src = readFileSync(PROJECT_SCHEMA_SRC, "utf8");
	const srcLines = src.split("\n");
	const comments = parseProjectComments(src, srcLines);

	const tables: TableDoc[] = [];
	for (const value of Object.values(schema)) {
		// Drizzle table objects carry a known symbol; getTableConfig throws on others.
		let config: ReturnType<typeof getTableConfig>;
		try {
			config = getTableConfig(value as Parameters<typeof getTableConfig>[0]);
		} catch {
			continue;
		}

		const fkByColumn = new Map<string, string>();
		for (const fk of config.foreignKeys) {
			const ref = fk.reference();
			ref.columns.forEach((column, idx) => {
				const target = ref.foreignColumns[idx];
				fkByColumn.set(column.name, `${getTableConfig(ref.foreignTable).name}.${target.name}`);
			});
		}
		const pkColumns = new Set(config.primaryKeys.flatMap((pk) => pk.columns.map((column) => column.name)));
		const tableComments = comments.get(config.name) ?? new Map<string, string>();

		const columns: ColumnDoc[] = config.columns.map((column) =>
			makeColumn({
				name: column.name,
				type: column.getSQLType(),
				notNull: column.notNull,
				primaryKey: column.primary || pkColumns.has(column.name),
				default: formatDefault(column.default, column.hasDefault),
				enumValues: (column.enumValues as string[] | undefined)?.length ? (column.enumValues as string[]) : undefined,
				references: fkByColumn.get(column.name),
				comment: tableComments.get(column.name),
			})
		);

		tables.push(makeTable(config.name, tableComments.get(""), columns));
	}

	tables.sort((a, b) => a.name.localeCompare(b.name));
	return tables;
}

function formatDefault(value: unknown, hasDefault: boolean): string | undefined {
	if (!hasDefault || value === undefined) return undefined;
	if (value === null) return "null";
	if (typeof value === "object") return "expression"; // sql`...` default
	return String(value);
}

/** Parse `//` comments from the Drizzle schema, grouped by table then column. */
function parseProjectComments(src: string, lines: string[]): CommentMap {
	const map: CommentMap = new Map();
	const tableRe = /export const \w+ = sqliteTable\(\s*"([^"]+)"/g;
	for (const m of src.matchAll(tableRe)) {
		const tableName = m[1];
		const startLine = src.slice(0, m.index).split("\n").length - 1;
		// Block runs until the matching `});` at column 0.
		let endLine = startLine;
		for (let i = startLine; i < lines.length; i++) {
			if (lines[i].startsWith("});")) {
				endLine = i;
				break;
			}
		}
		const block = lines.slice(startLine + 1, endLine);
		const colComments = collectColumnComments(block, "//", (line) => {
			const cm = line.match(/^\s*\w+:\s*(?:text|integer)\(\s*"([^"]+)"/);
			return cm?.[1];
		});
		const tableComment = leadingComment(lines, startLine, "//");
		if (tableComment) colComments.set("", tableComment);
		map.set(tableName, colComments);
	}
	return map;
}

// ── Orchestrator schema (raw CREATE TABLE SQL) ─────────────────────────────────────

function buildOrchestratorTables(): TableDoc[] {
	const { OrchestratorDatabase } = require(join(ROOT, "apps", "api", "src", "db", "orchestrator-database.ts"));
	const tmp = mkdtempSync(join(tmpdir(), "gen-db-md-"));
	const comments = parseOrchestratorComments();

	try {
		const dbInstance = new OrchestratorDatabase(tmp);
		// Reach the underlying bun:sqlite handle to introspect via PRAGMA.
		const db = (dbInstance as unknown as { sqlite: import("bun:sqlite").Database }).sqlite;

		const tableNames = db
			.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
			.all() as { name: string }[];

		const tables: TableDoc[] = tableNames.map(({ name }) => {
			const tableComments = comments.get(name) ?? new Map<string, string>();
			const info = db.query(`PRAGMA table_info("${name}")`).all() as {
				name: string;
				type: string;
				notnull: number;
				dflt_value: string | null;
				pk: number;
			}[];
			const fks = db.query(`PRAGMA foreign_key_list("${name}")`).all() as {
				from: string;
				table: string;
				to: string;
			}[];
			const fkByColumn = new Map(fks.map((fk) => [fk.from, `${fk.table}.${fk.to}`]));

			const columns: ColumnDoc[] = info.map((column) =>
				makeColumn({
					name: column.name,
					type: column.type || "TEXT",
					notNull: column.notnull === 1,
					primaryKey: column.pk > 0,
					default: column.dflt_value ?? undefined,
					references: fkByColumn.get(column.name),
					comment: tableComments.get(column.name),
				})
			);

			return makeTable(name, tableComments.get(""), columns);
		});

		dbInstance.close();
		return tables;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** Parse `--` comments from each CREATE TABLE block in the orchestrator schema. */
function parseOrchestratorComments(): CommentMap {
	const src = readFileSync(ORCHESTRATOR_DB_SRC, "utf8");
	const lines = src.split("\n");
	const map: CommentMap = new Map();

	const createRe = /CREATE TABLE IF NOT EXISTS (\w+) \(/g;
	for (const m of src.matchAll(createRe)) {
		const tableName = m[1];
		const startLine = src.slice(0, m.index).split("\n").length - 1;
		let endLine = startLine;
		for (let i = startLine; i < lines.length; i++) {
			if (lines[i].includes(");")) {
				endLine = i;
				break;
			}
		}
		const block = lines.slice(startLine + 1, endLine);
		const reserved = new Set(["FOREIGN", "PRIMARY", "UNIQUE", "CHECK", "CONSTRAINT"]);
		const colComments = collectColumnComments(block, "--", (line) => {
			const cm = line.trim().match(/^([a-z_]\w*)\s+/i);
			const tok = cm?.[1];
			return tok && !reserved.has(tok.toUpperCase()) ? tok : undefined;
		});
		const tableComment = leadingComment(lines, startLine, "--");
		if (tableComment) colComments.set("", tableComment);
		map.set(tableName, colComments);
	}
	return map;
}

// ── Default-seed detection ───────────────────────────────────────────────────

/**
 * Which orchestrator tables get default rows on first open. Read from the
 * `seedDefaults()` method in orchestrator-database.ts so the docs stay in sync with
 * whatever that method actually inserts.
 */
function parseSeededTables(): string[] {
	const src = readFileSync(ORCHESTRATOR_DB_SRC, "utf8");
	const start = src.indexOf("seedDefaults()");
	if (start === -1) return [];
	const braceStart = src.indexOf("{", start);
	let depth = 0;
	let end = src.length;
	for (let i = braceStart; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}" && --depth === 0) {
			end = i;
			break;
		}
	}
	const body = src.slice(braceStart, end);
	const tables = new Set<string>();
	for (const m of body.matchAll(/INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(\w+)/gi)) tables.add(m[1]);
	return [...tables].sort();
}

// ── Markdown rendering ───────────────────────────────────────────────────────

function renderTable(t: TableDoc): string {
	const out: string[] = [`### \`${t.name}\``, ""];
	if (t.comment) out.push(t.comment, "");
	out.push("| Column | Type | Constraints | Description |", "| --- | --- | --- | --- |");
	for (const c of t.columns) {
		const constraints: string[] = [];
		if (c.primaryKey) constraints.push("PK");
		if (c.notNull && !c.primaryKey) constraints.push("not null");
		if (c.default !== undefined) constraints.push(`default \`${c.default}\``);
		if (c.references) constraints.push(`→ \`${c.references}\``);
		let desc = c.comment ?? "";
		if (c.enumValues) desc = `${desc ? `${desc} ` : ""}One of: ${c.enumValues.map((value) => `\`${value}\``).join(", ")}`;
		out.push(`| \`${c.name}\` | \`${c.type}\` | ${constraints.join(", ") || "—"} | ${desc || "—"} |`);
	}
	out.push("");
	return out.join("\n");
}

function renderSection(title: string, intro: string, tables: TableDoc[]): string {
	return [`## ${title}`, "", intro, "", ...tables.map(renderTable)].join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

const projectTables = await buildProjectTables();
const orchestratorTables = buildOrchestratorTables();
const seededTables = parseSeededTables();

const orchestratorIntro =
	"The orchestrator's own database (`orchestrator.db`): templates, archived projects/sessions, and global statistics. " +
	"Defined in `apps/api/src/db/orchestrator-database.ts`." +
	(seededTables.length
		? ` On first open, the constructor runs \`seedDefaults()\`, which populates default rows for ${seededTables
				.map((table) => `\`${table}\``)
				.join(" and ")} when those tables are empty.`
		: "");

const doc = [
	"# Database Schema",
	"",
	"> Generated by `scripts/gen-db-md.ts` — do not edit by hand. Run `bun run gen:db-md` to regenerate.",
	"> Descriptions are sourced from the comments next to each table/column in the schema files.",
	"",
	renderSection("Orchestrator", orchestratorIntro, orchestratorTables),
	renderSection(
		"Project",
		"One database per managed project, holding that project's agent sessions and their activity. Defined in `packages/db/src/project-schema.ts`.",
		projectTables
	),
].join("\n");

writeFileSync(OUT_FILE, `${doc.trimEnd()}\n`);
console.log(`Wrote ${OUT_FILE} (${orchestratorTables.length} orchestrator + ${projectTables.length} project tables)`);
