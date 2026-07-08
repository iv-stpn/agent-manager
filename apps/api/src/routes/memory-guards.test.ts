import { describe, expect, it } from "bun:test";

import { ARCHIVED_MARKER, assertSafeId, buildMemoryFilter, parseLimit, tableName } from "./memory-guards";

describe("assertSafeId", () => {
	it("accepts an application-generated id (type_timestamp_random)", () => {
		expect(assertSafeId("memory_1720000000000_ab12cd")).toBe("memory_1720000000000_ab12cd");
	});

	it("accepts dots, colons and dashes", () => {
		expect(assertSafeId("a.b:c-d")).toBe("a.b:c-d");
	});

	for (const bad of [
		"id' OR '1'='1", // filter-string breakout
		'id" ; DROP', // double quote
		"a b", // space
		"a\nb", // newline
		"a,b", // comma
		"(a)", // parens
		"", // empty
		"a/b", // slash
	]) {
		it(`rejects ${JSON.stringify(bad)}`, () => {
			expect(() => assertSafeId(bad)).toThrow("invalid entry id");
		});
	}
});

describe("parseLimit", () => {
	it("returns the fallback for undefined / non-numeric", () => {
		expect(parseLimit(undefined, 20)).toBe(20);
		expect(parseLimit("", 20)).toBe(20);
		expect(parseLimit("abc", 20)).toBe(20);
	});

	it("returns the fallback for zero / negative", () => {
		expect(parseLimit("0", 20)).toBe(20);
		expect(parseLimit("-5", 20)).toBe(20);
	});

	it("passes through a valid in-range limit", () => {
		expect(parseLimit("50", 20)).toBe(50);
	});

	it("clamps to the 1000 ceiling", () => {
		expect(parseLimit("999999", 20)).toBe(1000);
	});

	it("floors a decimal via parseInt semantics", () => {
		expect(parseLimit("12.9", 20)).toBe(12);
	});
});

describe("tableName", () => {
	it("prefixes and passes through a clean id", () => {
		expect(tableName("abc-123_x")).toBe("project_abc-123_x");
	});

	it("replaces non-alphanumerics (no injection into the table name)", () => {
		expect(tableName("a b.c/d")).toBe("project_a_b_c_d");
		expect(tableName("x'; DROP")).toBe("project_x___DROP");
	});
});

describe("buildMemoryFilter", () => {
	it("excludes the sentinel row and archived entries by default", () => {
		expect(buildMemoryFilter(undefined, false)).toBe(`id != '__init__' AND metadata NOT LIKE '%${ARCHIVED_MARKER}%'`);
	});

	it("narrows to a type when given, still hiding archived", () => {
		expect(buildMemoryFilter("report", false)).toBe(
			`id != '__init__' AND type = 'report' AND metadata NOT LIKE '%${ARCHIVED_MARKER}%'`
		);
	});

	it("drops the archived clause when includeArchived is true", () => {
		expect(buildMemoryFilter(undefined, true)).toBe("id != '__init__'");
		expect(buildMemoryFilter("plan", true)).toBe("id != '__init__' AND type = 'plan'");
	});

	it("marker matches JSON.stringify output but not the archived:false case", () => {
		// The filter is a substring test; confirm the marker only appears in the
		// serialized metadata of a genuinely-archived entry.
		expect(JSON.stringify({ archived: true })).toContain(ARCHIVED_MARKER);
		expect(JSON.stringify({ archived: false })).not.toContain(ARCHIVED_MARKER);
		expect(JSON.stringify({ archived: true, urgent: true })).toContain(ARCHIVED_MARKER);
	});
});
