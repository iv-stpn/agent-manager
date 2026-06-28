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
		return c.json(c.var.templateManager.list());
	})
	.post("/", async (c) => {
		try {
			const input = CreateTemplateSchema.parse(await c.req.json());
			const template = c.var.templateManager.create(input);
			return c.json(template, 201);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 400);
		}
	})
	.put("/:id", async (c) => {
		try {
			const id = c.req.param("id");
			const input = UpdateTemplateSchema.parse(await c.req.json());
			const template = c.var.templateManager.update(id, input);
			return c.json(template);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 404);
		}
	})
	.delete("/:id", (c) => {
		try {
			c.var.templateManager.delete(c.req.param("id"));
			return c.json({ success: true });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 404);
		}
	});
