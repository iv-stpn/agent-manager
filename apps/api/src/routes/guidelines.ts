import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import z from "zod";
import { getErrorMessage } from "../lib/errors";
import type { HonoOrchestratorEnv } from "../types";

const CreateGuidelineSchema = z.object({
	name: z.string().min(1),
	description: z.string().default(""),
	categoryId: z.string().nullable().default(null),
	language: z.string().nullable().default(null),
	content: z.string().default(""),
});

// Hand-written rather than `CreateGuidelineSchema.partial()`: zod's `.partial()`
// doesn't protect fields defined with `.default()` (description, categoryId,
// language, content) — it leaves the ZodDefault wrapper in place, so an update
// payload that omits one of those keys still gets it defaulted and silently
// wipes the existing value in the DB. See the identical bug fixed in llm-clients.ts.
const UpdateGuidelineSchema = z.object({
	name: z.string().min(1).optional(),
	description: z.string().optional(),
	categoryId: z.string().nullable().optional(),
	language: z.string().nullable().optional(),
	content: z.string().optional(),
});

export const guidelinesRouter = new Hono<HonoOrchestratorEnv>()
	.get("/", (c) => {
		return c.json(c.var.orchestratorDb.listGuidelines());
	})
	.post("/", zValidator("json", CreateGuidelineSchema), async (c) => {
		try {
			const guideline = c.var.orchestratorDb.createGuideline(c.req.valid("json"));
			return c.json(guideline, 201);
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 400);
		}
	})
	.put("/:id", zValidator("json", UpdateGuidelineSchema), async (c) => {
		try {
			const guideline = c.var.orchestratorDb.updateGuideline(c.req.param("id"), c.req.valid("json"));
			return c.json(guideline);
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 404);
		}
	})
	.delete("/:id", (c) => {
		try {
			c.var.orchestratorDb.deleteGuideline(c.req.param("id"));
			return c.json({ success: true });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 404);
		}
	});
