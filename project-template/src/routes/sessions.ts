import { Hono } from "hono";
import { nanoid } from "nanoid";
import { AgentRunner } from "../agent/runner";
import {
	createSession,
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
import type { HonoProjectEnv } from "../types";

const runners = new Map<string, AgentRunner>();

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
		const body = await c.req.json<{
			task: string;
			reportIntervalMins?: number;
			totalTimeoutMins?: number;
			discordChannelId?: string;
			freezeReportMode?: "always" | "never" | "custom";
			freezeReportCustomRule?: string;
			freezeAskMode?: "always" | "requiredOnly" | "onReportOnly" | "never";
			compactThresholdTokens?: number;
			stopThresholdTokens?: number;
			alwaysImproveMode?: "yes" | "no" | "custom";
			alwaysImproveScope?: string;
		}>();

		if (!body.task?.trim()) return c.json({ error: "task is required" }, 400);

		const db = c.get("db");
		const id = nanoid();
		const reportIntervalMins = body.reportIntervalMins ?? 15;
		const totalTimeoutMins = body.totalTimeoutMins ?? 240;
		const freezeReportMode = body.freezeReportMode ?? "never";
		const freezeAskMode = body.freezeAskMode ?? "always";
		const compactThresholdTokens = body.compactThresholdTokens ?? 80_000;
		const stopThresholdTokens = body.stopThresholdTokens ?? 400_000;
		const alwaysImproveMode = body.alwaysImproveMode ?? "no";
		const discordChannelId = body.discordChannelId ?? process.env.DISCORD_DEFAULT_CHANNEL_ID ?? null;

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
			discordChannelId,
			status: "running",
			createdAt,
			updatedAt: createdAt,
		});

		const runner = new AgentRunner({
			db,
			sessionId: id,
			reportIntervalMins,
			totalTimeoutMins,
			discordChannelId,
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

		const { message } = await c.req.json<{ message: string }>();
		if (!message?.trim()) return c.json({ error: "message is required" }, 400);

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
			discordChannelId: session.discordChannelId,
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
