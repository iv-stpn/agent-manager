import { Hono } from "hono";
import z from "zod";
import { env } from "../env";
import type { HonoOrchestratorEnv } from "../types";
import { assertSafeId, parseLimit, tableName } from "./memory-guards";

const ENTRY_TYPES = ["decision", "todo", "plan", "question", "memory", "report", "context"] as const;
const typeSchema = z.enum(ENTRY_TYPES);

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
	type: typeSchema,
	title: z.string(),
	content: z.string(),
	metadata: z.record(z.string(), z.any()).optional(),
});

const updateSchema = z.object({
	title: z.string().optional(),
	content: z.string().optional(),
	type: typeSchema.optional(),
	metadata: z.record(z.string(), z.any()).optional(),
});

// ── Router ───────────────────────────────────────────────────────────────────

export const memoryRouter = new Hono<HonoOrchestratorEnv>()

	// List entries (filterable by type)
	.get("/:projectId", async (c) => {
		const projectId = c.req.param("projectId");
		const rawType = c.req.query("type");
		const limit = parseLimit(c.req.query("limit"), 100);

		const typeResult = rawType === undefined ? undefined : typeSchema.safeParse(rawType);
		if (typeResult && !typeResult.success) return c.json({ error: "invalid type" }, 400);
		const type = typeResult?.data;

		const filter = type ? `type = '${type}' AND id != '__init__'` : "id != '__init__'";

		const data = await lanceRequest(`/tables/${tableName(projectId)}/query?filter=${encodeURIComponent(filter)}&limit=${limit}`);
		return c.json(data);
	})

	// Semantic search
	.get("/:projectId/search", async (c) => {
		const projectId = c.req.param("projectId");
		const query = c.req.query("q");
		if (!query) return c.json({ error: "Missing ?q= parameter" }, 400);

		const rawType = c.req.query("type");
		const limit = parseLimit(c.req.query("limit"), 10);

		const typeResult = rawType === undefined ? undefined : typeSchema.safeParse(rawType);
		if (typeResult && !typeResult.success) return c.json({ error: "invalid type" }, 400);
		const type = typeResult?.data;

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
		const entryId = assertSafeId(c.req.param("entryId"));

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

		const id = body.id ? assertSafeId(body.id) : `${body.type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
		const entryId = assertSafeId(c.req.param("entryId"));
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
		const entryId = assertSafeId(c.req.param("entryId"));

		await lanceRequest(`/tables/${tableName(projectId)}/delete`, {
			method: "POST",
			body: JSON.stringify({ filter: `id = '${entryId}'` }),
		});

		return c.json({ deleted: true });
	});

// Validation failures (bad id / bad body) surface as 400 rather than a generic
// 500; upstream LanceDB failures stay 500 but are logged with context.
memoryRouter.onError((err, c) => {
	if (err instanceof z.ZodError || err.message === "invalid entry id") {
		return c.json({ error: err.message }, 400);
	}
	console.error(`[memory] ${c.req.method} ${c.req.path} failed: ${err}`);
	return c.json({ error: "memory backend error" }, 500);
});
