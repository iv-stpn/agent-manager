import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { getErrorMessage } from "../lib/errors";
import type { HonoHostEnv } from "../types";

const CreateGuidelineSchema = z.object({
	name: z.string().min(1),
	description: z.string().default(""),
	categoryId: z.string().nullable().default(null),
	content: z.string().default(""),
});

const UpdateGuidelineSchema = CreateGuidelineSchema.partial();

export const guidelinesRouter = new Hono<HonoHostEnv>()
	.get("/", (c) => {
		return c.json(c.var.hostDb.listGuidelines());
	})
	.post("/", zValidator("json", CreateGuidelineSchema), async (c) => {
		try {
			const guideline = c.var.hostDb.createGuideline(c.req.valid("json"));
			return c.json(guideline, 201);
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 400);
		}
	})
	.put("/:id", zValidator("json", UpdateGuidelineSchema), async (c) => {
		try {
			const guideline = c.var.hostDb.updateGuideline(c.req.param("id"), c.req.valid("json"));
			return c.json(guideline);
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 404);
		}
	})
	.delete("/:id", (c) => {
		try {
			c.var.hostDb.deleteGuideline(c.req.param("id"));
			return c.json({ success: true });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 404);
		}
	});
