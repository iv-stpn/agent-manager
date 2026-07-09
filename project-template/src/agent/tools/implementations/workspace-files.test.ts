import { describe, expect, it } from "bun:test";
import { finalizeTreePaths, isHiddenFromTree, looksBinary, MAX_TREE_ENTRIES } from "./workspace-files";

// The pure logic behind the live file browser. The disk/git side of
// listWorkspaceTree + readWorkspaceFile is not exercised here (it depends on
// WORKSPACE_PATH, captured at module load) — these lock the parts that decide
// what the browser is allowed to show and edit.

describe("isHiddenFromTree", () => {
	it("hides the .git directory and its contents", () => {
		expect(isHiddenFromTree(".git")).toBe(true);
		expect(isHiddenFromTree(".git/config")).toBe(true);
		expect(isHiddenFromTree(".git/refs/heads/main")).toBe(true);
	});

	it("hides node_modules at any depth", () => {
		expect(isHiddenFromTree("node_modules")).toBe(true);
		expect(isHiddenFromTree("node_modules/react/index.js")).toBe(true);
		expect(isHiddenFromTree("packages/web/node_modules/foo/index.js")).toBe(true);
	});

	it("keeps ordinary source files", () => {
		expect(isHiddenFromTree("src/index.ts")).toBe(false);
		expect(isHiddenFromTree("README.md")).toBe(false);
		// A file that merely mentions the name in its own basename is not hidden.
		expect(isHiddenFromTree("src/gitignore-docs.md")).toBe(false);
		expect(isHiddenFromTree("src/my-node_modules-notes.md")).toBe(false);
	});
});

describe("finalizeTreePaths", () => {
	it("drops empties, filters hidden entries, and sorts", () => {
		const result = finalizeTreePaths(["src/b.ts", "", ".git/config", "src/a.ts", "node_modules/x/i.js", "README.md"]);
		expect(result.paths).toEqual(["README.md", "src/a.ts", "src/b.ts"]);
		expect(result.truncated).toBe(false);
	});

	it("flags truncation and caps the list at MAX_TREE_ENTRIES", () => {
		const many = Array.from({ length: MAX_TREE_ENTRIES + 50 }, (_, i) => `f${String(i).padStart(5, "0")}.txt`);
		const result = finalizeTreePaths(many);
		expect(result.truncated).toBe(true);
		expect(result.paths.length).toBe(MAX_TREE_ENTRIES);
	});

	it("does not flag truncation exactly at the cap", () => {
		const exact = Array.from({ length: MAX_TREE_ENTRIES }, (_, i) => `f${String(i).padStart(5, "0")}.txt`);
		const result = finalizeTreePaths(exact);
		expect(result.truncated).toBe(false);
		expect(result.paths.length).toBe(MAX_TREE_ENTRIES);
	});
});

describe("looksBinary", () => {
	it("treats a NUL byte in the head as binary", () => {
		expect(looksBinary(new Uint8Array([0x48, 0x00, 0x49]))).toBe(true);
	});

	it("treats plain UTF-8 text as non-binary", () => {
		expect(looksBinary(new TextEncoder().encode("hello\nworld\n"))).toBe(false);
	});

	it("treats an empty file as non-binary", () => {
		expect(looksBinary(new Uint8Array([]))).toBe(false);
	});

	it("ignores a NUL that appears only beyond the scan window", () => {
		// 8000-byte scan window: a NUL at index 8000 is past it, so not detected.
		const bytes = new Uint8Array(8100);
		bytes.fill(0x41); // 'A'
		bytes[8050] = 0x00;
		expect(looksBinary(bytes)).toBe(false);
	});
});
