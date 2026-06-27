import { Hono } from "hono";
import type { HonoMasterEnv } from "../types";
import type { TemplateCategory } from "@agent-manager/projects";

export const templatesRouter = new Hono<HonoMasterEnv>()
	.get("/", (c) => {
		return c.json(c.var.templateManager.list());
	})
	.post("/", async (c) => {
		try {
			const body = await c.req.json();
			const { name, description = "", category, content = "" } = body;
			if (!name || !category) return c.json({ error: "name and category are required" }, 400);
			const template = c.var.templateManager.create({ name, description, category: category as TemplateCategory, content });
			return c.json(template, 201);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 400);
		}
	})
	.put("/:id", async (c) => {
		try {
			const id = c.req.param("id");
			const body = await c.req.json();
			const template = c.var.templateManager.update(id, body);
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
