import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { HonoHostEnv } from "../types";

const CreateCategorySchema = z.object({
	name: z.string().min(1),
	description: z.string().default(""),
	color: z.string().default("#6b7280"),
});

const UpdateCategorySchema = CreateCategorySchema.partial();

export const guidelineCategoriesRouter = new Hono<HonoHostEnv>()
	.get("/", (c) => {
		return c.json(c.var.hostDb.listGuidelineCategories());
	})
	.post("/", zValidator("json", CreateCategorySchema), async (c) => {
		try {
			const category = c.var.hostDb.createGuidelineCategory(c.req.valid("json"));
			return c.json(category, 201);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 400);
		}
	})
	.put("/:id", zValidator("json", UpdateCategorySchema), async (c) => {
		try {
			const category = c.var.hostDb.updateGuidelineCategory(c.req.param("id"), c.req.valid("json"));
			return c.json(category);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 404);
		}
	})
	.delete("/:id", (c) => {
		try {
			c.var.hostDb.deleteGuidelineCategory(c.req.param("id"));
			return c.json({ success: true });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 404);
		}
	});
