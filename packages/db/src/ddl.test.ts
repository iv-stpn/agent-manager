import { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createSchemaSql, migrateSchema } from "./ddl";

// A schema whose `widgets` table gained columns after its first release: a
// nullable one, one with a constant default, one NOT NULL with a default, and
// one NOT NULL WITHOUT a default (the un-migratable case).
const widgets = sqliteTable("widgets", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	// added later:
	note: text("note"), // nullable → addable
	count: integer("count").notNull().default(0), // NOT NULL + default → addable
	color: text("color").default("#000"), // nullable-ish + default → addable
	required: text("required").notNull(), // NOT NULL, no default → NOT addable
});

const schema = { widgets };

/** Open an in-memory DB with only the original (pre-migration) columns. */
function seedOldDb(): Database {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE "widgets" ("id" text PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
	db.exec(`INSERT INTO widgets (id, name) VALUES ('a', 'first');`);
	return db;
}

function columnNames(db: Database, table: string): Set<string> {
	const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
	return new Set(rows.map((r) => r.name));
}

describe("migrateSchema — additive column backfill", () => {
	it("adds nullable and defaulted columns to an existing table", () => {
		const db = seedOldDb();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		migrateSchema(db, schema);
		warn.mockRestore();

		const cols = columnNames(db, "widgets");
		expect(cols.has("note")).toBe(true);
		expect(cols.has("count")).toBe(true);
		expect(cols.has("color")).toBe(true);
	});

	it("preserves existing row data, defaulting the new columns", () => {
		const db = seedOldDb();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		migrateSchema(db, schema);
		warn.mockRestore();

		const row = db.prepare(`SELECT id, name, count, color, note FROM widgets WHERE id = 'a'`).get() as {
			id: string;
			name: string;
			count: number;
			color: string;
			note: string | null;
		};
		expect(row.name).toBe("first");
		expect(row.count).toBe(0); // NOT NULL default applied
		expect(row.color).toBe("#000");
		expect(row.note).toBeNull();
	});

	it("skips a NOT NULL column with no default and warns rather than throwing", () => {
		const db = seedOldDb();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		expect(() => migrateSchema(db, schema)).not.toThrow();
		const cols = columnNames(db, "widgets");
		expect(cols.has("required")).toBe(false);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("is idempotent — a second run is a no-op", () => {
		const db = seedOldDb();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		migrateSchema(db, schema);
		const after1 = columnNames(db, "widgets");
		migrateSchema(db, schema); // must not throw "duplicate column"
		const after2 = columnNames(db, "widgets");
		warn.mockRestore();
		expect([...after2].sort()).toEqual([...after1].sort());
	});

	it("leaves a not-yet-created table to createSchemaSql (no ALTER on a missing table)", () => {
		const db = new Database(":memory:"); // no widgets table at all
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		expect(() => migrateSchema(db, schema)).not.toThrow();
		warn.mockRestore();
		// The table still doesn't exist — migrateSchema didn't create it.
		expect(columnNames(db, "widgets").size).toBe(0);
		// …but createSchemaSql would create it whole.
		db.exec(createSchemaSql(schema));
		expect(columnNames(db, "widgets").has("required")).toBe(true);
	});
});
