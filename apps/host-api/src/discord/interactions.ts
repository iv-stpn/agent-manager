import {
	ActionRowBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	EmbedBuilder,
	type Interaction,
	ModalBuilder,
	type ModalSubmitInteraction,
	type TextChannel,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import { getChannel } from "./bot";

export interface Question {
	id: string;
	text: string;
	context?: string | null;
	suggestions?: string | null;
}

export interface Suggestion {
	id: string;
	title: string;
	subtitle?: string;
}

export interface CheckinFormResult {
	answers: Array<{ questionId: string; answer: string }>;
	confirmed: boolean;
}

export interface ReportSection {
	title?: string;
	content: string;
}

export interface MermaidDiagram {
	title?: string;
	definition: string;
}

export interface ReportData {
	title: string;
	sections: ReportSection[];
	mermaid_diagrams?: MermaidDiagram[];
}

const CHECKIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Send report embeds to a channel. If freeze=true, also send a check-in form and wait for response.
 */
export async function sendReport(
	channelId: string,
	report: ReportData,
	sessionId: string,
	trigger: string,
	freeze: boolean,
	pendingQuestions: Question[],
	signal?: AbortSignal
): Promise<CheckinFormResult | null> {
	const channel = await getChannel(channelId);
	if (!channel) return null;

	const triggerLabel =
		trigger === "timer"
			? "⏱ Scheduled Check-in"
			: trigger === "urgent"
				? "🚨 Agent Needs Help"
				: trigger === "completion"
					? "✅ Task Complete"
					: trigger === "compaction"
						? "🗜 Context Compacted"
						: "📋 Check-in";

	const color = trigger === "urgent" ? 0xff4444 : trigger === "completion" ? 0x44ff88 : 0x5865f2;

	// Header embed
	const headerEmbed = new EmbedBuilder()
		.setColor(color)
		.setTitle(triggerLabel)
		.setDescription(report.title || null)
		.addFields(
			{ name: "Session", value: `\`${sessionId.slice(0, 8)}…\``, inline: true },
			{ name: "Questions", value: pendingQuestions.length > 0 ? `${pendingQuestions.length} pending` : "None", inline: true },
			{ name: "Freeze", value: freeze ? "Yes" : "No", inline: true }
		)
		.setTimestamp();

	await channel.send({ embeds: [headerEmbed] });

	// Section embeds
	for (const section of report.sections) {
		const chunks = splitContent(section.content, 1800);
		for (let i = 0; i < chunks.length; i++) {
			const embed = new EmbedBuilder().setColor(color).setDescription(`\`\`\`\n${chunks[i]}\n\`\`\``);
			if (section.title && i === 0) embed.setTitle(section.title);
			await channel.send({ embeds: [embed] });
		}
	}

	// Mermaid diagram attachments (render up to 3 in parallel)
	if (report.mermaid_diagrams?.length) {
		const { renderMermaid } = await import("../render/chromium");
		const { AttachmentBuilder } = await import("discord.js");

		const diagrams = report.mermaid_diagrams;
		for (let i = 0; i < diagrams.length; i += 3) {
			const batch = diagrams.slice(i, i + 3);
			const results = await Promise.allSettled(batch.map((d) => renderMermaid(d.definition)));

			for (let j = 0; j < batch.length; j++) {
				const diagram = batch[j];
				const result = results[j];
				if (result.status === "fulfilled") {
					const attachment = new AttachmentBuilder(result.value, { name: "diagram.png" });
					const embed = new EmbedBuilder().setColor(color).setImage("attachment://diagram.png");
					if (diagram.title) embed.setTitle(diagram.title);
					await channel.send({ embeds: [embed], files: [attachment] });
				} else {
					const fallback = new EmbedBuilder().setColor(0xffaa00).setDescription(`\`\`\`mermaid\n${diagram.definition}\n\`\`\``);
					if (diagram.title) fallback.setTitle(`${diagram.title} (render failed)`);
					await channel.send({ embeds: [fallback] });
				}
			}
		}
	}

	// If not freezing, just show queued questions as info
	if (!freeze) {
		if (pendingQuestions.length > 0) {
			const qEmbed = new EmbedBuilder()
				.setColor(0xffaa00)
				.setTitle(`${pendingQuestions.length} Queued Question(s)`)
				.setDescription(pendingQuestions.map((q, i) => `**${i + 1}.** ${q.text}`).join("\n"));
			await channel.send({ embeds: [qEmbed] });
		}
		return null;
	}

	// Freeze mode: send checkin form
	return sendCheckinForm(channel, "", pendingQuestions, sessionId, trigger, signal);
}

/**
 * Send a checkin form with questions and wait for user interaction.
 */
export async function sendCheckinForm(
	channel: TextChannel,
	_summary: string,
	questions: Question[],
	sessionId: string,
	_trigger: string,
	signal?: AbortSignal
): Promise<CheckinFormResult> {
	const startRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(`checkin_start_${sessionId}`)
			.setLabel(questions.length > 0 ? `Answer ${questions.length} Question(s)` : "Acknowledge")
			.setStyle(ButtonStyle.Primary),
		new ButtonBuilder().setCustomId(`checkin_skip_${sessionId}`).setLabel("Skip").setStyle(ButtonStyle.Secondary)
	);

	const embed = new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle("🛑 Agent Frozen — Awaiting Response")
		.setDescription(
			questions.length > 0
				? `The agent has **${questions.length} question(s)** before it can continue.`
				: "The agent is paused. Click Acknowledge to resume."
		)
		.setTimestamp();

	const msg = await channel.send({ embeds: [embed], components: [startRow] });

	return new Promise((resolve) => {
		const answers: Array<{ questionId: string; answer: string }> = [];
		let currentStep = 0;

		const collector = msg.createMessageComponentCollector({ time: CHECKIN_TIMEOUT_MS });

		if (signal) {
			const onAbort = () => {
				msg.edit({ components: [] }).catch(() => {});
				cleanup();
				resolve({ answers, confirmed: false });
			};
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		function cleanup() {
			collector.stop("done");
			channel.client.removeListener("interactionCreate", modalListener);
		}

		function isSuggestion(v: unknown): v is Suggestion {
			if (typeof v !== "object" || v === null) return false;
			if (!("id" in v) || !("title" in v)) return false;
			return typeof v.id === "string" && typeof v.title === "string";
		}

		function parseSuggestions(q: Question): Suggestion[] {
			if (!q.suggestions) return [];
			try {
				const parsed: unknown = JSON.parse(q.suggestions);
				if (!Array.isArray(parsed)) return [];
				return parsed.filter(isSuggestion);
			} catch {
				return [];
			}
		}

		async function presentQuestion(
			interaction: ButtonInteraction | ModalSubmitInteraction,
			step: number,
			replyMethod: "reply" | "update"
		) {
			const question = questions[step];
			const suggestions = parseSuggestions(question);

			if (suggestions.length > 0) {
				const qEmbed = new EmbedBuilder()
					.setColor(0x5865f2)
					.setTitle(`Question ${step + 1} of ${questions.length}`)
					.setDescription(question.text);

				const buttons = suggestions.map((s) =>
					new ButtonBuilder()
						.setCustomId(`suggest_${sessionId}_${question.id}_${s.id}`)
						.setLabel(s.title.slice(0, 80))
						.setStyle(ButtonStyle.Primary)
				);
				buttons.push(
					new ButtonBuilder()
						.setCustomId(`custom_answer_${sessionId}_${question.id}_${step}`)
						.setLabel("✏️ Custom")
						.setStyle(ButtonStyle.Secondary)
				);

				const rows: ActionRowBuilder<ButtonBuilder>[] = [];
				for (let i = 0; i < buttons.length; i += 5) {
					rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
				}

				if (replyMethod === "reply") await interaction.reply({ embeds: [qEmbed], components: rows, flags: 64 });
				else if (interaction.isButton()) await interaction.update({ embeds: [qEmbed], components: rows });
			} else {
				if (interaction.isButton()) {
					const modal = new ModalBuilder()
						.setCustomId(`answer_modal_${sessionId}_${question.id}`)
						.setTitle(`Question ${step + 1} of ${questions.length}`);
					const input = new TextInputBuilder()
						.setCustomId("answer_input")
						.setLabel(question.text.length > 45 ? `${question.text.slice(0, 42)}...` : question.text)
						.setStyle(TextInputStyle.Paragraph)
						.setRequired(true);
					modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
					await interaction.showModal(modal);
				}
			}
		}

		const modalListener = async (i: Interaction) => {
			if (!i.isModalSubmit() && !i.isButton()) return;
			if (!("customId" in i)) return;
			if (!i.customId.includes(sessionId)) return;

			if (i.customId.startsWith(`answer_modal_${sessionId}_`)) {
				if (!i.isModalSubmit()) return;
				const answer = i.fields.getTextInputValue("answer_input");
				answers.push({ questionId: questions[currentStep].id, answer });
				currentStep++;
				if (currentStep >= questions.length) {
					await i.reply({ content: "✅ All questions answered. Agent resuming.", flags: 64 });
					cleanup();
					resolve({ answers, confirmed: true });
				} else {
					await presentQuestion(i, currentStep, "reply");
				}
			}
		};

		channel.client.on("interactionCreate", modalListener);

		collector.on("collect", async (interaction) => {
			if (!interaction.isButton()) return;

			if (interaction.customId === `checkin_skip_${sessionId}`) {
				await interaction.update({ components: [] });
				cleanup();
				resolve({ answers, confirmed: false });
				return;
			}

			if (interaction.customId === `checkin_start_${sessionId}`) {
				if (questions.length === 0) {
					await interaction.update({ components: [] });
					cleanup();
					resolve({ answers: [], confirmed: true });
					return;
				}
				await msg.edit({ components: [] });
				await presentQuestion(interaction, 0, "reply");
				return;
			}

			// Suggestion button
			if (interaction.customId.startsWith(`suggest_${sessionId}_`)) {
				const parts = interaction.customId.split("_");
				const suggestionId = parts[parts.length - 1];
				const question = questions[currentStep];
				const suggestions = parseSuggestions(question);
				const selected = suggestions.find((s) => s.id === suggestionId);
				answers.push({ questionId: question.id, answer: selected?.title ?? suggestionId });
				currentStep++;
				if (currentStep >= questions.length) {
					await interaction.update({ content: "✅ All questions answered. Agent resuming.", embeds: [], components: [] });
					cleanup();
					resolve({ answers, confirmed: true });
				} else {
					await presentQuestion(interaction, currentStep, "update");
				}
				return;
			}

			// Custom answer button
			if (interaction.customId.startsWith(`custom_answer_${sessionId}_`)) {
				const question = questions[currentStep];
				const modal = new ModalBuilder()
					.setCustomId(`answer_modal_${sessionId}_${question.id}`)
					.setTitle(`Question ${currentStep + 1} of ${questions.length}`);
				const input = new TextInputBuilder()
					.setCustomId("answer_input")
					.setLabel(question.text.length > 45 ? `${question.text.slice(0, 42)}...` : question.text)
					.setStyle(TextInputStyle.Paragraph)
					.setRequired(true);
				modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
				await interaction.showModal(modal);
			}
		});

		collector.on("end", (_, reason) => {
			if (reason === "done") return;
			msg.edit({ components: [] }).catch(() => {});
			channel.client.removeListener("interactionCreate", modalListener);
			resolve({ answers, confirmed: false });
		});
	});
}

/**
 * Send a checklist (pre-implementation questions) and wait for responses.
 */
export async function sendChecklist(
	channelId: string,
	sessionId: string,
	title: string,
	items: Array<{ id: string; question: string; description?: string }>,
	signal?: AbortSignal
): Promise<Record<string, string>> {
	const channel = await getChannel(channelId);
	if (!channel) return {};

	const embed = new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle(title)
		.setDescription(
			items.map((item, i) => `**${i + 1}.** ${item.question}${item.description ? `\n   _${item.description}_` : ""}`).join("\n\n")
		);

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(`checklist_start_${sessionId}`)
			.setLabel(`Answer ${items.length} Question(s)`)
			.setStyle(ButtonStyle.Primary),
		new ButtonBuilder().setCustomId(`checklist_skip_${sessionId}`).setLabel("Skip All").setStyle(ButtonStyle.Secondary)
	);

	const msg = await channel.send({ embeds: [embed], components: [row] });
	const results: Record<string, string> = {};

	return new Promise((resolve) => {
		let currentStep = 0;
		const collector = msg.createMessageComponentCollector({ time: CHECKIN_TIMEOUT_MS });

		if (signal) {
			const onAbort = () => {
				msg.edit({ components: [] }).catch(() => {});
				collector.stop("done");
				resolve(results);
			};
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		const modalListener = async (i: Interaction) => {
			if (!i.isModalSubmit()) return;
			if (!i.customId.startsWith(`checklist_modal_${sessionId}_`)) return;

			const answer = i.fields.getTextInputValue("answer_input");
			results[items[currentStep].id] = answer;
			currentStep++;

			if (currentStep >= items.length) {
				await i.reply({ content: "✅ Checklist complete. Agent proceeding.", flags: 64 });
				collector.stop("done");
				channel.client.removeListener("interactionCreate", modalListener);
				resolve(results);
			} else {
								// ModalSubmitInteraction has showModal at runtime but not in discord.js types
					await showChecklistModal(i as unknown as ModalShowable, items[currentStep], currentStep, items.length, sessionId);
			}
		};

		channel.client.on("interactionCreate", modalListener);

		collector.on("collect", async (interaction) => {
			if (!interaction.isButton()) return;
			if (interaction.customId === `checklist_skip_${sessionId}`) {
				await interaction.update({ components: [] });
				collector.stop("done");
				channel.client.removeListener("interactionCreate", modalListener);
				resolve(results);
				return;
			}
			if (interaction.customId === `checklist_start_${sessionId}`) {
				await msg.edit({ components: [] });
				await showChecklistModal(interaction, items[0], 0, items.length, sessionId);
			}
		});

		collector.on("end", (_collected, reason) => {
			if (reason === "done") return;
			msg.edit({ components: [] }).catch(() => {});
			channel.client.removeListener("interactionCreate", modalListener);
			resolve(results);
		});
	});
}

/** Any interaction that supports showing a modal (ButtonInteraction, SelectMenuInteraction, etc.) */
type ModalShowable = Pick<ButtonInteraction, "showModal">;

async function showChecklistModal(
	interaction: ModalShowable,
	item: { id: string; question: string; description?: string },
	step: number,
	total: number,
	sessionId: string
) {
	const modal = new ModalBuilder()
		.setCustomId(`checklist_modal_${sessionId}_${item.id}`)
		.setTitle(`Question ${step + 1} of ${total}`);
	const input = new TextInputBuilder()
		.setCustomId("answer_input")
		.setLabel(item.question.length > 45 ? `${item.question.slice(0, 42)}...` : item.question)
		.setPlaceholder(item.description ?? "")
		.setStyle(TextInputStyle.Paragraph)
		.setRequired(true);
	modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
	await interaction.showModal(modal);
}

function splitContent(content: string, maxLen: number): string[] {
	if (content.length <= maxLen) return [content];
	const chunks: string[] = [];
	let remaining = content;
	while (remaining.length > 0) {
		chunks.push(remaining.slice(0, maxLen));
		remaining = remaining.slice(maxLen);
	}
	return chunks;
}
