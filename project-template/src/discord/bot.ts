import { Client, GatewayIntentBits, Partials, type TextChannel } from "discord.js";
import type { Question } from "../db";
import { type CheckinFormResult, sendCheckinForm } from "./forms";

let client: Client | null = null;

export function getDiscordClient(): Client {
	if (client) return client;

	client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
			GatewayIntentBits.GuildMessageReactions,
		],
		partials: [Partials.Message, Partials.Channel, Partials.Reaction],
	});

	client.on("ready", () => {
		console.log(`[Discord] Logged in as ${client?.user?.tag}`);
	});

	client.on("error", (err) => {
		console.error("[Discord] Error:", err);
	});

	return client;
}

export async function startDiscordBot(token: string): Promise<void> {
	const bot = getDiscordClient();
	await bot.login(token);
}

export async function getChannel(channelId: string): Promise<TextChannel | null> {
	const bot = getDiscordClient();
	try {
		const channel = await bot.channels.fetch(channelId);
		if (channel?.isTextBased() && "send" in channel) {
			return channel as TextChannel;
		}
		return null;
	} catch {
		return null;
	}
}

export async function sendCheckin(
	channelId: string,
	summary: string,
	questions: Question[],
	sessionId: string,
	trigger: string
): Promise<CheckinFormResult> {
	const channel = await getChannel(channelId);
	if (!channel) {
		console.warn(`[Discord] Channel ${channelId} not found`);
		return { answers: [], confirmed: false };
	}
	return sendCheckinForm(channel, summary, questions, sessionId, trigger);
}

export async function sendMessage(channelId: string, content: string): Promise<void> {
	const channel = await getChannel(channelId);
	if (!channel) return;
	await channel.send(content);
}
