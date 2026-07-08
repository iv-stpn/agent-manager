import { describe, expect, it } from "bun:test";
import { CreateProjectSchema, isValidBunCreateSource, parseBunCreateFlags } from "./types";

describe("isValidBunCreateSource", () => {
	it("accepts npm create-* package names", () => {
		expect(isValidBunCreateSource("vite")).toBe(true);
		expect(isValidBunCreateSource("next-app")).toBe(true);
		expect(isValidBunCreateSource("hono")).toBe(true);
	});

	it("accepts scoped packages and version suffixes", () => {
		expect(isValidBunCreateSource("@scope/pkg")).toBe(true);
		expect(isValidBunCreateSource("vite@5.0.0")).toBe(true);
		expect(isValidBunCreateSource("@scope/pkg@latest")).toBe(true);
	});

	it("accepts GitHub owner/repo shorthands", () => {
		expect(isValidBunCreateSource("honojs/starter")).toBe(true);
	});

	it("rejects flag injection, traversal, and malformed sources", () => {
		expect(isValidBunCreateSource("")).toBe(false);
		expect(isValidBunCreateSource("--help")).toBe(false);
		expect(isValidBunCreateSource("-x")).toBe(false);
		expect(isValidBunCreateSource("../etc")).toBe(false);
		expect(isValidBunCreateSource("owner/../etc")).toBe(false);
		expect(isValidBunCreateSource("/abs/path")).toBe(false);
		expect(isValidBunCreateSource("a b")).toBe(false);
		expect(isValidBunCreateSource("@scope")).toBe(false);
		expect(isValidBunCreateSource(".hidden")).toBe(false);
	});
});

describe("parseBunCreateFlags", () => {
	it("splits flags into argv tokens", () => {
		expect(parseBunCreateFlags("--template react-ts")).toEqual(["--template", "react-ts"]);
		expect(parseBunCreateFlags("--template=react-ts --typescript")).toEqual(["--template=react-ts", "--typescript"]);
	});

	it("returns an empty list for blank input", () => {
		expect(parseBunCreateFlags("")).toEqual([]);
		expect(parseBunCreateFlags("   ")).toEqual([]);
	});

	it("rejects traversal and shell/control characters", () => {
		expect(parseBunCreateFlags("--out ../escape")).toBeNull();
		expect(parseBunCreateFlags("$(rm -rf /)")).toBeNull();
		expect(parseBunCreateFlags("`id`")).toBeNull();
		expect(parseBunCreateFlags("a;b")).toBeNull();
	});
});

describe("CreateProjectSchema bun-create templates", () => {
	const base = { name: "demo" };

	it("accepts a bun-create template with flags", () => {
		const parsed = CreateProjectSchema.safeParse({
			...base,
			templates: [{ type: "bun-create", source: "vite", flags: "--template react-ts" }],
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects an invalid bun-create source", () => {
		const parsed = CreateProjectSchema.safeParse({
			...base,
			templates: [{ type: "bun-create", source: "--help" }],
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects unsafe bun-create flags", () => {
		const parsed = CreateProjectSchema.safeParse({
			...base,
			templates: [{ type: "bun-create", source: "vite", flags: "--out ../escape" }],
		});
		expect(parsed.success).toBe(false);
	});

	it("still validates github and local sources", () => {
		expect(
			CreateProjectSchema.safeParse({ ...base, templates: [{ type: "github", source: "https://github.com/a/b.git" }] }).success
		).toBe(true);
		expect(CreateProjectSchema.safeParse({ ...base, templates: [{ type: "local", source: "../etc" }] }).success).toBe(false);
	});
});
