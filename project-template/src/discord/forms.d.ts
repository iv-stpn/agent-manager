import { type TextChannel } from "discord.js";
import type { Question } from "../db";
export interface Suggestion {
    id: string;
    title: string;
    subtitle?: string;
}
export interface CheckinFormResult {
    answers: Array<{
        questionId: string;
        answer: string;
    }>;
    confirmed: boolean;
}
export declare function sendCheckinForm(channel: TextChannel, summary: string, questions: Question[], sessionId: string, trigger: string, signal?: AbortSignal): Promise<CheckinFormResult>;
export interface ChecklistItem {
    id: string;
    question: string;
    description?: string;
    required?: boolean;
}
export interface ChecklistResult {
    answers: Record<string, string>;
    completed: boolean;
}
/**
 * Send a multi-question checklist to Discord, batched into modals of 5 fields each.
 * Used by ask_checklist at the start of implementation.
 */
export declare function sendChecklistForm(channel: TextChannel, title: string, items: ChecklistItem[], sessionId: string, signal?: AbortSignal): Promise<ChecklistResult>;
