export { ProjectDatabase } from "./database";
export { ProjectDocker } from "./docker";
export type {
	ArchivedProject,
	ArchivedSession,
	GlobalStats,
	Guideline,
	GuidelineCategory,
	StackEntry,
	StackLibrary,
	TechStack,
	Template,
	TemplateCategory,
} from "./host-database";
export { HostDatabase } from "./host-database";
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
export type {
	AgentConfig,
	CreateProjectInput,
	DiscordConfig,
	ProjectConfig,
	UpdateSettingsInput,
} from "./types";
export {
	AgentConfigSchema,
	CreateProjectSchema,
	DiscordConfigSchema,
	ProjectConfigSchema,
	UpdateSettingsSchema,
} from "./types";
