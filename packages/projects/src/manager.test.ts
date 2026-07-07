import { describe, expect, it } from "bun:test";

import { ProjectManager } from "./manager";

// The constructor only derives a path (no filesystem/network), so a throwaway
// instance is enough to exercise the pure name-sanitiser.
const manager = new ProjectManager("/tmp/agent-manager-test-root");

describe("dockerProjectName", () => {
	it("passes through an already-valid lowercase id", () => {
		expect(manager.dockerProjectName("my-project")).toBe("my-project");
	});

	it("lowercases and replaces disallowed characters with a dash", () => {
		expect(manager.dockerProjectName("My Project!")).toBe("my-project");
	});

	it("collapses runs of dashes/underscores (2+) to a single dash", () => {
		// Both `---` and `__` are runs of 2+, so each collapses to a single `-`.
		expect(manager.dockerProjectName("a---b__c")).toBe("a-b-c");
	});

	it("strips leading/trailing non-alphanumerics", () => {
		expect(manager.dockerProjectName("--edge--")).toBe("edge");
		expect(manager.dockerProjectName("__wrapped__")).toBe("wrapped");
	});

	it("falls back to 'project' when nothing usable remains", () => {
		expect(manager.dockerProjectName("!!!")).toBe("project");
		expect(manager.dockerProjectName("")).toBe("project");
	});

	it("keeps digits and underscores", () => {
		expect(manager.dockerProjectName("Project_123")).toBe("project_123");
	});
});
