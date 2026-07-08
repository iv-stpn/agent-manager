import z from "zod";

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

/** Accept only https:// or scp-like git@host:path remotes for github templates. */
export function isValidGitRemote(source: string): boolean {
	if (/^https:\/\/[^\s]+$/.test(source)) {
		try {
			// Reject embedded credentials / non-http(s) tricks smuggled past the regex.
			const url = new URL(source);
			return url.protocol === "https:" && !url.username && !url.password;
		} catch {
			return false;
		}
	}
	// scp-like syntax: git@github.com:owner/repo.git
	return /^git@[a-zA-Z0-9._-]+:[a-zA-Z0-9._/-]+$/.test(source);
}

/** A single, safe path segment — no separators, no traversal, no leading dot. */
export function isSafePathSegment(source: string): boolean {
	return source.length > 0 && !source.includes("/") && !source.includes("\\") && source !== ".." && source !== ".";
}

/**
 * Accept only shapes `bun create` understands for bun-create templates: an npm
 * package name (optionally scoped, optionally `@version`-suffixed) or a GitHub
 * `owner/repo` shorthand. Every segment must start with an alphanumeric, so a
 * source can never smuggle a leading `-` (flag injection into the spawned
 * command), a `..`/absolute path segment, or whitespace.
 */
export function isValidBunCreateSource(source: string): boolean {
	const seg = "[a-zA-Z0-9][a-zA-Z0-9._-]*";
	return new RegExp(`^(?:@${seg}/${seg}|${seg}(?:/${seg})?)(?:@[a-zA-Z0-9._-]+)?$`).test(source);
}

/**
 * Split a bun-create `flags` string into argv tokens for the spawned
 * `bun create` command. Returns null if any token falls outside a conservative
 * character set or contains `..` — the tokens become process arguments (never
 * a shell string), so this only needs to block path traversal and control
 * characters, not shell metacharacters.
 */
export function parseBunCreateFlags(flags: string): string[] | null {
	const tokens = flags.trim().split(/\s+/).filter(Boolean);
	for (const token of tokens) {
		if (!/^[a-zA-Z0-9@._/:=-]+$/.test(token) || token.includes("..")) return null;
	}
	return tokens;
}

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
 * A template a project was seeded from at creation time. Mirrors
 * `CreateProjectInput.templates`; persisted in `context.json` so the agent's
 * system prompt can tell the agent its workspace started from a template.
 */
const TemplateRefSchema = z.object({
	type: z.enum(["local", "github", "bun-create"]),
	source: z.string(), // For local: template name, for github: repo URL, for bun-create: npm package or owner/repo
	subdirectory: z.string().optional(), // Subdirectory under the workspace, if any
	flags: z.string().optional(), // For bun-create: extra CLI flags passed to `bun create`
});

/**
 * Per-project prompt context: which library tech stacks / guidelines apply,
 * plus a free-form project-local instructions block, and the templates the
 * project was seeded from. Persisted in the project's `context.json`; the
 * rendered markdown is mounted into the container and injected into the
 * agent's system prompt.
 */
export const ProjectContextSchema = z.object({
	techStackIds: z.array(z.string()).default([]),
	guidelineIds: z.array(z.string()).default([]),
	instructions: z.string().default(""),
	templates: z.array(TemplateRefSchema).default([]),
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
			z
				.object({
					type: z.enum(["local", "github", "bun-create"]),
					source: z.string(), // For local: template name, for github: repo URL, for bun-create: npm package or owner/repo
					subdirectory: z.string().optional(), // For multiple templates: subdirectory name under workspace
					flags: z.string().optional(), // For bun-create: extra CLI flags passed to `bun create`
				})
				// `source` is later fed to `git clone` (github), `bun create`
				// (bun-create), or joined onto the templates dir (local). Constrain it
				// per-type so it can never carry shell/URL tricks or a path-traversal
				// segment.
				.superRefine((tpl, ctx) => {
					if (tpl.type === "github") {
						if (!isValidGitRemote(tpl.source)) {
							ctx.addIssue({
								code: z.ZodIssueCode.custom,
								path: ["source"],
								message: "github source must be an https:// or git@ repository URL",
							});
						}
					} else if (tpl.type === "bun-create") {
						if (!isValidBunCreateSource(tpl.source)) {
							ctx.addIssue({
								code: z.ZodIssueCode.custom,
								path: ["source"],
								message: "bun-create source must be an npm package name or GitHub owner/repo shorthand",
							});
						}
						if (tpl.flags !== undefined && parseBunCreateFlags(tpl.flags) === null) {
							ctx.addIssue({
								code: z.ZodIssueCode.custom,
								path: ["flags"],
								message: "bun-create flags may only contain plain option tokens (no '..' or special characters)",
							});
						}
					} else if (!isSafePathSegment(tpl.source)) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							path: ["source"],
							message: "local source must be a single path segment (no '/', '\\', or '..')",
						});
					}
				})
		)
		.optional(),
	binaries: z.array(z.enum(["python3", "workerd", "cargo"])).optional(),
});

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;
