/**
 * Input validators for all agent tools.
 *
 * Each validator is a TypeScript assertion function: it narrows the raw
 * `Record<string, unknown>` tool input to a precisely-typed shape, or throws a
 * `ToolValidationError` describing what's wrong. Callers (the runner's tool
 * dispatch) get fully-typed input with no casting; the thrown message is
 * surfaced back to the agent as a tool_result error so it can self-correct.
 */

import type { ReportData } from "../../external/discord";
import type { MemoryType } from "./implementations/memory";

type Input = Record<string, unknown>;

/** Thrown by a validator when input fails its checks. */
export class ToolValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolValidationError";
	}
}

// ── Primitive checks (return an error string, or null when valid) ─────────────

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

function optionalEnum<T extends string>(input: Input, field: string, allowed: readonly T[]): string | null {
	const val = input[field];
	if (val === undefined || val === null) return null;
	if (typeof val !== "string") return `Parameter "${field}" must be a string, got ${typeof val}`;
	if (!allowed.includes(val as T)) return `Parameter "${field}" must be one of: ${allowed.join(", ")}. Got "${val}"`;
	return null;
}

function requireEnum<T extends string>(input: Input, field: string, allowed: readonly T[]): string | null {
	const val = input[field];
	if (val === undefined || val === null) return `Missing required parameter: "${field}". Must be one of: ${allowed.join(", ")}`;
	if (typeof val !== "string") return `Parameter "${field}" must be a string, got ${typeof val}`;
	if (!allowed.includes(val as T)) return `Parameter "${field}" must be one of: ${allowed.join(", ")}. Got "${val}"`;
	return null;
}

function optionalStringArray(input: Input, field: string): string | null {
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
			if (!(key in item) || typeof (item as Input)[key] !== "string" || ((item as Input)[key] as string).trim() === "") {
				errors.push(`"${field}[${i}].${key}" is required (${label})`);
			}
		}
	}
	return errors.length > 0 ? errors.join("\n") : null;
}

/** Throw a ToolValidationError if any of the checks produced an error. */
function assertValid(...checks: (string | null)[]): void {
	const errors = checks.filter(Boolean) as string[];
	if (errors.length > 0) throw new ToolValidationError(errors.join("\n"));
}

type TaskStatus = "pending" | "in_progress" | "done" | "cancelled";

// ── Commands ──────────────────────────────────────────────────────────────────

export interface BashInput extends Input {
	command: string;
	timeout_ms?: number;
}
export function validateBash(input: Input): asserts input is BashInput {
	assertValid(
		requireString(input, "command", "shell command to execute"),
		optionalNumber(input, "timeout_ms", { min: 1, max: 300_000 })
	);
}

export interface GrepInput extends Input {
	pattern: string;
	path?: string;
	include?: string;
	flags?: string;
}
export function validateGrep(input: Input): asserts input is GrepInput {
	assertValid(
		requireString(input, "pattern", "regex pattern"),
		optionalString(input, "path"),
		optionalString(input, "include"),
		optionalString(input, "flags")
	);
}

export interface GlobInput extends Input {
	pattern: string;
	path?: string;
}
export function validateGlob(input: Input): asserts input is GlobInput {
	assertValid(requireString(input, "pattern", "glob pattern"), optionalString(input, "path"));
}

// ── Filesystem ────────────────────────────────────────────────────────────────

export interface ReadFileInput extends Input {
	path: string;
}
export function validateReadFile(input: Input): asserts input is ReadFileInput {
	assertValid(requireString(input, "path", "file path"));
}

export interface WriteFileInput extends Input {
	path: string;
	content: string;
}
export function validateWriteFile(input: Input): asserts input is WriteFileInput {
	assertValid(requireString(input, "path", "file path"), requireString(input, "content", "file content"));
}

export interface ListDirectoryInput extends Input {
	path?: string;
}
export function validateListDirectory(input: Input): asserts input is ListDirectoryInput {
	assertValid(optionalString(input, "path"));
}

export interface SearchFilesInput extends Input {
	pattern: string;
	path?: string;
	file_pattern?: string;
	case_sensitive?: boolean;
	max_results?: number;
}
export function validateSearchFiles(input: Input): asserts input is SearchFilesInput {
	assertValid(
		requireString(input, "pattern", "search pattern"),
		optionalString(input, "path"),
		optionalString(input, "file_pattern"),
		optionalBoolean(input, "case_sensitive"),
		optionalNumber(input, "max_results", { min: 1, max: 1000 })
	);
}

export interface EditFileInput extends Input {
	path: string;
	old_string: string;
	new_string: string;
	replace_all?: boolean;
}
export function validateEditFile(input: Input): asserts input is EditFileInput {
	assertValid(
		requireString(input, "path", "file path"),
		requireString(input, "old_string", "string to find"),
		requireString(input, "new_string", "replacement string"),
		optionalBoolean(input, "replace_all")
	);
}

export interface MoveFileInput extends Input {
	source: string;
	destination: string;
}
export function validateMoveFile(input: Input): asserts input is MoveFileInput {
	assertValid(requireString(input, "source", "source path"), requireString(input, "destination", "destination path"));
}

