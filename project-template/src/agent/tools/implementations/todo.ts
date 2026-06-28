import { eq, and } from "drizzle-orm";
import { todos } from "../../../db/schema";
import type { Db } from "../../../db/client";

type TodoStatus = "pending" | "in_progress" | "done";

export async function addTodo(db: Db, sessionId: string, text: string, status: TodoStatus = "pending"): Promise<string> {
	const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
	db.insert(todos).values({ id, sessionId, text, status }).run();
	return `Added [${id}]: ${text}`;
}

export async function listTodos(db: Db, sessionId: string, filter = "all"): Promise<string> {
	const rows = filter === "all"
		? db.select().from(todos).where(eq(todos.sessionId, sessionId)).all()
		: db.select().from(todos).where(and(eq(todos.sessionId, sessionId), eq(todos.status, filter as TodoStatus))).all();
	if (rows.length === 0) return "No todos found.";
	return rows.map((t) => `[${t.id}] [${t.status}] ${t.text}`).join("\n");
}

export async function updateTodo(db: Db, sessionId: string, id: string, status?: TodoStatus, text?: string): Promise<string> {
	const [todo] = db.select().from(todos).where(and(eq(todos.id, id), eq(todos.sessionId, sessionId))).all();
	if (!todo) return `Todo not found: ${id}`;
	const updates: Partial<{ text: string; status: TodoStatus; updatedAt: number }> = { updatedAt: Date.now() };
	if (status) updates.status = status;
	if (text) updates.text = text;
	db.update(todos).set(updates).where(eq(todos.id, id)).run();
	return `Updated [${id}]: ${text ?? todo.text} → ${status ?? todo.status}`;
}
