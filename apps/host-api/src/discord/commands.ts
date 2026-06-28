import { type ChatInputCommandInteraction, REST, Routes, SlashCommandBuilder } from "discord.js";

export const COMMANDS = [
	new SlashCommandBuilder()
		.setName("timeout")
		.setDescription("Change the agent run timeout (minutes)")
		.addNumberOption((o) => o.setName("minutes").setDescription("Timeout in minutes (1–1440)").setRequired(true))
		.addStringOption((o) => o.setName("project").setDescription("Project ID"))
		.addStringOption((o) => o.setName("session").setDescription("Session ID")),

	new SlashCommandBuilder()
		.setName("report-interval")
		.setDescription("Change the automatic report interval (minutes)")
		.addNumberOption((o) => o.setName("minutes").setDescription("Minutes between reports (0 to disable)").setRequired(true))
		.addStringOption((o) => o.setName("project").setDescription("Project ID"))
		.addStringOption((o) => o.setName("session").setDescription("Session ID")),

	new SlashCommandBuilder()
		.setName("freeze-report")
		.setDescription("Control whether reports freeze the agent")
		.addStringOption((o) =>
			o
				.setName("mode")
				.setDescription("always | never | custom")
				.setRequired(true)
				.addChoices({ name: "always", value: "always" }, { name: "never", value: "never" }, { name: "custom", value: "custom" })
		)
		.addStringOption((o) => o.setName("rule").setDescription("Custom rule (when mode=custom)"))
		.addStringOption((o) => o.setName("project").setDescription("Project ID"))
		.addStringOption((o) => o.setName("session").setDescription("Session ID")),

	new SlashCommandBuilder()
		.setName("freeze-ask")
		.setDescription("Control how questions are sent to the user")
		.addStringOption((o) =>
			o
				.setName("mode")
				.setDescription("always | requiredOnly | onReportOnly | never")
				.setRequired(true)
				.addChoices(
					{ name: "always", value: "always" },
					{ name: "requiredOnly", value: "requiredOnly" },
					{ name: "onReportOnly", value: "onReportOnly" },
					{ name: "never", value: "never" }
				)
		)
		.addStringOption((o) => o.setName("project").setDescription("Project ID"))
		.addStringOption((o) => o.setName("session").setDescription("Session ID")),

	new SlashCommandBuilder()
		.setName("compact-threshold")
		.setDescription("Change the auto-compaction token threshold")
		.addNumberOption((o) => o.setName("tokens").setDescription("Threshold in tokens (0 to disable)").setRequired(true))
		.addStringOption((o) => o.setName("project").setDescription("Project ID"))
		.addStringOption((o) => o.setName("session").setDescription("Session ID")),

	new SlashCommandBuilder()
		.setName("stop-threshold")
		.setDescription("Change the cumulative token budget for auto-stop")
		.addNumberOption((o) => o.setName("tokens").setDescription("Token budget (0 to disable)").setRequired(true))
		.addStringOption((o) => o.setName("project").setDescription("Project ID"))
		.addStringOption((o) => o.setName("session").setDescription("Session ID")),

	new SlashCommandBuilder()
		.setName("always-improve")
		.setDescription("Control what happens after the original task is complete")
		.addStringOption((o) =>
			o
				.setName("mode")
				.setDescription("yes | no | custom")
				.setRequired(true)
				.addChoices({ name: "yes", value: "yes" }, { name: "no", value: "no" }, { name: "custom", value: "custom" })
		)
		.addStringOption((o) => o.setName("scope").setDescription("Scope of improvements (when mode=custom)"))
		.addStringOption((o) => o.setName("project").setDescription("Project ID"))
		.addStringOption((o) => o.setName("session").setDescription("Session ID")),

	new SlashCommandBuilder()
		.setName("agent-stop")
		.setDescription("Stop a running session")
		.addStringOption((o) => o.setName("project").setDescription("Project ID"))
		.addStringOption((o) => o.setName("session").setDescription("Session ID")),

	new SlashCommandBuilder()
		.setName("agent-status")
		.setDescription("Show status of running sessions")
		.addStringOption((o) => o.setName("project").setDescription("Project ID")),
];

