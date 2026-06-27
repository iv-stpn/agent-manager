import { type TextChannel } from "discord.js";
import type { Question } from "../db";
import { type CheckinFormResult } from "./forms";
export interface ReportSection {
    title?: string;
    content: string;
}
export interface MermaidDiagram {
    title?: string;
    definition: string;
}
export interface ScreenshotTarget {
    title?: string;
    /** File path relative to workspace, URL, or raw HTML string (starts with '<') */
    target: string;
}
export interface ReportData {
    title: string;
    sections: ReportSection[];
    mermaid_diagrams?: MermaidDiagram[];
    screenshot_targets?: ScreenshotTarget[];
}
export interface ReportContext {
    workspace: string;
    task: string;
    sinceCommit: string | null;
}
export declare function sendDiscordReport(channel: TextChannel, report: ReportData, sessionId: string, trigger: string, freeze: boolean, pendingQuestions: Question[], ctx: ReportContext, signal?: AbortSignal): Promise<CheckinFormResult | null>;
