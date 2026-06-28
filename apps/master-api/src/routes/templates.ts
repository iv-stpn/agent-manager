import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { HonoMasterEnv } from "../types";

const CATEGORIES = ["tech-stack", "ui-design", "best-practices", "system-prompt"] as const;

const CreateTemplateSchema = z.object({
	name: z.string().min(1),
	description: z.string().default(""),
	category: z.enum(CATEGORIES),
	content: z.string().default(""),
});

const UpdateTemplateSchema = CreateTemplateSchema.partial();

export const templatesRouter = new Hono<HonoMasterEnv>()
	.get("/", (c) => {
		return c.json(c.var.masterDb.listTemplates());
	})
	.post("/", zValidator("json", CreateTemplateSchema), async (c) => {
		try {
			const input = c.req.valid("json");
			const template = c.var.masterDb.createTemplate(input);
			return c.json(template, 201);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 400);
		}
	})
	.put("/:id", zValidator("json", UpdateTemplateSchema), async (c) => {
		try {
			const id = c.req.param("id");
			const input = c.req.valid("json");
			const template = c.var.masterDb.updateTemplate(id, input);
			return c.json(template);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 404);
		}
	})
	.delete("/:id", (c) => {
		try {
			c.var.masterDb.deleteTemplate(c.req.param("id"));
			return c.json({ success: true });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 404);
		}
	});
