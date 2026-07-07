import { ChannelType, Client, GatewayIntentBits, type Guild, Partials, type TextChannel } from "discord.js";

let client: Client | null = null;
let guildId: string | null = null;

export function getGuild(): Guild | null {
	if (!client || !guildId) return null;
	return client.guilds.cache.get(guildId) ?? null;
}

export async function startDiscordBot(token: string, guild: string, clientId: string): Promise<Client> {
	guildId = guild;

	client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
			GatewayIntentBits.GuildMessageReactions,
		],
		partials: [Partials.Message, Partials.Channel, Partials.Reaction],
	});

	client.on("clientReady", () => {
		console.log(`[Discord] Logged in as ${client?.user?.tag}`);
	});

	client.on("error", (err) => {
		console.error("[Discord] Error:", err);
	});

	await client.login(token);

	// Register slash commands
	const { registerCommands } = await import("./commands");
	await registerCommands(token, clientId);

	// Wire interaction handler
	const { handleInteraction } = await import("./commands");
	client.on("interactionCreate", async (interaction) => {
		if (!interaction.isChatInputCommand()) return;
		try {
			await handleInteraction(interaction);
		} catch (err) {
			console.error("[Discord] Command error:", err);
			const reply =
				interaction.replied || interaction.deferred
					? interaction.followUp.bind(interaction)
					: interaction.reply.bind(interaction);
			await reply({ content: "❌ Command failed.", ephemeral: true }).catch(() => {});
		}
	});

	return client;
}

export async function destroyDiscordBot(): Promise<void> {
	if (!client) return;
	try {
		await client.destroy();
	} catch (err) {
		console.error("[Discord] Error during shutdown:", err);
	} finally {
		client = null;
		guildId = null;
	}
}

export async function getChannel(channelId: string): Promise<TextChannel | null> {
	if (!client) return null;
	try {
		const channel = await client.channels.fetch(channelId);
		if (!channel?.isTextBased() || channel.type !== ChannelType.GuildText) return null;
		return channel;
	} catch {
		return null;
	}
}
