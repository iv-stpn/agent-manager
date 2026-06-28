import { env } from "../../../env";

const HOST_API_URL = env.HOST_API_URL;
const PROJECT_ID = env.PROJECT_ID;

function memoryUrl(path = ""): string {
	return `${HOST_API_URL}/api/memory/${PROJECT_ID}${path}`;
}

async function memoryRequest(path: string, opts: RequestInit = {}): Promise<Record<string, unknown>> {
	const res = await fetch(memoryUrl(path), {
		...opts,
		headers: { "Content-Type": "application/json", ...opts.headers },
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Memory API error ${res.status}: ${text}`);
	}
	return res.json() as Promise<Record<string, unknown>>;
}

export type MemoryType = "decision" | "todo" | "plan" | "question" | "memory" | "report" | "context";

/** Types available for direct use via the remember tool */
export type UserMemoryType = "decision" | "plan" | "memory" | "context";

export interface MemoryEntry {
	id: string;
	type: MemoryType;
	title: string;
	content: string;
	metadata?: Record<string, unknown>;
}

/** Store a new memory entry. Returns the generated ID. */
export async function remember(
	type: MemoryType,
	title: string,
	content: string,
	metadata?: Record<string, unknown>
): Promise<string> {
	const data = await memoryRequest("", {
		method: "POST",
		body: JSON.stringify({ type, title, content, metadata }),
	});
	return data.id as string;
}

/** Semantic search across project memory. */
export async function recall(query: string, type?: MemoryType, limit = 10): Promise<MemoryEntry[]> {
	const params = new URLSearchParams({ q: query, limit: String(limit) });
	if (type) params.set("type", type);
	const data = await memoryRequest(`/search?${params}`);
	return (data.results as MemoryEntry[]) ?? [];
}

/** Update an existing memory entry by ID. */
export async function updateMemory(
	id: string,
	updates: { title?: string; content?: string; type?: MemoryType; metadata?: Record<string, unknown> }
): Promise<void> {
	await memoryRequest(`/${id}`, { method: "PUT", body: JSON.stringify(updates) });
}

/** Delete a memory entry by ID. */
export async function deleteMemory(id: string): Promise<void> {
	await memoryRequest(`/${id}`, { method: "DELETE" });
}

/** List all memories, optionally filtered by type. */
export async function listMemories(type?: MemoryType, limit = 100): Promise<MemoryEntry[]> {
	const params = new URLSearchParams({ limit: String(limit) });
	if (type) params.set("type", type);
	const data = await memoryRequest(`?${params}`);
	return (data.results as MemoryEntry[]) ?? [];
}

/** Get a single memory entry by ID. */
export async function getMemory(id: string): Promise<MemoryEntry | null> {
	try {
		return (await memoryRequest(`/${id}`)) as MemoryEntry;
	} catch {
		return null;
	}
}
