export { ProjectDatabase } from "./database";
export { ProjectDocker } from "./docker";
export { ProjectManager, resolveWorkspaceRoot } from "./manager";
export type {
	CheckinRecord,
	CompactionRecord,
	MessageRecord,
	ProjectStats,
	QuestionRecord,
	ReportRecord,
	SessionRecord,
	ToolCallRecord,
} from "./records";
export type { Template, TemplateCategory } from "./templates";
export { TemplateManager } from "./templates";
export type {
	AgentConfig,
	CreateProjectInput,
	DiscordConfig,
	ProjectConfig,
} from "./types";
export {
	AgentConfigSchema,
	CreateProjectSchema,
	DiscordConfigSchema,
	ProjectConfigSchema,
} from "./types";
