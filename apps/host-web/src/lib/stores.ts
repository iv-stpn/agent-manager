// Global stores — the single source of truth for live project/session state.
//
// The problem this solves: several screens (home page, sidebar, project page,
// session page) each used to open their OWN SSE connection and fold events into
// the shared query cache independently. Two host streams both incrementing
// `stats.sessions` on the same `session_created` event double-counted; every
// screen carried its own divergent copy of the folding logic; and the same
// event could be applied twice or not at all depending on what was mounted.
//
// Here instead there is exactly ONE connection per resource (one host stream,
// one per running project, one per open session), ref-counted so it stays open
// while any screen needs it and closes when the last unmounts. All event→cache
// folding lives in one place, so the cache is authoritative and every screen
// that reads a given key sees identical state.
//
// Screens still use `useQuery` for the initial fetch (loading/error UI); the
// stores own every live update thereafter, and re-sync on (re)connect.

import { createProjectStream, createSessionStream } from "@agent-manager/utils";
import { useEffect } from "react";
import { toast } from "sonner";
import type { Checkin, Compaction, EnrichedProject, Message, Question, Report, Session, Task, ToolCall } from "@/lib/agent-api";
import {
	getCheckins,
	getCompactions,
	getMessages,
	getQuestions,
	getReports,
	getSession,
	getSessions,
	getTasks,
	getToolCalls,
} from "@/lib/agent-api";
import { createHostStream } from "@/lib/host-stream";
import { getCache, mutateCache, setCache, updateCache, useCacheValue } from "@/lib/query-cache";

// ── Cache keys ────────────────────────────────────────────────────────────────
// Every screen builds its keys through this object so a producer (a store fold)
// and a consumer (a `useQuery`/`useCacheValue`) can never disagree on the key.

export const cacheKeys = {
	projects: "projects",
	project: (id: string) => `project:${id}`,
	sessions: (id: string) => `sessions:${id}`,
	reports: (id: string) => `reports:${id}`,
	tasks: (id: string) => `tasks:${id}`,
	session: (pid: string, sid: string) => `session:${pid}:${sid}`,
	messages: (pid: string, sid: string) => `messages:${pid}:${sid}`,
	tools: (pid: string, sid: string) => `tools:${pid}:${sid}`,
	checkins: (pid: string, sid: string) => `checkins:${pid}:${sid}`,
	questions: (pid: string, sid: string) => `questions:${pid}:${sid}`,
	compactions: (pid: string, sid: string) => `compactions:${pid}:${sid}`,
	// Ephemeral per-session streaming state — store-owned, no fetch behind it.
	streamText: (sid: string) => `stream:text:${sid}`,
	streamThinking: (sid: string) => `stream:thinking:${sid}`,
	streamToolcall: (sid: string) => `stream:toolcall:${sid}`,
	planMode: (sid: string) => `stream:planmode:${sid}`,
	tokenWarning: (sid: string) => `stream:tokenwarning:${sid}`,
} as const;

export type StreamingToolcall = { name: string; inputDelta: string };
export type TokenWarning = { state: string; estimatedTokens: number; threshold: number; contextWindow: number };

// ── Ref-counted connection manager ──────────────────────────────────────────
// Keeps one live connection per key. `acquire` bumps the ref and returns a
// release fn; the connection is opened on the first acquire and closed when the
// last holder releases. `opener` returns the resource plus its teardown.

interface Conn {
	refs: number;
	close: () => void;
}

function connectionManager<A extends unknown[]>(opener: (key: string, ...args: A) => () => void) {
	const conns = new Map<string, Conn>();
	return function acquire(key: string, ...args: A): () => void {
		let conn = conns.get(key);
		if (!conn) {
			conn = { refs: 0, close: opener(key, ...args) };
			conns.set(key, conn);
		}
		conn.refs++;
		return () => {
			const cur = conns.get(key);
			if (!cur) return;
			cur.refs--;
			if (cur.refs <= 0) {
				cur.close();
				conns.delete(key);
			}
		};
	};
}

// ── Host stream ──────────────────────────────────────────────────────────────
// One connection for the whole app, feeding the `"projects"` list that the
// home page, sidebar, and statistics page all read.

