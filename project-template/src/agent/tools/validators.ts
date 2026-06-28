/**
 * Input validators for all agent tools.
 * Each validator returns null if valid, or an error string describing what's wrong.
 * The error is returned to the agent so it can self-correct.
 */

type Input = Record<string, unknown>;

type Validator = (input: Input) => string | null;

function requireString(input: Input, field: string, label?: string): string | null {
	const val = input[field];
	if (val === undefined || val === null) return `Missing required parameter: "${field}"${label ? ` (${label})` : ""}`;
	if (typeof val !== "string") return `Parameter "${field}" must be a string, got ${typeof val}`;
	if (val.trim() === "") return `Parameter "${field}" cannot be empty`;
	return null;
}

function requireNumber(input: Input, field: string, opts?: { min?: number; max?: number }): string | null {
	const val = input[field];
	if (val === undefined || val === null) return `Missing required parameter: "${field}"`;
	if (typeof val !== "number" || Number.isNaN(val)) return `Parameter "${field}" must be a number, got ${typeof val}`;
	if (opts?.min !== undefined && val < opts.min) return `Parameter "${field}" must be ≥ ${opts.min}, got ${val}`;
	if (opts?.max !== undefined && val > opts.max) return `Parameter "${field}" must be ≤ ${opts.max}, got ${val}`;
	return null;
}

function optionalString(input: Input, field: string): string | null {
	const val = input[field];
	if (val === undefined || val === null) return null;
	if (typeof val !== "string") return `Parameter "${field}" must be a string if provided, got ${typeof val}`;
	return null;
}

function optionalNumber(input: Input, field: string, opts?: { min?: number; max?: number }): string | null {
	const val = input[field];
	if (val === undefined || val === null) return null;
	if (typeof val !== "number" || Number.isNaN(val)) return `Parameter "${field}" must be a number if provided, got ${typeof val}`;
	if (opts?.min !== undefined && val < opts.min) return `Parameter "${field}" must be ≥ ${opts.min}, got ${val}`;
	if (opts?.max !== undefined && val > opts.max) return `Parameter "${field}" must be ≤ ${opts.max}, got ${val}`;
	return null;
}

function optionalBoolean(input: Input, field: string): string | null {
	const val = input[field];
	if (val === undefined || val === null) return null;
	if (typeof val !== "boolean") return `Parameter "${field}" must be a boolean if provided, got ${typeof val}`;
	return null;
}

function optionalEnum(input: Input, field: string, allowed: string[]): string | null {
	const val = input[field];
	if (val === undefined || val === null) return null;
	if (typeof val !== "string") return `Parameter "${field}" must be a string, got ${typeof val}`;
	if (!allowed.includes(val)) return `Parameter "${field}" must be one of: ${allowed.join(", ")}. Got "${val}"`;
	return null;
}

function requireEnum(input: Input, field: string, allowed: string[]): string | null {
	const val = input[field];
	if (val === undefined || val === null) return `Missing required parameter: "${field}". Must be one of: ${allowed.join(", ")}`;
	if (typeof val !== "string") return `Parameter "${field}" must be a string, got ${typeof val}`;
	if (!allowed.includes(val)) return `Parameter "${field}" must be one of: ${allowed.join(", ")}. Got "${val}"`;
	return null;
}

function requireStringArray(input: Input, field: string): string | null {
	const val = input[field];
	if (val === undefined || val === null) return null;
	if (!Array.isArray(val)) return `Parameter "${field}" must be an array, got ${typeof val}`;
	for (let i = 0; i < val.length; i++) {
		if (typeof val[i] !== "string") return `Parameter "${field}[${i}]" must be a string, got ${typeof val[i]}`;
	}
	return null;
}

