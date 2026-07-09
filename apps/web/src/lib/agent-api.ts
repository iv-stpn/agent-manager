// Typed API client for orchestrator API. All HTTP calls go through the hono/client
// RPC layer — response shapes are inferred from the server's route definitions.
// SSE streams connect directly to the agent server port to avoid proxy buffering.

import type { AppType, Guideline, GuidelineCategory, LlmClient, TechStack, WorkspaceFolderStatus } from "@agent-manager/api";

export type { Guideline, GuidelineCategory, LlmClient, LlmProvider, StackEntry, TechStack } from "@agent-manager/api";
export type {
	CheckinRecord as Checkin,
	CompactionRecord as Compaction,
	MessageRecord as Message,
	QuestionRecord as Question,
	ReportRecord as Report,
	SessionRecord as Session,
	ToolCallRecord as ToolCall,
} from "@agent-manager/projects";
export type { EnrichedProject } from "@/lib/types";

import type { CreateProjectInput, ProjectConfig, SessionRecord as Session } from "@agent-manager/projects";
import { hc } from "hono/client";
import { API_URL } from "@/constants";
import { authHeaders } from "@/lib/auth";
import { readSSEStream } from "@/lib/sse";

// `headers` is evaluated per request, so a token configured at build time is
// attached to every hono-client call. Empty object when no token is set.
const api = hc<AppType>(API_URL, { headers: authHeaders });

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

export async function checkWorkspacePath(path: string): Promise<{ status: WorkspaceFolderStatus; path: string }> {
	const res = await api.api.projects["check-path"].$post({ json: { path } });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
}

export interface CreateProjectStreamHandlers {
	onStep?: (step: string, status: "running" | "done" | "error", log?: string) => void;
	onLine?: (step: string, line: string) => void;
}

/**
 * Create a project, streaming workspace-setup progress (cloning,
 * installing dependencies, etc.) as it happens. Raw `fetch` + manual SSE
 * parsing rather than the hono client / `EventSource`: the request body can
 * carry an LLM API key, which can't go in a GET query string.
 */
export async function createProjectStream(
	data: CreateProjectInput,
	handlers: CreateProjectStreamHandlers = {}
): Promise<ProjectConfig> {
	const res = await fetch(`${API_URL}/api/projects/create-stream`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify(data),
	});
	if (!res.ok) throw new Error(`API responded with ${res.status}`);

	let result: { success: boolean; error?: string; project?: ProjectConfig } | null = null;
	await readSSEStream(res, (event, raw) => {
		try {
			const parsed = JSON.parse(raw);
			if (event === "progress") handlers.onStep?.(parsed.step, parsed.status, parsed.log);
			else if (event === "delta") handlers.onLine?.(parsed.step, parsed.line);
			else if (event === "complete") result = parsed;
		} catch {
			// ignore malformed frame
		}
	});

	if (!result) throw new Error("Stream ended without a completion event");
	const { success, error, project } = result as { success: boolean; error?: string; project?: ProjectConfig };
	if (!success || !project) throw new Error(error || "Failed to create project");
	return project;
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
		agent?: { clientId?: string; anthropicApiKey?: string; anthropicBaseUrl?: string; model?: string };
	}
) {
	const req = { param: { projectId }, json: data };
	const res = await api.api.projects[":projectId"].settings.$put(req);
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()).project;
}

// ── Project context (tech stacks / guidelines / instructions) ──────────────────

export type ProjectContext = {
	techStackIds: string[];
	guidelineIds: string[];
	instructions: string;
};

export async function getProjectContext(projectId: string): Promise<ProjectContext> {
	const res = await api.api.projects[":projectId"].context.$get({ param: { projectId } });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()).context;
}

export async function updateProjectContext(projectId: string, data: ProjectContext): Promise<ProjectContext> {
	const req = { param: { projectId }, json: data };
	const res = await api.api.projects[":projectId"].context.$put(req);
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()).context;
}

// ── Session endpoints ─────────────────────────────────────────────────────────

export async function getSessions(projectId: string) {
	const res = await api.api.projects[":projectId"].sessions.$get({ param: { projectId } });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
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
	return await res.json();
}

export async function getMessages(projectId: string, id: string) {
	const res = await api.api.projects[":projectId"].sessions[":sessionId"].messages.$get({
		param: { projectId, sessionId: id },
	});
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
}

