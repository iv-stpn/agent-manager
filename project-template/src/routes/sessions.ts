import { extractTextContent } from "@agent-manager/utils/blocks";
import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import z from "zod";

import {
	initAgent,
	interjectAgent,
	pauseAgent,
	queueFollowUp,
	requestCompaction,
	runners,
	steerAgent,
	stopAgent,
} from "../agent/definition";
import { restart, resume, run } from "../agent/runner-utils/loop";
import type { AgentLlmConfig, AgentStateConfig } from "../agent/types";
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
import { fetchAgentConfig } from "../external/agent-config";
import { fetchProjectContext } from "../external/context";
import type { HonoProjectEnv } from "../types";

const CreateSessionSchema = z.object({
	task: z.string().min(1),
	name: z.string().optional(),
	reportIntervalMins: z.number().optional(),
	stopThresholdMins: z.number().optional(),
	awaitReportMode: z.enum(["always", "never", "custom"]).optional(),
	awaitReportCustomRule: z.string().optional(),
	awaitAskMode: z.enum(["always", "requiredOnly", "onReportOnly", "never"]).optional(),
	compactThresholdTokens: z.number().optional(),
	stopThresholdTokens: z.number().optional(),
	alwaysImproveMode: z.enum(["yes", "no", "custom"]).optional(),
	alwaysImproveScope: z.string().optional(),
});

const UpdateSessionSchema = z.object({
	name: z.string().optional(),
	reportIntervalMins: z.number().optional(),
	stopThresholdMins: z.number().optional(),
	awaitReportMode: z.enum(["always", "never", "custom"]).optional(),
	awaitReportCustomRule: z.string().nullable().optional(),
	awaitAskMode: z.enum(["always", "requiredOnly", "onReportOnly", "never"]).optional(),
	compactThresholdTokens: z.number().optional(),
	stopThresholdTokens: z.number().optional(),
	alwaysImproveMode: z.enum(["yes", "no", "custom"]).optional(),
	alwaysImproveScope: z.string().nullable().optional(),
});

const MessageSchema = z.object({ message: z.string().min(1) });

/** Fire-and-forget: ask the LLM to name the session based on the task. */
function autoNameSession(db: Db, sessionId: string, task: string, llm: AgentLlmConfig) {
	const client = new Anthropic({
		apiKey: llm.apiKey,
		baseURL: llm.baseUrl || undefined,
	});
	client.messages
		.create({
			model: llm.smallModel,
			// Generous despite the tiny reply: thinking models (local backends
			// serve one regardless of the requested model name) emit a thinking
			// block first and return no text at all if it hits max_tokens.
			max_tokens: 2048,
			messages: [
				{
					role: "user",
					content: `Give a short name (2-5 words) for a coding session with this task. Reply with ONLY the name, nothing else.\n\nTask: ${task}`,
				},
			],
		})
		.then((res) => {
			// Text may follow a thinking block, so scan all blocks
			const text = extractTextContent(res.content).trim();
			if (text) {
				updateSession(db, sessionId, { name: text });
				sessionEmitter.emit(sessionId, { type: "session_updated", data: { id: sessionId, name: text } });
			}
		})
		.catch((err) => {
			console.warn("[AutoName] Failed to name session:", err.message ?? err);
		});
}

