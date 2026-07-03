import type Anthropic from "@anthropic-ai/sdk";

export enum ToolName {
	Bash = "bash",
	Grep = "grep",
	Glob = "glob",
	ReadFile = "read_file",
	WriteFile = "write_file",
	ListDirectory = "list_directory",
	SearchFiles = "search_files",
	EditFile = "edit_file",
	MoveFile = "move_file",
	DeleteFile = "delete_file",
	CreateDirectory = "create_directory",
	ReadFileRange = "read_file_range",
	WebSearch = "web_search",
	WebFetch = "web_fetch",
	Remember = "remember",
	Recall = "recall",
	UpdateMemory = "update_memory",
	DeleteMemory = "delete_memory",
	ListMemories = "list_memories",
	AddTask = "add_task",
	ListTasks = "list_tasks",
	UpdateTask = "update_task",
	GetCurrentTask = "get_current_task",
	SetCurrentTask = "set_current_task",
	AskUserQuestion = "ask_user_question",
	SendReport = "send_report",
	CommitChanges = "commit_changes",
	CompactContext = "compact_context",
	EnterPlanMode = "enter_plan_mode",
	ExitPlanMode = "exit_plan_mode",
}

const VALID_TOOL_NAMES = new Set<string>(Object.values(ToolName));

export function isToolName(value: string): value is ToolName {
	return VALID_TOOL_NAMES.has(value);
}

// ── Schema helpers ────────────────────────────────────────────────────────────
const string = (description: string) => ({ type: "string" as const, description: description });
const number = (description: string) => ({ type: "number" as const, description: description });
const boolean = (description: string) => ({ type: "boolean" as const, description: description });

const pathProp = string("Workspace-relative path");
const dirProp = string("Directory to search (default: workspace root)");

type Props = Record<string, object>;
const obj = (properties: Props, required: string[] = []): Anthropic.Tool["input_schema"] => ({
	type: "object",
	properties,
	required,
});

const TASK_STATUS = ["pending", "in_progress", "done", "cancelled"] as const;
const MEM_TYPES_RW = ["decision", "plan", "memory", "context"] as const;
const MEM_TYPES_ALL = [...MEM_TYPES_RW, "question", "report"] as const;

