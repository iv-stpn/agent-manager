import { Hono } from "hono";
import { renderMermaid, resolveWorkspacePath, screenshotHtml, screenshotTarget } from "../render/chromium";
import type { HonoMasterEnv } from "../types";

const png = (buf: Buffer) => new Response(new Uint8Array(buf), { headers: { "content-type": "image/png" } });

/**
 * Centralised rendering endpoints. Project agents call these instead of
 * bundling Chromium/puppeteer/mermaid-cli into every container image.
 *
 * Each project container mounts its workspace at /workspace, but master-api
 * runs on the host and sees the real path (config.workspace.path), so a
 * workspace-relative screenshot target is resolved against that real path here.
 */
export const renderRouter = new Hono<HonoMasterEnv>()
	.post("/mermaid", async (c) => {
		try {
			const { definition } = await c.req.json();
			if (typeof definition !== "string" || !definition.trim()) {
				return c.json({ error: "definition is required" }, 400);
			}
			return png(await renderMermaid(definition));
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "render failed" }, 500);
		}
	})
	.post("/screenshot", async (c) => {
		try {
			const { target, html, projectId } = await c.req.json();

			if (typeof html === "string" || (typeof target === "string" && target.trimStart().startsWith("<"))) {
				return png(await screenshotHtml(html ?? target));
			}

			if (typeof target !== "string" || !target.trim()) {
				return c.json({ error: "target or html is required" }, 400);
			}

			if (/^https?:\/\//.test(target)) {
				return png(await screenshotTarget(target));
			}

			// Workspace-relative file path — resolve against the project's real workspace.
			if (typeof projectId !== "string") {
				return c.json({ error: "projectId is required for workspace file targets" }, 400);
			}
			const project = await c.var.manager.getProject(projectId);
			const abs = resolveWorkspacePath(project.workspace.path, target);
			return png(await screenshotTarget(abs));
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "screenshot failed" }, 500);
		}
	});
