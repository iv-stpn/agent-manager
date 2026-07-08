import { beforeEach, describe, expect, it } from "bun:test";
import { sessions, tasks } from "@agent-manager/db/project-schema";
import { eq } from "drizzle-orm";
import { initDb } from "../../../db/client";
import { getCurrentTask, listTasks, setCurrentTask } from "./task";

// Archiving is the UI's way of clearing a finished/abandoned task out of the
// agent's working set. These tests pin the contract the agent's task tools must
// honour: archived tasks are invisible to list_tasks / get_current_task, but an
// archived *done* task still counts when annotating another task's dependencies
// (archiving a completed prerequisite must not make its dependents look blocked).

type Db = ReturnType<typeof initDb>;

const SESSION_ID = "sess-1";

// Insert one task row directly (bypassing addTask) so each test controls the id,
// status, archived flag and dependency metadata precisely.
function insertTask(
	db: Db,
	opts: {
		id: string;
		text?: string;
		status?: "pending" | "in_progress" | "done" | "cancelled";
		archived?: boolean;
		dependsOn?: string[];
	}
): void {
	const now = Date.now();
	db.insert(tasks)
		.values({
			id: opts.id,
			sessionId: SESSION_ID,
			text: opts.text ?? opts.id,
			status: opts.status ?? "pending",
			archived: opts.archived ?? false,
			metadata: opts.dependsOn && opts.dependsOn.length > 0 ? JSON.stringify({ dependsOn: opts.dependsOn }) : null,
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

let db: Db;

beforeEach(() => {
	// A fresh in-memory DB per test — initDb builds the full schema from the
	// Drizzle definitions, so `archived` and the FKs are present.
	db = initDb(":memory:");
	db.insert(sessions).values({ id: SESSION_ID, task: "test session" }).run();
});

describe("listTasks — archived filtering", () => {
	it("hides archived tasks from the default (all) listing", async () => {
		insertTask(db, { id: "keep", text: "visible task" });
		insertTask(db, { id: "gone", text: "archived task", archived: true });

		const out = await listTasks(db);
		expect(out).toContain("[keep]");
		expect(out).not.toContain("[gone]");
	});

	it("hides archived tasks from a status-filtered listing", async () => {
		insertTask(db, { id: "done-live", status: "done" });
		insertTask(db, { id: "done-archived", status: "done", archived: true });

		const out = await listTasks(db, "done");
		expect(out).toContain("[done-live]");
		expect(out).not.toContain("[done-archived]");
	});

	it("reports 'No tasks found.' when every match is archived", async () => {
		insertTask(db, { id: "a", archived: true });
		expect(await listTasks(db)).toBe("No tasks found.");
	});

	it("still counts an archived DONE task as a satisfied dependency (dependent reads 'ready')", async () => {
		insertTask(db, { id: "dep", status: "done", archived: true });
		insertTask(db, { id: "work", status: "pending", dependsOn: ["dep"] });

		const out = await listTasks(db);
		// The archived prerequisite is hidden…
		expect(out).not.toContain("[dep]");
		// …but the dependent is unblocked, not "blocked by dep".
		expect(out).toContain("[work]");
		expect(out).toContain("ready");
		expect(out).not.toContain("blocked by");
	});
});

describe("getCurrentTask — archived filtering", () => {
	it("ignores an archived in_progress task", async () => {
		insertTask(db, { id: "hidden", status: "in_progress", archived: true });
		expect(await getCurrentTask(db)).toBe("No current task (none in progress).");
	});

	it("returns a live in_progress task", async () => {
		insertTask(db, { id: "live", text: "doing it", status: "in_progress" });
		expect(await getCurrentTask(db)).toContain("[live]");
	});
});

describe("setCurrentTask — restores an archived task when adopted", () => {
	it("clears archived and makes the task the visible current task", async () => {
		insertTask(db, { id: "revive", text: "come back", status: "pending", archived: true });

		await setCurrentTask(db, SESSION_ID, "revive");

		const row = db.select().from(tasks).where(eq(tasks.id, "revive")).get();
		expect(row?.archived).toBe(false);
		expect(row?.status).toBe("in_progress");
		// It must now be visible to both agent-facing task tools.
		expect(await getCurrentTask(db)).toContain("[revive]");
		expect(await listTasks(db)).toContain("[revive]");
	});
});