export const acquireHostStream = connectionManager(() => {
	const patch = (projectId: string, fn: (p: EnrichedProject) => EnrichedProject) =>
		mutateCache<EnrichedProject[]>(cacheKeys.projects, (list) => list.map((p) => (p.id === projectId ? fn(p) : p)));

	const es = createHostStream<EnrichedProject>(
		(type, { projectId, data }) => {
			if (type === "project_status") {
				const running = Boolean((data as { running?: boolean }).running);
				patch(projectId, (p) => ({ ...p, dockerStatus: { ...p.dockerStatus, running } }));
			} else if (type === "session_created") {
				patch(projectId, (p) => ({ ...p, stats: { ...p.stats, sessions: p.stats.sessions + 1 } }));
			} else if (type === "message") {
				patch(projectId, (p) => ({ ...p, stats: { ...p.stats, messages: p.stats.messages + 1 } }));
			}
		},
		(snapshot) => setCache(cacheKeys.projects, snapshot)
	);
	return () => es.close();
});

// ── Project stream ───────────────────────────────────────────────────────────
// One connection per running project. Feeds the sessions list, the reports
// list, the project's live stats, and the running indicator.

export const acquireProjectStream = connectionManager((_key: string, projectId: string, port: number) => {
	const projKey = cacheKeys.project(projectId);
	const sessKey = cacheKeys.sessions(projectId);
	const repKey = cacheKeys.reports(projectId);

	const setRunning = (running: boolean) =>
		mutateCache<EnrichedProject>(projKey, (p) => ({ ...p, dockerStatus: { ...p.dockerStatus, running } }));

	const es = createProjectStream((event) => {
		if (event.type === "sessions") {
			setCache(sessKey, event.data);
			mutateCache<EnrichedProject>(projKey, (p) => ({ ...p, stats: { ...p.stats, sessions: event.data.length } }));
		} else if (event.type === "session_created") {
			mutateCache<Session[]>(sessKey, (prev) => (prev.some((x) => x.id === event.data.id) ? prev : [event.data, ...prev]));
			mutateCache<EnrichedProject>(projKey, (p) => ({ ...p, stats: { ...p.stats, sessions: p.stats.sessions + 1 } }));
		} else if (event.type === "session_updated" || event.type === "token_update") {
			mutateCache<Session[]>(sessKey, (prev) => prev.map((x) => (x.id === event.data.sessionId ? { ...x, ...event.data } : x)));
		} else if (event.type === "message") {
			mutateCache<EnrichedProject>(projKey, (p) => ({ ...p, stats: { ...p.stats, messages: p.stats.messages + 1 } }));
		} else if (event.type === "checkin_started" || event.type === "checkin_completed") {
			const d = event.data;
			const session = (getCache<Session[]>(sessKey) ?? []).find((s) => s.id === d.sessionId);
			const confirmed = event.type === "checkin_completed";
			const report: Report = {
				id: d.id,
				sessionId: d.sessionId,
				trigger: d.trigger,
				summary: d.summary ?? "",
				discordMessageId: d.discordMessageId ?? null,
				status: confirmed ? "answered" : "pending",
				createdAt: d.createdAt,
				completedAt: confirmed ? Date.now() : null,
				sessionName: session?.name ?? null,
				sessionTask: session?.task ?? "",
			};
			mutateCache<Report[]>(repKey, (prev) => {
				const next = prev.filter((r) => r.id !== report.id);
				next.push(report);
				return next.sort((a, b) => b.createdAt - a.createdAt);
			});
		}
	}, port);

	es.onopen = () => {
		setRunning(true);
		// Re-sync anything that changed while disconnected. `setCache` seeds or
		// replaces regardless of whether the initial fetch has landed.
		void getSessions(projectId)
			.then((data) => setCache(sessKey, data))
			.catch(() => {});
		void getReports(projectId)
			.then((data) => setCache(repKey, data))
			.catch(() => {});
	};
	es.onerror = () => {
		// The browser auto-reconnects on a transient drop (readyState → CONNECTING).
		// Only treat this as "the project stopped" once it has given up (CLOSED).
		if (es.readyState === EventSource.CLOSED) setRunning(false);
	};

	return () => es.close();
});

// ── Session stream ───────────────────────────────────────────────────────────
// One connection per open session. Owns every per-session cache (messages,
// tools, check-ins, questions, compactions, tasks, the session record itself)
// plus the ephemeral live-streaming state, and drives session-scoped toasts.

