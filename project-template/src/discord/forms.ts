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
import type { Question } from "../db";

export interface Suggestion {
	id: string;
	title: string;
	subtitle?: string;
}

export interface CheckinFormResult {
	answers: Array<{ questionId: string; answer: string }>;
	confirmed: boolean;
}

const CHECKIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes to respond

export async function sendCheckinForm(
	channel: TextChannel,
	summary: string,
	questions: Question[],
	sessionId: string,
	trigger: string,
	signal?: AbortSignal
): Promise<CheckinFormResult> {
	const triggerLabel =
		trigger === "timer"
			? "⏱ Scheduled Check-in"
			: trigger === "urgent"
				? "🚨 Agent Needs Help"
				: trigger === "completion"
					? "✅ Task Complete"
					: trigger === "compaction"
						? "🗜 Context Compacted"
						: "📋 Manual Check-in";

	const summaryEmbed = new EmbedBuilder()
		.setColor(trigger === "urgent" ? 0xff4444 : trigger === "completion" ? 0x44ff88 : 0x5865f2)
		.setTitle(triggerLabel)
		.setDescription(summary || null)
		.addFields(
			{ name: "Session", value: `\`${sessionId.slice(0, 8)}...\``, inline: true },
			{
				name: "Questions",
				value: questions.length > 0 ? `${questions.length} pending` : "None",
				inline: true,
			}
		)
		.setTimestamp();

	const startRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(`checkin_start_${sessionId}`)
			.setLabel(questions.length > 0 ? `Answer ${questions.length} Question(s)` : "Acknowledge")
			.setStyle(ButtonStyle.Primary),
		new ButtonBuilder().setCustomId(`checkin_skip_${sessionId}`).setLabel("Skip").setStyle(ButtonStyle.Secondary)
	);

	const msg = await channel.send({ embeds: [summaryEmbed], components: [startRow] });

	return new Promise((resolve) => {
		const answers: Array<{ questionId: string; answer: string }> = [];
		let currentStep = 0;

		const collector = msg.createMessageComponentCollector({
			time: CHECKIN_TIMEOUT_MS,
		});

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

		function parseSuggestions(q: Question): Suggestion[] {
			if (!q.suggestions) return [];
			try {
				return JSON.parse(q.suggestions) as Suggestion[];
			} catch {
				return [];
			}
		}

		/** Show the current question — either as suggestion buttons or a modal */
		async function presentQuestion(
			interaction: ButtonInteraction | ModalSubmitInteraction,
			step: number,
			replyMethod: "reply" | "update"
		) {
			const question = questions[step];
			const suggestions = parseSuggestions(question);

			if (suggestions.length > 0) {
				// Render embed with suggestion buttons
				const qEmbed = new EmbedBuilder()
					.setColor(0x5865f2)
					.setTitle(`Question ${step + 1} of ${questions.length}`)
					.setDescription(question.text)
					.setFooter(question.context ? { text: question.context } : null);

				// Add suggestion descriptions as fields
				for (const s of suggestions) {
					if (s.subtitle) {
						qEmbed.addFields({ name: s.title, value: s.subtitle, inline: true });
					}
				}

				// Build button rows (max 5 buttons per row, max 5 rows)
				const rows: ActionRowBuilder<ButtonBuilder>[] = [];
				const allButtons = suggestions.map((s) =>
					new ButtonBuilder()
						.setCustomId(`suggest_${sessionId}_${question.id}_${s.id}`)
						.setLabel(s.title.slice(0, 80))
						.setStyle(ButtonStyle.Primary)
				);
				// Add "Custom answer" button
				allButtons.push(
					new ButtonBuilder()
						.setCustomId(`custom_answer_${sessionId}_${question.id}_${step}`)
						.setLabel("✏️ Custom answer")
						.setStyle(ButtonStyle.Secondary)
				);

				for (let i = 0; i < allButtons.length; i += 5) {
					rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(allButtons.slice(i, i + 5)));
				}

				if (replyMethod === "reply") {
					await interaction.reply({ embeds: [qEmbed], components: rows, ephemeral: true });
				} else {
					await (interaction as ButtonInteraction).update({ embeds: [qEmbed], components: rows });
				}
			} else {
				// No suggestions — use modal for free-form input
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
				} else {
					// From a modal submit — show a button to trigger the next modal
					const qEmbed = new EmbedBuilder()
						.setColor(0x5865f2)
						.setTitle(`Question ${step + 1} of ${questions.length}`)
						.setDescription(question.text)
						.setFooter(question.context ? { text: question.context } : null);
					await interaction.reply({
						embeds: [qEmbed],
						components: [
							new ActionRowBuilder<ButtonBuilder>().addComponents(
								new ButtonBuilder()
									.setCustomId(`show_modal_${sessionId}_${question.id}_${step}`)
									.setLabel("Answer")
									.setStyle(ButtonStyle.Primary)
							),
						],
						ephemeral: true,
					});
				}
			}
		}

		/** Show the review/confirm step */
		async function showVerifyStep(interaction: ButtonInteraction | ModalSubmitInteraction) {
			const verifyEmbed = new EmbedBuilder()
				.setColor(0xffa500)
				.setTitle("✅ Review Your Answers")
				.setDescription("Please review your responses before confirming:");

			for (let i = 0; i < questions.length; i++) {
				const q = questions[i];
				const a = answers.find((x) => x.questionId === q.id);
				verifyEmbed.addFields({
					name: `Q${i + 1}: ${q.text.slice(0, 80)}`,
					value: a?.answer ?? "_skipped_",
				});
			}

			const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(`checkin_confirm_${sessionId}`)
					.setLabel("Confirm & Resume Agent")
					.setStyle(ButtonStyle.Success),
				new ButtonBuilder().setCustomId(`checkin_edit_${sessionId}`).setLabel("Edit Answers").setStyle(ButtonStyle.Secondary),
				new ButtonBuilder().setCustomId(`checkin_restart_${sessionId}`).setLabel("Start Over").setStyle(ButtonStyle.Danger)
			);

			await interaction.reply({
				embeds: [verifyEmbed],
				components: [confirmRow],
				ephemeral: true,
			});
		}

		function advanceStep(questionId: string, answer: string) {
			// Replace if already answered (edit mode), otherwise push
			const existing = answers.findIndex((a) => a.questionId === questionId);
			if (existing >= 0) {
				answers[existing].answer = answer;
			} else {
				answers.push({ questionId, answer });
			}
			currentStep++;
		}

		const modalListener = async (interaction: Interaction) => {
			if (!interaction.isModalSubmit()) return;
			if (!interaction.customId.startsWith(`answer_modal_${sessionId}_`)) return;

			const parts = interaction.customId.split("_");
			const questionId = parts[parts.length - 1] ?? "";
			const answer = interaction.fields.getTextInputValue("answer_input");

			advanceStep(questionId, answer);

			if (currentStep < questions.length) {
				await presentQuestion(interaction, currentStep, "reply");
			} else {
				await showVerifyStep(interaction);
			}
		};

		channel.client.on("interactionCreate", modalListener);

		collector.on("collect", async (interaction) => {
			if (!interaction.isButton()) return;

			if (interaction.customId === `checkin_start_${sessionId}`) {
				if (questions.length === 0) {
					await interaction.reply({
						content: "✅ Acknowledged! The agent will continue.",
						ephemeral: true,
					});
					cleanup();
					resolve({ answers: [], confirmed: true });
					return;
				}
				await presentQuestion(interaction, 0, "reply");
			} else if (interaction.customId === `checkin_skip_${sessionId}`) {
				await interaction.reply({ content: "Check-in skipped.", ephemeral: true });
				cleanup();
				resolve({ answers: [], confirmed: false });
			} else if (interaction.customId === `checkin_confirm_${sessionId}`) {
				await interaction.reply({
					content: "✅ Confirmed! The agent will continue with your answers.",
					ephemeral: true,
				});
				await msg.edit({ components: [] });
				cleanup();
				resolve({ answers, confirmed: true });
			} else if (interaction.customId === `checkin_restart_${sessionId}`) {
				answers.length = 0;
				currentStep = 0;
				await interaction.reply({
					content: "Restarting questions from the beginning.",
					ephemeral: true,
				});
				await msg.edit({ components: [startRow] });
			} else if (interaction.customId === `checkin_edit_${sessionId}`) {
				// Let user re-answer from step 0 but keep existing answers as starting point
				currentStep = 0;
				await presentQuestion(interaction, 0, "reply");
			} else if (interaction.customId.startsWith(`suggest_${sessionId}_`)) {
				// User clicked a suggestion button
				const parts = interaction.customId.split("_");
				// Format: suggest_<sessionId>_<questionId>_<suggestionId>
				const questionId = parts[2] ?? "";
				const suggestionId = parts.slice(3).join("_");
				const question = questions[currentStep];
				const suggestions = parseSuggestions(question);
				const chosen = suggestions.find((s) => s.id === suggestionId);
				const answer = chosen?.title ?? suggestionId;

				advanceStep(questionId, answer);

				if (currentStep < questions.length) {
					await presentQuestion(interaction, currentStep, "reply");
				} else {
					await showVerifyStep(interaction);
				}
			} else if (interaction.customId.startsWith(`custom_answer_${sessionId}_`)) {
				// User wants to type a custom answer — show modal
				const parts = interaction.customId.split("_");
				const questionId = parts[parts.length - 2] ?? "";
				const stepNum = Number.parseInt(parts[parts.length - 1] ?? "0", 10);
				const _question = questions[stepNum];
				const modal = new ModalBuilder()
					.setCustomId(`answer_modal_${sessionId}_${questionId}`)
					.setTitle(`Question ${stepNum + 1} of ${questions.length}`);
				const input = new TextInputBuilder()
					.setCustomId("answer_input")
					.setLabel("Your answer")
					.setStyle(TextInputStyle.Paragraph)
					.setRequired(true);
				modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
				await interaction.showModal(modal);
			} else if (interaction.customId.startsWith(`show_modal_${sessionId}_`)) {
				const parts = interaction.customId.split("_");
				const qId = parts[parts.length - 2] ?? "";
				const stepNum = Number.parseInt(parts[parts.length - 1] ?? "0", 10);
				const modal = new ModalBuilder()
					.setCustomId(`answer_modal_${sessionId}_${qId}`)
					.setTitle(`Question ${stepNum + 1} of ${questions.length}`);
				const input = new TextInputBuilder()
					.setCustomId("answer_input")
					.setLabel("Your answer")
					.setStyle(TextInputStyle.Paragraph)
					.setRequired(true);
				modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
				await interaction.showModal(modal);
			}
		});

		collector.on("end", (_collected, reason) => {
			if (reason === "time") {
				msg.edit({ components: [] }).catch(() => {});
				cleanup();
				resolve({ answers, confirmed: false });
			}
		});

		function cleanup() {
			collector.stop();
			channel.client.removeListener("interactionCreate", modalListener);
		}
	});
}