export async function getToolCalls(projectId: string, id: string) {
	const res = await api.api.projects[":projectId"].sessions[":sessionId"].tools.$get({
		param: { projectId, sessionId: id },
	});
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
}

export async function getCheckins(projectId: string, id: string) {
	const res = await api.api.projects[":projectId"].sessions[":sessionId"].checkins.$get({
		param: { projectId, sessionId: id },
	});
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
}

export async function getQuestions(projectId: string, id: string) {
	const res = await api.api.projects[":projectId"].sessions[":sessionId"].questions.$get({
		param: { projectId, sessionId: id },
	});
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
}

export async function getCompactions(projectId: string, id: string) {
	const res = await api.api.projects[":projectId"].sessions[":sessionId"].compactions.$get({
		param: { projectId, sessionId: id },
	});
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
}

export interface Task {
	id: string;
	sessionId: string | null;
	text: string;
	status: "pending" | "in_progress" | "done" | "cancelled";
	metadata: string | null;
	archived: boolean;
	createdAt: number;
	updatedAt: number;
}

export async function getTasks(projectId: string, sessionId?: string): Promise<Task[]> {
	const params = sessionId ? `?sessionId=${sessionId}` : "";
	const res = await fetch(`${API_URL}/api/projects/${projectId}/tasks${params}`, { headers: authHeaders() });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as Task[];
}

export async function updateTask(
	projectId: string,
	taskId: string,
	changes: { text?: string; status?: Task["status"] }
): Promise<Task> {
	const res = await fetch(`${API_URL}/api/projects/${projectId}/tasks/${taskId}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify(changes),
	});
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()) as Task;
}

export async function deleteTask(projectId: string, taskId: string): Promise<void> {
	const res = await fetch(`${API_URL}/api/projects/${projectId}/tasks/${taskId}`, {
		method: "DELETE",
		headers: authHeaders(),
	});
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
}

// ── Archive toggles ───────────────────────────────────────────────────────────
// Flip the UI-only `archived` flag on a task / session / report. Written straight
// to the project DB by the orchestrator, so they work whether or not the container
// is running.

async function postArchive(path: string, archived: boolean): Promise<void> {
	const res = await fetch(`${API_URL}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify({ archived }),
	});
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
}

export function archiveTask(projectId: string, taskId: string, archived: boolean): Promise<void> {
	return postArchive(`/api/projects/${projectId}/tasks/${taskId}/archive`, archived);
}

export function archiveSession(projectId: string, sessionId: string, archived: boolean): Promise<void> {
	return postArchive(`/api/projects/${projectId}/sessions/${sessionId}/archive`, archived);
}

export function archiveReport(projectId: string, reportId: string, archived: boolean): Promise<void> {
	return postArchive(`/api/projects/${projectId}/reports/${reportId}/archive`, archived);
}

// Bulk "archive finished" actions. Each archives every finished-but-not-yet-archived
// row in one server-side DB write and returns how many were archived.
async function postArchiveFinished(path: string): Promise<number> {
	const res = await fetch(`${API_URL}${path}`, { method: "POST", headers: authHeaders() });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return ((await res.json()) as { count: number }).count;
}

export function archiveFinishedTasks(projectId: string): Promise<number> {
	return postArchiveFinished(`/api/projects/${projectId}/tasks/archive-finished`);
}

export function archiveFinishedSessions(projectId: string): Promise<number> {
	return postArchiveFinished(`/api/projects/${projectId}/sessions/archive-finished`);
}

export function archiveFinishedSessionReports(projectId: string): Promise<number> {
	return postArchiveFinished(`/api/projects/${projectId}/reports/archive-finished`);
}

export async function createSession(
	projectId: string,
	data: {
		task: string;
		reportIntervalMins?: number;
		stopThresholdMins?: number;
		awaitReportMode?: "always" | "never" | "custom";
		awaitReportCustomRule?: string;
		awaitAskMode?: "always" | "requiredOnly" | "onReportOnly" | "never";
		compactThresholdTokens?: number;
		stopThresholdTokens?: number;
		alwaysImproveMode?: "yes" | "no" | "custom";
		alwaysImproveScope?: string;
	}
) {
	const req = { param: { projectId }, json: data };
	const res = await api.api.projects[":projectId"].sessions.$post(req);
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
}

export async function stopSession(projectId: string, id: string): Promise<void> {
	await api.api.projects[":projectId"].sessions[":sessionId"].stop.$post({
		param: { projectId, sessionId: id },
	});
}

