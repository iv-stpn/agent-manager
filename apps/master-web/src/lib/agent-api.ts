// Typed API client for master-api. All HTTP calls go through the hono/client
// RPC layer — response shapes are inferred from the server's route definitions.
// SSE streams connect directly to the agent server port to avoid proxy buffering.

import type { AppType } from "@agent-manager/master-api";
import type { CheckinRecord, CompactionRecord, CreateProjectInput, MessageRecord, QuestionRecord, SessionRecord, Template, ToolCallRecord } from "@agent-manager/projects";
import { PROJECT_STREAM_EVENTS, SESSION_STREAM_EVENTS, createEventStream } from "@agent-manager/utils";
import type { ProjectStreamEvent, SessionStreamEvent } from "@agent-manager/utils";
import { hc } from "hono/client";

export type {
	EnrichedProject,
	ProjectDockerStatus,
	ProjectDockerContainer,
	ProjectStats,
	ProjectConfig,
	DiscordConfig,
	AgentConfig,
} from "./types";
export type {
	SessionRecord as Session,
	MessageRecord as Message,
	ToolCallRecord as ToolCall,
	CheckinRecord as Checkin,
	QuestionRecord as Question,
	ReportRecord as Report,
	CompactionRecord as Compaction,
	Template,
} from "@agent-manager/projects";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3100";
const api = hc<AppType>(API_URL);

// ── Project endpoints ─────────────────────────────────────────────────────────

export async function getProjects(signal?: AbortSignal) {
	const res = await api.api.projects.$get(signal ? { init: { signal } } : {});
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()).projects;
}

export async function getProject(projectId: string, signal?: AbortSignal) {
	const res = await api.api.projects[":projectId"].$get({
		param: { projectId },
		...(signal ? { init: { signal } } : {}),
	});
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()).project;
}

export async function createProject(data: CreateProjectInput) {
	const res = await api.api.projects.$post({ json: data });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()).project;
}

export async function startProject(projectId: string) {
	const res = await api.api.projects[":projectId"].start.$post({ param: { projectId } });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
}

export async function stopProject(projectId: string) {
	const res = await api.api.projects[":projectId"].stop.$post({ param: { projectId } });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
}

export async function restartProject(projectId: string) {
	const res = await api.api.projects[":projectId"].restart.$post({ param: { projectId } });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
}

export async function deleteProject(projectId: string) {
	const res = await api.api.projects[":projectId"].$delete({ param: { projectId } });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
}

export async function getLogs(projectId: string, service?: string) {
	const req = { param: { projectId }, query: service ? { service } : {} };
	const res = await api.api.projects[":projectId"].logs.$get(req);
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()).logs;
}

export async function updateSettings(
	projectId: string,
	data: {
		discord?: { token?: string; defaultChannelId?: string };
		agent?: { anthropicApiKey?: string; anthropicBaseUrl?: string; model?: string };
	}
) {
	const req = { param: { projectId }, json: data };
	const res = await api.api.projects[":projectId"].settings.$put(req);
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()).project;
}

// ── Session endpoints ─────────────────────────────────────────────────────────

export async function getSessions(projectId: string) {
	const res = await api.api.projects[":projectId"].sessions.$get({ param: { projectId } });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as SessionRecord[];
}

export async function getReports(projectId: string) {
	const res = await api.api.projects[":projectId"].reports.$get({ param: { projectId } });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return res.json();
}

export async function getSession(projectId: string, id: string) {
	const res = await api.api.projects[":projectId"].sessions[":sessionId"].$get({
		param: { projectId, sessionId: id },
	});
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as SessionRecord;
}

export async function getMessages(projectId: string, id: string) {
	const res = await api.api.projects[":projectId"].sessions[":sessionId"].messages.$get({
		param: { projectId, sessionId: id },
	});
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as MessageRecord[];
}

export async function getToolCalls(projectId: string, id: string) {
	const res = await api.api.projects[":projectId"].sessions[":sessionId"].tools.$get({
		param: { projectId, sessionId: id },
	});
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as ToolCallRecord[];
}

