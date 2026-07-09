import { Hono } from "hono";
import { z } from "zod";
import { createDirectory, deleteFile, moveFile, writeFile } from "../agent/tools/implementations/filesystem";
import { listWorkspaceTree, pathExists, readWorkspaceFile } from "../agent/tools/implementations/workspace-files";
import type { HonoProjectEnv } from "../types";

// Every path in these bodies is a workspace-relative path chosen by the
// operator in the web UI. It is validated as a non-empty string here and then
// re-rooted + escape-checked by `sandboxPath` at each filesystem call, so a
// crafted `../` or absolute path can never leave WORKSPACE_PATH.
const WriteBodySchema = z.object({ content: z.string() });
const EntryBodySchema = z.object({
	path: z.string().min(1, "path is required"),
	type: z.enum(["file", "directory"]),
	content: z.string().optional(),
});
const MoveBodySchema = z.object({
	from: z.string().min(1, "from is required"),
	to: z.string().min(1, "to is required"),
});

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Filesystem operation failed";
}

/**
 * Live workspace file browser/editor routes, proxied by the orchestrator under
 * `/api/projects/:projectId/files/*`. Read + full CRUD against WORKSPACE_PATH,
 * every path gated by the shared `sandboxPath` guard.
 */
export const filesRouter = new Hono<HonoProjectEnv>()
	// Flat path list for the tree view (honours .gitignore).
	.get("/tree", async (c) => {
		try {
			return c.json(await listWorkspaceTree());
		} catch (error) {
			return c.json({ error: errorMessage(error) }, 500);
		}
	})
	// Read one file's content for the editor (binary/size-capped).
	.get("/content", async (c) => {
		const path = c.req.query("path");
		if (!path) return c.json({ error: "path query param is required" }, 400);
		try {
			return c.json(await readWorkspaceFile(path));
		} catch (error) {
			return c.json({ error: errorMessage(error) }, 404);
		}
	})
	// Overwrite one file's content (Save in the editor).
	.put("/content", async (c) => {
		const path = c.req.query("path");
		if (!path) return c.json({ error: "path query param is required" }, 400);
		let body: z.infer<typeof WriteBodySchema>;
		try {
			body = WriteBodySchema.parse(await c.req.json());
		} catch (error) {
			return c.json({ error: errorMessage(error) }, 400);
		}
		try {
			await writeFile(path, body.content);
			return c.json({ ok: true });
		} catch (error) {
			return c.json({ error: errorMessage(error) }, 500);
		}
	})
	// Create a new file or directory. Refuses to clobber an existing file so a
	// colliding name typed in the UI can't silently wipe its contents (mkdir is
	// idempotent, so an existing directory is a no-op and left alone).
	.post("/entry", async (c) => {
		let body: z.infer<typeof EntryBodySchema>;
		try {
			body = EntryBodySchema.parse(await c.req.json());
		} catch (error) {
			return c.json({ error: errorMessage(error) }, 400);
		}
		try {
			if (body.type === "directory") {
				await createDirectory(body.path);
			} else {
				if (await pathExists(body.path)) return c.json({ error: `${body.path} already exists` }, 409);
				await writeFile(body.path, body.content ?? "");
			}
			return c.json({ ok: true }, 201);
		} catch (error) {
			return c.json({ error: errorMessage(error) }, 500);
		}
	})
	// Rename / move a file or directory.
	.post("/move", async (c) => {
		let body: z.infer<typeof MoveBodySchema>;
		try {
			body = MoveBodySchema.parse(await c.req.json());
		} catch (error) {
			return c.json({ error: errorMessage(error) }, 400);
		}
		try {
			if (await pathExists(body.to)) return c.json({ error: `${body.to} already exists` }, 409);
			await moveFile(body.from, body.to);
			return c.json({ ok: true });
		} catch (error) {
			return c.json({ error: errorMessage(error) }, 500);
		}
	})
	// Delete a file or directory (recursive for directories).
	.delete("/entry", async (c) => {
		const path = c.req.query("path");
		if (!path) return c.json({ error: "path query param is required" }, 400);
		try {
			await deleteFile(path, true);
			return c.json({ ok: true });
		} catch (error) {
			return c.json({ error: errorMessage(error) }, 500);
		}
	});