function validateArrayItems(
	input: Input,
	field: string,
	requiredFields: Record<string, string>,
	opts?: { required?: boolean; minLength?: number }
): string | null {
	const val = input[field];
	if (val === undefined || val === null) {
		if (opts?.required) return `Missing required parameter: "${field}"`;
		return null;
	}
	if (!Array.isArray(val)) return `Parameter "${field}" must be an array, got ${typeof val}`;
	if (opts?.minLength && val.length < opts.minLength) return `Parameter "${field}" must have at least ${opts.minLength} item(s)`;
	const errors: string[] = [];
	for (let i = 0; i < val.length; i++) {
		const item = val[i];
		if (typeof item !== "object" || item === null) {
			errors.push(`"${field}[${i}]" must be an object`);
			continue;
		}
		for (const [key, label] of Object.entries(requiredFields)) {
			if (!(key in item) || typeof item[key] !== "string" || item[key].trim() === "") {
				errors.push(`"${field}[${i}].${key}" is required (${label})`);
			}
		}
	}
	return errors.length > 0 ? errors.join("\n") : null;
}

/** Collect all errors from a list of validation checks. */
function collectErrors(...checks: (string | null)[]): string | null {
	const errors = checks.filter(Boolean) as string[];
	return errors.length > 0 ? errors.join("\n") : null;
}

// ── Per-tool validators ──────────────────────────────────────────────────────

