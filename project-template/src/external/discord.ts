/**
 * Discord communication via host-api.
 * Replaces direct discord.js usage — all Discord interactions are routed
 * through the global bot running in the host-api process.
 */

import { env } from "../env";

const HOST_API_URL = env.HOST_API_URL;
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

export interface ChecklistItem {
	id: string;
	question: string;
	description?: string;
}

export interface ChecklistResult {
	answers: Record<string, string>;
	completed: boolean;
}

/**
 * Send a report to Discord via host-api. If freeze=true, waits for user response.
 */
export async function sendReport(
	sessionId: string,
	report: ReportData,
	trigger: string,
	freeze: boolean,
	pendingQuestions: Question[],
	signal?: AbortSignal
): Promise<CheckinFormResult | null> {
	try {
		const res = await fetch(`${HOST_API_URL}/api/projects/${PROJECT_ID}/discord/report`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId, report, trigger, freeze, pendingQuestions }),
			signal: signal ?? null,
		});
		if (!res.ok) return null;
		const data = (await res.json()) as CheckinFormResult;
		return data;
	} catch {
		return null;
	}
}

/**
 * Send a checklist to Discord via host-api and wait for responses.
 */
export async function sendChecklist(
	sessionId: string,
	title: string,
	items: ChecklistItem[],
	signal?: AbortSignal
): Promise<ChecklistResult> {
	try {
		const res = await fetch(`${HOST_API_URL}/api/projects/${PROJECT_ID}/discord/checklist`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId, title, items }),
			signal: signal ?? null,
		});
		if (!res.ok) return { answers: {}, completed: false };
		const data = (await res.json()) as { answers: Record<string, string> };
		return { answers: data.answers, completed: Object.keys(data.answers).length > 0 };
	} catch {
		return { answers: {}, completed: false };
	}
}

/**
 * Send a plain message to the session's Discord channel.
 */
export async function sendMessage(sessionId: string, content: string): Promise<void> {
	try {
		await fetch(`${HOST_API_URL}/api/projects/${PROJECT_ID}/discord/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId, content }),
		});
	} catch {
		// Silent failure — Discord is non-critical
	}
}

/**
 * Send a rendered Mermaid graph (PNG buffer) to the session's Discord channel.
 */
export async function sendGraph(sessionId: string, png: Buffer, title?: string): Promise<void> {
	try {
		const formData = new FormData();
		formData.append("sessionId", sessionId);
		if (title) formData.append("title", title);
		formData.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "graph.png");

		await fetch(`${HOST_API_URL}/api/projects/${PROJECT_ID}/discord/graph`, {
			method: "POST",
			body: formData,
		});
	} catch {
		// Silent failure — Discord is non-critical
	}
}
