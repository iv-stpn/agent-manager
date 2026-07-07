/**
 * Discord communication via api.
 * Replaces direct discord.js usage — all Discord interactions are routed
 * through the global bot running in the api process.
 */

import { env } from "../env";
import { orchestratorHeaders } from "./orchestrator";

const ORCHESTRATOR_API_URL = env.ORCHESTRATOR_API_URL;
const PROJECT_ID = env.PROJECT_ID;

export interface ReportData {
	title: string;
	sections: Array<{ title?: string; content: string }>;
	mermaid_diagrams?: Array<{ title?: string; definition: string }>;
}

export interface CheckinFormResult {
	answers: Array<{ questionId: string; answer: string }>;
	confirmed: boolean;
}

interface QuestionOption {
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
	signal?: AbortSignal
): Promise<CheckinFormResult | null> {
	const res = await fetch(`${ORCHESTRATOR_API_URL}/api/projects/${PROJECT_ID}/discord/report`, {
		method: "POST",
		headers: orchestratorHeaders({ "Content-Type": "application/json" }),
		body: JSON.stringify({ sessionId, report, trigger, awaiting }),
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
		headers: orchestratorHeaders({ "Content-Type": "application/json" }),
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
