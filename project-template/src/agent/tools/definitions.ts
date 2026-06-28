import type Anthropic from "@anthropic-ai/sdk";

export const AGENT_TOOLS: Anthropic.Tool[] = [
	// ── Commands ─────────────────────────────────────────────────────────────────
	{
		name: "bash",
		description:
			"Execute a shell command inside the sandboxed workspace. Working directory is always the workspace root. All file operations are relative to the workspace.",
		input_schema: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command to execute" },
				timeout_ms: {
					type: "number",
					description: "Max execution time in ms (default: 30000)",
				},
			},
			required: ["command"],
		},
	},
	{
		name: "grep",
		description: "Search for a regex pattern in files. Returns matching lines with file paths and line numbers.",
		input_schema: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Regex pattern to search for" },
				path: { type: "string", description: "Directory to search in (default: workspace root)" },
				include: { type: "string", description: "File glob filter (e.g. '*.ts')" },
				flags: { type: "string", description: "Extra grep flags (e.g. '-i' for case-insensitive)" },
			},
			required: ["pattern"],
		},
	},
	{
		name: "glob",
		description: "Find files and directories matching a glob pattern (e.g. '**/*.ts', 'src/**/*.{ts,js}').",
		input_schema: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Glob pattern to match" },
				path: { type: "string", description: "Base directory (default: workspace root)" },
			},
			required: ["pattern"],
		},
	},

	// ── File system ──────────────────────────────────────────────────────────────
	{
		name: "read_file",
		description: "Read a file from the workspace. Path is relative to workspace root.",
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path (relative to workspace)" },
			},
			required: ["path"],
		},
	},
	{
		name: "write_file",
		description: "Write content to a file in the workspace.",
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path (relative to workspace)" },
				content: { type: "string", description: "Content to write" },
			},
			required: ["path", "content"],
		},
	},
	{
		name: "list_directory",
		description: "List files in a workspace directory.",
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Directory path (default: workspace root)" },
			},
			required: [],
		},
	},
	{
		name: "search_files",
		description:
			"Search for patterns in files using grep. Returns matching lines with file paths and line numbers. Useful for finding function definitions, imports, TODOs, or any text pattern across the codebase.",
		input_schema: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Search pattern (supports regex)" },
				path: {
					type: "string",
					description: "Directory to search in (default: workspace root)",
				},
				file_pattern: {
					type: "string",
					description: "File glob pattern (e.g., '*.ts', '*.py'). Default: all files",
				},
				case_sensitive: {
					type: "boolean",
					description: "Case-sensitive search. Default: false",
				},
				max_results: {
					type: "number",
					description: "Maximum results to return. Default: 100",
				},
			},
			required: ["pattern"],
		},
	},
	{
		name: "edit_file",
		description:
			"Edit a file by replacing specific content. Searches for old_string and replaces with new_string. More efficient than reading entire file, modifying, and writing back. The old_string must match exactly (including whitespace).",
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path (relative to workspace)" },
				old_string: {
					type: "string",
					description: "Exact string to find and replace (must match exactly)",
				},
				new_string: { type: "string", description: "Replacement string" },
				replace_all: {
					type: "boolean",
					description: "Replace all occurrences (default: false, only first match)",
				},
			},
			required: ["path", "old_string", "new_string"],
		},
	},
	{
		name: "move_file",
		description: "Move or rename a file or directory. Creates parent directories if needed.",
		input_schema: {
			type: "object",
			properties: {
				source: { type: "string", description: "Source path (relative to workspace)" },
				destination: {
					type: "string",
					description: "Destination path (relative to workspace)",
				},
			},
			required: ["source", "destination"],
		},
	},
	{
		name: "delete_file",
		description: "Delete a file or directory. Use with caution. For directories, deletes recursively.",
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to delete (relative to workspace)" },
				recursive: {
					type: "boolean",
					description: "Required true for directories. Default: false",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "create_directory",
		description: "Create a directory (and any missing parent directories).",
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Directory path (relative to workspace)" },
			},
			required: ["path"],
		},
	},
	{
		name: "get_file_info",
		description:
			"Get metadata about a file or directory: size, modification time, permissions, type. Useful before reading large files or checking if a path exists.",
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to inspect (relative to workspace)" },
			},
			required: ["path"],
		},
	},
	{
		name: "read_file_range",
		description: "Read a specific range of lines from a file. Efficient for large files when you only need a portion.",
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path (relative to workspace)" },
				start_line: {
					type: "number",
					description: "Starting line number (1-indexed, inclusive)",
				},
				end_line: {
					type: "number",
					description: "Ending line number (1-indexed, inclusive)",
				},
			},
			required: ["path", "start_line", "end_line"],
		},
	},

	// ── Web ────────────────────────────────────────────────────────────────────────
	{
		name: "web_search",
		description:
			"Search the web and return a ranked list of results (title, URL, snippet). Use to find current information, documentation, or sources. Follow up with web_fetch to read a specific result.",
		input_schema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query" },
				limit: { type: "number", description: "Max number of results to return (default: 8)" },
			},
			required: ["query"],
		},
	},
	{
		name: "web_fetch",
		description:
			"Fetch a URL and return its readable text content (HTML is stripped to plain text). Use to read documentation, articles, or any web page. Content is truncated to a character budget.",
		input_schema: {
			type: "object",
			properties: {
				url: { type: "string", description: "Absolute URL to fetch (must start with http:// or https://)" },
				max_chars: { type: "number", description: "Max characters of content to return (default: 20000)" },
			},
			required: ["url"],
		},
	},

	// ── Memory Management ─────────────────────────────────────────────────────────
	{
		name: "remember",
		description:
			"Store a new entry in the project's persistent vector memory. Use to record architecture decisions, conventions, context, plans, or any knowledge that should persist across sessions. Entries are semantically searchable. Do NOT use for todos (use task tools), reports (use send_report), or questions (use queue_question/urgent_question).",
		input_schema: {
			type: "object",
			properties: {
				type: {
					type: "string",
					enum: ["decision", "plan", "memory", "context"],
					description: "Category of the memory entry",
				},
				title: { type: "string", description: "Short descriptive title (used for search ranking)" },
				content: { type: "string", description: "Full content of the memory entry" },
				metadata: {
					type: "object",
					description: "Optional structured metadata (e.g. {priority: 'high', status: 'active'})",
				},
			},
			required: ["type", "title", "content"],
		},
	},
	{
		name: "recall",
		description:
			"Semantically search project memory. Returns entries ranked by relevance to your query. Use natural language queries for best results (e.g. 'how is authentication implemented' rather than 'auth'). Searches across all entry types including auto-recorded todos, reports, and questions.",
		input_schema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Natural language search query" },
				type: {
					type: "string",
					enum: ["decision", "todo", "plan", "question", "memory", "report", "context"],
					description: "Optional: filter results to a specific type",
				},
				limit: { type: "number", description: "Max results to return (default: 10)" },
			},
			required: ["query"],
		},
	},
	{
		name: "update_memory",
		description:
			"Update an existing memory entry by its ID. Use to modify content, title, or type of a previously stored entry. Only entries you created directly (decision, plan, memory, context) should be updated this way.",
		input_schema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Memory entry ID (from recall or list_memories)" },
				title: { type: "string", description: "New title (optional)" },
				content: { type: "string", description: "New content (optional)" },
				type: {
					type: "string",
					enum: ["decision", "plan", "memory", "context"],
					description: "New type (optional)",
				},
				metadata: { type: "object", description: "New metadata (optional)" },
			},
			required: ["id"],
		},
	},
	{
		name: "delete_memory",
		description: "Delete a memory entry by its ID. Use when information is outdated or incorrect.",
		input_schema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Memory entry ID (from recall or list_memories)" },
			},
			required: ["id"],
		},
	},
	{
		name: "list_memories",
		description: "List all memory entries, optionally filtered by type. Use to see everything stored or browse a category.",
		input_schema: {
			type: "object",
			properties: {
				type: {
					type: "string",
					enum: ["decision", "todo", "plan", "question", "memory", "report", "context"],
					description: "Filter by type (optional, lists all if omitted)",
				},
				limit: { type: "number", description: "Max results (default: 100)" },
			},
			required: [],
		},
	},
	// ── Task Management ──────────────────────────────────────────────────────────
	{
		name: "add_task",
		description:
			"Add a new task to the project-wide task list. Tasks persist in the DB and are shared across sessions. Optionally declare dependencies on other tasks that must be done first.",
		input_schema: {
			type: "object",
			properties: {
				text: { type: "string", description: "Task description" },
				status: {
					type: "string",
					enum: ["pending", "in_progress", "done", "cancelled"],
					description: "Initial status (default: pending)",
				},
				dependsOn: {
					type: "array",
					items: { type: "string" },
					description: "IDs of tasks that must be done before this one can start",
				},
			},
			required: ["text"],
		},
	},
	{
		name: "list_tasks",
		description:
			"List tasks across the whole project (all sessions). Each line shows status and any dependencies, flagging tasks blocked by unfinished dependencies. Optionally filter by status.",
		input_schema: {
			type: "object",
			properties: {
				filter: {
					type: "string",
					enum: ["all", "pending", "in_progress", "done", "cancelled"],
					description: "Status filter (default: all)",
				},
			},
			required: [],
		},
	},
	{
		name: "update_task",
		description: "Update a task's status, text, or dependencies by its ID.",
		input_schema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Task ID (from list_tasks)" },
				status: {
					type: "string",
					enum: ["pending", "in_progress", "done", "cancelled"],
					description: "New status",
				},
				text: { type: "string", description: "Updated text" },
				dependsOn: {
					type: "array",
					items: { type: "string" },
					description: "Replacement list of dependency task IDs",
				},
			},
			required: ["id"],
		},
	},

	{
		name: "get_current_task",
		description: "Get the task that is currently in progress (the active task), if any.",
		input_schema: {
			type: "object",
			properties: {},
			required: [],
		},
	},
	{
		name: "set_current_task",
		description:
			"Mark a task as the current task in progress. The given task becomes in_progress and assigned to this session; any other in_progress task is moved back to pending, so exactly one task is active at a time. Warns if the task is still blocked by unfinished dependencies.",
		input_schema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Task ID (from list_tasks)" },
			},
			required: ["id"],
		},
	},

	// ── Questions ────────────────────────────────────────────────────────────────
	{
		name: "queue_question",
		description:
			"Add a question to the pending queue. Whether it blocks or is deferred depends on freeze_ask_mode. Use for non-urgent questions. Provide suggestions when possible to make answering easier.",
		input_schema: {
			type: "object",
			properties: {
				question: { type: "string" },
				context: { type: "string", description: "Background info to help the user answer" },
				suggestions: {
					type: "array",
					description:
						"Premade answer suggestions rendered as clickable buttons in Discord. The user can pick one or type a custom free-form answer.",
					items: {
						type: "object",
						properties: {
							id: { type: "string", description: "Short unique identifier (snake_case)" },
							title: { type: "string", description: "Button label (short, ≤80 chars)" },
							subtitle: {
								type: "string",
								description: "Extra context shown below the title in the embed",
							},
						},
						required: ["id", "title"],
					},
				},
			},
			required: ["question"],
		},
	},
	{
		name: "urgent_question",
		description:
			"Ask a critical question that blocks progress. In requiredOnly/always modes this sends immediately and waits. In onReportOnly mode it triggers an early report. In never mode it logs to memory and proceeds autonomously. Provide suggestions when possible.",
		input_schema: {
			type: "object",
			properties: {
				question: { type: "string" },
				context: { type: "string", description: "Why this is blocking your progress" },
				suggestions: {
					type: "array",
					description:
						"Premade answer suggestions rendered as clickable buttons in Discord. The user can pick one or type a custom free-form answer.",
					items: {
						type: "object",
						properties: {
							id: { type: "string", description: "Short unique identifier (snake_case)" },
							title: { type: "string", description: "Button label (short, ≤80 chars)" },
							subtitle: {
								type: "string",
								description: "Extra context shown below the title in the embed",
							},
						},
						required: ["id", "title"],
					},
				},
			},
			required: ["question"],
		},
	},

	// ── Reports ──────────────────────────────────────────────────────────────────
	{
		name: "send_report",
		description:
			"Send a structured progress report via Discord and save it as an immutable record in the database. Supports text sections (auto-split at 1800 chars), Mermaid diagrams (rendered to PNG), and web page / HTML screenshots. Whether the agent freezes after sending depends on freeze_report_mode.\n\nIMPORTANT: This is the ONLY correct way to record reports. Do NOT use write_file to save reports — file-based reports are mutable and can be accidentally overwritten. Reports saved via send_report are permanent database records that cannot be modified.",
		input_schema: {
			type: "object",
			properties: {
				title: { type: "string", description: "Report title" },
				sections: {
					type: "array",
					description: "Text sections. Each section is split into ≤1800-char chunks automatically.",
					items: {
						type: "object",
						properties: {
							title: { type: "string" },
							content: {
								type: "string",
								description: "Section body. Plain text or markdown. Will be formatted as a code block.",
							},
						},
						required: ["content"],
					},
				},
				mermaid_diagrams: {
					type: "array",
					description: "Mermaid diagrams to render as PNG images and attach to the report.",
					items: {
						type: "object",
						properties: {
							title: { type: "string" },
							definition: {
								type: "string",
								description: "Full Mermaid diagram definition (e.g. 'graph TD; A-->B')",
							},
						},
						required: ["definition"],
					},
				},
				screenshot_targets: {
					type: "array",
					description:
						"Pages to screenshot. Each target can be: a URL (https://...), a workspace-relative file path (.html), or a raw HTML string (starts with '<').",
					items: {
						type: "object",
						properties: {
							title: { type: "string" },
							target: { type: "string" },
						},
						required: ["target"],
					},
				},
				freeze_override: {
					type: "string",
					enum: ["freeze", "continue"],
					description:
						"Override the current freeze_report_mode for this specific report. 'freeze' = pause agent until user confirms; 'continue' = send report and keep working.",
				},
			},
			required: ["title", "sections"],
		},
	},

	// ── Mode controls (managed via Discord commands, not agent tools) ────────────

	// ── Git ──────────────────────────────────────────────────────────────────────
	{
		name: "commit_changes",
		description:
			"Stage all workspace changes, run quality checks (lint, typecheck, tests), and create a git commit with a conventional commit message. Commit is aborted if any quality check fails. Use this regularly after completing meaningful units of work.",
		input_schema: {
			type: "object",
			properties: {
				message: {
					type: "string",
					description:
						"Conventional commit message (e.g. 'feat(auth): add JWT middleware', 'fix(login): handle token expiry', 'chore: update dependencies'). Be descriptive and specific.",
				},
				skip_checks: {
					type: "boolean",
					description:
						"Skip lint/typecheck/test before committing. Only use when checks are known to be unavailable. Default: false.",
				},
			},
			required: ["message"],
		},
	},

	// ── Context management ────────────────────────────────────────────────────────
	{
		name: "compact_context",
		description:
			"Summarise the older portion of the conversation into a concise context block, freeing up context window space. Call this proactively when the conversation grows long or before an intensive multi-step operation.",
		input_schema: {
			type: "object",
			properties: {},
			required: [],
		},
	},

	// ── Implementation checklist ──────────────────────────────────────────────────
	{
		name: "ask_checklist",
		description:
			"Present a structured implementation checklist to the user via Discord BEFORE starting coding. Use this at the very start of a new implementation to surface ambiguities, confirm constraints, and avoid asking questions later. Group related questions into the same checklist call.",
		input_schema: {
			type: "object",
			properties: {
				title: {
					type: "string",
					description: "Checklist title (e.g. 'Implementation Requirements')",
				},
				items: {
					type: "array",
					description: "Questions to ask the user. All unanswered questions block implementation until Discord response.",
					items: {
						type: "object",
						properties: {
							id: {
								type: "string",
								description: "Short unique identifier for this question (snake_case)",
							},
							question: { type: "string", description: "The question text" },
							description: {
								type: "string",
								description: "Context or example answers to help the user",
							},
							required: {
								type: "boolean",
								description: "Whether this answer is required to proceed. Default: false.",
							},
						},
						required: ["id", "question"],
					},
				},
			},
			required: ["title", "items"],
		},
	},

	// ── Plan Mode ────────────────────────────────────────────────────────────────
	{
		name: "enter_plan_mode",
		description:
			"Enter plan mode — restricts available tools to read-only operations (grep, glob, read_file, list_directory, search_files, bash read-only commands). Use this when you need to explore the codebase and form a plan before making changes. Call exit_plan_mode when ready to implement.",
		input_schema: {
			type: "object",
			properties: {},
			required: [],
		},
	},
	{
		name: "exit_plan_mode",
		description:
			"Exit plan mode and resume full tool access. Optionally provide a plan summary documenting what you learned and intend to do.",
		input_schema: {
			type: "object",
			properties: {
				plan_summary: {
					type: "string",
					description: "Summary of what you explored and the implementation plan you've formed",
				},
			},
			required: ["plan_summary"],
		},
	},
];
