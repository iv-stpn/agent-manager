import { nanoid } from "nanoid";
import type { Db, Question } from "../db";
import { answerQuestion, getPendingQuestions, insertCheckin, updateCheckin, updateSession } from "../db";
import { sendCheckin } from "../discord/bot";
import { sessionEmitter } from "../emitter";

export interface CheckinResult {
	summary: string;
	answers: Array<{ questionId: string; question: string; answer: string }>;
	confirmed: boolean;
}

export async function performCheckin(
	db: Db,
	sessionId: string,
	trigger: "timer" | "urgent" | "manual" | "completion",
	summary: string,
	discordChannelId: string | null,
	pendingQuestions: Question[]
): Promise<CheckinResult> {
	const checkinId = nanoid();

	const checkin = insertCheckin(db, {
		id: checkinId,
		sessionId,
		trigger,
		summary,
		status: "pending",
		createdAt: Date.now(),
	});

	sessionEmitter.emit(sessionId, {
		type: "checkin_started",
		data: { ...checkin, questions: pendingQuestions },
	});

	updateSession(db, sessionId, { status: "paused" });
	sessionEmitter.emit(sessionId, {
		type: "session_updated",
		data: { id: sessionId, status: "paused" },
	});

	const answers: Array<{ questionId: string; question: string; answer: string }> = [];
	let confirmed = false;

	if (discordChannelId) {
		const result = await sendCheckin(discordChannelId, summary, pendingQuestions, sessionId, trigger);

		if (result.confirmed) {
			confirmed = true;
			for (const ans of result.answers) {
				answerQuestion(db, ans.questionId, ans.answer);
				const q = pendingQuestions.find((q) => q.id === ans.questionId);
				if (q) {
					answers.push({ questionId: ans.questionId, question: q.text, answer: ans.answer });
				}
			}
		}
	} else {
		confirmed = true;
		console.log(`[Checkin] No Discord channel — auto-confirming check-in for ${sessionId}`);
	}

	updateCheckin(db, checkinId, {
		status: confirmed ? "answered" : "skipped",
		completedAt: Date.now(),
	});

	updateSession(db, sessionId, { status: "running" });

	sessionEmitter.emit(sessionId, {
		type: "checkin_completed",
		data: { ...checkin, answers, confirmed },
	});

	sessionEmitter.emit(sessionId, {
		type: "session_updated",
		data: { id: sessionId, status: "running" },
	});

	return { summary, answers, confirmed };
}
