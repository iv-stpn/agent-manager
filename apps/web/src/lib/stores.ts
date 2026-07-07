// Global stores — the single source of truth for live project/session state.
//
// The problem this solves: several screens (home page, sidebar, project page,
// session page) each used to open their OWN SSE connection and fold events into
// the shared query cache independently. Two orchestrator streams both incrementing
// `stats.sessions` on the same `session_created` event double-counted; every
// screen carried its own divergent copy of the folding logic; and the same
// event could be applied twice or not at all depending on what was mounted.
//
// Here instead there is exactly ONE connection per resource (one orchestrator stream,
// one per running project, one per open session), ref-counted so it stays open
// while any screen needs it and closes when the last unmounts. All event→cache
// folding lives in one place, so the cache is authoritative and every screen
// that reads a given key sees identical state.
//
// Screens still use `useQuery` for the initial fetch (loading/error UI); the
// stores own every live update thereafter, and re-sync on (re)connect.

import { createProjectStream, createSessionStream, replaceOrPrependById, upsertById } from "@agent-manager/utils";
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

// ── Orchestratorstream ──────────────────────────────────────────────────────────────
// One connection for the whole app, feeding the `"projects"` list that the
// home page, sidebar, and statistics page all read.

const acquireHostStream = connectionManager(() => {
	const patch = (projectId: string, fn: (project: EnrichedProject) => EnrichedProject) =>
		mutateCache<EnrichedProject[]>(cacheKeys.projects, (list) =>
			list.map((project) => (project.id === projectId ? fn(project) : project))
		);

	const eventSource = createHostStream<EnrichedProject>(
		(type, { projectId, data }) => {
			if (type === "project_status") {
				const running = Boolean((data as { running?: boolean }).running);
				patch(projectId, (project) => ({ ...project, dockerStatus: { ...project.dockerStatus, running } }));
			} else if (type === "session_created") {
				patch(projectId, (project) => ({ ...project, stats: { ...project.stats, sessions: project.stats.sessions + 1 } }));
			} else if (type === "message") {
				patch(projectId, (project) => ({ ...project, stats: { ...project.stats, messages: project.stats.messages + 1 } }));
			}
		},
		(snapshot) => setCache(cacheKeys.projects, snapshot)
	);
	return () => eventSource.close();
});

// ── Project stream ───────────────────────────────────────────────────────────
// One connection per running project. Feeds the sessions list, the reports
// list, the project's live stats, and the running indicator.

