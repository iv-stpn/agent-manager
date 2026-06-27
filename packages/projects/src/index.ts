export { ProjectManager, resolveWorkspaceRoot } from "./manager";
export { ProjectDocker } from "./docker";
export { ProjectDatabase } from "./database";
export type {
	ProjectConfig,
	CreateProjectInput,
	DiscordConfig,
	AgentConfig,
} from "./types";
export {
	ProjectConfigSchema,
	CreateProjectSchema,
	DiscordConfigSchema,
	AgentConfigSchema,
} from "./types";
export { TemplateManager } from "./templates";
export type { Template, TemplateCategory } from "./templates";
export type {
	ProjectStats,
	SessionRecord,
	MessageRecord,
	ToolCallRecord,
	CheckinRecord,
	QuestionRecord,
	ReportRecord,
	CompactionRecord,
} from "./records";
