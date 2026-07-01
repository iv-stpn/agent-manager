import type { LooseOptional } from "@agent-manager/db/orchestrator-schema";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	type Interaction,
	ModalBuilder,
	type TextChannel,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import { getChannel } from "./bot";

export interface Question {
	id: string;
	text: string;
	context?: string | null | undefined;
	suggestions?: string | null | undefined;
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
 * Send report embeds to a channel. If awaiting=true, also send a check-in form and wait for response.
 */
export async function sendReport(
	channelId: string,
	report: LooseOptional<ReportData>,
	sessionId: string,
	trigger: string,
	awaiting: boolean,
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
			{ name: "Await", value: awaiting ? "Yes" : "No", inline: true }
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
			const results = await Promise.allSettled(batch.map((diagram) => renderMermaid(diagram.definition)));

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

	// If not awaiting, just show queued questions as info
	if (!awaiting) {
		if (pendingQuestions.length > 0) {
			const qEmbed = new EmbedBuilder()
				.setColor(0xffaa00)
				.setTitle(`${pendingQuestions.length} Queued Question(s)`)
				.setDescription(pendingQuestions.map((q, i) => `**${i + 1}.** ${q.text}`).join("\n"));
			await channel.send({ embeds: [qEmbed] });
		}
		return null;
	}

	// Await mode: send checkin form
	return sendCheckinForm(channel, "", pendingQuestions, sessionId, trigger, signal);
}

/**
 * Send a checkin form with questions asked one by one.
 * Each step shows Back/Skip. At the end, a confirmation summary lets the user redo any answer.
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

		function isSuggestion(value: unknown): value is Suggestion {
			if (typeof value !== "object" || value === null) return false;
			if (!("id" in value) || !("title" in value)) return false;
			return typeof value.id === "string" && typeof value.title === "string";
		}

		function parseSuggestions(question: Question): Suggestion[] {
			if (!question.suggestions) return [];
			try {
				const parsed = JSON.parse(question.suggestions);
				if (!Array.isArray(parsed)) return [];
				return parsed.filter(isSuggestion);
			} catch {
				return [];
			}
		}

		/** Build the embed + buttons for a given question step and edit the message. */
		async function showQuestionStep(step: number) {
			const question = questions[step];
			const suggestions = parseSuggestions(question);

			const qEmbed = new EmbedBuilder()
				.setColor(0x5865f2)
				.setTitle(`Question ${step + 1} of ${questions.length}`)
				.setDescription(question.text);

			if (question.context) {
				qEmbed.addFields({ name: "Context", value: question.context });
			}

			const rows: ActionRowBuilder<ButtonBuilder>[] = [];

			if (suggestions.length > 0) {
				// Suggestion buttons (up to 5 per row)
				const suggestionButtons = suggestions.map((suggestion) =>
					new ButtonBuilder()
						.setCustomId(`suggest_${sessionId}_${step}_${suggestion.id}`)
						.setLabel(suggestion.title.slice(0, 80))
						.setStyle(ButtonStyle.Primary)
				);
				for (let i = 0; i < suggestionButtons.length; i += 5) {
					rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(suggestionButtons.slice(i, i + 5)));
				}
			}