const acquireProjectStream = connectionManager((_key: string, projectId: string, port: number) => {
	const projectKey = cacheKeys.project(projectId);
	const sessionKey = cacheKeys.sessions(projectId);
	const reportKey = cacheKeys.reports(projectId);
	const tkKey = cacheKeys.tasks(projectId);

	const setRunning = (running: boolean) =>
		mutateCache<EnrichedProject>(projectKey, (project) => ({ ...project, dockerStatus: { ...project.dockerStatus, running } }));

	const eventSource = createProjectStream((event) => {
		if (event.type === "sessions") {
			setCache(sessionKey, event.data);
			mutateCache<EnrichedProject>(projectKey, (project) => ({
				...project,
				stats: { ...project.stats, sessions: event.data.length },
			}));
		} else if (event.type === "session_created") {
			mutateCache<Session[]>(sessionKey, (previous) => replaceOrPrependById(previous, event.data));
			mutateCache<EnrichedProject>(projectKey, (project) => ({
				...project,
				stats: { ...project.stats, sessions: project.stats.sessions + 1 },
			}));
		} else if (event.type === "session_updated" || event.type === "token_update") {
			mutateCache<Session[]>(sessionKey, (previous) =>
				previous.map((session) => (session.id === event.data.sessionId ? { ...session, ...event.data } : session))
			);
		} else if (event.type === "message") {
			mutateCache<EnrichedProject>(projectKey, (project) => ({
				...project,
				stats: { ...project.stats, messages: project.stats.messages + 1 },
			}));
		} else if (event.type === "checkin_started" || event.type === "checkin_completed") {
			const data = event.data;
			const session = (getCache<Session[]>(sessionKey) ?? []).find((session) => session.id === data.sessionId);

			const confirmed = event.type === "checkin_completed";
			const report: Report = {
				id: data.id,
				sessionId: data.sessionId,
				trigger: data.trigger,
				summary: data.summary ?? "",
				discordMessageId: data.discordMessageId ?? null,
				status: confirmed ? "answered" : "pending",
				createdAt: data.createdAt,
				completedAt: confirmed ? Date.now() : null,
				sessionName: session?.name ?? null,
				sessionTask: session?.task ?? "",
			};

			mutateCache<Report[]>(reportKey, (previous) => {
				const next = previous.filter((previousReport) => previousReport.id !== report.id);
				next.push(report);
				return next.sort((report1, report2) => report2.createdAt - report1.createdAt);
			});
		} else if (event.type === "task_created") {
			const task = event.data as Task;
			mutateCache<Task[]>(tkKey, (previous = []) =>
				previous.some((previousTask) => previousTask.id === task.id) ? previous : [...previous, task]
			);
		} else if (event.type === "task_updated") {
			const task = event.data as Task;
			mutateCache<Task[]>(tkKey, (previous = []) => upsertById(previous, task));
		}
	}, port);

	eventSource.onopen = () => {
		setRunning(true);
		// Re-sync anything that changed while disconnected. `setCache` seeds or
		// replaces regardless of whether the initial fetch has landed.
		void getSessions(projectId)
			.then((data) => setCache(sessionKey, data))
			.catch(() => {});
		void getReports(projectId)
			.then((data) => setCache(reportKey, data))
			.catch(() => {});
		void getTasks(projectId)
			.then((data) => setCache(tkKey, data))
			.catch(() => {});
	};
	eventSource.onerror = () => {
		// The browser auto-reconnects on a transient drop (readyState → CONNECTING).
		// Only treat this as "the project stopped" once it has given up (CLOSED).
		if (eventSource.readyState === EventSource.CLOSED) setRunning(false);
	};

	return () => eventSource.close();
});

// ── Session stream ───────────────────────────────────────────────────────────
// One connection per open session. Owns every per-session cache (messages,
// tools, check-ins, questions, compactions, the session record itself) plus
// the ephemeral live-streaming state, and drives session-scoped toasts. Tasks
// are project-wide (cross-session), so they're owned by the project stream
// instead — see acquireProjectStream.

