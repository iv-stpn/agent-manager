import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import z from "zod";
import { getErrorMessage } from "../lib/errors";
import type { HonoOrchestratorEnv } from "../types";

const StackLibrarySchema = z.object({
	name: z.string().min(1),
	version: z.string().optional(),
});

const StackEntrySchema = z.object({
	label: z.string().min(1),
	libraries: z.array(StackLibrarySchema).default([]),
	usagePatterns: z.array(z.string()).default([]),
});

const CreateTechStackSchema = z.object({
	language: z.string().min(1),
	name: z.string().min(1),
	description: z.string().default(""),
	stack: z.array(StackEntrySchema).default([]),
	templateGithubUrl: z.string().url().nullable().optional(),
});

const UpdateTechStackSchema = CreateTechStackSchema.partial();

export const techStacksRouter = new Hono<HonoOrchestratorEnv>()
	.get("/", (c) => {
		return c.json(c.var.orchestratorDb.listTechStacks());
	})
	.post("/", zValidator("json", CreateTechStackSchema), async (c) => {
		try {
			const data = c.req.valid("json");
			const stack = c.var.orchestratorDb.createTechStack({
				...data,
				templateGithubUrl: data.templateGithubUrl || null,
			});
			return c.json(stack, 201);
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 400);
		}
	})
	.put("/:id", zValidator("json", UpdateTechStackSchema), async (c) => {
		try {
			const stack = c.var.orchestratorDb.updateTechStack(c.req.param("id"), c.req.valid("json"));
			return c.json(stack);
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 404);
		}
	})
	.delete("/:id", (c) => {
		try {
			c.var.orchestratorDb.deleteTechStack(c.req.param("id"));
			return c.json({ success: true });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 404);
		}
	});
