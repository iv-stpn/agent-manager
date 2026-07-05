import { ChannelType, type TextChannel } from "discord.js";
import { getGuild } from "./bot";

interface DiscordChannel {
	id: string;
	projectId: string;
	sessionId: string | null;
	type: "category" | "summary" | "tasks" | "session" | "archive";
	createdAt: number;
}

export interface ChannelStore {
	get(projectId: string, type: DiscordChannel["type"], sessionId?: string | null): DiscordChannel | undefined;
	getBySession(sessionId: string): DiscordChannel | undefined;
	save(channel: DiscordChannel): void;
	delete(id: string): void;
	listByProject(projectId: string): DiscordChannel[];
}

let store: ChannelStore | null = null;

export function setChannelStore(s: ChannelStore) {
	store = s;
}

/** Ensure a Discord category exists for a project. */
export async function ensureProjectCategory(projectId: string, projectName: string): Promise<string | null> {
	const guild = getGuild();
	if (!guild || !store) return null;

	const existing = store.get(projectId, "category");
	if (existing) {
		// Verify it still exists on Discord
		try {
			await guild.channels.fetch(existing.id);
			return existing.id;
		} catch {
			store.delete(existing.id);
		}
	}

	const category = await guild.channels.create({
		name: `🤖 ${projectName}`,
		type: ChannelType.GuildCategory,
	});

	store.save({ id: category.id, projectId, sessionId: null, type: "category", createdAt: Date.now() });
	return category.id;
}

/** Create pinned channels (#summary, #tasks) at the top of a project category. */
export async function ensureProjectPinnedChannels(projectId: string, categoryId: string): Promise<void> {
	const guild = getGuild();
	if (!guild || !store) return;

	// Summary channel
	if (!store.get(projectId, "summary")) {
		const ch = await guild.channels.create({
			name: "summary",
			type: ChannelType.GuildText,
			parent: categoryId,
			position: 0,
			topic: "Project summary and status overview",
		});
		store.save({ id: ch.id, projectId, sessionId: null, type: "summary", createdAt: Date.now() });
	}

	// Tasks channel
	if (!store.get(projectId, "tasks")) {
		const ch = await guild.channels.create({
			name: "tasks",
			type: ChannelType.GuildText,
			parent: categoryId,
			position: 1,
			topic: "Project tasks and action items",
		});
		store.save({ id: ch.id, projectId, sessionId: null, type: "tasks", createdAt: Date.now() });
	}
}

/** Create a session text channel inside the project category. */
export async function createSessionChannel(projectId: string, sessionId: string, sessionName: string): Promise<string | null> {
	const guild = getGuild();
	if (!guild || !store) return null;

	const category = store.get(projectId, "category");
	if (!category) return null;

	const safeName =
		sessionName
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "-")
			.slice(0, 80) || "session";

	const ch = await guild.channels.create({
		name: safeName,
		type: ChannelType.GuildText,
		parent: category.id,
		topic: `Session: ${sessionName} (${sessionId.slice(0, 8)})`,
	});

	store.save({ id: ch.id, projectId, sessionId, type: "session", createdAt: Date.now() });
	return ch.id;
}

/** Archive a session channel: convert last messages to a thread, then delete the channel. */
export async function archiveSessionChannel(sessionId: string): Promise<void> {
	const guild = getGuild();
	if (!guild || !store) return;

	const record = store.getBySession(sessionId);
	if (!record) return;

	try {
		const channel = await guild.channels.fetch(record.id);
		if (!channel?.isTextBased()) {
			store.delete(record.id);
			return;
		}

		// Find or create the archive channel in the same category
		let archiveCh = store.get(record.projectId, "archive");
		let archiveChannel: TextChannel | undefined;

		if (archiveCh) {
			const archiveChId = archiveCh.id;
			try {
				const fetched = await guild.channels.fetch(archiveChId);
				if (fetched?.type === ChannelType.GuildText) {
					archiveChannel = fetched;
				} else {
					store.delete(archiveChId);
					archiveCh = undefined;
				}
			} catch {
				store.delete(archiveChId);
				archiveCh = undefined;
			}
		}

		if (!archiveCh) {
			const category = store.get(record.projectId, "category");
			archiveChannel = await guild.channels.create({
				name: "sessions-archive",
				type: ChannelType.GuildText,
				...(category?.id && { parent: category.id }),
				topic: "Archived session threads",
			});
			store.save({ id: archiveChannel.id, projectId: record.projectId, sessionId: null, type: "archive", createdAt: Date.now() });
		}

		if (!archiveChannel) return;

		// Create a thread in the archive channel with the session name
		if (channel.type !== ChannelType.GuildText) {
			store.delete(record.id);
			return;
		}
		const textChannel = channel;
		const thread = await archiveChannel.threads.create({
			name: textChannel.name,
			autoArchiveDuration: 10080, // 7 days
			reason: `Session ${sessionId} archived`,
		});

		// Post a summary message in the thread
		await thread.send(`📦 Archived session channel: **${textChannel.name}**\nSession ID: \`${sessionId}\``);

		// Delete the original channel
		await textChannel.delete("Session archived");
		store.delete(record.id);
	} catch (err) {
		console.error(`[Discord] Failed to archive session channel ${sessionId}:`, err);
	}
}

/** Delete an entire project category and all its channels. */
export async function deleteProjectCategory(projectId: string): Promise<void> {
	const guild = getGuild();
	if (!guild || !store) return;

	const channels = store.listByProject(projectId);

	for (const record of channels) {
		if (record.type === "category") continue; // delete category last
		try {
			const ch = await guild.channels.fetch(record.id);
			if (ch) await ch.delete("Project deleted");
		} catch {
			/* already gone */
		}
		store.delete(record.id);
	}

	// Delete category itself
	const category = store.get(projectId, "category");
	if (category) {
		try {
			const ch = await guild.channels.fetch(category.id);
			if (ch) await ch.delete("Project deleted");
		} catch {
			/* already gone */
		}
		store.delete(category.id);
	}
}
