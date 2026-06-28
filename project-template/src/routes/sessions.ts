import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import { AgentRunner } from "../agent/runner";
import {
	createSession,
	type Db,
	getCheckins,
	getCompactions,
	getMessages,
	getQuestions,
	getSession,
	getToolCalls,
	listSessions,
	updateSession,
} from "../db";
import { sessionEmitter } from "../emitter";
import { env } from "../env";
import { runners } from "../runners";
import type { HonoProjectEnv } from "../types";

const CreateSessionSchema = z.object({
	task: z.string().min(1),
	name: z.string().optional(),
	reportIntervalMins: z.number().optional(),
	totalTimeoutMins: z.number().optional(),
	freezeReportMode: z.enum(["always", "never", "custom"]).optional(),
	freezeReportCustomRule: z.string().optional(),
	freezeAskMode: z.enum(["always", "requiredOnly", "onReportOnly", "never"]).optional(),
	compactThresholdTokens: z.number().optional(),
	stopThresholdTokens: z.number().optional(),
	alwaysImproveMode: z.enum(["yes", "no", "custom"]).optional(),
	alwaysImproveScope: z.string().optional(),
});

const MessageSchema = z.object({ message: z.string().min(1) });

/** Fire-and-forget: ask the LLM to name the session based on the task. */
function autoNameSession(db: Db, sessionId: string, task: string) {
	const client = new Anthropic({
		apiKey: env.ANTHROPIC_API_KEY,
		baseURL: env.ANTHROPIC_BASE_URL,
	});
	client.messages
		.create({
			model: env.ANTHROPIC_MODEL,
			max_tokens: 30,
			messages: [
				{
					role: "user",
					content: `Give a short name (2-5 words) for a coding session with this task. Reply with ONLY the name, nothing else.\n\nTask: ${task}`,
				},
			],
		})
		.then((res) => {
			const text = res.content[0]?.type === "text" ? res.content[0].text.trim() : null;
			if (text) {
				updateSession(db, sessionId, { name: text });
				sessionEmitter.emit(sessionId, { type: "session_updated", data: { id: sessionId, name: text } });
			}
		})
		.catch((err) => {
			console.warn("[AutoName] Failed to name session:", err.message ?? err);
		});
}

export const sessionsRouter = new Hono<HonoProjectEnv>()
	.get("/", (c) => c.json(listSessions(c.get("db"))))

	.get("/:id", (c) => {
		const session = getSession(c.get("db"), c.req.param("id"));
		if (!session) return c.json({ error: "Not found" }, 404);
		return c.json(session);
	})

	.get("/:id/messages", (c) => {
		const session = getSession(c.get("db"), c.req.param("id"));
		if (!session) return c.json({ error: "Not found" }, 404);
		return c.json(getMessages(c.get("db"), session.id));
	})

	.get("/:id/tools", (c) => {
		const session = getSession(c.get("db"), c.req.param("id"));
		if (!session) return c.json({ error: "Not found" }, 404);
		return c.json(getToolCalls(c.get("db"), session.id));
	})

	.get("/:id/checkins", (c) => {
		const session = getSession(c.get("db"), c.req.param("id"));
		if (!session) return c.json({ error: "Not found" }, 404);
		return c.json(getCheckins(c.get("db"), session.id));
	})

	.get("/:id/questions", (c) => {
		const session = getSession(c.get("db"), c.req.param("id"));
		if (!session) return c.json({ error: "Not found" }, 404);
		return c.json(getQuestions(c.get("db"), session.id));
	})

	.get("/:id/compactions", (c) => {
		const session = getSession(c.get("db"), c.req.param("id"));
		if (!session) return c.json({ error: "Not found" }, 404);
		return c.json(getCompactions(c.get("db"), session.id));
	})

	.post("/", async (c) => {
		let body: z.infer<typeof CreateSessionSchema>;
		try {
			body = CreateSessionSchema.parse(await c.req.json());
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
		}

		const db = c.get("db");
		const id = nanoid();
		const reportIntervalMins = body.reportIntervalMins ?? 15;
		const totalTimeoutMins = body.totalTimeoutMins ?? 240;
		const freezeReportMode = body.freezeReportMode ?? "never";
		const freezeAskMode = body.freezeAskMode ?? "always";
		const compactThresholdTokens = body.compactThresholdTokens ?? 80_000;
		const stopThresholdTokens = body.stopThresholdTokens ?? 400_000;
		const alwaysImproveMode = body.alwaysImproveMode ?? "no";

		const createdAt = Date.now();
		const d = new Date(createdAt);
		const pad = (n: number) => String(n).padStart(2, "0");
		const defaultName = `New chat session at ${pad(d.getHours())}:${pad(d.getMinutes())} on ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;

		const session = createSession(db, {
			id,
			name: body.name ?? defaultName,
			task: body.task,
			reportIntervalMins,
			totalTimeoutMins,
			freezeReportMode,
			freezeReportCustomRule: body.freezeReportCustomRule ?? null,
			freezeAskMode,
			compactThresholdTokens,
			stopThresholdTokens,
			alwaysImproveMode,
			alwaysImproveScope: body.alwaysImproveScope ?? null,
			status: "running",
			createdAt,
			updatedAt: createdAt,
		});

		const runner = new AgentRunner({
			db,
			sessionId: id,
			reportIntervalMins,
			totalTimeoutMins,
			freezeReportMode,
			freezeReportCustomRule: body.freezeReportCustomRule ?? null,
			freezeAskMode,
			compactThresholdTokens,
			stopThresholdTokens,
			alwaysImproveMode,
			alwaysImproveScope: body.alwaysImproveScope ?? null,
		});
		runners.set(id, runner);

		sessionEmitter.emit(id, { type: "session_created", data: session });

		// Auto-name the session via a parallel LLM call (fire-and-forget)
		if (!body.name) {
			autoNameSession(db, id, body.task);
		}

		runner.run(body.task).finally(() => {
			runners.delete(id);
		});

		return c.json(session, 201);
	})

	.post("/:id/stop", (c) => {
		const id = c.req.param("id");
		const db = c.get("db");
		const session = getSession(db, id);
		if (!session) return c.json({ error: "Not found" }, 404);

		const runner = runners.get(id);
		if (runner) {
			runner.stop();
			runners.delete(id);
		}

		updateSession(db, id, { status: "stopped" });
		sessionEmitter.emit(id, { type: "session_updated", data: { id, status: "stopped" } });
		return c.json({ ok: true });
	})

	.post("/:id/message", async (c) => {
		const id = c.req.param("id");
		const db = c.get("db");
		const session = getSession(db, id);
		if (!session) return c.json({ error: "Not found" }, 404);

		let message: string;
		try {
			({ message } = MessageSchema.parse(await c.req.json()));
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
		}

		const existing = runners.get(id);
		if (existing) {
			existing.interject(message);
			return c.json({ ok: true });
		}

		const runner = new AgentRunner({
			db,
			sessionId: id,
			reportIntervalMins: session.reportIntervalMins,
			totalTimeoutMins: session.totalTimeoutMins,
			freezeReportMode: session.freezeReportMode,
			freezeReportCustomRule: session.freezeReportCustomRule,
			freezeAskMode: session.freezeAskMode,
			compactThresholdTokens: session.compactThresholdTokens,
			stopThresholdTokens: session.stopThresholdTokens,
			alwaysImproveMode: session.alwaysImproveMode,
			alwaysImproveScope: session.alwaysImproveScope,
		});

		runners.set(id, runner);
		runner.resume(message).finally(() => runners.delete(id));

		return c.json({ ok: true });
	});
