import type { Context } from "hono";
import { Hono } from "hono";
import { getErrorMessage } from "../lib/errors";
import type { HonoHostEnv } from "../types";

export interface TemplateMetadata {
	name?: string;
	description?: string;
	techStackIds?: string[];
}

export interface LocalTemplate {
	name: string;
	path: string;
	description: string;
	techStackIds: string[];
	techStackNames: string[];
	createdAt: string;
}

export const templatesRouter = new Hono<HonoHostEnv>()
	// List local templates from templates/ directory
	.get("/", async (c: Context<HonoHostEnv>) => {
		try {
			const { readdirSync, statSync, existsSync, readFileSync } = await import("node:fs");
			const { join } = await import("node:path");
			const { resolveWorkspaceRoot } = await import("@agent-manager/projects");

			const workspaceRoot = resolveWorkspaceRoot();
			const templatesDir = join(workspaceRoot, "templates");

			if (!existsSync(templatesDir)) {
				return c.json({ templates: [] });
			}

			const entries = readdirSync(templatesDir, { withFileTypes: true });
			const templates: LocalTemplate[] = entries
				.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
				.map((entry) => {
					const templatePath = join(templatesDir, entry.name);
					const stat = statSync(templatePath);

					// Try to read metadata from .template.json
					let metadata: TemplateMetadata = {};
					try {
						const metaPath = join(templatePath, ".template.json");
						if (existsSync(metaPath)) {
							metadata = JSON.parse(readFileSync(metaPath, "utf-8")) as TemplateMetadata;
						}
					} catch {
						// No metadata, that's fine
					}

					// Resolve tech stack names from IDs
					const techStackIds = metadata.techStackIds || [];
					const techStackNames = techStackIds
						.map((id) => {
							const stack = c.var.hostDb.getTechStack(id);
							return stack ? stack.name : null;
						})
						.filter((name): name is string => name !== null);

					return {
						name: entry.name,
						path: templatePath,
						description: metadata.description || "",
						techStackIds,
						techStackNames,
						createdAt: stat.birthtime.toISOString(),
					};
				})
				.sort((a, b) => a.name.localeCompare(b.name));

			return c.json({ templates });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 500);
		}
	})
	// Update template metadata
	.put("/:templateName", async (c: Context<HonoHostEnv>) => {
		try {
			const templateName = c.req.param("templateName");
			if (!templateName) {
				return c.json({ error: "Template name is required" }, 400);
			}

			const updates = await c.req.json<Partial<TemplateMetadata>>();

			const { join } = await import("node:path");
			const { existsSync, writeFileSync, readFileSync } = await import("node:fs");
			const { resolveWorkspaceRoot } = await import("@agent-manager/projects");

			const workspaceRoot = resolveWorkspaceRoot();
			const templatePath = join(workspaceRoot, "templates", templateName);

			if (!existsSync(templatePath)) {
				return c.json({ error: "Template not found" }, 404);
			}

			const metaPath = join(templatePath, ".template.json");
			let metadata: TemplateMetadata = {};

			// Read existing metadata if it exists
			if (existsSync(metaPath)) {
				try {
					metadata = JSON.parse(readFileSync(metaPath, "utf-8")) as TemplateMetadata;
				} catch {
					// Invalid JSON, start fresh
				}
			}

			// Merge updates
			metadata = { ...metadata, ...updates };

			// Write back
			writeFileSync(metaPath, JSON.stringify(metadata, null, 2));

			return c.json({ success: true, metadata });
		} catch (error) {
			return c.json({ error: getErrorMessage(error) }, 500);
		}
	});
