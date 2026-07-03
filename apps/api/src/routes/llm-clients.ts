import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import z from "zod";
import { getErrorMessage } from "../lib/errors";
import type { HonoOrchestratorEnv } from "../types";

const CreateLlmClientSchema = z.object({
	name: z.string().min(1),
	provider: z.enum(["anthropic", "openai", "custom"]),
	apiKey: z.string().default(""),
	baseUrl: z.string().default(""),
	model: z.string().default(""),
	smallModel: z.string().default(""),
});

const UpdateLlmClientSchema = z.object({
	name: z.string().min(1).optional(),
	provider: z.enum(["anthropic", "openai", "custom"]).optional(),
	apiKey: z.string().optional(),
	baseUrl: z.string().optional(),
	model: z.string().optional(),
	smallModel: z.string().optional(),
});

export const llmClientsRouter = new Hono<HonoOrchestratorEnv>()
	.get("/", (c) => {
		const clients = c.var.orchestratorDb.listLlmClients().map((client) => ({
			...client,
			apiKey: client.apiKey ? `${"•".repeat(8)}${client.apiKey.slice(-4)}` : "",
		}));
		return c.json(clients);
	})
	.get("/:id/raw", (c) => {
		const client = c.var.orchestratorDb.getLlmClient(c.req.param("id"));
		if (!client) return c.json({ error: "LLM client not found" }, 404);
		return c.json(client);
	})
	.post("/", zValidator("json", CreateLlmClientSchema), async (c) => {
		try {
			const client = c.var.orchestratorDb.createLlmClient(c.req.valid("json"));
			return c.json(client, 201);
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 400);
		}
	})
	.put("/:id", zValidator("json", UpdateLlmClientSchema), async (c) => {
		try {
			const client = c.var.orchestratorDb.updateLlmClient(c.req.param("id"), c.req.valid("json"));
			return c.json(client);
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 404);
		}
	})
	.delete("/:id", (c) => {
		try {
			c.var.orchestratorDb.deleteLlmClient(c.req.param("id"));
			return c.json({ success: true });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 404);
		}
	});
