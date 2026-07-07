import { describe, expect, it } from "bun:test";

import { isBashCommandReadOnly } from "./plan-mode";

describe("isBashCommandReadOnly — allowed read-only commands", () => {
	it("approves a bare read-only command", () => {
		expect(isBashCommandReadOnly("cat file.txt")).toBe(true);
		expect(isBashCommandReadOnly("ls -la")).toBe(true);
		expect(isBashCommandReadOnly("git log --oneline")).toBe(true);
		expect(isBashCommandReadOnly("grep -r foo src")).toBe(true);
	});

	it("approves a compound of read-only commands (&&, ||, ;)", () => {
		expect(isBashCommandReadOnly("cat a.txt && ls")).toBe(true);
		expect(isBashCommandReadOnly("ls; cat a.txt")).toBe(true);
		expect(isBashCommandReadOnly("cat a.txt || echo missing")).toBe(true);
	});

	it("approves a pipe between two read-only commands", () => {
		expect(isBashCommandReadOnly("cat file.txt | grep foo")).toBe(true);
		expect(isBashCommandReadOnly("cat file.txt | head")).toBe(true);
	});

	it("approves a newline-separated read-only script", () => {
		expect(isBashCommandReadOnly("ls\ncat file.txt")).toBe(true);
	});
});

describe("isBashCommandReadOnly — rejected write commands", () => {
	it("rejects direct write commands", () => {
		expect(isBashCommandReadOnly("rm -rf x")).toBe(false);
		expect(isBashCommandReadOnly("mv a b")).toBe(false);
		expect(isBashCommandReadOnly("mkdir foo")).toBe(false);
	});

	it("rejects output redirects", () => {
		expect(isBashCommandReadOnly("echo x > file")).toBe(false);
		expect(isBashCommandReadOnly("cat a >> b")).toBe(false);
		expect(isBashCommandReadOnly("ls | tee out.txt")).toBe(false);
	});

	it("rejects command substitution", () => {
		expect(isBashCommandReadOnly("cat $(rm -rf x)")).toBe(false);
		expect(isBashCommandReadOnly("echo `rm -rf x`")).toBe(false);
	});

	it("rejects unknown commands", () => {
		expect(isBashCommandReadOnly("some-unknown-tool")).toBe(false);
	});
});

describe("isBashCommandReadOnly — H4: pipe/newline smuggling is caught", () => {
	// Before the fix the splitter only split on &&/||/;, so a command after a
	// single pipe or newline was never checked — it rode in on the read-only
	// prefix of the FIRST command.
	it("rejects an unknown/writing command after a single pipe", () => {
		// `some-writer` isn't caught by a write pattern and isn't a read-only
		// prefix — it must be rejected via the pipe split, not approved via `cat `.
		expect(isBashCommandReadOnly("cat f | some-writer")).toBe(false);
		expect(isBashCommandReadOnly("curl http://x | python")).toBe(false);
	});

	it("rejects an unknown/writing command after a newline", () => {
		expect(isBashCommandReadOnly("cat a\nsome-writer arg")).toBe(false);
		expect(isBashCommandReadOnly("ls\n./install.sh")).toBe(false);
	});
});
