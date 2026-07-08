import { describe, expect, test } from "bun:test";
import type { LlmClient } from "../db";
import { type ResolvableAgent, resolveAgentLlmClient } from "./llm-client-resolve";

const CLIENT: LlmClient = {
	id: "c1",
	name: "prod",
	provider: "anthropic",
	apiKey: "sk-from-client",
	baseUrl: "https://client.example",
	model: "claude-from-client",
	smallModel: "haiku-from-client",
	createdAt: 0,
	updatedAt: 0,
};

describe("resolveAgentLlmClient", () => {
	test("no-op when the agent has no clientId", () => {
		const agent: ResolvableAgent = { anthropicApiKey: "keep" };
		resolveAgentLlmClient(agent, () => CLIENT);
		expect(agent).toEqual({ anthropicApiKey: "keep" });
	});

	test("backfills blank fields from the client record", () => {
		const agent: ResolvableAgent = { clientId: "c1" };
		resolveAgentLlmClient(agent, () => CLIENT);
		expect(agent).toEqual({
			clientId: "c1",
			anthropicApiKey: "sk-from-client",
			anthropicBaseUrl: "https://client.example",
			model: "claude-from-client",
		});
	});

	test("explicit agent values win over the client record", () => {
		const agent: ResolvableAgent = { clientId: "c1", anthropicApiKey: "sk-explicit", model: "explicit-model" };
		resolveAgentLlmClient(agent, () => CLIENT);
		expect(agent.anthropicApiKey).toBe("sk-explicit");
		expect(agent.model).toBe("explicit-model");
		// still backfills the one field left blank
		expect(agent.anthropicBaseUrl).toBe("https://client.example");
	});

	test("throws when the clientId resolves to nothing", () => {
		const agent: ResolvableAgent = { clientId: "missing" };
		expect(() => resolveAgentLlmClient(agent, () => undefined)).toThrow("LLM client not found");
	});
});
