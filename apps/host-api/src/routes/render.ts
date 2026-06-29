import { Hono } from "hono";
import { z } from "zod";
import { renderMermaid } from "../render/chromium";
import type { HonoHostEnv } from "../types";

const MermaidSchema = z.object({ definition: z.string().min(1) });

const png = (buf: Buffer) => new Response(new Uint8Array(buf), { headers: { "content-type": "image/png" } });

/**
 * Centralised rendering endpoints. Project agents call these instead of
 * bundling Chromium/puppeteer/mermaid-cli into every container image.
 */
export const renderRouter = new Hono<HonoHostEnv>().post("/mermaid", async (c) => {
	try {
		const { definition } = MermaidSchema.parse(await c.req.json());
		return png(await renderMermaid(definition));
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : "render failed" }, 500);
	}
});
