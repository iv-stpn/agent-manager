import type { Checkin } from "@agent-manager/db/project-schema";
import { nanoid } from "nanoid";
import { getSession, insertCheckin, insertReport, updateCheckin } from "../../db";
import { sessionEmitter } from "../../emitter";
import type { ReportData } from "../../external/discord";
import { sendReport } from "../../external/discord";
import { remember } from "../tools/implementations/memory";
import type { AgentState } from "../types";
import { requestSummary } from "./api";
import { setStatus } from "./status";

export function shouldAwait(agent: AgentState, awaitOverride?: "await" | "continue"): boolean {
	if (awaitOverride === "await") return true;
	if (awaitOverride === "continue") return false;

	if (agent.config.awaitReportMode === "always") return true;
	if (agent.config.awaitReportMode === "never") return false;
	return true; // custom: agent passes await_override; default await if not specified
}

export interface ReportOutcome {
	delivered: boolean; // Reached the user (Discord). False when delivery threw or there was no channel.
	confirmed: boolean; // The user acknowledged (only possible when awaiting).
	awaiting: boolean; // Whether this report blocked for acknowledgment.
}

export async function triggerReport(
	agent: AgentState,
	report: ReportData,
	trigger: string,
	forceAwait = false,
	awaitOverride?: "await" | "continue"
): Promise<ReportOutcome> {
	console.log("[Report]", trigger, JSON.stringify(report, null, 2));

	const awaiting = forceAwait || shouldAwait(agent, awaitOverride);
	const sessionId = agent.sessionId;

	// Normalize the trigger to the checkin timeline's vocabulary so every
	// report path (timer, completion, total-timeout, token budget, urgent,
	// manual) shows up in the UI — not just compaction.
	const checkinTrigger: Checkin["trigger"] =
		trigger === "timer" || trigger === "urgent" || trigger === "manual" || trigger === "completion" || trigger === "compaction"
			? trigger
			: "manual";

	// A section title is optional (manual send_report allows title-less sections),
	// so only prepend the bold heading when one is present — otherwise a missing
	// title would render as the literal "**undefined**".
	const summary = report.sections
		.map((section) => (section.title ? `**${section.title}**\n${section.content}` : section.content))
		.join("\n\n");

	// Record the check-in BEFORE any Discord round-trip so the timeline
	// reflects the event even when there is no channel (e.g. token budget
	// exhausted with Discord disabled).
	const checkinId = nanoid();
	const createdAt = Date.now();

	insertCheckin(agent.db, { id: checkinId, sessionId, trigger: checkinTrigger, summary, status: "pending", createdAt });

	// Mirror the report into vector memory under a deterministic id tied to the
	// check-in, so recall can surface past reports AND archiving the check-in in
	// the UI can cascade to its memory entry (see the reports/archive routes).
	// Fire-and-forget: a memory-service blip must not fail the report.
	remember("report", report.title, summary, undefined, `report_${checkinId}`).catch(() => {});

	sessionEmitter.emit(sessionId, {
		type: "checkin_started",
		data: { id: checkinId, sessionId, trigger: checkinTrigger, summary, status: "pending", createdAt },
	});

	setStatus(agent, "paused");

	let confirmed = false;
	let delivered = true;
	try {
		// Persist the immutable report record regardless of Discord delivery.
		insertReport(agent.db, { id: nanoid(), sessionId, trigger, title: report.title, content: JSON.stringify(report) });
		const result = await sendReport(sessionId, report, trigger, awaiting, agent.abortController.signal);

		if (result?.confirmed) {
			confirmed = true;
		}
	} catch (err) {
		// Delivery failure (e.g. no Discord channel, a 404) must not fail the
		// report: the check-in, report row and memory entry are already persisted.
		delivered = false;
		console.error(
			`[Agent ${sessionId}] Discord report delivery failed (trigger=${trigger}):`,
			err instanceof Error ? err.message : err
		);
	} finally {
		const status = confirmed ? "answered" : "skipped";
		updateCheckin(agent.db, checkinId, { status, completedAt: Date.now() });
		sessionEmitter.emit(agent.sessionId, {
			type: "checkin_completed",
			data: { id: checkinId, sessionId, trigger: checkinTrigger, summary, status, completedAt: Date.now(), confirmed },
		});

		setStatus(agent, "running");
	}

	return { delivered, awaiting, confirmed };
}

export async function triggerAutoReport(agent: AgentState): Promise<void> {
	const summary = await requestSummary(agent);
	await triggerReport(agent, { title: "⏱ Scheduled Report", sections: [{ title: "Progress", content: summary }] }, "timer");
}

export async function handleTotalTimeout(agent: AgentState): Promise<void> {
	const summary = await requestSummary(agent);
	await triggerReport(
		agent,
		{ title: "⏰ Total Timeout — Agent Awaiting", sections: [{ title: "Progress at timeout", content: summary }] },
		"completion",
		true
	);
	setStatus(agent, "aborted");
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
	setStatus(agent, "aborted");
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
