import { nanoid } from "nanoid";
import { insertQuestion } from "../../db";
import type { ReportData } from "../../external/discord";
import { sendReport } from "../../external/discord";
import { remember } from "../tools/implementations/memory";
import type { QuestionInput, SendGraphInput, SendReportInput } from "../tools/validators";
import type { AgentState } from "../types";
import { appendToQuestionsFile, drainPending, injectAnswers, makeQuestion } from "./questions";
import { flushQuestionsToDiscord, shouldFreeze, triggerReport } from "./reports";
import { setStatus } from "./status";

export async function handleQueueQuestion(agent: AgentState, input: QuestionInput): Promise<string> {
	const question = makeQuestion(agent, input, false);
	insertQuestion(agent.db, question);
	remember(
		"question",
		question.text.slice(0, 100),
		`${question.text}${question.context ? `\n\nContext: ${question.context}` : ""}`,
		{ questionId: question.id, status: "pending" }
	).catch(() => {});

	switch (agent.config.freezeAskMode) {
		case "always":
			agent.pendingQuestions.push(question);
			return "Question queued — will be sent to Discord shortly.";
		case "requiredOnly":
		case "onReportOnly":
			agent.pendingQuestions.push(question);
			return "Question queued for next report.";
		case "never":
			await appendToQuestionsFile(question);
			return "Question logged to memory.";
	}
}

export async function handleUrgentQuestion(agent: AgentState, input: QuestionInput): Promise<string> {
	const q = makeQuestion(agent, input, true);
	insertQuestion(agent.db, q);
	remember("question", `🚨 ${q.text.slice(0, 95)}`, `${q.text}${q.context ? `\n\nContext: ${q.context}` : ""}`, {
		questionId: q.id,
		status: "pending",
		urgent: true,
	}).catch(() => {});

	switch (agent.config.freezeAskMode) {
		case "always":
		case "requiredOnly": {
			agent.pendingQuestions.push(q);
			await flushQuestionsToDiscord(agent);
			return q.answer ?? "No answer received — proceeding with best judgment.";
		}
		case "onReportOnly": {
			agent.pendingQuestions.push(q);
			await triggerReport(
				agent,
				{
					title: "🚨 Urgent Question",
					sections: [{ title: "Context", content: input.context ?? "Agent is blocked." }],
				},
				"urgent",
				true
			);
			return q.answer ?? "No answer received — proceeding with best judgment.";
		}
		case "never":
			await appendToQuestionsFile(q);
			return "Logged to memory — proceeding with best judgment.";
	}
}

export async function handleSendReport(agent: AgentState, input: SendReportInput): Promise<string> {
	const report: ReportData = {
		title: input.title,
		sections: input.sections,
		...(input.mermaid_diagrams !== undefined && { mermaid_diagrams: input.mermaid_diagrams }),
	};

	const freeze = shouldFreeze(agent, input.freeze_override);
	const pending = drainPending(agent);
	const questionsToAsk = freeze ? pending : [];

	setStatus(agent, "paused");

	try {
		const result = await sendReport(agent.sessionId, report, "manual", freeze, questionsToAsk, agent.abortController.signal);

		insertReport(agent.db, {
			id: nanoid(),
			sessionId: agent.sessionId,
			trigger: "manual",
			title: report.title,
			content: JSON.stringify(report),
		});

		// Record in vector memory for semantic recall
		remember("report", report.title, report.sections.map((s) => `${s.title ?? ""}\n${s.content}`).join("\n\n")).catch(() => {});

		if (result?.confirmed) injectAnswers(agent, result.answers, pending);
	} finally {
		setStatus(agent, "running");
	}

	return freeze ? "Report sent and user acknowledged." : "Report sent (continuing).";
}

export async function handleSendGraph(agent: AgentState, input: SendGraphInput): Promise<string> {
	const definition = input.definition;
	const title = input.title || undefined;

	const { renderMermaid } = await import("../../external/mermaid");
	const png = await renderMermaid(definition);

	const { sendGraph } = await import("../../external/discord");
	await sendGraph(agent.sessionId, png, title);

	return "Graph sent to Discord.";
}

// Re-export insertReport for convenience
import { insertReport } from "../../db";

export { insertReport };