export interface DeleteFileInput extends Input {
	path: string;
	recursive?: boolean;
}
export function validateDeleteFile(input: Input): asserts input is DeleteFileInput {
	assertValid(requireString(input, "path", "path to delete"), optionalBoolean(input, "recursive"));
}

export interface CreateDirectoryInput extends Input {
	path: string;
}
export function validateCreateDirectory(input: Input): asserts input is CreateDirectoryInput {
	assertValid(requireString(input, "path", "directory path"));
}

export interface GetFileInfoInput extends Input {
	path: string;
}
export function validateGetFileInfo(input: Input): asserts input is GetFileInfoInput {
	assertValid(requireString(input, "path", "file path"));
}

export interface ReadFileRangeInput extends Input {
	path: string;
	start_line: number;
	end_line: number;
}
export function validateReadFileRange(input: Input): asserts input is ReadFileRangeInput {
	assertValid(
		requireString(input, "path", "file path"),
		requireNumber(input, "start_line", { min: 1 }),
		requireNumber(input, "end_line", { min: 1 })
	);
	if ((input.end_line as number) < (input.start_line as number))
		throw new ToolValidationError(`"end_line" must be ≥ "start_line"`);
}

// ── Web ───────────────────────────────────────────────────────────────────────

export interface WebSearchInput extends Input {
	query: string;
	limit?: number;
}
export function validateWebSearch(input: Input): asserts input is WebSearchInput {
	assertValid(requireString(input, "query", "search query"), optionalNumber(input, "limit", { min: 1, max: 50 }));
}

export interface WebFetchInput extends Input {
	url: string;
	max_chars?: number;
}
export function validateWebFetch(input: Input): asserts input is WebFetchInput {
	assertValid(requireString(input, "url", "URL to fetch"));
	const url = input.url as string;
	if (!/^https?:\/\//i.test(url))
		throw new ToolValidationError(`Parameter "url" must start with http:// or https:// — got "${url}"`);
	assertValid(optionalNumber(input, "max_chars", { min: 100 }));
}

// ── Memory ────────────────────────────────────────────────────────────────────

const REMEMBER_TYPES = ["decision", "plan", "memory", "context"] as const satisfies readonly MemoryType[];
const ALL_MEMORY_TYPES = ["decision", "plan", "question", "memory", "report", "context"] as const satisfies readonly MemoryType[];

export interface RememberInput extends Input {
	type: MemoryType;
	title: string;
	content: string;
	metadata?: Record<string, unknown>;
}
export function validateRemember(input: Input): asserts input is RememberInput {
	assertValid(
		requireEnum(input, "type", REMEMBER_TYPES),
		requireString(input, "title", "short descriptive title"),
		requireString(input, "content", "memory content")
	);
}

export interface RecallInput extends Input {
	query: string;
	type?: MemoryType;
	limit?: number;
}
export function validateRecall(input: Input): asserts input is RecallInput {
	assertValid(
		requireString(input, "query", "natural language search query"),
		optionalEnum(input, "type", ALL_MEMORY_TYPES),
		optionalNumber(input, "limit", { min: 1 })
	);
}

export interface UpdateMemoryInput extends Input {
	id: string;
	title?: string;
	content?: string;
	type?: MemoryType;
	metadata?: Record<string, unknown>;
}
export function validateUpdateMemory(input: Input): asserts input is UpdateMemoryInput {
	assertValid(requireString(input, "id", "memory entry ID"));
	if (!input.title && !input.content && !input.type && !input.metadata)
		throw new ToolValidationError(`At least one field to update must be provided (title, content, type, or metadata)`);
	assertValid(optionalString(input, "title"), optionalString(input, "content"), optionalEnum(input, "type", REMEMBER_TYPES));
}

export interface DeleteMemoryInput extends Input {
	id: string;
}
export function validateDeleteMemory(input: Input): asserts input is DeleteMemoryInput {
	assertValid(requireString(input, "id", "memory entry ID"));
}

export interface ListMemoriesInput extends Input {
	type?: MemoryType;
	limit?: number;
}
export function validateListMemories(input: Input): asserts input is ListMemoriesInput {
	assertValid(optionalEnum(input, "type", ALL_MEMORY_TYPES), optionalNumber(input, "limit", { min: 1 }));
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

const TASK_STATUSES = ["pending", "in_progress", "done", "cancelled"] as const satisfies readonly TaskStatus[];

export interface AddTaskInput extends Input {
	text: string;
	status?: TaskStatus;
	dependsOn?: string[];
}
export function validateAddTask(input: Input): asserts input is AddTaskInput {
	assertValid(
		requireString(input, "text", "task description"),
		optionalEnum(input, "status", TASK_STATUSES),
		optionalStringArray(input, "dependsOn")
	);
}

export interface ListTasksInput extends Input {
	filter?: "all" | TaskStatus;
}
export function validateListTasks(input: Input): asserts input is ListTasksInput {
	assertValid(optionalEnum(input, "filter", ["all", ...TASK_STATUSES] as const));
}

export interface UpdateTaskInput extends Input {
	id: string;
	status?: TaskStatus;
	text?: string;
	dependsOn?: string[];
}
export function validateUpdateTask(input: Input): asserts input is UpdateTaskInput {
	assertValid(
		requireString(input, "id", "task ID"),
		optionalEnum(input, "status", TASK_STATUSES),
		optionalString(input, "text"),
		optionalStringArray(input, "dependsOn")
	);
}

export interface SetCurrentTaskInput extends Input {
	id: string;
}
export function validateSetCurrentTask(input: Input): asserts input is SetCurrentTaskInput {
	assertValid(requireString(input, "id", "task ID"));
}

// ── Questions ─────────────────────────────────────────────────────────────────

export interface QuestionInput extends Input {
	question: string;
	context?: string;
	suggestions?: Array<{ id: string; title: string; description?: string }>;
}
export function validateQuestion(input: Input): asserts input is QuestionInput {
	assertValid(
		requireString(input, "question", "question text"),
		optionalString(input, "context"),
		validateArrayItems(input, "suggestions", { id: "unique identifier", title: "button label" })
	);
}

export interface AskUserQuestionOption {
	label: string;
	description: string;
}

export interface AskUserQuestionItem {
	question: string;
	header: string;
	options: AskUserQuestionOption[];
	multiSelect?: boolean;
}

export interface AskUserQuestionInput extends Input {
	title?: string;
	questions: AskUserQuestionItem[];
	context?: string;
	urgent?: boolean;
}
export function validateAskUserQuestion(input: Input): asserts input is AskUserQuestionInput {
	assertValid(optionalString(input, "title"), optionalString(input, "context"), optionalBoolean(input, "urgent"));
	// Validate questions array
	const questions = input.questions;
	if (!questions || !Array.isArray(questions))
		throw new ToolValidationError('Missing required parameter: "questions" (must be an array)');
	if (questions.length < 1) throw new ToolValidationError('"questions" must have at least 1 item');
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];

		if (typeof q !== "object" || q === null) throw new ToolValidationError(`"questions[${i}]" must be an object`);
		const errors: string[] = [];
		const qErr = requireString(q, "question", "question text");
		if (qErr) errors.push(`questions[${i}]: ${qErr}`);
		const hErr = requireString(q, "header", "short label (max 12 chars)");
		if (hErr) errors.push(`questions[${i}]: ${hErr}`);
		if (!q.options || !Array.isArray(q.options)) errors.push(`questions[${i}]: "options" is required and must be an array`);
		else if (q.options.length < 2) errors.push(`questions[${i}]: "options" must have at least 2 items`);
		else if (q.options.length > 4) errors.push(`questions[${i}]: "options" must have at most 4 items`);
		else {
			for (let j = 0; j < q.options.length; j++) {
				const opt = q.options[j] as Input;
				if (typeof opt !== "object" || opt === null) {
					errors.push(`questions[${i}].options[${j}]: must be an object`);
					continue;
				}
				const lErr = requireString(opt, "label", "option label");
				if (lErr) errors.push(`questions[${i}].options[${j}]: ${lErr}`);
				const dErr = requireString(opt, "description", "option description");
				if (dErr) errors.push(`questions[${i}].options[${j}]: ${dErr}`);
			}
		}
		const msErr = optionalBoolean(q, "multiSelect");
		if (msErr) errors.push(`questions[${i}]: ${msErr}`);
		if (errors.length > 0) throw new ToolValidationError(errors.join("\n"));
	}
}

