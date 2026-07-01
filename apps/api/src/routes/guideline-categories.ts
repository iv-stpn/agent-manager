import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import z from "zod";
import { getErrorMessage } from "../lib/errors";
import type { HonoOrchestratorEnv } from "../types";

const CreateCategorySchema = z.object({
	name: z.string().min(1),
	description: z.string().default(""),
	color: z.string().default("#6b7280"),
});

const UpdateCategorySchema = CreateCategorySchema.partial();

export const guidelineCategoriesRouter = new Hono<HonoOrchestratorEnv>()
	.get("/", (c) => {
		return c.json(c.var.orchestratorDb.listGuidelineCategories());
	})
	.post("/", zValidator("json", CreateCategorySchema), async (c) => {
		try {
			const category = c.var.orchestratorDb.createGuidelineCategory(c.req.valid("json"));
			return c.json(category, 201);
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 400);
		}
	})
	.put("/:id", zValidator("json", UpdateCategorySchema), async (c) => {
		try {
			const category = c.var.orchestratorDb.updateGuidelineCategory(c.req.param("id"), c.req.valid("json"));
			return c.json(category);
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 404);
		}
	})
	.delete("/:id", (c) => {
		try {
			c.var.orchestratorDb.deleteGuidelineCategory(c.req.param("id"));
			return c.json({ success: true });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 404);
		}
	});
