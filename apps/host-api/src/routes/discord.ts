import { Hono } from "hono";
import { z } from "zod";
import type { ChannelStore } from "../discord/channels";
import { sendQuestions, sendReport } from "../discord/interactions";
import type { HonoHostEnv } from "../types";

const ReportSchema = z.object({
	sessionId: z.string().min(1),
	report: z.object({
		title: z.string(),
		sections: z.array(z.object({ title: z.string().optional(), content: z.string() })),
		mermaid_diagrams: z.array(z.object({ title: z.string().optional(), definition: z.string() })).optional(),
	}),
	trigger: z.string(),
	freeze: z.boolean(),
	pendingQuestions: z.array(
		z.object({
			id: z.string(),
			text: z.string(),
			context: z.string().nullable().optional(),
			suggestions: z.string().nullable().optional(),
		})
	),
});

const QuestionsSchema = z.object({
	sessionId: z.string().min(1),
	title: z.string(),
	questions: z.array(
		z.object({
			question: z.string(),
			header: z.string(),
			options: z.array(
				z.object({
					label: z.string(),
					description: z.string(),
				})
			),
			multiSelect: z.boolean().optional(),
		})
	),
	urgent: z.boolean().default(false),
});

const MessageSchema = z.object({
	sessionId: z.string().min(1),
	content: z.string().min(1),
});

let channelStore: ChannelStore | null = null;

export function setDiscordRouteChannelStore(store: ChannelStore) {
	channelStore = store;
}

export const discordRouter = new Hono<HonoHostEnv>()
	.post("/:id/discord/report", async (c) => {
		const body = ReportSchema.parse(await c.req.json());

		if (!channelStore) return c.json({ error: "Discord not configured" }, 503);

		const channelRecord = channelStore.getBySession(body.sessionId);
		if (!channelRecord) return c.json({ error: "No Discord channel for this session" }, 404);

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);

		try {
			const result = await sendReport(
				channelRecord.id,
				body.report,
				body.sessionId,
				body.trigger,
				body.freeze,
				body.pendingQuestions,
				controller.signal
			);
			return c.json({ answers: result?.answers ?? [], confirmed: result?.confirmed ?? false });
		} finally {
			clearTimeout(timeout);
		}
	})

	.post("/:id/discord/questions", async (c) => {
		const body = QuestionsSchema.parse(await c.req.json());

		if (!channelStore) return c.json({ error: "Discord not configured" }, 503);

		const channelRecord = channelStore.getBySession(body.sessionId);
		if (!channelRecord) return c.json({ error: "No Discord channel for this session" }, 404);

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);

		try {
			const answers = await sendQuestions(channelRecord.id, body.sessionId, body.title, body.questions, body.urgent, controller.signal);
			return c.json({ answers });
		} finally {
			clearTimeout(timeout);
		}
	})

	.post("/:id/discord/message", async (c) => {
		const body = MessageSchema.parse(await c.req.json());

		if (!channelStore) return c.json({ error: "Discord not configured" }, 503);

		const channelRecord = channelStore.getBySession(body.sessionId);
		if (!channelRecord) return c.json({ error: "No Discord channel for this session" }, 404);

		const { getChannel } = await import("../discord/bot");
		const channel = await getChannel(channelRecord.id);
		if (!channel) return c.json({ error: "Discord channel unavailable" }, 503);

		await channel.send(body.content);
		return c.json({ ok: true });
	})

	.post("/:id/discord/graph", async (c) => {
		const formData = await c.req.formData();
		const sessionId = formData.get("sessionId") as string;
		const title = formData.get("title") as string | null;
		const fileEntry = formData.get("file");
		const file = fileEntry instanceof File ? fileEntry : null;

		if (!sessionId || !file) return c.json({ error: "Missing sessionId or file" }, 400);
		if (!channelStore) return c.json({ error: "Discord not configured" }, 503);

		const channelRecord = channelStore.getBySession(sessionId);
		if (!channelRecord) return c.json({ error: "No Discord channel for this session" }, 404);

		const { getChannel } = await import("../discord/bot");
		const channel = await getChannel(channelRecord.id);
		if (!channel) return c.json({ error: "Discord channel unavailable" }, 503);

		const buffer = Buffer.from(await file.arrayBuffer());
		const { AttachmentBuilder, EmbedBuilder } = await import("discord.js");
		const attachment = new AttachmentBuilder(buffer, { name: "graph.png" });
		const embed = new EmbedBuilder().setColor(0x5865f2).setImage("attachment://graph.png");
		if (title) embed.setTitle(title);

		await channel.send({ embeds: [embed], files: [attachment] });
		return c.json({ ok: true });
	});