			// Action row: ✏️ Custom/Answer + ⬅️ Back + Skip
			const actionButtons: ButtonBuilder[] = [];
			actionButtons.push(
				new ButtonBuilder()
					.setCustomId(`checkin_answer_${sessionId}_${step}`)
					.setLabel(suggestions.length > 0 ? "✏️ Custom" : "✏️ Answer")
					.setStyle(suggestions.length > 0 ? ButtonStyle.Secondary : ButtonStyle.Primary)
			);
			if (step > 0) {
				actionButtons.push(
					new ButtonBuilder().setCustomId(`checkin_back_${sessionId}_${step}`).setLabel("⬅️ Back").setStyle(ButtonStyle.Secondary)
				);
			}
			actionButtons.push(
				new ButtonBuilder().setCustomId(`checkin_skip_${sessionId}`).setLabel("Skip").setStyle(ButtonStyle.Danger)
			);
			rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(actionButtons));

			await msg.edit({ embeds: [qEmbed], components: rows });
		}

		/** Show the confirmation summary with all answers and Confirm/Redo buttons. */
		async function showConfirmation() {
			const summaryLines = answers.map((a, i) => {
				const q = questions[i];
				const answerPreview = a.answer.length > 100 ? `${a.answer.slice(0, 97)}...` : a.answer;
				return `**${i + 1}. ${q.text}**\n> ${answerPreview}`;
			});

			const confirmEmbed = new EmbedBuilder()
				.setColor(0x44ff88)
				.setTitle("✅ Review Your Answers")
				.setDescription(summaryLines.join("\n\n"))
				.setFooter({ text: "Confirm to resume the agent, or redo any answer." });

			const rows: ActionRowBuilder<ButtonBuilder>[] = [];

			// Redo buttons (up to 5 per row)
			const redoButtons = questions.map((_, i) =>
				new ButtonBuilder()
					.setCustomId(`checkin_redo_${sessionId}_${i}`)
					.setLabel(`Redo #${i + 1}`)
					.setStyle(ButtonStyle.Secondary)
			);
			for (let i = 0; i < redoButtons.length; i += 5) {
				rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(redoButtons.slice(i, i + 5)));
			}

			// Confirm + Skip row
			rows.push(
				new ActionRowBuilder<ButtonBuilder>().addComponents(
					new ButtonBuilder().setCustomId(`checkin_confirm_${sessionId}`).setLabel("✅ Confirm").setStyle(ButtonStyle.Success),
					new ButtonBuilder().setCustomId(`checkin_skip_${sessionId}`).setLabel("Skip").setStyle(ButtonStyle.Danger)
				)
			);

			await msg.edit({ embeds: [confirmEmbed], components: rows });
		}

		const modalListener = async (i: Interaction) => {
			if (!i.isModalSubmit()) return;
			if (!i.customId.startsWith(`checkin_modal_${sessionId}_`)) return;

			const answer = i.fields.getTextInputValue("answer_input");
			// Acknowledge the modal
			await i.deferUpdate().catch(() => i.reply({ content: "✅", flags: 64 }).catch(() => {}));

			// Store answer at the current step (overwrite if redoing)
			answers[currentStep] = { questionId: questions[currentStep].id, answer };
			currentStep++;

			if (currentStep >= questions.length) {
				await showConfirmation();
			} else {
				await showQuestionStep(currentStep);
			}
		};

		channel.client.on("interactionCreate", modalListener);

		collector.on("collect", async (interaction) => {
			if (!interaction.isButton()) return;

			// Skip button (available at every step)
			if (interaction.customId === `checkin_skip_${sessionId}`) {
				await interaction.update({ embeds: [], components: [], content: "⏭ Skipped. Agent resuming." });
				cleanup();
				resolve({ answers: [], confirmed: false });
				return;
			}

			// Start button
			if (interaction.customId === `checkin_start_${sessionId}`) {
				if (questions.length === 0) {
					await interaction.update({ embeds: [], components: [], content: "✅ Acknowledged. Agent resuming." });
					cleanup();
					resolve({ answers: [], confirmed: true });
					return;
				}
				currentStep = 0;
				await interaction.deferUpdate();
				await showQuestionStep(0);
				return;
			}

			// Answer button → open modal
			if (interaction.customId.startsWith(`checkin_answer_${sessionId}_`)) {
				const question = questions[currentStep];
				const modal = new ModalBuilder()
					.setCustomId(`checkin_modal_${sessionId}_${currentStep}`)
					.setTitle(`Question ${currentStep + 1} of ${questions.length}`);
				const input = new TextInputBuilder()
					.setCustomId("answer_input")
					.setLabel(question.text.length > 45 ? `${question.text.slice(0, 42)}...` : question.text)
					.setStyle(TextInputStyle.Paragraph)
					.setRequired(true);
				if (answers[currentStep]) {
					input.setValue(answers[currentStep].answer);
				}
				modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
				await interaction.showModal(modal);
				return;
			}

			// Back button
			if (interaction.customId.startsWith(`checkin_back_${sessionId}_`)) {
				currentStep = Math.max(0, currentStep - 1);
				await interaction.deferUpdate();
				await showQuestionStep(currentStep);
				return;
			}

			// Suggestion button
			if (interaction.customId.startsWith(`suggest_${sessionId}_`)) {
				const parts = interaction.customId.split("_");

				// Format: suggest_{sessionId}_{step}_{suggestionId}
				const suggestionId = parts[parts.length - 1];
				const question = questions[currentStep];

				const suggestions = parseSuggestions(question);
				const selected = suggestions.find((suggestion) => suggestion.id === suggestionId);

				answers[currentStep] = { questionId: question.id, answer: selected?.title ?? suggestionId };
				currentStep++;

				await interaction.deferUpdate();
				if (currentStep >= questions.length) await showConfirmation();
				else await showQuestionStep(currentStep);

				return;
			}

			// Redo button from confirmation screen
			if (interaction.customId.startsWith(`checkin_redo_${sessionId}_`)) {
				const stepStr = interaction.customId.split("_").pop();
				const step = Number.parseInt(stepStr ?? "0", 10);
				currentStep = step;
				await interaction.deferUpdate();
				await showQuestionStep(step);
				return;
			}

			// Confirm button
			if (interaction.customId === `checkin_confirm_${sessionId}`) {
				await interaction.update({ embeds: [], components: [], content: "✅ All answers confirmed. Agent resuming." });
				cleanup();
				resolve({ answers: answers.filter(Boolean), confirmed: true });
				return;
			}
		});

		collector.on("end", (_, reason) => {
			if (reason === "done") return;
			msg.edit({ components: [] }).catch(() => {});
			channel.client.removeListener("interactionCreate", modalListener);
			resolve({ answers: [], confirmed: false });
		});
	});
}