export const AGENT_TOOLS: Anthropic.Tool[] = [
	// ── Commands ──────────────────────────────────────────────────────────────
	{
		name: "bash",
		description: "Run a shell command in the workspace root.",
		input_schema: obj({ command: string("Shell command"), timeout_ms: number("Max ms (default: 30000)") }, ["command"]),
	},
	{
		name: "grep",
		description: "Regex search across files. Returns file:line matches.",
		input_schema: obj(
			{
				pattern: string("Regex pattern"),
				path: dirProp,
				include: string("File glob filter (e.g. '*.ts')"),
				flags: string("Extra grep flags (e.g. '-i')"),
			},
			["pattern"]
		),
	},
	{
		name: "glob",
		description: "Find files matching a glob pattern.",
		input_schema: obj({ pattern: string("Glob pattern"), path: dirProp }, ["pattern"]),
	},

	// ── File system ───────────────────────────────────────────────────────────
	{
		name: "read_file",
		description: "Read a workspace file.",
		input_schema: obj({ path: pathProp }, ["path"]),
	},
	{
		name: "write_file",
		description: "Write content to a workspace file.",
		input_schema: obj({ path: pathProp, content: string("File content") }, ["path", "content"]),
	},
	{
		name: "list_directory",
		description: "List a workspace directory.",
		input_schema: obj({ path: string("Directory path (default: workspace root)") }),
	},
	{
		name: "search_files",
		description: "Search files with grep. Returns file:line matches.",
		input_schema: obj(
			{
				pattern: string("Search pattern (regex)"),
				path: dirProp,
				file_pattern: string("File glob (e.g. '*.ts')"),
				case_sensitive: boolean("Default: false"),
				max_results: number("Default: 100"),
			},
			["pattern"]
		),
	},
	{
		name: "edit_file",
		description: "Replace old_string with new_string in a file (exact whitespace match required).",
		input_schema: obj(
			{
				path: pathProp,
				old_string: string("Exact string to replace"),
				new_string: string("Replacement string"),
				replace_all: boolean("Replace all occurrences (default: false)"),
			},
			["path", "old_string", "new_string"]
		),
	},
	{
		name: "move_file",
		description: "Move or rename a file or directory.",
		input_schema: obj({ source: pathProp, destination: pathProp }, ["source", "destination"]),
	},
	{
		name: "delete_file",
		description: "Delete a file or directory (set recursive=true for directories).",
		input_schema: obj({ path: pathProp, recursive: boolean("Required true for directories") }, ["path"]),
	},
	{
		name: "create_directory",
		description: "Create a directory (including parents).",
		input_schema: obj({ path: pathProp }, ["path"]),
	},
	{
		name: "read_file_range",
		description: "Read a line range from a file.",
		input_schema: obj(
			{
				path: pathProp,
				start_line: number("Start line (1-indexed, inclusive)"),
				end_line: number("End line (1-indexed, inclusive)"),
			},
			["path", "start_line", "end_line"]
		),
	},

	// ── Web ───────────────────────────────────────────────────────────────────
	{
		name: "web_search",
		description: "Search the web. Returns title/URL/snippet list. Follow up with web_fetch to read a page.",
		input_schema: obj({ query: string("Search query"), limit: number("Max results (default: 8)") }, ["query"]),
	},
	{
		name: "web_fetch",
		description: "Fetch a URL and return its plain-text content.",
		input_schema: obj(
			{
				url: string("Absolute URL (http:// or https://)"),
				max_chars: number("Max characters (default: 20000)"),
			},
			["url"]
		),
	},

	// ── Memory ────────────────────────────────────────────────────────────────
	{
		name: "remember",
		description: "Store a persistent memory entry. Not for tasks, reports, or questions.",
		input_schema: obj(
			{
				type: { type: "string", enum: MEM_TYPES_RW, description: "Memory category" },
				title: string("Short descriptive title"),
				content: string("Memory content"),
				metadata: { type: "object", description: "Optional structured metadata" },
			},
			["type", "title", "content"]
		),
	},
	{
		name: "recall",
		description: "Semantic search over project memory.",
		input_schema: obj(
			{
				query: string("Natural language query"),
				type: { type: "string", enum: MEM_TYPES_ALL, description: "Filter by type (optional)" },
				limit: number("Max results (default: 10)"),
			},
			["query"]
		),
	},
	{
		name: "update_memory",
		description: "Update an existing memory entry by ID.",
		input_schema: obj(
			{
				id: string("Memory entry ID"),
				title: string("New title"),
				content: string("New content"),
				type: { type: "string", enum: MEM_TYPES_RW, description: "New type" },
				metadata: { type: "object", description: "New metadata" },
			},
			["id"]
		),
	},
	{
		name: "delete_memory",
		description: "Delete a memory entry by ID.",
		input_schema: obj({ id: string("Memory entry ID") }, ["id"]),
	},
	{
		name: "list_memories",
		description: "List memory entries, optionally filtered by type.",
		input_schema: obj({
			type: { type: "string", enum: MEM_TYPES_ALL, description: "Filter by type (optional)" },
			limit: number("Max results (default: 100)"),
		}),
	},

	// ── Tasks ─────────────────────────────────────────────────────────────────
	{
		name: "add_task",
		description: "Add a task to the project task list.",
		input_schema: obj(
			{
				text: string("Task description"),
				status: { type: "string", enum: TASK_STATUS, description: "Initial status (default: pending)" },
				dependsOn: { type: "array", items: { type: "string" }, description: "IDs of prerequisite tasks" },
			},
			["text"]
		),
	},
	{
		name: "list_tasks",
		description: "List all project tasks with status and blocked-by info.",
		input_schema: obj({
			filter: { type: "string", enum: ["all", ...TASK_STATUS], description: "Status filter (default: all)" },
		}),
	},
	{
		name: "update_task",
		description: "Update a task's status, text, or dependencies.",
		input_schema: obj(
			{
				id: string("Task ID"),
				status: { type: "string", enum: TASK_STATUS, description: "New status" },
				text: string("Updated text"),
				dependsOn: { type: "array", items: { type: "string" }, description: "Replacement dependency IDs" },
			},
			["id"]
		),
	},
	{
		name: "get_current_task",
		description: "Get the currently active in-progress task.",
		input_schema: obj({}),
	},
	{
		name: "set_current_task",
		description: "Set a task as active (demotes any other in-progress task). Warns if blocked by dependencies.",
		input_schema: obj({ id: string("Task ID") }, ["id"]),
	},

	// ── Questions ─────────────────────────────────────────────────────────────
	{
		name: "ask_user_question",
		description: "Ask the user questions and wait for answers. Set urgent=true only when fully blocked.",
		input_schema: obj(
			{
				title: string("Optional heading for the question group"),
				questions: {
					type: "array",
					description: "Questions sent and answered as a group",
					items: {
						type: "object",
						properties: {
							question: string("The question to ask"),
							header: string("Short chip label (max 12 chars)"),
							options: {
								type: "array",
								description: "2-4 answer choices (user may also type a custom answer)",
								items: {
									type: "object",
									properties: { label: string("1-5 word label"), description: string("What this option means") },
									required: ["label", "description"],
								},
							},
							multiSelect: boolean("Allow multiple selections (default: false)"),
						},
						required: ["question", "header", "options"],
					},
				},
				context: string("Background info explaining why you're asking"),
				urgent: boolean("High-priority notification when fully blocked (default: false)"),
			},
			["questions"]
		),
	},

	// ── Reports ───────────────────────────────────────────────────────────────
	{
		name: "send_report",
		description: "Send a report via Discord and save it to the database. Use ONLY this for reports — do not use write_file.",
		input_schema: obj(
			{
				title: string("Report title"),
				sections: {
					type: "array",
					description: "Text sections (auto-split at 1800 chars)",
					items: {
						type: "object",
						properties: { title: string("Section title"), content: string("Section body (plain text or markdown)") },
						required: ["content"],
					},
				},
				mermaid_diagrams: {
					type: "array",
					description: "Mermaid diagrams rendered as PNG images",
					items: {
						type: "object",
						properties: { title: string("Diagram title"), definition: string("Full Mermaid definition") },
						required: ["definition"],
					},
				},
				await_override: {
					type: "string",
					enum: ["await", "continue"],
					description: "Override await_report_mode for this report",
				},
			},
			["title", "sections"]
		),
	},

	// ── Git ───────────────────────────────────────────────────────────────────
	{
		name: "commit_changes",
		description: "Stage all changes, run lint/typecheck/tests, and commit. Aborts if checks fail.",
		input_schema: obj(
			{
				message: string("Conventional commit message (e.g. 'feat(auth): add JWT middleware')"),
				skip_checks: boolean("Skip quality checks before committing (default: false)"),
			},
			["message"]
		),
	},

	// ── Context ───────────────────────────────────────────────────────────────
	{
		name: "compact_context",
		description: "Summarise older conversation to free context space. Call before intensive multi-step operations.",
		input_schema: obj({}),
	},

	// ── Plan Mode ─────────────────────────────────────────────────────────────
	{
		name: "enter_plan_mode",
		description: "Restrict to read-only tools for codebase exploration. Call exit_plan_mode when ready to implement.",
		input_schema: obj({}),
	},
	{
		name: "exit_plan_mode",
		description: "Exit plan mode and restore full tool access.",
		input_schema: obj({ plan_summary: string("What you explored and your implementation plan") }, ["plan_summary"]),
	},
];
