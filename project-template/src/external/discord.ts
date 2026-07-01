/**
 * Discord communication via api.
 * Replaces direct discord.js usage — all Discord interactions are routed
 * through the global bot running in the api process.
 */

import { env } from "../env";

const ORCHESTRATOR_API_URL = env.ORCHESTRATOR_API_URL;
const PROJECT_ID = env.PROJECT_ID;

export interface ReportData {
	title: string;
	sections: Array<{ title?: string; content: string }>;
	mermaid_diagrams?: Array<{ title?: string; definition: string }>;
}

export interface Question {
	id: string;
	text: string;
	context?: string | null;
	suggestions?: string | null;
}

export interface CheckinFormResult {
	answers: Array<{ questionId: string; answer: string }>;
	confirmed: boolean;
}

export interface QuestionOption {
	label: string;
	description: string;
}

export interface QuestionItem {
	question: string;
	header: string;
	options: QuestionOption[];
	multiSelect?: boolean;
}

export interface ChecklistResult {
	answers: Record<string, string>;
	completed: boolean;
}

/**
 * Send a report to Discord via api. If awaiting=true, waits for user response.
 */
export async function sendReport(
	sessionId: string,
	report: ReportData,
	trigger: string,
	awaiting: boolean,
	pendingQuestions: Question[],
	signal?: AbortSignal
): Promise<CheckinFormResult | null> {
	const res = await fetch(`${ORCHESTRATOR_API_URL}/api/projects/${PROJECT_ID}/discord/report`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ sessionId, report, trigger, awaiting, pendingQuestions }),
		signal: signal ?? null,
	});
	if (!res.ok) {
		const errorText = await res.text().catch(() => "Unknown error");
		throw new Error(`Discord report failed (${res.status}): ${errorText}`);
	}
	const data = (await res.json()) as CheckinFormResult;
	return data;
}

/**
 * Send questions to Discord via api and wait for responses.
 */
export async function sendQuestions(
	sessionId: string,
	title: string,
	questions: QuestionItem[],
	urgent?: boolean,
	signal?: AbortSignal
): Promise<ChecklistResult> {
	const res = await fetch(`${ORCHESTRATOR_API_URL}/api/projects/${PROJECT_ID}/discord/questions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ sessionId, title, questions, urgent: urgent ?? false }),
		signal: signal ?? null,
	});
	if (!res.ok) {
		const errorText = await res.text().catch(() => "Unknown error");
		throw new Error(`Discord questions failed (${res.status}): ${errorText}`);
	}
	const data = (await res.json()) as { answers: Record<string, string> };
	return { answers: data.answers, completed: Object.keys(data.answers).length > 0 };
}

/**
 * Send a plain message to the session's Discord channel.
 */
export async function sendMessage(sessionId: string, content: string): Promise<void> {
	const res = await fetch(`${ORCHESTRATOR_API_URL}/api/projects/${PROJECT_ID}/discord/message`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ sessionId, content }),
	});
	if (!res.ok) {
		const errorText = await res.text().catch(() => "Unknown error");
		throw new Error(`Discord message failed (${res.status}): ${errorText}`);
	}
}

/**
 * Send a rendered Mermaid graph (PNG buffer) to the session's Discord channel.
 */
export async function sendGraph(sessionId: string, png: Buffer, title?: string): Promise<void> {
	const formData = new FormData();
	formData.append("sessionId", sessionId);
	if (title) formData.append("title", title);
	formData.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "graph.png");

	const res = await fetch(`${ORCHESTRATOR_API_URL}/api/projects/${PROJECT_ID}/discord/graph`, {
		method: "POST",
		body: formData,
	});
	if (!res.ok) {
		const errorText = await res.text().catch(() => "Unknown error");
		throw new Error(`Discord graph upload failed (${res.status}): ${errorText}`);
	}
}
