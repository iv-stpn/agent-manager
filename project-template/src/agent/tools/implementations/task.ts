import { type TaskMetadata, tasks } from "@agent-manager/db/project-schema";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../../../db/client";

type TaskStatus = "pending" | "in_progress" | "done" | "cancelled";

function parseMeta(raw: string | null): TaskMetadata {
	if (!raw) return {};
	try {
		return JSON.parse(raw) as TaskMetadata;
	} catch {
		return {};
	}
}

function serializeMeta(meta: TaskMetadata): string | null {
	const keys = Object.keys(meta);
	if (keys.length === 0) return null;
	if (Array.isArray(meta.dependsOn) && meta.dependsOn.length === 0 && keys.length === 1) return null;
	return JSON.stringify(meta);
}

// Render a single task line, annotating dependencies and whether they block it.
function formatTask(t: typeof tasks.$inferSelect, doneIds: Set<string>): string {
	const meta = parseMeta(t.metadata);
	const deps = meta.dependsOn ?? [];
	let line = `[${t.id}] [${t.status}] ${t.text}`;
	if (deps.length > 0) {
		const blocking = deps.filter((d) => !doneIds.has(d));
		line += ` (depends on: ${deps.join(", ")}`;
		line += blocking.length > 0 ? `; blocked by ${blocking.join(", ")})` : "; ready)";
	}
	return line;
}

export async function addTask(
	db: Db,
	sessionId: string,
	text: string,
	status: TaskStatus = "pending",
	dependsOn?: string[]
): Promise<string> {
	const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
	const meta: TaskMetadata = {};
	if (dependsOn && dependsOn.length > 0) meta.dependsOn = dependsOn;
	db.insert(tasks)
		.values({ id, sessionId, text, status, metadata: serializeMeta(meta) })
		.run();
	const depNote = dependsOn && dependsOn.length > 0 ? ` (depends on: ${dependsOn.join(", ")})` : "";
	return `Added [${id}]: ${text}${depNote}`;
}

// List tasks across the whole project (cross-session), optionally filtered by
// status. Dependency annotations are computed against all done tasks.
export async function listTasks(db: Db, filter: TaskStatus | "all" = "all"): Promise<string> {
	const rows = filter === "all" ? db.select().from(tasks).all() : db.select().from(tasks).where(eq(tasks.status, filter)).all();
	if (rows.length === 0) return "No tasks found.";
	const doneIds = new Set(
		db
			.select()
			.from(tasks)
			.where(eq(tasks.status, "done"))
			.all()
			.map((t) => t.id)
	);
	return rows.map((t) => formatTask(t, doneIds)).join("\n");
}

// Return the task currently in progress, if any (project-wide).
export async function getCurrentTask(db: Db): Promise<string> {
	const [task] = db.select().from(tasks).where(eq(tasks.status, "in_progress")).all();
	if (!task) return "No current task (none in progress).";
	return `[${task.id}] ${task.text}`;
}

// Mark one task as the current task: it becomes in_progress and assigned to the
// calling session; any other in_progress task is demoted back to pending, so
// exactly one task is ever active. Warns if the task is still blocked by
// unfinished dependencies.
export async function setCurrentTask(db: Db, sessionId: string, id: string): Promise<string> {
	const [task] = db.select().from(tasks).where(eq(tasks.id, id)).all();
	if (!task) return `Task not found: ${id}`;
	const now = Date.now();
	db.update(tasks).set({ status: "pending", updatedAt: now }).where(eq(tasks.status, "in_progress")).run();
	db.update(tasks).set({ status: "in_progress", sessionId, updatedAt: now }).where(eq(tasks.id, id)).run();

	const deps = parseMeta(task.metadata).dependsOn ?? [];
	let warning = "";
	if (deps.length > 0) {
		const depRows = db.select().from(tasks).where(inArray(tasks.id, deps)).all();
		const unfinished = depRows.filter((d) => d.status !== "done").map((d) => d.id);
		if (unfinished.length > 0) warning = ` ⚠️ blocked by unfinished dependencies: ${unfinished.join(", ")}`;
	}
	return `Current task set to [${id}]: ${task.text}${warning}`;
}

export async function updateTask(
	db: Db,
	_sessionId: string,
	id: string,
	status?: TaskStatus,
	text?: string,
	dependsOn?: string[]
): Promise<string> {
	const [task] = db.select().from(tasks).where(eq(tasks.id, id)).all();
	if (!task) return `Task not found: ${id}`;
	const updates: Partial<typeof tasks.$inferInsert> = { updatedAt: Date.now() };
	if (status) updates.status = status;
	if (text) updates.text = text;
	if (dependsOn) {
		const meta = parseMeta(task.metadata);
		meta.dependsOn = dependsOn;
		updates.metadata = serializeMeta(meta);
	}
	db.update(tasks).set(updates).where(eq(tasks.id, id)).run();
	return `Updated [${id}]: ${text ?? task.text} → ${status ?? task.status}`;
}
