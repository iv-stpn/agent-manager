import { Hono } from "hono";
import { z } from "zod";
import { env } from "../env";
import type { HonoOrchestratorEnv } from "../types";

function tableName(projectId: string): string {
	return `project_${projectId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

async function lanceRequest(path: string, opts: RequestInit = {}) {
	const res = await fetch(`${env.LANCEDB_URL}${path}`, {
		...opts,
		headers: { "Content-Type": "application/json", ...opts.headers },
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`LanceDB error ${res.status}: ${text}`);
	}
	return res.json();
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const createSchema = z.object({
	id: z.string().optional(),
	type: z.enum(["decision", "todo", "plan", "question", "memory", "report", "context"]),
	title: z.string(),
	content: z.string(),
	metadata: z.record(z.any()).optional(),
});

const updateSchema = z.object({
	title: z.string().optional(),
	content: z.string().optional(),
	type: z.enum(["decision", "todo", "plan", "question", "memory", "report", "context"]).optional(),
	metadata: z.record(z.any()).optional(),
});

// ── Router ───────────────────────────────────────────────────────────────────

export const memoryRouter = new Hono<HonoOrchestratorEnv>()

	// List entries (filterable by type)
	.get("/:projectId", async (c) => {
		const projectId = c.req.param("projectId");
		const type = c.req.query("type");
		const limit = parseInt(c.req.query("limit") ?? "100", 10);

		const filter = type ? `type = '${type}' AND id != '__init__'` : "id != '__init__'";

		const data = await lanceRequest(`/tables/${tableName(projectId)}/query?filter=${encodeURIComponent(filter)}&limit=${limit}`);
		return c.json(data);
	})

	// Semantic search
	.get("/:projectId/search", async (c) => {
		const projectId = c.req.param("projectId");
		const query = c.req.query("q");
		if (!query) return c.json({ error: "Missing ?q= parameter" }, 400);

		const type = c.req.query("type");
		const limit = parseInt(c.req.query("limit") ?? "10", 10);

		const filter = type ? `type = '${type}' AND id != '__init__'` : "id != '__init__'";

		const data = await lanceRequest(`/tables/${tableName(projectId)}/search`, {
			method: "POST",
			body: JSON.stringify({ query, filter, limit }),
		});
		return c.json(data);
	})

	// Get single entry
	.get("/:projectId/:entryId", async (c) => {
		const projectId = c.req.param("projectId");
		const entryId = c.req.param("entryId");

		const data = await lanceRequest(
			`/tables/${tableName(projectId)}/query?filter=${encodeURIComponent(`id = '${entryId}'`)}&limit=1`
		);
		const entry = data.results?.[0];
		if (!entry) return c.json({ error: "Not found" }, 404);
		return c.json(entry);
	})

	// Create entry
	.post("/:projectId", async (c) => {
		const projectId = c.req.param("projectId");
		const body = createSchema.parse(await c.req.json());

		const id = body.id ?? `${body.type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const doc = {
			id,
			type: body.type,
			title: body.title,
			content: body.content,
			metadata: JSON.stringify(body.metadata ?? {}),
			createdAt: Date.now(),
		};

		await lanceRequest(`/tables/${tableName(projectId)}/add`, {
			method: "POST",
			body: JSON.stringify({ documents: [doc] }),
		});

		return c.json({ id, created: true }, 201);
	})

	// Update entry
	.put("/:projectId/:entryId", async (c) => {
		const projectId = c.req.param("projectId");
		const entryId = c.req.param("entryId");
		const body = updateSchema.parse(await c.req.json());

		const updates: Record<string, string> = {};
		if (body.title !== undefined) updates.title = body.title;
		if (body.content !== undefined) updates.content = body.content;
		if (body.type !== undefined) updates.type = body.type;
		if (body.metadata !== undefined) updates.metadata = JSON.stringify(body.metadata);

		await lanceRequest(`/tables/${tableName(projectId)}/update`, {
			method: "PUT",
			body: JSON.stringify({ id: entryId, updates }),
		});

		return c.json({ updated: true });
	})

	// Delete entry
	.delete("/:projectId/:entryId", async (c) => {
		const projectId = c.req.param("projectId");
		const entryId = c.req.param("entryId");

		await lanceRequest(`/tables/${tableName(projectId)}/delete`, {
			method: "POST",
			body: JSON.stringify({ filter: `id = '${entryId}'` }),
		});

		return c.json({ deleted: true });
	});