/** Graceful stop: the agent finishes its current message (no abort), then stops. */
export async function pauseSession(projectId: string, id: string): Promise<void> {
	await api.api.projects[":projectId"].sessions[":sessionId"].pause.$post({
		param: { projectId, sessionId: id },
	});
}

export async function restartSession(projectId: string, id: string): Promise<void> {
	await api.api.projects[":projectId"].sessions[":sessionId"].restart.$post({
		param: { projectId, sessionId: id },
	});
}

export async function sendSessionMessage(projectId: string, id: string, message: string): Promise<void> {
	const req = { param: { projectId, sessionId: id }, json: { message } };
	const res = await api.api.projects[":projectId"].sessions[":sessionId"].message.$post(req);
	if (!res.ok) throw new Error(`Failed to send message (${res.status})`);
}

export interface SessionSettingsInput {
	name?: string;
	reportIntervalMins?: number;
	stopThresholdMins?: number;
	awaitReportMode?: "always" | "never" | "custom";
	awaitReportCustomRule?: string | null;
	awaitAskMode?: "always" | "requiredOnly" | "onReportOnly" | "never";
	compactThresholdTokens?: number;
	stopThresholdTokens?: number;
	alwaysImproveMode?: "yes" | "no" | "custom";
	alwaysImproveScope?: string | null;
}

export async function updateSessionSettings(projectId: string, id: string, data: SessionSettingsInput): Promise<Session> {
	const req = { param: { projectId, sessionId: id }, json: data };
	const res = await api.api.projects[":projectId"].sessions[":sessionId"].settings.$put(req);
	if (!res.ok) {
		// A 404 here means the *agent container's* own DB doesn't have this session —
		// distinct from the session having failed to load in the first place (that read
		// goes straight to the project's DB file, not through the container). Surface it
		// as such so the UI can prompt a refresh instead of a bare status code.
		if (res.status === 404) throw new Error("Session not found on the running agent — try refreshing the page.");
		throw new Error(`API responded with ${res.status}`);
	}
	return (await res.json()) as Session;
}

// ── Tech stack endpoints ────────────────────────────────────────────────────

export async function getTechStacks(): Promise<TechStack[]> {
	const res = await api.api["tech-stacks"].$get();
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
}

export async function createTechStack(data: Omit<TechStack, "id" | "createdAt" | "updatedAt">): Promise<TechStack> {
	const res = await api.api["tech-stacks"].$post({ json: data });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
}

export async function updateTechStack(id: string, data: Partial<Omit<TechStack, "id" | "createdAt">>): Promise<TechStack> {
	const res = await api.api["tech-stacks"][":id"].$put({ param: { id }, json: data });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
}

export async function deleteTechStack(id: string): Promise<void> {
	const res = await api.api["tech-stacks"][":id"].$delete({ param: { id } });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
}

// ── Guideline category endpoints ────────────────────────────────────────────

export async function getGuidelineCategories(): Promise<GuidelineCategory[]> {
	const res = await api.api["guideline-categories"].$get();
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
}

export async function createGuidelineCategory(
	data: Omit<GuidelineCategory, "id" | "createdAt" | "updatedAt">
): Promise<GuidelineCategory> {
	const res = await api.api["guideline-categories"].$post({ json: data });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
}

export async function updateGuidelineCategory(
	id: string,
	data: Partial<Omit<GuidelineCategory, "id" | "createdAt">>
): Promise<GuidelineCategory> {
	const res = await api.api["guideline-categories"][":id"].$put({ param: { id }, json: data });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
}

export async function deleteGuidelineCategory(id: string): Promise<void> {
	const res = await api.api["guideline-categories"][":id"].$delete({ param: { id } });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
}

// ── Guideline endpoints ─────────────────────────────────────────────────────

export async function getGuidelines(): Promise<Guideline[]> {
	const res = await api.api.guidelines.$get();
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
}

export async function createGuideline(data: Omit<Guideline, "id" | "createdAt" | "updatedAt">): Promise<Guideline> {
	const res = await api.api.guidelines.$post({ json: data });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
}

export async function updateGuideline(id: string, data: Partial<Omit<Guideline, "id" | "createdAt">>): Promise<Guideline> {
	const res = await api.api.guidelines[":id"].$put({ param: { id }, json: data });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
}

export async function deleteGuideline(id: string): Promise<void> {
	const res = await api.api.guidelines[":id"].$delete({ param: { id } });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
}

