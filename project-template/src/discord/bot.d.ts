import type { Client, TextChannel } from "discord.js";
import type { Question } from "../db";
import type { CheckinFormResult } from "./forms";
export declare function getDiscordClient(): Client;
export declare function startDiscordBot(token: string): Promise<void>;
export declare function getChannel(channelId: string): Promise<TextChannel | null>;
export declare function sendCheckin(
	channelId: string,
	summary: string,
	questions: Question[],
	sessionId: string,
	trigger: string
): Promise<CheckinFormResult>;
export declare function sendMessage(channelId: string, content: string): Promise<void>;