export async function getCheckins(projectId: string, id: string) {
	const res = await api.api.projects[":projectId"].sessions[":sessionId"].checkins.$get({
		param: { projectId, sessionId: id },
	});
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as CheckinRecord[];
}

export async function getQuestions(projectId: string, id: string) {
	const res = await api.api.projects[":projectId"].sessions[":sessionId"].questions.$get({
		param: { projectId, sessionId: id },
	});
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as QuestionRecord[];
}

export async function getCompactions(projectId: string, id: string) {
	const res = await api.api.projects[":projectId"].sessions[":sessionId"].compactions.$get({
		param: { projectId, sessionId: id },
	});
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as CompactionRecord[];
}

export async function createSession(
	projectId: string,
	data: {
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
	}
) {
	const req = { param: { projectId }, json: data };
	const res = await api.api.projects[":projectId"].sessions.$post(req);
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as SessionRecord;
}

export async function stopSession(projectId: string, id: string): Promise<void> {
	await api.api.projects[":projectId"].sessions[":sessionId"].stop.$post({
		param: { projectId, sessionId: id },
	});
}

export async function sendSessionMessage(projectId: string, id: string, message: string): Promise<void> {
	const req = { param: { projectId, sessionId: id }, json: { message } };
	await api.api.projects[":projectId"].sessions[":sessionId"].message.$post(req);
}

// ── SSE streams (direct to agent server, bypass proxy) ───────────────────────

export function createSessionStream(
	projectId: string,
	id: string,
	onEvent: (event: SessionStreamEvent) => void,
	port: number
): EventSource {
	return createEventStream<SessionStreamEvent>(
		`http://localhost:${port}/api/sessions/${id}/stream`,
		SESSION_STREAM_EVENTS,
		onEvent,
		"session"
	);
}

export function createProjectStream(projectId: string, onEvent: (event: ProjectStreamEvent) => void, port: number): EventSource {
	return createEventStream<ProjectStreamEvent>(`http://localhost:${port}/api/stream`, PROJECT_STREAM_EVENTS, onEvent, "project");
}

export function createMasterStream(
	onEvent: (type: string, payload: { projectId: string; data: unknown }) => void,
	onSnapshot: (projects: unknown[]) => void
): EventSource {
	// Use a relative URL so the request goes through Next.js's rewrite proxy,
	// avoiding cross-origin issues with the SSE streaming response.
	const es = new EventSource(`/api/projects/events`);

	es.addEventListener("projects", (e) => {
		try {
			const parsed = JSON.parse((e as MessageEvent).data);
			console.log("[SSE:master] projects (snapshot)", parsed);
			onSnapshot(parsed);
		} catch {
			// ignore malformed snapshot
		}
	});

	const events = ["project_status", "session_created", "message"];
	for (const event of events) {
		es.addEventListener(event, (e) => {
			try {
				const parsed = JSON.parse((e as MessageEvent).data);
				console.log(`[SSE:master] ${event}`, parsed);
				onEvent(event, parsed);
			} catch {
				// ignore malformed event
			}
		});
	}

	return es;
}

// ── Template endpoints ────────────────────────────────────────────────────────

export async function getTemplates(): Promise<Template[]> {
	const res = await fetch(`${API_URL}/api/templates`);
	if (!res.ok) throw new Error(`API ${res.status}`);
	return res.json();
}

export async function createTemplate(data: Omit<Template, "id" | "createdAt" | "updatedAt">): Promise<Template> {
	const res = await fetch(`${API_URL}/api/templates`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
	if (!res.ok) throw new Error(`API ${res.status}`);
	return res.json();
}

export async function updateTemplate(id: string, data: Partial<Omit<Template, "id" | "createdAt">>): Promise<Template> {
	const res = await fetch(`${API_URL}/api/templates/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
	if (!res.ok) throw new Error(`API ${res.status}`);
	return res.json();
}

export async function deleteTemplate(id: string): Promise<void> {
	await fetch(`${API_URL}/api/templates/${id}`, { method: "DELETE" });
}