// ── Reports ───────────────────────────────────────────────────────────────────

export interface SendReportInput extends Input {
	title: string;
	sections: ReportData["sections"];
	mermaid_diagrams?: ReportData["mermaid_diagrams"];
	await_override?: "await" | "continue";
}
export function validateSendReport(input: Input): asserts input is SendReportInput {
	assertValid(
		requireString(input, "title", "report title"),
		validateArrayItems(input, "sections", { content: "section body" }, { required: true, minLength: 1 }),
		validateArrayItems(input, "mermaid_diagrams", { definition: "mermaid diagram definition" }),
		optionalEnum(input, "await_override", ["await", "continue"] as const)
	);
}

export interface SendGraphInput extends Input {
	definition: string;
	title?: string;
}
export function validateSendGraph(input: Input): asserts input is SendGraphInput {
	assertValid(requireString(input, "definition", "mermaid diagram definition"), optionalString(input, "title"));
}

// ── Git ───────────────────────────────────────────────────────────────────────

export interface CommitChangesInput extends Input {
	message: string;
	skip_checks?: boolean;
}
export function validateCommitChanges(input: Input): asserts input is CommitChangesInput {
	assertValid(requireString(input, "message", "conventional commit message"), optionalBoolean(input, "skip_checks"));
}

// ── Plan mode ─────────────────────────────────────────────────────────────────

export interface ExitPlanModeInput extends Input {
	plan_summary: string;
}
export function validateExitPlanMode(input: Input): asserts input is ExitPlanModeInput {
	assertValid(requireString(input, "plan_summary", "summary of what you explored and the implementation plan"));
}
