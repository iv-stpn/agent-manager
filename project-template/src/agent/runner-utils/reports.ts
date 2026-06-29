import type { Checkin } from "@agent-manager/db/project-schema";
import { nanoid } from "nanoid";
import { getPendingQuestions, getSession, insertCheckin, insertReport, updateCheckin, updateQuestionCheckin } from "../../db";
import { sessionEmitter } from "../../emitter";
import type { ReportData } from "../../external/discord";
import { sendReport } from "../../external/discord";
import type { AgentState } from "../runner-types";
import { requestSummary } from "./api";
import { drainPending, injectAnswers } from "./questions";
import { setStatus } from "./status";

export function shouldFreeze(agent: AgentState, freezeOverride?: "freeze" | "continue"): boolean {
	if (freezeOverride === "freeze") return true;
	if (freezeOverride === "continue") return false;
	if (agent.config.freezeReportMode === "always") return true;
	if (agent.config.freezeReportMode === "never") return false;
	return true; // custom: agent passes freeze_override; default freeze if not specified
}

export async function triggerReport(
	agent: AgentState,
	report: ReportData,
	trigger: string,
	forceFreeze = false,
	freezeOverride?: "freeze" | "continue"
): Promise<void> {
	console.log("[Report]", trigger, JSON.stringify(report, null, 2));

	const freeze = forceFreeze || shouldFreeze(agent, freezeOverride);
	const pending = drainPending(agent);
	const questionsToAsk = freeze ? pending : [];

	const sessionId = agent.sessionId;

	// Normalize the trigger to the checkin timeline's vocabulary so every
	// report path (timer, completion, total-timeout, token budget, urgent,
	// manual) shows up in the UI — not just compaction.
	const checkinTrigger: Checkin["trigger"] =
		trigger === "timer" || trigger === "urgent" || trigger === "manual" || trigger === "completion" || trigger === "compaction"
			? trigger
			: "manual";

	const summary = report.sections.map((s) => `**${s.title}**\n${s.content}`).join("\n\n");

	// Record the check-in BEFORE any Discord round-trip so the timeline
	// reflects the event even when there is no channel (e.g. token budget
	// exhausted with Discord disabled).
	const checkinId = nanoid();
	const createdAt = Date.now();

	insertCheckin(agent.db, { id: checkinId, sessionId, trigger: checkinTrigger, summary, status: "pending", createdAt });
	// Link any questions being asked to this check-in so they render under it.
	for (const question of questionsToAsk) {
		updateQuestionCheckin(agent.db, question.id, checkinId);
		question.checkinId = checkinId;
	}

	sessionEmitter.emit(sessionId, {
		type: "checkin_started",
		data: { id: checkinId, sessionId, trigger: checkinTrigger, summary, status: "pending", createdAt, questions: questionsToAsk },
	});

	setStatus(agent, "paused");

	let confirmed = false;
	try {
		// Persist the immutable report record regardless of Discord delivery.
		insertReport(agent.db, { id: nanoid(), sessionId, trigger, title: report.title, content: JSON.stringify(report) });
		const result = await sendReport(sessionId, report, trigger, freeze, questionsToAsk, agent.abortController.signal);

		if (result?.confirmed) {
			confirmed = true;
			injectAnswers(agent, result.answers, pending);
		}
	} finally {
		const status = confirmed ? "answered" : "skipped";
		updateCheckin(agent.db, checkinId, { status, completedAt: Date.now() });
		sessionEmitter.emit(agent.sessionId, {
			type: "checkin_completed",
			data: { id: checkinId, sessionId, trigger: checkinTrigger, summary, status, completedAt: Date.now(), confirmed },
		});

		setStatus(agent, "running");
	}
}

export async function triggerAutoReport(agent: AgentState): Promise<void> {
	const summary = await requestSummary(agent);
	await triggerReport(agent, { title: "⏱ Scheduled Report", sections: [{ title: "Progress", content: summary }] }, "timer");
}

export async function handleTotalTimeout(agent: AgentState): Promise<void> {
	const summary = await requestSummary(agent);
	const questionsMd = buildQuestionsFileSync(agent);
	const sections: ReportData["sections"] = [{ title: "Progress at timeout", content: summary }];
	if (questionsMd) {
		sections.push({ title: "Accumulated Questions", content: questionsMd });
	}
	await triggerReport(agent, { title: "⏰ Total Timeout — Agent Frozen", sections }, "completion", true);
	setStatus(agent, "stopped");
}

export async function handleStopThreshold(agent: AgentState): Promise<void> {
	const summary = await requestSummary(agent);
	const t = getSession(agent.db, agent.sessionId);
	const tokenLine = `input: ${(t?.totalInputTokens ?? 0).toLocaleString()}, output: ${(t?.totalOutputTokens ?? 0).toLocaleString()}, cache_read: ${(t?.totalCacheReadTokens ?? 0).toLocaleString()}, cache_write: ${(t?.totalCacheWriteTokens ?? 0).toLocaleString()}`;
	await triggerReport(
		agent,
		{
			title: "🛑 Token Budget Exhausted — Agent Stopped",
			sections: [
				{ title: "Summary", content: summary },
				{ title: "Token Usage", content: `${tokenLine}\nBudget: ${agent.config.stopThresholdTokens.toLocaleString()}` },
			],
		},
		"completion",
		true
	);
	setStatus(agent, "stopped");
}

export async function flushQuestionsToDiscord(agent: AgentState): Promise<void> {
	if (agent.pendingQuestions.length === 0) return;
	const pending = drainPending(agent);

	const reportData = { title: "❓ Questions", sections: [] };
	const result = await sendReport(agent.sessionId, reportData, "manual", true, pending, agent.abortController.signal);
	if (result?.confirmed) injectAnswers(agent, result.answers, pending);
}

export function buildImproveMessage(agent: AgentState): string {
	if (agent.config.alwaysImproveMode === "yes") {
		return `You have completed the initial task. Do NOT declare yourself done.

Continue to improve the codebase. For example, look for opportunities to:

- Refactor duplicated or unclear code
- Strengthen error handling and resilience
- Improve performance (obvious wins only)
- Identify and address security gaps
- Add or improve tests (unit, integration, edge cases)
- Improve documentation (README, inline comments where genuinely needed)

Use \`add_task\` to track new improvements. Keep committing.`;
	}

	// "custom" mode: keep improving, but only within the configured scope
	return `You have completed the initial task. Continue improving within this scope ONLY: ${agent.config.alwaysImproveScope ?? ""}
Do NOT work outside this scope. Use \`add_task\` to track new improvements. Keep committing.`;
}

// Internal helper — sync version used by handleTotalTimeout
function buildQuestionsFileSync(agent: AgentState): string {
	const questions = getPendingQuestions(agent.db, agent.sessionId);
	if (questions.length === 0) return "";
	return questions
		.map(
			(question, idx) =>
				`### ${idx + 1}. ${question.isUrgent ? "🚨 " : ""}${question.text}${question.context ? `\n\nContext: ${question.context}` : ""}`
		)
		.join("\n\n");
}
