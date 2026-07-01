import { z } from "zod";

/**
 * Recursively allow optional properties to also be explicitly `undefined`.
 * Under `exactOptionalPropertyTypes`, hand-written row types reject the
 * `T | undefined` shape that zod's `.optional()` / `.partial()` infer; wrap a
 * boundary param in `LooseOptional<T>` to accept zod-parsed inputs.
 */
export type LooseOptional<T> = T extends (infer U)[]
	? LooseOptional<U>[]
	: T extends object
		? { [K in keyof T]: undefined extends T[K] ? LooseOptional<Exclude<T[K], undefined>> | undefined : LooseOptional<T[K]> }
		: T;

export const AgentConfigSchema = z.object({
	clientId: z.string().optional(),
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
	agent: AgentConfigSchema.optional(),
	status: z.enum(["active", "stopped", "error"]).default("stopped"),
	binaries: z.array(z.enum(["python3", "workerd", "cargo"])).optional(),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/**
 * Per-project prompt context: which library tech stacks / guidelines apply,
 * plus a free-form project-local instructions block. Persisted in the
 * project's `context.json`; the rendered markdown is mounted into the
 * container and injected into the agent's system prompt.
 */
export const ProjectContextSchema = z.object({
	techStackIds: z.array(z.string()).default([]),
	guidelineIds: z.array(z.string()).default([]),
	instructions: z.string().default(""),
});

export type ProjectContext = z.infer<typeof ProjectContextSchema>;

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
	agent: AgentConfigSchema.optional(),
	templates: z
		.array(
			z.object({
				type: z.enum(["local", "github"]),
				source: z.string(), // For local: template name, for github: repo URL
				subdirectory: z.string().optional(), // For multiple templates: subdirectory name under workspace
			})
		)
		.optional(),
	binaries: z.array(z.enum(["python3", "workerd", "cargo"])).optional(),
});

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;