const validators: Record<string, Validator> = {
	// Commands
	bash: (input) =>
		collectErrors(
			requireString(input, "command", "shell command to execute"),
			optionalNumber(input, "timeout_ms", { min: 1, max: 300_000 })
		),
	grep: (input) =>
		collectErrors(
			requireString(input, "pattern", "regex pattern"),
			optionalString(input, "path"),
			optionalString(input, "include"),
			optionalString(input, "flags")
		),
	glob: (input) => collectErrors(requireString(input, "pattern", "glob pattern"), optionalString(input, "path")),

	// Filesystem
	read_file: (input) => requireString(input, "path", "file path"),
	write_file: (input) =>
		collectErrors(requireString(input, "path", "file path"), requireString(input, "content", "file content")),
	list_directory: (input) => optionalString(input, "path"),
	search_files: (input) =>
		collectErrors(
			requireString(input, "pattern", "search pattern"),
			optionalString(input, "path"),
			optionalString(input, "file_pattern"),
			optionalBoolean(input, "case_sensitive"),
			optionalNumber(input, "max_results", { min: 1, max: 1000 })
		),
	edit_file: (input) =>
		collectErrors(
			requireString(input, "path", "file path"),
			requireString(input, "old_string", "string to find"),
			requireString(input, "new_string", "replacement string"),
			optionalBoolean(input, "replace_all")
		),
	move_file: (input) =>
		collectErrors(requireString(input, "source", "source path"), requireString(input, "destination", "destination path")),
	delete_file: (input) => collectErrors(requireString(input, "path", "path to delete"), optionalBoolean(input, "recursive")),
	create_directory: (input) => requireString(input, "path", "directory path"),
	get_file_info: (input) => requireString(input, "path", "file path"),
	read_file_range: (input) => {
		const errs = collectErrors(
			requireString(input, "path", "file path"),
			requireNumber(input, "start_line", { min: 1 }),
			requireNumber(input, "end_line", { min: 1 })
		);
		if (errs) return errs;
		if ((input.end_line as number) < (input.start_line as number)) return `"end_line" must be ≥ "start_line"`;
		return null;
	},

	// Web
	web_search: (input) =>
		collectErrors(requireString(input, "query", "search query"), optionalNumber(input, "limit", { min: 1, max: 50 })),
	web_fetch: (input) => {
		const urlErr = requireString(input, "url", "URL to fetch");
		if (urlErr) return urlErr;
		const url = input.url as string;
		if (!/^https?:\/\//i.test(url)) return `Parameter "url" must start with http:// or https:// — got "${url}"`;
		return optionalNumber(input, "max_chars", { min: 100 });
	},

	// Memory
	remember: (input) =>
		collectErrors(
			requireEnum(input, "type", ["decision", "plan", "memory", "context"]),
			requireString(input, "title", "short descriptive title"),
			requireString(input, "content", "memory content")
		),
	recall: (input) =>
		collectErrors(
			requireString(input, "query", "natural language search query"),
			optionalEnum(input, "type", ["decision", "todo", "plan", "question", "memory", "report", "context"]),
			optionalNumber(input, "limit", { min: 1 })
		),
	update_memory: (input) => {
		const idErr = requireString(input, "id", "memory entry ID");
		if (idErr) return idErr;
		// At least one update field should be present
		if (!input.title && !input.content && !input.type && !input.metadata)
			return `At least one field to update must be provided (title, content, type, or metadata)`;
		return collectErrors(
			optionalString(input, "title"),
			optionalString(input, "content"),
			optionalEnum(input, "type", ["decision", "plan", "memory", "context"])
		);
	},
	delete_memory: (input) => requireString(input, "id", "memory entry ID"),
	list_memories: (input) =>
		collectErrors(
			optionalEnum(input, "type", ["decision", "todo", "plan", "question", "memory", "report", "context"]),
			optionalNumber(input, "limit", { min: 1 })
		),

	// Tasks
	add_task: (input) =>
		collectErrors(
			requireString(input, "text", "task description"),
			optionalEnum(input, "status", ["pending", "in_progress", "done", "cancelled"]),
			requireStringArray(input, "dependsOn")
		),
	list_tasks: (input) => optionalEnum(input, "filter", ["all", "pending", "in_progress", "done", "cancelled"]),
	update_task: (input) =>
		collectErrors(
			requireString(input, "id", "task ID"),
			optionalEnum(input, "status", ["pending", "in_progress", "done", "cancelled"]),
			optionalString(input, "text"),
			requireStringArray(input, "dependsOn")
		),
	get_current_task: () => null,
	set_current_task: (input) => requireString(input, "id", "task ID"),

	// Questions
	queue_question: (input) =>
		collectErrors(
			requireString(input, "question", "question text"),
			optionalString(input, "context"),
			validateArrayItems(input, "suggestions", { id: "unique identifier", title: "button label" })
		),
	urgent_question: (input) =>
		collectErrors(
			requireString(input, "question", "question text"),
			optionalString(input, "context"),
			validateArrayItems(input, "suggestions", { id: "unique identifier", title: "button label" })
		),

	// Reports
	send_report: (input) =>
		collectErrors(
			requireString(input, "title", "report title"),
			validateArrayItems(input, "sections", { content: "section body" }, { required: true, minLength: 1 }),
			validateArrayItems(input, "mermaid_diagrams", { definition: "mermaid diagram definition" }),
			validateArrayItems(input, "screenshot_targets", { target: "URL, file path, or HTML string" }),
			optionalEnum(input, "freeze_override", ["freeze", "continue"])
		),

	// Git
	commit_changes: (input) =>
		collectErrors(requireString(input, "message", "conventional commit message"), optionalBoolean(input, "skip_checks")),

	// Context
	compact_context: () => null,

	// Checklist
	ask_checklist: (input) =>
		collectErrors(
			requireString(input, "title", "checklist title"),
			validateArrayItems(input, "items", { id: "unique identifier", question: "question text" }, { required: true, minLength: 1 })
		),

	// Plan mode
	enter_plan_mode: () => null,
	exit_plan_mode: (input) => requireString(input, "plan_summary", "summary of what you explored and the implementation plan"),
};

/**
 * Validate tool input. Returns null if valid, or a descriptive error string
 * that should be returned to the agent as a tool_result with is_error: true.
 */
export function validateToolInput(toolName: string, input: Input): string | null {
	const validator = validators[toolName];
	if (!validator) return null; // Unknown tools pass through (handled by dispatch)
	return validator(input);
}