// ── Checklist form ────────────────────────────────────────────────────────────

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

const MODAL_FIELD_LIMIT = 5;
const CHECKLIST_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

/**
 * Send a multi-question checklist to Discord, batched into modals of 5 fields each.
 * Used by ask_checklist at the start of implementation.
 */
export async function sendChecklistForm(
	channel: TextChannel,
	title: string,
	items: ChecklistItem[],
	sessionId: string,
	signal?: AbortSignal
): Promise<ChecklistResult> {
	const batches: ChecklistItem[][] = [];
	for (let i = 0; i < items.length; i += MODAL_FIELD_LIMIT) {
		batches.push(items.slice(i, i + MODAL_FIELD_LIMIT));
	}

	const headerEmbed = new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle(`📋 ${title}`)
		.setDescription(
			`The agent has **${items.length} question(s)** to ask before implementation begins.\n\n${items
				.map((it, i) => `${i + 1}. ${it.question}`)
				.join("\n")
				.slice(0, 1800)}`
		)
		.addFields(
			{ name: "Questions", value: `${items.length}`, inline: true },
			{ name: "Batches", value: `${batches.length}`, inline: true }
		)
		.setFooter({ text: `Session ${sessionId.slice(0, 8)}` })
		.setTimestamp();

	const startRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(`cl_start_${sessionId}`).setLabel("Answer Questions").setStyle(ButtonStyle.Primary),
		new ButtonBuilder().setCustomId(`cl_skip_${sessionId}`).setLabel("Skip (agent decides)").setStyle(ButtonStyle.Secondary)
	);

	const msg = await channel.send({ embeds: [headerEmbed], components: [startRow] });

	return new Promise((resolve) => {
		const answers: Record<string, string> = {};
		let currentBatch = 0;

		const collector = msg.createMessageComponentCollector({
			time: CHECKLIST_TIMEOUT_MS,
		});

		if (signal) {
			const onAbort = () => {
				msg.edit({ components: [] }).catch(() => {});
				cleanup();
				resolve({ answers, completed: false });
			};
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		const modalListener = async (interaction: Interaction) => {
			if (!interaction.isModalSubmit()) return;
			if (!interaction.customId.startsWith(`cl_batch_${sessionId}_`)) return;

			const batchIdx = Number.parseInt(interaction.customId.split("_").pop() ?? "0", 10);
			const batch = batches[batchIdx];

			// Collect answers from this batch
			for (const item of batch) {
				try {
					const val = interaction.fields.getTextInputValue(`cl_field_${item.id}`);
					if (val) answers[item.id] = val;
				} catch {
					// optional field not filled
				}
			}

			currentBatch = batchIdx + 1;

			if (currentBatch < batches.length) {
				// Show next batch prompt
				const nextBatch = batches[currentBatch];
				const progressEmbed = new EmbedBuilder()
					.setColor(0x5865f2)
					.setTitle(`📋 ${title} — Batch ${currentBatch + 1}/${batches.length}`)
					.setDescription(
						nextBatch
							.map((it) => `**${it.question}**${it.description ? `\n> ${it.description}` : ""}`)
							.join("\n\n")
							.slice(0, 1800)
					);
				await interaction.reply({
					embeds: [progressEmbed],
					components: [
						new ActionRowBuilder<ButtonBuilder>().addComponents(
							new ButtonBuilder()
								.setCustomId(`cl_next_${sessionId}_${currentBatch}`)
								.setLabel(`Answer Batch ${currentBatch + 1}/${batches.length}`)
								.setStyle(ButtonStyle.Primary)
						),
					],
					ephemeral: true,
				});
			} else {
				// All batches done — show confirmation
				const fields = Object.entries(answers);
				const confirmEmbed = new EmbedBuilder()
					.setColor(0x44ff88)
					.setTitle("✅ Checklist Complete — Review Answers")
					.setDescription(
						fields.length > 0
							? fields
									.map(([id, ans]) => {
										const item = items.find((it) => it.id === id);
										return `**${item?.question ?? id}**\n${ans}`;
									})
									.join("\n\n")
									.slice(0, 3800)
							: "_No answers provided — agent will proceed with best judgment._"
					);
				await interaction.reply({
					embeds: [confirmEmbed],
					components: [
						new ActionRowBuilder<ButtonBuilder>().addComponents(
							new ButtonBuilder()
								.setCustomId(`cl_confirm_${sessionId}`)
								.setLabel("Confirm & Start Implementation")
								.setStyle(ButtonStyle.Success),
							new ButtonBuilder().setCustomId(`cl_restart_${sessionId}`).setLabel("Start Over").setStyle(ButtonStyle.Danger)
						),
					],
					ephemeral: true,
				});
			}
		};

		channel.client.on("interactionCreate", modalListener);

		const showBatchModal = async (interaction: ButtonInteraction, batchIdx: number) => {
			const batch = batches[batchIdx];
			const modal = new ModalBuilder()
				.setCustomId(`cl_batch_${sessionId}_${batchIdx}`)
				.setTitle(`${title} (${batchIdx + 1}/${batches.length})`);

			for (const item of batch) {
				const input = new TextInputBuilder()
					.setCustomId(`cl_field_${item.id}`)
					.setLabel(item.question.length > 45 ? `${item.question.slice(0, 42)}...` : item.question)
					.setStyle(TextInputStyle.Paragraph)
					.setRequired(item.required ?? false);
				if (item.description) input.setPlaceholder(item.description.slice(0, 100));
				modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
			}

			await interaction.showModal(modal);
		};

		collector.on("collect", async (interaction) => {
			if (!interaction.isButton()) return;

			if (interaction.customId === `cl_start_${sessionId}`) {
				await showBatchModal(interaction, 0);
			} else if (interaction.customId === `cl_skip_${sessionId}`) {
				await interaction.reply({
					content: "Checklist skipped — agent will proceed.",
					ephemeral: true,
				});
				await msg.edit({ components: [] });
				cleanup();
				resolve({ answers: {}, completed: false });
			} else if (interaction.customId.startsWith(`cl_next_${sessionId}_`)) {
				const batchIdx = Number.parseInt(interaction.customId.split("_").pop() ?? "0", 10);
				await showBatchModal(interaction, batchIdx);
			} else if (interaction.customId === `cl_confirm_${sessionId}`) {
				await interaction.reply({ content: "✅ Implementation starting!", ephemeral: true });
				await msg.edit({ components: [] });
				cleanup();
				resolve({ answers, completed: true });
			} else if (interaction.customId === `cl_restart_${sessionId}`) {
				// Reset and start over
				for (const key of Object.keys(answers)) delete answers[key];
				currentBatch = 0;
				await interaction.reply({
					content: "Restarting checklist from the beginning.",
					ephemeral: true,
				});
				await msg.edit({ components: [startRow] });
			}
		});

		collector.on("end", (_c, reason) => {
			if (reason === "time") {
				msg.edit({ components: [] }).catch(() => {});
				cleanup();
				resolve({ answers, completed: Object.keys(answers).length > 0 });
			}
		});

		function cleanup() {
			collector.stop();
			channel.client.removeListener("interactionCreate", modalListener);
		}
	});
}
