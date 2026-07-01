import { type Connection, connect, type Table } from "@lancedb/lancedb";
import { type FeatureExtractionPipeline, pipeline } from "@xenova/transformers";
import { Hono } from "hono";

const app = new Hono();

// ── Globals ──────────────────────────────────────────────────────────────────

const DATA_DIR = process.env.LANCEDB_DATA_DIR ?? "/data/lancedb";
let db: Connection;
let embedder: FeatureExtractionPipeline;

async function init() {
	console.log(`[lancedb] Connecting to ${DATA_DIR}`);
	db = await connect(DATA_DIR);
	console.log("[lancedb] Loading embedding model (all-MiniLM-L6-v2)...");
	embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
	console.log("[lancedb] Ready");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const VECTOR_DIM = 384;

async function embed(text: string): Promise<number[]> {
	const output = await embedder(text, { pooling: "mean", normalize: true });
	if (!(output.data instanceof Float32Array)) {
		throw new Error(`Expected Float32Array from embedder, got ${Object.prototype.toString.call(output.data)}`);
	}
	return Array.from(output.data) as number[];
}

async function getOrCreateTable(name: string): Promise<Table> {
	const tables = await db.tableNames();
	if (tables.includes(name)) {
		return db.openTable(name);
	}
	return db.createTable(name, [
		{
			id: "__init__",
			type: "system",
			title: "init",
			content: "Table initialized",
			vector: new Array(VECTOR_DIM).fill(0),
			metadata: "{}",
			createdAt: Date.now(),
			createdAtStr: new Date().toISOString(),
			updatedAt: Date.now(),
			updatedAtStr: new Date().toISOString(),
		},
	]);
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ status: "ok" }));

// Add documents (upsert by id)
app.post("/tables/:table/add", async (c) => {
	const tableName = c.req.param("table");
	const body = await c.req.json<{ documents: Record<string, unknown>[] }>();

	const table = await getOrCreateTable(tableName);

	const docs = await Promise.all(
		body.documents.map(async (doc) => ({
			...doc,
			vector: await embed(`${doc.title ?? ""} ${doc.content ?? ""}`),
			createdAt: doc.createdAt ?? Date.now(),
			createdAtStr: (doc.createdAtStr as string) ?? new Date(Number(doc.createdAt) || Date.now()).toISOString(),
			updatedAt: Date.now(),
			updatedAtStr: new Date().toISOString(),
		}))
	);

	// Overwrite existing docs with same id
	const existingIds = docs.map((doc) => (doc as Record<string, unknown>).id);
	try {
		await table.delete(`id IN ('${existingIds.join("','")}')`);
	} catch {
		// Table might be empty or ids don't exist
	}

	await table.add(docs);
	return c.json({ added: docs.length });
});

// Semantic search
app.post("/tables/:table/search", async (c) => {
	const tableName = c.req.param("table");
	const body = await c.req.json<{ query: string; filter?: string; limit?: number }>();

	const table = await getOrCreateTable(tableName);
	const queryVector = await embed(body.query);

	let search = table.search(queryVector).limit(body.limit ?? 10);
	if (body.filter) {
		search = search.where(body.filter);
	}

	const results = await search.toArray();
	return c.json({
		results: results.filter((result) => result.id !== "__init__").map(({ vector, ...rest }) => rest),
	});
});

// Filter-only query (no vector)
app.get("/tables/:table/query", async (c) => {
	const tableName = c.req.param("table");
	const filter = c.req.query("filter") ?? "id != '__init__'";
	const limit = parseInt(c.req.query("limit") ?? "100", 10);

	const table = await getOrCreateTable(tableName);
	const results = await table.query().where(filter).limit(limit).toArray();

	return c.json({
		results: results.map(({ vector, ...rest }) => rest),
	});
});

// Delete by filter
app.post("/tables/:table/delete", async (c) => {
	const tableName = c.req.param("table");
	const body = await c.req.json<{ filter: string }>();

	const table = await getOrCreateTable(tableName);
	await table.delete(body.filter);
	return c.json({ deleted: true });
});

// Drop table entirely
app.delete("/tables/:table", async (c) => {
	const tableName = c.req.param("table");
	const tables = await db.tableNames();
	if (tables.includes(tableName)) {
		await db.dropTable(tableName);
	}
	return c.json({ dropped: true });
});

// Update by id
app.put("/tables/:table/update", async (c) => {
	const tableName = c.req.param("table");
	const body = await c.req.json<{ id: string; updates: Record<string, unknown> }>();

	const table = await getOrCreateTable(tableName);

	// Re-embed if content or title changed
	let vector: number[] | undefined;
	if (body.updates.content || body.updates.title) {
		// Fetch existing to merge
		const existing = await table.query().where(`id = '${body.id}'`).limit(1).toArray();
		if (existing.length > 0) {
			const title = body.updates.title ?? existing[0].title;
			const content = body.updates.content ?? existing[0].content;
			vector = await embed(`${title} ${content}`);
		}
	}

	// LanceDB doesn't have native update — delete + re-add
	const existing = await table.query().where(`id = '${body.id}'`).limit(1).toArray();
	if (existing.length === 0) {
		return c.json({ error: "Not found" }, 404);
	}

	await table.delete(`id = '${body.id}'`);
	const updated = {
		...existing[0],
		...body.updates,
		...(vector ? { vector } : {}),
		updatedAt: Date.now(),
		updatedAtStr: new Date().toISOString(),
	};
	await table.add([updated]);

	return c.json({ updated: true });
});

// ── Start ────────────────────────────────────────────────────────────────────

await init();

export default {
	port: parseInt(process.env.PORT ?? "3200", 10),
	fetch: app.fetch,
};