export async function registerCommands(token: string, clientId: string) {
	const rest = new REST({ version: "10" }).setToken(token);
	await rest.put(Routes.applicationCommands(clientId), {
		body: COMMANDS.map((c) => c.toJSON()),
	});
	console.log("[Discord] Slash commands registered");
}

/**
 * Forward settings commands to the project's agent server.
 * The host-api knows each project's port from its config.
 */
let _resolveProject: ((projectId: string) => Promise<{ port: number } | null>) | null = null;

export function setProjectResolver(resolver: (projectId: string) => Promise<{ port: number } | null>) {
	_resolveProject = resolver;
}

export async function handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
	const projectId = interaction.options.getString("project") ?? undefined;
	const sessionId = interaction.options.getString("session") ?? undefined;

	// For settings commands, forward to the project's agent server
	const settingsCommands = [
		"timeout",
		"report-interval",
		"freeze-report",
		"freeze-ask",
		"compact-threshold",
		"stop-threshold",
		"always-improve",
	];

	if (settingsCommands.includes(interaction.commandName)) {
		if (!projectId) {
			await interaction.reply({ content: "❌ `project` is required for settings commands.", ephemeral: true });
			return;
		}
		if (!_resolveProject) {
			await interaction.reply({ content: "❌ Project resolver not configured.", ephemeral: true });
			return;
		}

		const project = await _resolveProject(projectId);
		if (!project) {
			await interaction.reply({ content: `❌ Project \`${projectId}\` not found or not running.`, ephemeral: true });
			return;
		}

		// Build the settings payload
		const payload: Record<string, unknown> = { sessionId };

		switch (interaction.commandName) {
			case "timeout":
				payload.totalTimeoutMins = Math.max(1, Math.min(1440, interaction.options.getNumber("minutes", true)));
				break;
			case "report-interval":
				payload.reportIntervalMins = Math.max(0, interaction.options.getNumber("minutes", true));
				break;
			case "freeze-report":
				payload.freezeReportMode = interaction.options.getString("mode", true);
				payload.freezeReportCustomRule = interaction.options.getString("rule") ?? null;
				break;
			case "freeze-ask":
				payload.freezeAskMode = interaction.options.getString("mode", true);
				break;
			case "compact-threshold":
				payload.compactThresholdTokens = Math.max(0, interaction.options.getNumber("tokens", true));
				break;
			case "stop-threshold":
				payload.stopThresholdTokens = Math.max(0, interaction.options.getNumber("tokens", true));
				break;
			case "always-improve":
				payload.alwaysImproveMode = interaction.options.getString("mode", true);
				payload.alwaysImproveScope = interaction.options.getString("scope") ?? null;
				break;
		}

		try {
			const res = await fetch(`http://localhost:${project.port}/api/sessions/${sessionId}/settings`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			if (!res.ok) {
				const err = await res.text();
				await interaction.reply({ content: `❌ Failed: ${err}`, ephemeral: true });
				return;
			}
			await interaction.reply(`✅ \`${interaction.commandName}\` updated for project \`${projectId.slice(0, 8)}…\``);
		} catch {
			await interaction.reply({ content: `❌ Could not reach project server.`, ephemeral: true });
		}
		return;
	}

	if (interaction.commandName === "agent-stop") {
		if (!projectId) {
			await interaction.reply({ content: "❌ `project` is required.", ephemeral: true });
			return;
		}
		if (!_resolveProject) {
			await interaction.reply({ content: "❌ Project resolver not configured.", ephemeral: true });
			return;
		}
		const project = await _resolveProject(projectId);
		if (!project) {
			await interaction.reply({ content: `❌ Project \`${projectId}\` not found or not running.`, ephemeral: true });
			return;
		}
		const target = sessionId ? `/api/sessions/${sessionId}/stop` : "/api/sessions/latest/stop";
		try {
			await fetch(`http://localhost:${project.port}${target}`, { method: "POST" });
			await interaction.reply(`✅ Session stopped for project \`${projectId.slice(0, 8)}…\``);
		} catch {
			await interaction.reply({ content: "❌ Could not reach project server.", ephemeral: true });
		}
		return;
	}

	if (interaction.commandName === "agent-status") {
		await interaction.reply({ content: "📊 Status command not yet implemented.", ephemeral: true });
	}
}
