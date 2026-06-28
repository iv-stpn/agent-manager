// Typed API client for master-api. All HTTP calls go through the hono/client
// RPC layer — response shapes are inferred from the server's route definitions.
// SSE streams connect directly to the agent server port to avoid proxy buffering.

import type { AppType } from "@agent-manager/master-api";
import type {
	CheckinRecord,
	CompactionRecord,
	CreateProjectInput,
	Guideline,
	GuidelineCategory,
	MessageRecord,
	QuestionRecord,
	SessionRecord,
	TechStack,
	Template,
	ToolCallRecord,
} from "@agent-manager/projects";
import { hc } from "hono/client";

export type {
	CheckinRecord as Checkin,
	CompactionRecord as Compaction,
	Guideline,
	GuidelineCategory,
	MessageRecord as Message,
	QuestionRecord as Question,
	ReportRecord as Report,
	SessionRecord as Session,
	StackEntry,
	StackLibrary,
	TechStack,
	Template,
	ToolCallRecord as ToolCall,
} from "@agent-manager/projects";
export type {
	AgentConfig,
	DiscordConfig,
	EnrichedProject,
	ProjectConfig,
	ProjectDockerContainer,
	ProjectDockerStatus,
	ProjectStats,
} from "./types";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3100";
const api = hc<AppType>(API_URL);

// ── Project endpoints ─────────────────────────────────────────────────────────

export async function getProjects(signal?: AbortSignal) {
	const res = await api.api.projects.$get(signal ? { init: { signal } } : {});
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()).projects;
}

export async function getProject(projectId?: string, signal?: AbortSignal) {
	if (!projectId) return null;
	const res = await api.api.projects[":projectId"].$get({
		param: { projectId },
		...(signal ? { init: { signal } } : {}),
	});
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()).project;
}

export async function checkWorkspacePath(
	path: string
): Promise<{ status: "not_found" | "empty" | "not_empty" | "not_directory"; path: string }> {
	const res = await api.api.projects["check-path"].$post({ json: { path } });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as any;
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
		name?: string;
		description?: string;
		ports?: { server?: number };
		workspace?: { path: string; type: "external" | "internal" };
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

// ── SSE streams — re-exported from @agent-manager/utils ─────────────────────

export { createMasterStream, createProjectStream, createSessionStream } from "@agent-manager/utils";

// ── Template endpoints ────────────────────────────────────────────────────────

export async function getTemplates(): Promise<Template[]> {
	const res = await api.api.templates.$get();
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as Template[];
}

export async function createTemplate(data: Omit<Template, "id" | "createdAt" | "updatedAt">): Promise<Template> {
	const res = await api.api.templates.$post({ json: data });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as Template;
}

export async function updateTemplate(id: string, data: Partial<Omit<Template, "id" | "createdAt">>): Promise<Template> {
	const res = await api.api.templates[":id"].$put({ param: { id }, json: data });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as Template;
}

export async function deleteTemplate(id: string): Promise<void> {
	const res = await api.api.templates[":id"].$delete({ param: { id } });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
}

// ── Tech stack endpoints ────────────────────────────────────────────────────

export async function getTechStacks(): Promise<TechStack[]> {
	const res = await api.api["tech-stacks"].$get();
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as TechStack[];
}

export async function createTechStack(data: Omit<TechStack, "id" | "createdAt" | "updatedAt">): Promise<TechStack> {
	const res = await api.api["tech-stacks"].$post({ json: data });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as TechStack;
}

export async function updateTechStack(id: string, data: Partial<Omit<TechStack, "id" | "createdAt">>): Promise<TechStack> {
	const res = await api.api["tech-stacks"][":id"].$put({ param: { id }, json: data });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as TechStack;
}

export async function deleteTechStack(id: string): Promise<void> {
	const res = await api.api["tech-stacks"][":id"].$delete({ param: { id } });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
}

// ── Guideline category endpoints ────────────────────────────────────────────

export async function getGuidelineCategories(): Promise<GuidelineCategory[]> {
	const res = await api.api["guideline-categories"].$get();
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as GuidelineCategory[];
}

export async function createGuidelineCategory(
	data: Omit<GuidelineCategory, "id" | "createdAt" | "updatedAt">
): Promise<GuidelineCategory> {
	const res = await api.api["guideline-categories"].$post({ json: data });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as GuidelineCategory;
}

export async function updateGuidelineCategory(
	id: string,
	data: Partial<Omit<GuidelineCategory, "id" | "createdAt">>
): Promise<GuidelineCategory> {
	const res = await api.api["guideline-categories"][":id"].$put({ param: { id }, json: data });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as GuidelineCategory;
}

export async function deleteGuidelineCategory(id: string): Promise<void> {
	const res = await api.api["guideline-categories"][":id"].$delete({ param: { id } });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
}

// ── Guideline endpoints ─────────────────────────────────────────────────────

export async function getGuidelines(): Promise<Guideline[]> {
	const res = await api.api.guidelines.$get();
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as Guideline[];
}

export async function createGuideline(data: Omit<Guideline, "id" | "createdAt" | "updatedAt">): Promise<Guideline> {
	const res = await api.api.guidelines.$post({ json: data });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as Guideline;
}

export async function updateGuideline(id: string, data: Partial<Omit<Guideline, "id" | "createdAt">>): Promise<Guideline> {
	const res = await api.api.guidelines[":id"].$put({ param: { id }, json: data });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as Guideline;
}

export async function deleteGuideline(id: string): Promise<void> {
	const res = await api.api.guidelines[":id"].$delete({ param: { id } });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
}
