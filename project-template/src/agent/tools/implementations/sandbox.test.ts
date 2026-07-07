import { describe, expect, it } from "bun:test";
import { isAbsolute, join, resolve } from "node:path";
import { isWithinWorkspace, sandboxPath } from "./sandbox";

// These are the sandbox-boundary guards every filesystem tool routes through.
// They must contain the agent inside WORKSPACE_PATH even when handed absolute
// paths or `..` traversal. Tests derive the workspace root from the function
// itself (`sandboxPath(".")`) so they don't depend on the env-configured value.
const ROOT = sandboxPath(".");

describe("sandboxPath — normal paths stay inside", () => {
	it("resolves a relative path under the workspace root", () => {
		expect(sandboxPath("foo/bar.txt")).toBe(join(ROOT, "foo/bar.txt"));
	});

	it("treats '.' as the workspace root", () => {
		expect(ROOT).toBe(resolve(ROOT));
		expect(isAbsolute(ROOT)).toBe(true);
	});

	it("keeps an absolute path already inside the workspace", () => {
		const inside = join(ROOT, "src/index.ts");
		expect(sandboxPath(inside)).toBe(inside);
	});

	it("collapses interior '..' that stays within the workspace", () => {
		expect(sandboxPath("a/b/../c")).toBe(join(ROOT, "a/c"));
	});
});

describe("sandboxPath — escape attempts", () => {
	it("rejects relative traversal that climbs out of the workspace", () => {
		expect(() => sandboxPath("../etc/passwd")).toThrow(/escapes the workspace/);
	});

	it("rejects deep traversal that resolves above the root", () => {
		expect(() => sandboxPath("a/../../../../etc/passwd")).toThrow(/escapes the workspace/);
	});

	it("re-roots an absolute path from outside into the workspace", () => {
		// An absolute /etc/passwd can't be read as-is; it's re-rooted under the
		// workspace so the read stays sandboxed rather than hitting the host file.
		const result = sandboxPath("/etc/passwd");
		expect(result).toBe(join(ROOT, "etc/passwd"));
		expect(isWithinWorkspace(result)).toBe(true);
	});

	it("rejects an absolute path whose re-rooting still escapes", () => {
		// Leading `/..` survives the `/^\/+/` strip as `..`, so the re-root itself
		// climbs out — the final within-workspace check must still throw.
		expect(() => sandboxPath("/../../etc/passwd")).toThrow(/escapes the workspace/);
	});
});

describe("isWithinWorkspace", () => {
	it("accepts the root itself and descendants", () => {
		expect(isWithinWorkspace(ROOT)).toBe(true);
		expect(isWithinWorkspace(join(ROOT, "nested/deep"))).toBe(true);
	});

	it("rejects a sibling directory sharing a name prefix", () => {
		// `/workspace-evil` must NOT count as inside `/workspace` — a prefix string
		// match would wrongly accept it; the path-relative check guards against that.
		expect(isWithinWorkspace(`${ROOT}-evil/secret`)).toBe(false);
	});

	it("rejects an unrelated absolute path", () => {
		expect(isWithinWorkspace("/etc/passwd")).toBe(false);
	});
});
