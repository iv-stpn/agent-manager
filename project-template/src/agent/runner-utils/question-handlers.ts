import { nanoid } from "nanoid";
import { insertQuestion } from "../../db";
import type { ReportData } from "../../external/discord";
import { sendQuestions, sendReport } from "../../external/discord";
import { remember } from "../tools/implementations/memory";
import type { AskUserQuestionInput, QuestionInput, SendGraphInput, SendReportInput } from "../tools/validators";
import type { AgentState } from "../types";
import { appendToQuestionsFile, drainPending, injectAnswers, makeQuestion } from "./questions";
import { shouldFreeze } from "./reports";
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

export async function handleAskUserQuestion(agent: AgentState, input: AskUserQuestionInput): Promise<string> {
	const title = input.title ?? "Questions";
	const urgent = input.urgent ?? false;

	// Record each question in DB + memory
	for (const item of input.questions) {
		insertQuestion(agent.db, {
			id: nanoid(),
			sessionId: agent.sessionId,
			text: item.question,
			context: input.context ?? null,
			suggestions: JSON.stringify(item.options),
			answer: null,
			isUrgent: urgent,
		});
		remember(
			"question",
			`${urgent ? "🚨 " : ""}${item.question.slice(0, 95)}`,
			`${item.question}${input.context ? `\n\nContext: ${input.context}` : ""}`,
			{ status: "pending", urgent }
		).catch(() => {});
	}

	// Send to Discord and wait for answers
	const result = await sendQuestions(
		agent.sessionId,
		title,
		input.questions,
		urgent,
		agent.abortController.signal
	);

	if (result.completed) {
		const answersText = Object.entries(result.answers)
			.map(([header, answer]) => `- ${header}: ${answer}`)
			.join("\n");
		return `Answers received:\n${answersText}`;
	}
	return urgent
		? "Urgent questions sent but no response received — proceeding with best judgment."
		: "Questions sent but no response received — proceeding with best judgment.";
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
