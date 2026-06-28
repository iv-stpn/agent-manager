import { z } from "zod";

export const DiscordConfigSchema = z.object({
	token: z.string().optional(),
	defaultChannelId: z.string().optional(),
});

export type DiscordConfig = z.infer<typeof DiscordConfigSchema>;

export const AgentConfigSchema = z.object({
	anthropicApiKey: z.string().optional(),
	anthropicBaseUrl: z.string().optional(),
	model: z.string().optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const ProjectConfigSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
	ports: z.object({
		server: z.number(),
	}),
	workspace: z.object({
		path: z.string(), // Absolute path to repository/workspace
		type: z.enum(["external", "internal"]), // external = user path, internal = .projects/<project>/workspace
	}),
	discord: DiscordConfigSchema.optional(),
	agent: AgentConfigSchema.optional(),
	status: z.enum(["active", "stopped", "error"]).default("stopped"),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const UpdateSettingsSchema = z.object({
	name: z.string().min(1).max(50).optional(),
	description: z.string().optional(),
	ports: z
		.object({
			server: z.number().min(3000).max(65535).optional(),
		})
		.optional(),
	workspace: z
		.object({
			path: z.string(),
			type: z.enum(["external", "internal"]),
		})
		.optional(),
	discord: DiscordConfigSchema.optional(),
	agent: AgentConfigSchema.optional(),
});

export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>;

export const CreateProjectSchema = z.object({
	id: z
		.string()
		.regex(/^[a-z0-9_-]+$/, "id must be lowercase alphanumeric, underscores, or hyphens")
		.optional(), // If omitted, derived from name (underscores become hyphens)
	name: z.string().min(1).max(50),
	description: z.string().optional(),
	workspacePath: z.string().optional(), // If provided, mount this path; otherwise use internal workspace
	ports: z
		.object({
			server: z.number().min(3000).max(65535).optional(),
		})
		.optional(),
	discord: DiscordConfigSchema.optional(),
	agent: AgentConfigSchema.optional(),
});

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;
