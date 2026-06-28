import { AttachmentBuilder, EmbedBuilder, type TextChannel } from "discord.js";
import { getCommitsSince } from "../agent/git";
import { renderMermaid } from "../agent/mermaid";
import { screenshotHtml, screenshotTarget } from "../agent/screenshot";
import type { Question } from "../db";
import { type CheckinFormResult, sendCheckinForm } from "./forms";

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

const CHUNK_SIZE = 1800;

function splitText(text: string, maxLen = CHUNK_SIZE): string[] {
	if (text.length <= maxLen) return [text];

	const chunks: string[] = [];
	let remaining = text.trim();

	while (remaining.length > maxLen) {
		let cut = remaining.lastIndexOf(". ", maxLen);
		if (cut < maxLen * 0.5) cut = remaining.lastIndexOf("\n", maxLen);
		if (cut < maxLen * 0.3) cut = remaining.lastIndexOf(" ", maxLen);
		if (cut <= 0) cut = maxLen;
		chunks.push(remaining.slice(0, cut + 1).trim());
		remaining = remaining.slice(cut + 1).trim();
	}

	if (remaining.length > 0) chunks.push(remaining);
	return chunks;
}

const TRIGGER_COLORS: Record<string, number> = {
	timer: 0x5865f2,
	urgent: 0xff4444,
	completion: 0x44ff88,
	manual: 0x888888,
};

export async function sendDiscordReport(
	channel: TextChannel,
	report: ReportData,
	sessionId: string,
	trigger: string,
	freeze: boolean,
	pendingQuestions: Question[],
	ctx: ReportContext,
	signal?: AbortSignal
): Promise<CheckinFormResult | null> {
	// ── Fetch git log ──────────────────────────────────────────────────────────
	const commitLog = await getCommitsSince(ctx.workspace, ctx.sinceCommit).catch(() => "(unavailable)");

	// ── 1. Header embed ────────────────────────────────────────────────────────
	const color = TRIGGER_COLORS[trigger] ?? 0x5865f2;
	const header = new EmbedBuilder()
		.setColor(color)
		.setTitle(report.title)
		.addFields(
			{ name: "Session", value: `\`${sessionId.slice(0, 8)}...\``, inline: true },
			{ name: "Trigger", value: trigger, inline: true },
			{
				name: freeze ? "⏸ Awaiting input" : "▶ Continuing",
				value: pendingQuestions.length > 0 ? `${pendingQuestions.length} question(s) pending` : "No questions",
				inline: true,
			}
		)
		.setTimestamp();

	await channel.send({ embeds: [header] });

	// ── 2. Current task + commits since last report ────────────────────────────
	const contextEmbed = new EmbedBuilder()
		.setColor(color)
		.setTitle("Context")
		.addFields(
			{
				name: "Current task",
				value: ctx.task.slice(0, 800),
			},
			{
				name: "Commits since last report",
				value: `\`\`\`\n${commitLog.slice(0, 800)}\n\`\`\``,
			}
		);
	await channel.send({ embeds: [contextEmbed] });

	// ── 3. Text sections (1800-char chunks) ────────────────────────────────────
	for (const section of report.sections) {
		const chunks = splitText(section.content);
		for (let i = 0; i < chunks.length; i++) {
			const embed = new EmbedBuilder().setColor(color).setDescription(`\`\`\`\n${chunks[i]}\n\`\`\``);
			if (i === 0 && section.title) embed.setTitle(section.title);
			if (i > 0) embed.setFooter({ text: `continued (${i + 1}/${chunks.length})` });
			await channel.send({ embeds: [embed] });
		}
	}

	// ── 4. Mermaid diagrams ────────────────────────────────────────────────────
	for (const diagram of report.mermaid_diagrams ?? []) {
		try {
			const png = await renderMermaid(diagram.definition);
			const attachment = new AttachmentBuilder(png, { name: "diagram.png" });
			const embed = new EmbedBuilder()
				.setColor(color)
				.setTitle(diagram.title ?? "Diagram")
				.setImage("attachment://diagram.png");
			await channel.send({ embeds: [embed], files: [attachment] });
		} catch (err) {
			await channel.send({
				embeds: [
					new EmbedBuilder()
						.setColor(0xff8800)
						.setTitle(`⚠ Mermaid render failed: ${diagram.title ?? "diagram"}`)
						.setDescription(`\`\`\`\n${diagram.definition.slice(0, 800)}\n\`\`\`\n\nError: ${err}`),
				],
			});
		}
	}

	// ── 5. Screenshots ─────────────────────────────────────────────────────────
	for (const st of report.screenshot_targets ?? []) {
		try {
			let png: Buffer;
			if (st.target.trimStart().startsWith("<")) {
				png = await screenshotHtml(st.target);
			} else {
				png = await screenshotTarget(st.target);
			}
			const attachment = new AttachmentBuilder(png, { name: "screenshot.png" });
			const embed = new EmbedBuilder()
				.setColor(color)
				.setTitle(st.title ?? "Screenshot")
				.setImage("attachment://screenshot.png");
			await channel.send({ embeds: [embed], files: [attachment] });
		} catch (err) {
			await channel.send({
				embeds: [
					new EmbedBuilder()
						.setColor(0xff8800)
						.setTitle(`⚠ Screenshot failed: ${st.title ?? st.target}`)
						.setDescription(String(err).slice(0, 400)),
				],
			});
		}
	}

	// ── 6. Questions + optional freeze ────────────────────────────────────────
	if (!freeze) {
		if (pendingQuestions.length > 0) {
			const qEmbed = new EmbedBuilder()
				.setColor(0xffa500)
				.setTitle(`${pendingQuestions.length} Queued Question(s)`)
				.setDescription(
					pendingQuestions
						.map((q, i) => `**Q${i + 1}**: ${q.text}`)
						.join("\n\n")
						.slice(0, 3800)
				);
			await channel.send({ embeds: [qEmbed] });
		}
		return null;
	}

	return sendCheckinForm(channel, "", pendingQuestions, sessionId, trigger, signal);
}