const acquireSessionStream = connectionManager((_key: string, sessionId: string, projectId: string, port: number) => {
	const sKey = cacheKeys.session(projectId, sessionId);
	const mKey = cacheKeys.messages(projectId, sessionId);
	const tKey = cacheKeys.tools(projectId, sessionId);
	const cKey = cacheKeys.checkins(projectId, sessionId);
	const qKey = cacheKeys.questions(projectId, sessionId);
	const xKey = cacheKeys.compactions(projectId, sessionId);
	const rKey = cacheKeys.project(projectId);

	const eventSource = createSessionStream(
		sessionId,
		(event) => {
			if (event.type === "turn_start") {
				// Clear all live-streaming buffers, not just thinking/toolcall. The
				// max_tokens escalation re-emits turn_start before re-streaming the
				// whole response at the higher limit; without resetting streamText the
				// truncated first attempt's text would be duplicated ahead of the retry.
				updateCache(cacheKeys.streamText(sessionId), () => "");
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
				mutateCache<Session>(sKey, (session) => (session ? { ...session, ...event.data } : session));
			} else if (event.type === "message") {
				if ((event.data as { role?: string }).role === "assistant") {
					updateCache(cacheKeys.streamText(sessionId), () => "");
					updateCache(cacheKeys.streamThinking(sessionId), () => "");
					updateCache<StreamingToolcall | null>(cacheKeys.streamToolcall(sessionId), () => null);
				}
				mutateCache<Message[]>(mKey, (previous = []) =>
					previous.some((message) => message.id === event.data.id) ? previous : [...previous, event.data]
				);
			} else if (event.type === "tool_call") {
				mutateCache<ToolCall[]>(tKey, (previous = []) => upsertById(previous, event.data));
			} else if (event.type === "token_update") {
				mutateCache<Session>(sKey, (session) =>
					session
						? {
								...session,
								totalInputTokens: event.data.totalInputTokens,
								totalOutputTokens: event.data.totalOutputTokens,
								totalCacheReadTokens: event.data.totalCacheReadTokens,
								totalCacheWriteTokens: event.data.totalCacheWriteTokens,
								tokensInputSinceCompaction: event.data.tokensInputSinceCompaction,
								tokensOutputSinceCompaction: event.data.tokensOutputSinceCompaction,
								tokensCacheReadSinceCompaction: event.data.tokensCacheReadSinceCompaction,
								tokensCacheWriteSinceCompaction: event.data.tokensCacheWriteSinceCompaction,
								contextTokens: event.data.contextTokens,
							}
						: session
				);
			} else if (event.type === "checkin_started" || event.type === "checkin_completed") {
				const payload = event.data;

				mutateCache<Checkin[]>(cKey, (previous = []) => upsertById(previous, payload));
				if ("questions" in payload && payload.questions?.length) {
					mutateCache<Question[]>(qKey, (previous = []) => {
						const byId = new Map(previous.map((question) => [question.id, question]));
						for (const q of payload.questions) byId.set(q.id, { ...byId.get(q.id), ...q });
						return [...byId.values()];
					});
				}
			} else if (event.type === "compaction") {
				mutateCache<Compaction[]>(xKey, (previous = []) =>
					previous.some((compaction) => compaction.id === event.data.id) ? previous : [...previous, event.data]
				);
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
				const waitSec = Math.round(event.data.nextRetryMs / 1000);
				const attemptLabel = event.data.maxAttempts
					? `#${event.data.attempt} of ${event.data.maxAttempts}`
					: `#${event.data.attempt}`;
				if (event.data.category === "server_crash") {
					// A crashed backend reboots on a multi-minute timescale, so keep the
					// toast up for the whole wait (with a little slack) instead of the
					// default few seconds — otherwise it vanishes long before the retry.
					const waitLabel = waitSec >= 60 ? `${Math.round(waitSec / 60)}m` : `${waitSec}s`;
					toast.warning(`LLM server crashed — waiting ${waitLabel} before retry ${attemptLabel}`, {
						id: `server-crash-${sessionId}`,
						duration: event.data.nextRetryMs + 10_000,
					});
				} else {
					toast.info(`API retry ${attemptLabel}: ${event.data.error} (retrying in ${waitSec}s)`);
				}
			}
		},
		port
	);

	eventSource.onopen = () => {
		// Re-sync every per-session cache on (re)connect so nothing missed while
		// disconnected is lost. `setCache` seeds or replaces regardless of the
		// initial `useQuery` fetch.
		void getSession(projectId, sessionId)
			.then((data) => setCache(sKey, data))
			.catch(() => {});
		void getMessages(projectId, sessionId)
			.then((data) => setCache(mKey, data))
			.catch(() => {});
		void getToolCalls(projectId, sessionId)
			.then((data) => setCache(tKey, data))
			.catch(() => {});
		void getCheckins(projectId, sessionId)
			.then((data) => setCache(cKey, data))
			.catch(() => {});
		void getQuestions(projectId, sessionId)
			.then((data) => setCache(qKey, data))
			.catch(() => {});
		void getCompactions(projectId, sessionId)
			.then((data) => setCache(xKey, data))
			.catch(() => {});
	};

	eventSource.onerror = () => {
		// This cache key is shared with the project page's running-gated stream;
		// only mark stopped once the browser has fully given up (CLOSED).
		if (eventSource.readyState === EventSource.CLOSED) {
			mutateCache<EnrichedProject>(rKey, (project) =>
				project ? { ...project, dockerStatus: { ...project.dockerStatus, running: false } } : project
			);
		}
	};

	return () => eventSource.close();
});

// ── React hooks ────────────────────────────────────────────────────────────────
// Each hook acquires its resource's shared connection for the lifetime of the
// component, and reads store-owned state out of the cache. Mounting the same
// hook in several places reuses one connection (ref-counted above).

/**
 * Keep the orchestrator `"projects"` stream connected while mounted. Any screen that
 * reads the projects list (home, sidebar, statistics) calls this; they share a
 * single upstream connection and therefore a single, consistent fold.
 */
export function useOrchestratorSSE(): void {
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