const defaultChatName = () => {
	const now = new Date();
	const pad = (number: number) => String(number).padStart(2, "0");
	return `New chat session at ${pad(now.getHours())}:${pad(now.getMinutes())} on ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
};

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
	.put("/:id/settings", async (c) => {
		const id = c.req.param("id");
		const db = c.get("db");
		const session = getSession(db, id);
		if (!session) return c.json({ error: "Not found" }, 404);

		let body: z.infer<typeof UpdateSessionSchema>;
		try {
			body = UpdateSessionSchema.parse(await c.req.json());
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
		}

		// Build the change set from only the fields the client sent. With
		// exactOptionalPropertyTypes, passing `undefined` through to updateSession
		// (which expects `field?: T` without `undefined`) would type-error, so we
		// pick defined values explicitly.
		const changes: Partial<Parameters<typeof updateSession>[2]> = {};
		if (body.name !== undefined) changes.name = body.name;
		if (body.reportIntervalMins !== undefined) changes.reportIntervalMins = body.reportIntervalMins;
		if (body.stopThresholdMins !== undefined) changes.stopThresholdMins = body.stopThresholdMins;
		if (body.awaitReportMode !== undefined) changes.awaitReportMode = body.awaitReportMode;
		if (body.awaitReportCustomRule !== undefined) changes.awaitReportCustomRule = body.awaitReportCustomRule;
		if (body.awaitAskMode !== undefined) changes.awaitAskMode = body.awaitAskMode;
		if (body.compactThresholdTokens !== undefined) changes.compactThresholdTokens = body.compactThresholdTokens;
		if (body.stopThresholdTokens !== undefined) changes.stopThresholdTokens = body.stopThresholdTokens;
		if (body.alwaysImproveMode !== undefined) changes.alwaysImproveMode = body.alwaysImproveMode;
		if (body.alwaysImproveScope !== undefined) changes.alwaysImproveScope = body.alwaysImproveScope;
		updateSession(db, id, changes);

		// Apply to the live runner so runtime checks (compaction/stop thresholds,
		// report interval, ask gating) pick up the new values on the next turn.
		// Settings baked into the system prompt (await/always-improve wording)
		// only take full effect on the next restart, but persisting them here
		// ensures that restart sees them.
		const runner = runners.get(id);
		if (runner) {
			if (body.reportIntervalMins !== undefined) runner.config.reportIntervalMins = body.reportIntervalMins;
			if (body.stopThresholdMins !== undefined) runner.config.stopThresholdMins = body.stopThresholdMins;
			if (body.awaitReportMode !== undefined) runner.config.awaitReportMode = body.awaitReportMode;
			if (body.awaitReportCustomRule !== undefined) runner.config.awaitReportCustomRule = body.awaitReportCustomRule;
			if (body.awaitAskMode !== undefined) runner.config.awaitAskMode = body.awaitAskMode;
			if (body.compactThresholdTokens !== undefined) runner.config.compactThresholdTokens = body.compactThresholdTokens;
			if (body.stopThresholdTokens !== undefined) runner.config.stopThresholdTokens = body.stopThresholdTokens;
			if (body.alwaysImproveMode !== undefined) runner.config.alwaysImproveMode = body.alwaysImproveMode;
			if (body.alwaysImproveScope !== undefined) runner.config.alwaysImproveScope = body.alwaysImproveScope;
		}

		const updated = getSession(db, id);
		if (updated) sessionEmitter.emit(id, { type: "session_updated", data: updated });
		return c.json(updated);
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

		const config: AgentStateConfig = {
			reportIntervalMins: body.reportIntervalMins ?? 15,
			stopThresholdMins: body.stopThresholdMins ?? 240,
			awaitReportMode: body.awaitReportMode ?? "never",
			awaitAskMode: body.awaitAskMode ?? "always",
			awaitReportCustomRule: body.awaitReportCustomRule ?? null,
			compactThresholdTokens: body.compactThresholdTokens ?? 80_000,
			stopThresholdTokens: body.stopThresholdTokens ?? 2_000_000,
			alwaysImproveMode: body.alwaysImproveMode ?? "no",
			alwaysImproveScope: body.alwaysImproveScope ?? null,
		};

		const createdAt = Date.now();
		const name = body.name ?? defaultChatName();
		const session = createSession(db, { id, name, task: body.task, status: "running", createdAt, ...config });

		const [context, llm] = await Promise.all([fetchProjectContext(), fetchAgentConfig()]);
		const runner = initAgent({ db, sessionId: id, config, llm, context });
		runners.set(id, runner);

		sessionEmitter.emit(id, { type: "session_created", data: session });

		// Auto-name the session via a parallel LLM call (fire-and-forget)
		if (!body.name) {
			autoNameSession(db, id, body.task, llm);
		}

		run(runner, body.task).finally(() => {
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
			stopAgent(runner);
			runners.delete(id);
		}

		updateSession(db, id, { status: "aborted" });
		sessionEmitter.emit(id, { type: "session_updated", data: { id, status: "aborted" } });
		return c.json({ ok: true });
	})
	.post("/:id/pause", (c) => {
		const id = c.req.param("id");
		const db = c.get("db");
		const session = getSession(db, id);
		if (!session) return c.json({ error: "Not found" }, 404);

		const runner = runners.get(id);
		if (!runner) return c.json({ error: "Agent is not running" }, 409);

		// Unlike /stop, the session stays "running" until the agent's
		// in-flight message actually finishes — the loop flips the status to
		// "aborted" itself once it stops (see runLoop's pauseRequested check),
		// which arrives over SSE as a normal session_updated event.
		pauseAgent(runner);
		return c.json({ ok: true });
	})
	.post("/:id/compact", (c) => {
		const id = c.req.param("id");
		const db = c.get("db");
		const session = getSession(db, id);
		if (!session) return c.json({ error: "Not found" }, 404);

		const runner = runners.get(id);
		if (!runner) return c.json({ error: "Agent is not running" }, 409);
		// Already summarizing — a second request would be a no-op at best and, if
		// it slipped through, could abort the in-flight summarization call.
		if (session.status === "compacting") return c.json({ error: "Agent is already compacting" }, 409);

		// Non-disruptive, like steer: the flag is picked up at the top of the next
		// loop iteration (after the in-flight API call and its tools finish), then
		// the loop flips the status to "compacting" and back to "running" over SSE.
		requestCompaction(runner);
		return c.json({ ok: true });
	})
	.post("/:id/restart", async (c) => {
		const id = c.req.param("id");
		const db = c.get("db");
		const session = getSession(db, id);
		if (!session) return c.json({ error: "Not found" }, 404);
		if (session.status !== "error" && session.status !== "aborted") {
			return c.json({ error: "Session is not in a restartable state" }, 409);
		}
		if (runners.get(id)) return c.json({ error: "Agent is already running" }, 409);

		const config: AgentStateConfig = {
			reportIntervalMins: session.reportIntervalMins,
			stopThresholdMins: session.stopThresholdMins,
			awaitReportMode: session.awaitReportMode,
			awaitReportCustomRule: session.awaitReportCustomRule,
			awaitAskMode: session.awaitAskMode,
			compactThresholdTokens: session.compactThresholdTokens,
			stopThresholdTokens: session.stopThresholdTokens,
			alwaysImproveMode: session.alwaysImproveMode,
			alwaysImproveScope: session.alwaysImproveScope,
		};

		const [context, llm] = await Promise.all([fetchProjectContext(), fetchAgentConfig()]);
		const runner = initAgent({ db, sessionId: id, config, llm, context });

		runners.set(id, runner);
		restart(runner).finally(() => runners.delete(id));

		return c.json({ ok: true });
	})
	.post("/:id/steer", async (c) => {
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
		if (!existing) return c.json({ error: "Agent is not running" }, 409);

		steerAgent(existing, message);
		return c.json({ ok: true });
	})
	.post("/:id/follow-up", async (c) => {
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
		if (!existing) return c.json({ error: "Agent is not running" }, 409);

		queueFollowUp(existing, message);
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
			// Don't let a reply abort the summarization call mid-compaction —
			// the user must wait for the compaction to finish. The loop flips
			// the status back to "running" (over SSE) as soon as it's done.
			if (session.status === "compacting") {
				return c.json({ error: "Agent is compacting context — please wait." }, 409);
			}
			interjectAgent(existing, message);
			return c.json({ ok: true });
		}

		const config: AgentStateConfig = {
			reportIntervalMins: session.reportIntervalMins,
			stopThresholdMins: session.stopThresholdMins,
			awaitReportMode: session.awaitReportMode,
			awaitReportCustomRule: session.awaitReportCustomRule,
			awaitAskMode: session.awaitAskMode,
			compactThresholdTokens: session.compactThresholdTokens,
			stopThresholdTokens: session.stopThresholdTokens,
			alwaysImproveMode: session.alwaysImproveMode,
			alwaysImproveScope: session.alwaysImproveScope,
		};

		const [context, llm] = await Promise.all([fetchProjectContext(), fetchAgentConfig()]);
		const runner = initAgent({ db, sessionId: id, config, llm, context });

		runners.set(id, runner);
		resume(runner, message).finally(() => runners.delete(id));

		return c.json({ ok: true });
	});