export const acquireSessionStream = connectionManager((_key: string, sessionId: string, projectId: string, port: number) => {
	const sKey = cacheKeys.session(projectId, sessionId);
	const mKey = cacheKeys.messages(projectId, sessionId);
	const tKey = cacheKeys.tools(projectId, sessionId);
	const cKey = cacheKeys.checkins(projectId, sessionId);
	const qKey = cacheKeys.questions(projectId, sessionId);
	const xKey = cacheKeys.compactions(projectId, sessionId);
	const tkKey = cacheKeys.tasks(projectId);
	const rKey = cacheKeys.project(projectId);

	const es = createSessionStream(
		sessionId,
		(event) => {
			if (event.type === "turn_start") {
				updateCache(cacheKeys.streamThinking(sessionId), () => "");
				updateCache<StreamingToolcall | null>(cacheKeys.streamToolcall(sessionId), () => null);
			} else if (event.type === "text_delta") {
				updateCache<string>(cacheKeys.streamText(sessionId), (prev = "") => prev + event.data.text);
			} else if (event.type === "thinking_delta") {
				updateCache<string>(cacheKeys.streamThinking(sessionId), (prev = "") => prev + event.data.thinking);
			} else if (event.type === "toolcall_start") {
				updateCache<StreamingToolcall | null>(cacheKeys.streamToolcall(sessionId), () => ({
					name: event.data.name,
					inputDelta: "",
				}));
			} else if (event.type === "toolcall_delta") {
				updateCache<StreamingToolcall | null>(cacheKeys.streamToolcall(sessionId), (prev) =>
					prev ? { ...prev, inputDelta: prev.inputDelta + event.data.inputDelta } : null
				);
			} else if (event.type === "session_updated") {
				mutateCache<Session>(sKey, (s) => (s ? { ...s, ...event.data } : s));
			} else if (event.type === "message") {
				if ((event.data as { role?: string }).role === "assistant") {
					updateCache(cacheKeys.streamText(sessionId), () => "");
					updateCache(cacheKeys.streamThinking(sessionId), () => "");
					updateCache<StreamingToolcall | null>(cacheKeys.streamToolcall(sessionId), () => null);
				}
				mutateCache<Message[]>(mKey, (prev = []) => (prev.some((m) => m.id === event.data.id) ? prev : [...prev, event.data]));
			} else if (event.type === "tool_call") {
				mutateCache<ToolCall[]>(tKey, (prev = []) => {
					const idx = prev.findIndex((t) => t.id === event.data.id);
					if (idx < 0) return [...prev, event.data];
					const next = [...prev];
					next[idx] = { ...next[idx], ...event.data };
					return next;
				});
			} else if (event.type === "token_update") {
				mutateCache<Session>(sKey, (s) =>
					s
						? {
								...s,
								totalInputTokens: event.data.totalInputTokens,
								totalOutputTokens: event.data.totalOutputTokens,
								totalCacheReadTokens: event.data.totalCacheReadTokens,
								totalCacheWriteTokens: event.data.totalCacheWriteTokens,
							}
						: s
				);
			} else if (event.type === "checkin_started" || event.type === "checkin_completed") {
				const payload = event.data;
				mutateCache<Checkin[]>(cKey, (prev = []) => {
					const idx = prev.findIndex((c) => c.id === payload.id);
					if (idx < 0) return [...prev, payload];
					const next = [...prev];
					next[idx] = { ...next[idx], ...payload };
					return next;
				});
				if ("questions" in payload && payload.questions?.length) {
					mutateCache<Question[]>(qKey, (prev = []) => {
						const byId = new Map(prev.map((q) => [q.id, q]));
						for (const q of payload.questions) byId.set(q.id, { ...byId.get(q.id), ...q });
						return [...byId.values()];
					});
				}
			} else if (event.type === "compaction") {
				mutateCache<Compaction[]>(xKey, (prev = []) => (prev.some((c) => c.id === event.data.id) ? prev : [...prev, event.data]));
			} else if (event.type === "plan_mode") {
				updateCache(cacheKeys.planMode(sessionId), () => event.data.active);
				if (event.data.active) toast.info("Agent entered plan mode (read-only)");
				else toast.success("Agent exited plan mode");
			} else if (event.type === "token_warning") {
				updateCache<TokenWarning>(cacheKeys.tokenWarning(sessionId), () => event.data);
				const pct = Math.round((event.data.estimatedTokens / event.data.contextWindow) * 100);
				if (event.data.state === "warning") toast.warning(`Context reaching capacity (${pct}%)`);
				else if (event.data.state === "error") toast.error("Context near limit — auto-compacting");
				else if (event.data.state === "blocking") toast.error("Context at maximum capacity");
			} else if (event.type === "error_recovered") {
				toast.info(
					`API retry #${event.data.attempt}: ${event.data.error} (retrying in ${Math.round(event.data.nextRetryMs / 1000)}s)`
				);
			} else if (event.type === "task_created") {
				const task = event.data as Task;
				mutateCache<Task[]>(tkKey, (prev = []) => (prev.some((t) => t.id === task.id) ? prev : [...prev, task]));
			} else if (event.type === "task_updated") {
				const task = event.data as Task;
				mutateCache<Task[]>(tkKey, (prev = []) => {
					const idx = prev.findIndex((t) => t.id === task.id);
					if (idx < 0) return [...prev, task];
					const next = [...prev];
					next[idx] = { ...next[idx], ...task };
					return next;
				});
			}
		},
		port
	);

	es.onopen = () => {
		// Re-sync every per-session cache on (re)connect so nothing missed while
		// disconnected is lost. `setCache` seeds or replaces regardless of the
		// initial `useQuery` fetch.
		void getSession(projectId, sessionId)
			.then((d) => setCache(sKey, d))
			.catch(() => {});
		void getMessages(projectId, sessionId)
			.then((d) => setCache(mKey, d))
			.catch(() => {});
		void getToolCalls(projectId, sessionId)
			.then((d) => setCache(tKey, d))
			.catch(() => {});
		void getCheckins(projectId, sessionId)
			.then((d) => setCache(cKey, d))
			.catch(() => {});
		void getQuestions(projectId, sessionId)
			.then((d) => setCache(qKey, d))
			.catch(() => {});
		void getCompactions(projectId, sessionId)
			.then((d) => setCache(xKey, d))
			.catch(() => {});
		void getTasks(projectId)
			.then((d) => setCache(tkKey, d))
			.catch(() => {});
	};
	es.onerror = () => {
		// This cache key is shared with the project page's running-gated stream;
		// only mark stopped once the browser has fully given up (CLOSED).
		if (es.readyState === EventSource.CLOSED) {
			mutateCache<EnrichedProject>(rKey, (p) => (p ? { ...p, dockerStatus: { ...p.dockerStatus, running: false } } : p));
		}
	};

	return () => es.close();
});

