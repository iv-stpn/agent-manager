import { asc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { type NewCheckin, type NewQuestion, checkins, questions } from "../schema";

export function insertCheckin(db: Db, data: NewCheckin) {
	db.insert(checkins).values(data).run();
	const result = db.select().from(checkins).where(eq(checkins.id, data.id)).get();
	if (!result) throw new Error("Checkin not found after insert");
	return result;
}

export function updateCheckin(db: Db, id: string, data: Partial<Omit<typeof checkins.$inferSelect, "id" | "createdAt">>) {
	db.update(checkins).set(data).where(eq(checkins.id, id)).run();
}

export function getCheckins(db: Db, sessionId: string) {
	return db.select().from(checkins).where(eq(checkins.sessionId, sessionId)).orderBy(asc(checkins.createdAt)).all();
}

export function insertQuestion(db: Db, data: NewQuestion) {
	db.insert(questions).values(data).run();
}

export function answerQuestion(db: Db, id: string, answer: string) {
	db.update(questions).set({ answer, answeredAt: Date.now() }).where(eq(questions.id, id)).run();
}

export function updateQuestionCheckin(db: Db, id: string, checkinId: string) {
	db.update(questions).set({ checkinId }).where(eq(questions.id, id)).run();
}

export function getPendingQuestions(db: Db, sessionId: string) {
	return db
		.select()
		.from(questions)
		.where(eq(questions.sessionId, sessionId))
		.all()
		.filter((q) => q.answer === null);
}

export function getQuestions(db: Db, sessionId: string) {
	return db.select().from(questions).where(eq(questions.sessionId, sessionId)).orderBy(asc(questions.createdAt)).all();
}
