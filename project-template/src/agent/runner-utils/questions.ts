import { nanoid } from "nanoid";
import type { Db } from "../../db";
import { answerQuestion, insertQuestion } from "../../db";
import type { ReportData } from "../../external/discord";
import { sendQuestions } from "../../external/discord";
import { steerAgent } from "../definition";
import { recall, remember, updateMemory } from "../tools/implementations/memory";
import type { AskUserQuestionInput, SendReportInput } from "../tools/validators";
import type { AgentState } from "../types";
import { triggerReport } from "./reports";

/**
 * Record an answer for a question in the database and update its vector memory
 * entry. Called when ask_user_question answers arrive (blocking or deferred).
 */
async function recordAnswer(db: Db, questionId: string, answer: string): Promise<void> {
	answerQuestion(db, questionId, answer);

	// Update the question's vector memory entry with the answer (best-effort)
	try {
		const results = await recall(questionId, "question", 1);
		const entry = results.find((result) => result.metadata?.questionId === questionId);
		if (entry) {
			await updateMemory(entry.id, {
				content: `${entry.content}\n\n**Answer:** ${answer}`,
				metadata: { ...entry.metadata, status: "answered" },
			});
		}
	} catch {
		// Non-fatal if memory service is unavailable
	}
}

export async function handleAskUserQuestion(agent: AgentState, input: AskUserQuestionInput): Promise<string> {
	const title = input.title ?? "Questions";
	const urgent = input.urgent ?? false;

	// Record each question in DB + memory. Answers come back keyed by header,
	// so keep the header → row-id mapping to record them against the right row.
	const questionIdByHeader = new Map<string, string>();
	for (const item of input.questions) {
		const questionId = nanoid();
		questionIdByHeader.set(item.header, questionId);
		insertQuestion(agent.db, {
			id: questionId,
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

	const persistAnswers = async (answers: Record<string, string>): Promise<void> => {
		for (const [header, answer] of Object.entries(answers)) {
			const questionId = questionIdByHeader.get(header);
			if (questionId) await recordAnswer(agent.db, questionId, answer);
		}
	};

	// In "never" mode: fire the question to Discord in the background and return
	// immediately. When the user eventually replies, inject the answers as a
	// steering message so the agent picks them up at the start of its next turn.
	if (agent.config.awaitAskMode === "never") {
		sendQuestions(agent.sessionId, title, input.questions, urgent)
			.then(async (result) => {
				if (!result.completed) return;
				await persistAnswers(result.answers);
				const answersText = Object.entries(result.answers)
					.map(([header, answer]) => `- ${header}: ${answer}`)
					.join("\n");
				steerAgent(agent, `[Deferred answers received for "${title}"]\n${answersText}`);
			})
			.catch(() => {
				// Silently ignore: agent may have stopped or question timed out.
			});
		return "The user will reply later. Proceed now on other tasks, or for non-critical questions, make a best choice decision.";
	}

	// Otherwise: send to Discord and block until answers arrive.
	const result = await sendQuestions(agent.sessionId, title, input.questions, urgent, agent.abortController.signal);

	if (result.completed) {
		await persistAnswers(result.answers);
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

	// Route through triggerReport so a manual report follows the exact same path
	// as every automatic one: it records a check-in (so it shows in the Reports
	// tab and can be archived from the UI) and writes a `report_<checkinId>`
	// memory entry (so recall surfaces it and archiving cascades to it). Before
	// this, manual reports created only a stray memory with a random id and no
	// check-in, so they never appeared in the UI and could never be archived.
	const { delivered, awaiting, confirmed } = await triggerReport(agent, report, "manual", false, input.await_override);

	if (!delivered) return "Report saved, but delivery to the user failed (messaging unavailable). Continuing.";
	if (awaiting)
		return confirmed ? "Report sent and user acknowledged." : "Report sent, but no acknowledgment received. Continuing.";
	return "Report sent (continuing).";
}
