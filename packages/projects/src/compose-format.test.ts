import { describe, expect, it } from "bun:test";

import { parseComposeEnvironment, yamlScalar } from "./compose-format";

/** Build a minimal compose `environment:` block from key→scalar-line pairs. */
function composeWith(lines: string[]): string {
	return ["services:", "  agent:", "    environment:", ...lines, "    ports:", '      - "4000:4000"', ""].join("\n");
}

describe("yamlScalar", () => {
	it("wraps a plain value in double quotes", () => {
		expect(yamlScalar("hello")).toBe('"hello"');
	});

	it("escapes embedded double quotes", () => {
		expect(yamlScalar('a"b')).toBe('"a\\"b"');
	});

	it("escapes newlines (can't break onto a new compose line)", () => {
		expect(yamlScalar("a\nb")).toBe('"a\\nb"');
		expect(yamlScalar("a\nb")).not.toContain("\n");
	});

	it("escapes backslashes", () => {
		expect(yamlScalar("a\\b")).toBe('"a\\\\b"');
	});
});

describe("yamlScalar → parseComposeEnvironment round-trip", () => {
	const cases: Array<[string, string]> = [
		["plain", "sonnet-4.5"],
		["with colon", "http://host.docker.internal:3100"],
		["with double quote", 'name-with-"-quote'],
		["with single quote", "it's-a-name"],
		["with spaces", "My Cool Project"],
		["with newline (injection attempt)", "evil\n      ANTHROPIC_API_KEY: stolen"],
		["with backslash", "path\\to\\thing"],
		["with braces/brackets", "{a: [1,2]}"],
		["unicode", "проект-🚀"],
		["empty", ""],
	];

	for (const [label, value] of cases) {
		it(`preserves ${label}`, () => {
			const compose = composeWith([`      PROJECT_NAME: ${yamlScalar(value)}`]);
			const env = parseComposeEnvironment(compose);
			expect(env.PROJECT_NAME).toBe(value);
		});
	}

	it("a newline-injection value does NOT create a sibling env key", () => {
		// The classic compose-injection: a project name containing a newline +
		// `KEY: value` must stay a single scalar, not smuggle in ANTHROPIC_API_KEY.
		const malicious = "evil\n      ANTHROPIC_API_KEY: stolen-key";
		const compose = composeWith([`      PROJECT_NAME: ${yamlScalar(malicious)}`]);
		const env = parseComposeEnvironment(compose);
		expect(env.PROJECT_NAME).toBe(malicious);
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
	});

	it("round-trips several keys together", () => {
		const compose = composeWith([
			`      PORT: ${yamlScalar("4000")}`,
			`      PROJECT_ID: ${yamlScalar("abc-123")}`,
			`      PROJECT_NAME: ${yamlScalar('Proj: "quoted"')}`,
		]);
		const env = parseComposeEnvironment(compose);
		expect(env.PORT).toBe("4000");
		expect(env.PROJECT_ID).toBe("abc-123");
		expect(env.PROJECT_NAME).toBe('Proj: "quoted"');
	});
});

describe("parseComposeEnvironment — edge cases", () => {
	it("returns an empty object when there is no environment block", () => {
		expect(parseComposeEnvironment("services:\n  agent:\n    image: x\n")).toEqual({});
	});

	it("passes through bare (legacy, unquoted) values", () => {
		const compose = composeWith(["      DATABASE_PATH: /data/agent.db"]);
		expect(parseComposeEnvironment(compose).DATABASE_PATH).toBe("/data/agent.db");
	});
});