// ── LLM Client endpoints ────────────────────────────────────────────────────

export async function getLlmClients(): Promise<LlmClient[]> {
	const res = await api.api["llm-clients"].$get();
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
}

export async function createLlmClient(data: Omit<LlmClient, "id" | "createdAt" | "updatedAt">): Promise<LlmClient> {
	const res = await api.api["llm-clients"].$post({ json: data });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
}

export async function updateLlmClient(id: string, data: Partial<Omit<LlmClient, "id" | "createdAt">>): Promise<LlmClient> {
	const res = await api.api["llm-clients"][":id"].$put({ param: { id }, json: data });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return await res.json();
}

export async function deleteLlmClient(id: string): Promise<void> {
	const res = await api.api["llm-clients"][":id"].$delete({ param: { id } });
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
}

// ── Templates endpoints ──────────────────────────────────────────────────────

export interface LocalTemplate {
	name: string;
	path: string;
	description: string;
	techStackIds: string[];
	techStackNames: string[];
	createdAt: string;
}

export async function getTemplates(): Promise<LocalTemplate[]> {
	const res = await api.api.templates.$get();
	if (!res.ok) throw new Error(`API responded with ${res.status}`);
	return (await res.json()).templates;
}

// ── Workspace files endpoints ─────────────────────────────────────────────────
// The live file browser/editor. These proxy straight through the orchestrator to
// the agent container (they read/write the real /workspace on disk), so they only
// work while the project is running. Raw `fetch` — the responses are loosely typed
// proxy passthroughs, and the content path carries the file body in a JSON body.

export interface WorkspaceTree {
	/** Flat list of every editable path (honours .gitignore). */
	paths: string[];
	/** True when the workspace exceeded the server-side entry cap. */
	truncated: boolean;
}

export interface WorkspaceFile {
	path: string;
	/** File text, or null when the file is binary or too large to edit. */
	content: string | null;
	binary: boolean;
	tooLarge: boolean;
	size: number;
}

/** Pull the orchestrator's `{ error }` body out of a failed file-route response. */
async function fileError(res: Response, fallback: string): Promise<never> {
	const body = (await res.json().catch(() => null)) as { error?: string } | null;
	throw new Error(body?.error || fallback);
}

export async function getWorkspaceTree(projectId: string, signal?: AbortSignal): Promise<WorkspaceTree> {
	const res = await fetch(`${API_URL}/api/projects/${projectId}/files/tree`, {
		headers: authHeaders(),
		...(signal ? { signal } : {}),
	});
	if (!res.ok) return fileError(res, `API responded with ${res.status}`);
	return (await res.json()) as WorkspaceTree;
}

export async function getWorkspaceFile(projectId: string, path: string, signal?: AbortSignal): Promise<WorkspaceFile> {
	const res = await fetch(`${API_URL}/api/projects/${projectId}/files/content?path=${encodeURIComponent(path)}`, {
		headers: authHeaders(),
		...(signal ? { signal } : {}),
	});
	if (!res.ok) return fileError(res, `Could not open ${path}`);
	return (await res.json()) as WorkspaceFile;
}

export async function saveWorkspaceFile(projectId: string, path: string, content: string): Promise<void> {
	const res = await fetch(`${API_URL}/api/projects/${projectId}/files/content?path=${encodeURIComponent(path)}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify({ content }),
	});
	if (!res.ok) await fileError(res, `Could not save ${path}`);
}

export async function createWorkspaceEntry(projectId: string, path: string, type: "file" | "directory"): Promise<void> {
	const res = await fetch(`${API_URL}/api/projects/${projectId}/files/entry`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify({ path, type }),
	});
	if (!res.ok) await fileError(res, `Could not create ${path}`);
}

export async function moveWorkspaceEntry(projectId: string, from: string, to: string): Promise<void> {
	const res = await fetch(`${API_URL}/api/projects/${projectId}/files/move`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify({ from, to }),
	});
	if (!res.ok) await fileError(res, `Could not move ${from}`);
}

export async function deleteWorkspaceEntry(projectId: string, path: string): Promise<void> {
	const res = await fetch(`${API_URL}/api/projects/${projectId}/files/entry?path=${encodeURIComponent(path)}`, {
		method: "DELETE",
		headers: authHeaders(),
	});
	if (!res.ok) await fileError(res, `Could not delete ${path}`);
}