// ── React hooks ────────────────────────────────────────────────────────────────
// Each hook acquires its resource's shared connection for the lifetime of the
// component, and reads store-owned state out of the cache. Mounting the same
// hook in several places reuses one connection (ref-counted above).

/**
 * Keep the host `"projects"` stream connected while mounted. Any screen that
 * reads the projects list (home, sidebar, statistics) calls this; they share a
 * single upstream connection and therefore a single, consistent fold.
 */
export function useHostStream(): void {
	useEffect(() => acquireHostStream(cacheKeys.projects), []);
}

/**
 * Keep a project's stream connected while mounted and the project is running.
 * Feeds the sessions list, reports, live stats, and running indicator.
 */
export function useProjectStream(projectId: string | undefined, running: boolean, port: number | undefined): void {
	useEffect(() => {
		if (!projectId || !running || !port) return;
		return acquireProjectStream(cacheKeys.project(projectId), projectId, port);
	}, [projectId, running, port]);
}

/**
 * Keep a session's stream connected while mounted and the project is running.
 * Owns every per-session cache plus the ephemeral live-streaming state.
 */
export function useSessionStream(
	projectId: string | undefined,
	sessionId: string | undefined,
	running: boolean,
	port: number | undefined
): void {
	useEffect(() => {
		if (!projectId || !sessionId || !running || !port) return;
		return acquireSessionStream(cacheKeys.session(projectId, sessionId), sessionId, projectId, port);
	}, [projectId, sessionId, running, port]);
}

/** Read the ephemeral live-streaming state a session stream folds in. */
export function useSessionStreamingState(sessionId: string | undefined) {
	const text = useCacheValue<string>(sessionId ? cacheKeys.streamText(sessionId) : null) ?? "";
	const thinking = useCacheValue<string>(sessionId ? cacheKeys.streamThinking(sessionId) : null) ?? "";
	const toolcall = useCacheValue<StreamingToolcall | null>(sessionId ? cacheKeys.streamToolcall(sessionId) : null) ?? null;
	const planMode = useCacheValue<boolean>(sessionId ? cacheKeys.planMode(sessionId) : null) ?? false;
	const tokenWarning = useCacheValue<TokenWarning>(sessionId ? cacheKeys.tokenWarning(sessionId) : null) ?? null;
	return { text, thinking, toolcall, planMode, tokenWarning };
}