/**
 * Send structured questions with options as buttons. Each question is shown one at a time.
 * Users pick from options or type a custom answer via a modal.
 */
export async function sendQuestions(
	channelId: string,
	sessionId: string,
	title: string,
	questions: Array<{
		question: string;
		header: string;
		options: Array<{ label: string; description: string }>;
		multiSelect?: boolean | undefined;
	}>,
	urgent?: boolean,
	signal?: AbortSignal
): Promise<Record<string, string>> {
	const maybeChannel = await getChannel(channelId);
	if (!maybeChannel) return {};
	const channel = maybeChannel;

	const embedColor = urgent ? 0xff4444 : 0x5865f2;

	// Overview embed showing all questions
	const embed = new EmbedBuilder()
		.setColor(embedColor)
		.setTitle(`${urgent ? "🚨 " : ""}${title}`)
		.setDescription(questions.map((q, i) => `**${i + 1}.** \`${q.header}\` — ${q.question}`).join("\n\n"));

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(`q_start_${sessionId}`)
			.setLabel(`Answer ${questions.length} Question(s)`)
			.setStyle(urgent ? ButtonStyle.Danger : ButtonStyle.Primary),
		new ButtonBuilder().setCustomId(`q_skip_${sessionId}`).setLabel("Skip All").setStyle(ButtonStyle.Secondary)
	);

	const msg = await channel.send({ embeds: [embed], components: [row] });
	const results: Record<string, string> = {};

	return new Promise((resolve) => {
		let currentStep = 0;
		// For multiSelect, track selected options per step
		const multiSelections: Map<number, Set<string>> = new Map();
		const collector = msg.createMessageComponentCollector({ time: CHECKIN_TIMEOUT_MS });

		if (signal) {
			const onAbort = () => {
				msg.edit({ components: [] }).catch(() => {});
				cleanup();
				resolve(results);
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

		/** Show a single question with option buttons + custom answer button + navigation. */
		async function showStep(step: number) {
			const q = questions[step];
			const isMulti = q.multiSelect ?? false;

			const qEmbed = new EmbedBuilder()
				.setColor(embedColor)
				.setTitle(`${urgent ? "🚨 " : ""}${title} — ${q.header} (${step + 1}/${questions.length})`)
				.setDescription(`**${q.question}**${isMulti ? "\n\n_Select one or more options, then press Done._" : ""}`);

			// Option buttons row(s)
			const optionButtons: ButtonBuilder[] = q.options.map((opt, oi) => {
				const selected = isMulti && multiSelections.get(step)?.has(opt.label);
				return new ButtonBuilder()
					.setCustomId(`q_opt_${sessionId}_${step}_${oi}`)
					.setLabel(`${selected ? "✅ " : ""}${opt.label}`)
					.setStyle(selected ? ButtonStyle.Success : ButtonStyle.Primary);
			});

			const rows: ActionRowBuilder<ButtonBuilder>[] = [];
			// Options row (max 5 per row)
			for (let i = 0; i < optionButtons.length; i += 5) {
				rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(optionButtons.slice(i, i + 5)));
			}

			// Navigation row
			const navButtons: ButtonBuilder[] = [];
			if (isMulti) {
				navButtons.push(
					new ButtonBuilder().setCustomId(`q_multidone_${sessionId}_${step}`).setLabel("✅ Done").setStyle(ButtonStyle.Success)
				);
			}
			navButtons.push(
				new ButtonBuilder()
					.setCustomId(`q_custom_${sessionId}_${step}`)
					.setLabel("✏️ Custom Answer")
					.setStyle(ButtonStyle.Secondary)
			);
			if (step > 0) {
				navButtons.push(
					new ButtonBuilder().setCustomId(`q_back_${sessionId}_${step}`).setLabel("⬅️ Back").setStyle(ButtonStyle.Secondary)
				);
			}
			navButtons.push(new ButtonBuilder().setCustomId(`q_skip_${sessionId}`).setLabel("Skip All").setStyle(ButtonStyle.Danger));
			rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(navButtons));

			await msg.edit({ embeds: [qEmbed], components: rows });
		}

		/** Show confirmation with all answers and Confirm/Redo buttons. */
		async function showConfirmation() {
			const summaryLines = questions.map((q, i) => {
				const answer = results[q.header];
				const preview = answer && answer.length > 100 ? `${answer.slice(0, 97)}...` : (answer ?? "_skipped_");
				return `**${i + 1}. ${q.header}** — ${q.question}\n> ${preview}`;
			});

			const confirmEmbed = new EmbedBuilder()
				.setColor(0x44ff88)
				.setTitle(`✅ ${title} — Review`)
				.setDescription(summaryLines.join("\n\n"))
				.setFooter({ text: "Confirm to proceed, or redo any answer." });

			const rows: ActionRowBuilder<ButtonBuilder>[] = [];
			const redoButtons = questions.map((_, i) =>
				new ButtonBuilder()
					.setCustomId(`q_redo_${sessionId}_${i}`)
					.setLabel(`Redo #${i + 1}`)
					.setStyle(ButtonStyle.Secondary)
			);
			for (let i = 0; i < redoButtons.length; i += 5) {
				rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(redoButtons.slice(i, i + 5)));
			}
			rows.push(
				new ActionRowBuilder<ButtonBuilder>().addComponents(
					new ButtonBuilder().setCustomId(`q_confirm_${sessionId}`).setLabel("✅ Confirm").setStyle(ButtonStyle.Success),
					new ButtonBuilder().setCustomId(`q_skip_${sessionId}`).setLabel("Skip All").setStyle(ButtonStyle.Danger)
				)
			);

			await msg.edit({ embeds: [confirmEmbed], components: rows });
		}

		function advanceStep() {
			currentStep++;
			if (currentStep >= questions.length) {
				showConfirmation();
			} else {
				showStep(currentStep);
			}
		}

		const modalListener = async (i: Interaction) => {
			if (!i.isModalSubmit()) return;
			if (!i.customId.startsWith(`q_modal_${sessionId}_`)) return;

			const answer = i.fields.getTextInputValue("answer_input");
			await i.deferUpdate().catch(() => i.reply({ content: "✅", flags: 64 }).catch(() => {}));

			results[questions[currentStep].header] = answer;
			advanceStep();
		};

		channel.client.on("interactionCreate", modalListener);

		collector.on("collect", async (interaction) => {
			if (!interaction.isButton()) return;

			// Skip all
			if (interaction.customId === `q_skip_${sessionId}`) {
				await interaction.update({ embeds: [], components: [], content: "⏭ Questions skipped." });
				cleanup();
				resolve(results);
				return;
			}

			// Start
			if (interaction.customId === `q_start_${sessionId}`) {
				currentStep = 0;
				await interaction.deferUpdate();
				await showStep(0);
				return;
			}

			// Option selection
			if (interaction.customId.startsWith(`q_opt_${sessionId}_`)) {
				// Format: q_opt_{sessionId}_{step}_{oi} — sessionId may contain "_",
				// so parse the trailing numeric segments from the end.
				const parts = interaction.customId.split("_");
				const optionIdx = Number.parseInt(parts[parts.length - 1], 10);

				const step = Number.parseInt(parts[parts.length - 2], 10);
				const question = questions[step];

				const isMulti = question.multiSelect ?? false;
				const selectedLabel = question.options[optionIdx].label;

				if (isMulti) {
					// Toggle selection
					if (!multiSelections.has(step)) multiSelections.set(step, new Set());
					const sel = multiSelections.get(step) ?? new Set();
					if (sel.has(selectedLabel)) sel.delete(selectedLabel);
					else sel.add(selectedLabel);
					await interaction.deferUpdate();
					await showStep(step);
				} else {
					// Single select — record and advance
					results[question.header] = selectedLabel;
					await interaction.deferUpdate();
					advanceStep();
				}
				return;
			}

			// MultiSelect done
			if (interaction.customId.startsWith(`q_multidone_${sessionId}_`)) {
				const step = Number.parseInt(interaction.customId.split("_").pop() ?? "0", 10);
				const selection = multiSelections.get(step);

				results[questions[step].header] = selection && selection.size > 0 ? [...selection].join(", ") : "_no selection_";
				await interaction.deferUpdate();
				advanceStep();
				return;
			}

			// Custom answer → open modal
			if (interaction.customId.startsWith(`q_custom_${sessionId}_`)) {
				const question = questions[currentStep];
				const modal = new ModalBuilder()
					.setCustomId(`q_modal_${sessionId}_${currentStep}`)
					.setTitle(question.header.length > 45 ? `${question.header.slice(0, 42)}...` : question.header);

				const input = new TextInputBuilder()
					.setCustomId("answer_input")
					.setLabel(question.question.length > 45 ? `${question.question.slice(0, 42)}...` : question.question)
					.setPlaceholder("Type your answer...")
					.setStyle(TextInputStyle.Paragraph)
					.setRequired(true);
				if (results[question.header]) {
					input.setValue(results[question.header]);
				}
				modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
				await interaction.showModal(modal);
				return;
			}

			// Back
			if (interaction.customId.startsWith(`q_back_${sessionId}_`)) {
				currentStep = Math.max(0, currentStep - 1);
				await interaction.deferUpdate();
				await showStep(currentStep);
				return;
			}

			// Redo from confirmation
			if (interaction.customId.startsWith(`q_redo_${sessionId}_`)) {
				const stepStr = interaction.customId.split("_").pop();
				const step = Number.parseInt(stepStr ?? "0", 10);
				currentStep = step;
				await interaction.deferUpdate();
				await showStep(step);
				return;
			}

			// Confirm
			if (interaction.customId === `q_confirm_${sessionId}`) {
				await interaction.update({ embeds: [], components: [], content: "✅ Questions answered. Agent proceeding." });
				cleanup();
				resolve(results);
				return;
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
