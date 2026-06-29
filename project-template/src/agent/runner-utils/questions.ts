import type { Question } from "@agent-manager/db/project-schema";
import { nanoid } from "nanoid";
import { answerQuestion, getPendingQuestions, insertQuestion } from "../../db";
import type { AgentState } from "../runner-types";
import { recall, remember, updateMemory } from "../tools/implementations/memory";
import type { QuestionInput } from "../tools/validators";

export function makeQuestion(agent: AgentState, input: QuestionInput, isUrgent: boolean): Question {
	const suggestions = input.suggestions ? JSON.stringify(input.suggestions) : null;
	return {
		id: nanoid(),
		sessionId: agent.sessionId,
		checkinId: null,
		text: input.question,
		context: input.context ?? null,
		suggestions,
		answer: null,
		isUrgent,
		createdAt: Date.now(),
		answeredAt: null,
	};
}

/** Atomically drain and return all accumulated pending questions. */
export function drainPending(agent: AgentState): Question[] {
	const pending = agent.pendingQuestions;
	agent.pendingQuestions = [];
	return pending;
}

export function injectAnswers(
	agent: AgentState,
	answers: Array<{ questionId: string; answer: string }>,
	pending: Question[]
): void {
	for (const a of answers) {
		answerQuestion(agent.db, a.questionId, a.answer);
		const q = pending.find((p) => p.id === a.questionId);
		if (q) q.answer = a.answer;
		// Append answer to the question's vector memory entry
		recall(a.questionId, "question", 1)
			.then((results) => {
				const entry = results.find((r) => r.metadata?.questionId === a.questionId);
				if (entry) {
					updateMemory(entry.id, {
						content: `${entry.content}\n\n**Answer:** ${a.answer}`,
						metadata: { ...entry.metadata, status: "answered" },
					}).catch(() => {});
				}
			})
			.catch(() => {});
	}
}

export async function appendToQuestionsFile(q: Question): Promise<void> {
	const entry = `${q.isUrgent ? "🚨 Urgent" : "❓ Question"} (${new Date(q.createdAt).toISOString()})\n${q.text}${q.context ? `\n\nContext: ${q.context}` : ""}`;
	try {
		await remember("question", q.text.slice(0, 100), entry);
	} catch {
		// Non-fatal if memory service is unavailable
	}
}

export function buildQuestionsFile(agent: AgentState): string {
	const qs = getPendingQuestions(agent.db, agent.sessionId);
	if (qs.length === 0) return "";
	return qs
		.map((q, i) => `### ${i + 1}. ${q.isUrgent ? "🚨 " : ""}${q.text}${q.context ? `\n\nContext: ${q.context}` : ""}`)
		.join("\n\n");
}

export { insertQuestion };
