import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

const WORKSPACE = process.env.WORKSPACE_PATH ?? "/workspace";

/** Resolve a path to an absolute path within the workspace sandbox */
function sandboxPath(p: string): string {
	if (p.startsWith("/")) {
		// Absolute path — only allow if it's already inside the workspace
		if (!p.startsWith(WORKSPACE)) return join(WORKSPACE, p.replace(/^\/+/, ""));
		return p;
	}
	return join(WORKSPACE, p);
}

export const AGENT_TOOLS: Anthropic.Tool[] = [
	// ── File system ──────────────────────────────────────────────────────────────
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
		description: "Write content to a file in the workspace. Cannot write to .agent/memory/ — use write_memory for that.",
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

	// ── Memory Management ─────────────────────────────────────────────────────────
	{
		name: "read_memory",
		description:
			"Read from the agent's persistent memory system (.agent/ directory). Use this to recall project context, architecture, decisions, TODOs, and conventions stored from previous sessions.",
		input_schema: {
			type: "object",
			properties: {
				file: {
					type: "string",
					description:
						"Memory file to read. Options: 'MEMORY.md' (index), 'DECISIONS.md', 'TODO.md', 'QUESTIONS.md', 'plans/CURRENT_PLAN.md', or any file in memory/ subdirectory like 'memory/architecture.md', 'memory/codebase.md', 'memory/conventions.md', etc.",
				},
			},
			required: ["file"],
		},
	},
	{
		name: "write_memory",
		description:
			"Write to the agent's persistent memory system. Updates memory files with new information. If writing to memory/ subdirectory, automatically updates MEMORY.md index. Use this to record architecture decisions, update TODOs, document conventions, etc.",
		input_schema: {
			type: "object",
			properties: {
				file: {
					type: "string",
					description:
						"Memory file to write. For topic files use 'memory/filename.md'. For root files use 'DECISIONS.md', 'TODO.md', etc. New memory/ files are auto-registered in MEMORY.md.",
				},
				content: {
					type: "string",
					description:
						"Full content to write. For memory/ files, include frontmatter if needed. For DECISIONS.md, append new entries without deleting old ones.",
				},
				append: {
					type: "boolean",
					description: "If true, append to file instead of overwriting. Useful for DECISIONS.md and TODO.md. Default: false",
				},
			},
			required: ["file", "content"],
		},
	},
	{
		name: "search_memory",
		description:
			"Search across all memory files for specific patterns or keywords. Returns matches with file names and context. Useful for finding where you documented something, checking if a decision was made, or discovering related context.",
		input_schema: {
			type: "object",
			properties: {
				pattern: {
					type: "string",
					description: "Search pattern (supports regex). Examples: 'authentication', 'database.*choice', 'TODO.*urgent'",
				},
				case_sensitive: {
					type: "boolean",
					description: "Case-sensitive search. Default: false",
				},
			},
			required: ["pattern"],
		},
	},
	{
		name: "append_decision",
		description:
			"Append a new architectural or design decision to DECISIONS.md. Automatically formats it with timestamp and proper structure. Never deletes previous decisions (append-only log).",
		input_schema: {
			type: "object",
			properties: {
				title: {
					type: "string",
					description: "Short decision title (e.g., 'Use PostgreSQL for persistence')",
				},
				context: {
					type: "string",
					description: "Why this decision was needed",
				},
				decision: {
					type: "string",
					description: "What was decided",
				},
				rationale: {
					type: "string",
					description: "Why this option over alternatives",
				},
				consequences: {
					type: "string",
					description: "Trade-offs, implications, or follow-up actions",
				},
			},
			required: ["title", "context", "decision", "rationale"],
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
			"Ask a critical question that blocks progress. In requiredOnly/always modes this sends immediately and waits. In onReportOnly mode it triggers an early report. In never mode it writes to QUESTIONS.md. Provide suggestions when possible.",
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

	// ── Mode controls ────────────────────────────────────────────────────────────
	{
		name: "change_timeout",
		description: "Change the total agent run timeout (default: 240 minutes). After timeout, agent freezes and awaits user input.",
		input_schema: {
			type: "object",
			properties: {
				minutes: { type: "number", description: "New total timeout in minutes (1–1440)" },
			},
			required: ["minutes"],
		},
	},
	{
		name: "change_report_time_interval",
		description: "Change the automatic report interval (default: 15 minutes). Set to 0 to disable automatic reports entirely.",
		input_schema: {
			type: "object",
			properties: {
				minutes: { type: "number", description: "Minutes between auto-reports (0 to disable)" },
			},
			required: ["minutes"],
		},
	},
	{
		name: "change_freeze_report_mode",
		description:
			"Control whether reports cause the agent to freeze and await user input.\n- always: freeze on every report\n- never: reports are async, agent continues immediately\n- custom: agent evaluates custom_rule to decide per-report",
		input_schema: {
			type: "object",
			properties: {
				mode: { type: "string", enum: ["always", "never", "custom"] },
				custom_rule: {
					type: "string",
					description:
						"When mode=custom: describe the condition under which the agent should freeze (e.g. 'freeze if the report involves a security concern or major architecture decision')",
				},
			},
			required: ["mode"],
		},
	},
	{
		name: "change_freeze_ask_mode",
		description:
			"Control how questions are sent to the user.\n- always: ask questions at every opportunity, grouped\n- requiredOnly: only urgent questions block; others accumulate for next report\n- onReportOnly: all questions accumulate until the next report cycle; urgent questions trigger an early report\n- never: all questions written to QUESTIONS.md; agent decides autonomously; asks at total timeout\n\nNote: freeze_report_mode takes precedence — if a report freezes, questions are always asked then.",
		input_schema: {
			type: "object",
			properties: {
				mode: {
					type: "string",
					enum: ["always", "requiredOnly", "onReportOnly", "never"],
				},
			},
			required: ["mode"],
		},
	},

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
	{
		name: "change_compact_threshold",
		description:
			"Change the estimated context token threshold that triggers automatic context compaction (default: 80 000). Set to 0 to disable automatic compaction.",
		input_schema: {
			type: "object",
			properties: {
				tokens: { type: "number", description: "Threshold in tokens (0 to disable)" },
			},
			required: ["tokens"],
		},
	},
	{
		name: "change_stop_threshold",
		description:
			"Change the cumulative token budget at which the agent auto-stops (default: 400 000 tokens). The agent freezes and surfaces all pending questions when this limit is reached. Set to 0 to disable.",
		input_schema: {
			type: "object",
			properties: {
				tokens: { type: "number", description: "Cumulative token budget (0 to disable)" },
			},
			required: ["tokens"],
		},
	},

	// ── Always-improve ────────────────────────────────────────────────────────────
	{
		name: "change_always_improve_mode",
		description:
			"Control what happens after the original task is complete.\n- no (default): agent completes and reports done\n- yes: agent never stops; always looks for further improvements (code quality, tests, docs, performance, refactoring)\n- custom: agent continues within a specific scope defined by the user",
		input_schema: {
			type: "object",
			properties: {
				mode: { type: "string", enum: ["yes", "no", "custom"] },
				scope: {
					type: "string",
					description:
						"When mode=custom: describe exactly what kinds of improvements are in scope (e.g. 'add tests and improve docs only; do not add new features')",
				},
			},
			required: ["mode"],
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

	// ── Session Management ────────────────────────────────────────────────────────
	{
		name: "set_session_name",
		description:
			"Give this session a short, memorable name that describes what you're working on. This helps the user identify sessions at a glance. Call this early in the session, ideally after understanding the task. Keep names concise (2-5 words) and descriptive (e.g. 'Auth System Refactor', 'Payment API', 'Bug Fix: Login Flow').",
		input_schema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "Short, descriptive name for this session (2-5 words recommended)",
				},
			},
			required: ["name"],
		},
	},
];

// ── Tool executors ────────────────────────────────────────────────────────────

export async function executeBash(
	command: string,
	timeoutMs = 30_000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	try {
		const proc = Bun.spawn(["bash", "-c", command], {
			cwd: WORKSPACE,
			stdout: "pipe",
			stderr: "pipe",
		});

		const timer = setTimeout(() => proc.kill(), timeoutMs);
		const exitCode = await proc.exited;
		clearTimeout(timer);

		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		return { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000), exitCode };
	} catch (err) {
		return { stdout: "", stderr: String(err), exitCode: 1 };
	}
}

export async function readFile(path: string): Promise<string> {
	const abs = sandboxPath(path);
	try {
		const text = await Bun.file(abs).text();
		return text.slice(0, 20_000);
	} catch (err) {
		throw new Error(`Cannot read ${path}: ${err}`);
	}
}

export async function writeFile(path: string, content: string): Promise<void> {
	const abs = sandboxPath(path);
	await Bun.write(abs, content);
}

export async function listDirectory(path = ""): Promise<string> {
	const abs = sandboxPath(path || ".");
	const result = await executeBash(`ls -la "${abs}"`);
	return result.stdout || result.stderr;
}

export async function searchFiles(
	pattern: string,
	path = ".",
	filePattern = "*",
	caseSensitive = false,
	maxResults = 100
): Promise<string> {
	const abs = sandboxPath(path);
	const caseFlag = caseSensitive ? "" : "-i";
	const includeFlag = filePattern === "*" ? "" : `--include="${filePattern}"`;

	// Use grep with line numbers and file names
	const cmd = `cd "${abs}" && grep -rn ${caseFlag} ${includeFlag} -E "${pattern.replace(/"/g, '\\"')}" . 2>/dev/null | head -${maxResults}`;
	const result = await executeBash(cmd, 15_000);

	if (result.exitCode !== 0 && !result.stdout) {
		return "No matches found.";
	}

	return result.stdout || "No matches found.";
}

export async function editFile(path: string, oldString: string, newString: string, replaceAll = false): Promise<string> {
	const abs = sandboxPath(path);

	try {
		const content = await Bun.file(abs).text();

		if (!content.includes(oldString)) {
			throw new Error(`String not found in file: ${path}`);
		}

		const occurrences = content.split(oldString).length - 1;
		if (occurrences > 1 && !replaceAll) {
			throw new Error(`Found ${occurrences} occurrences. Set replace_all=true to replace all, or make old_string more specific.`);
		}

		const newContent = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString);

		await Bun.write(abs, newContent);
		return `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${path}`;
	} catch (err) {
		throw new Error(`Cannot edit ${path}: ${err}`);
	}
}

export async function moveFile(source: string, destination: string): Promise<string> {
	const absSrc = sandboxPath(source);
	const absDest = sandboxPath(destination);

	// Create parent directory if needed
	const destDir = absDest.substring(0, absDest.lastIndexOf("/"));
	if (destDir) {
		await executeBash(`mkdir -p "${destDir}"`);
	}

	const result = await executeBash(`mv "${absSrc}" "${absDest}"`);

	if (result.exitCode !== 0) {
		throw new Error(`Cannot move ${source} to ${destination}: ${result.stderr}`);
	}

	return `Moved ${source} → ${destination}`;
}

export async function deleteFile(path: string, recursive = false): Promise<string> {
	const abs = sandboxPath(path);

	// Check if it's a directory
	const statResult = await executeBash(`test -d "${abs}" && echo "dir" || echo "file"`);
	const isDir = statResult.stdout.trim() === "dir";

	if (isDir && !recursive) {
		throw new Error(`${path} is a directory. Set recursive=true to delete directories.`);
	}

	const flag = recursive ? "-rf" : "-f";
	const result = await executeBash(`rm ${flag} "${abs}"`);

	if (result.exitCode !== 0) {
		throw new Error(`Cannot delete ${path}: ${result.stderr}`);
	}

	return `Deleted ${path}`;
}

export async function createDirectory(path: string): Promise<string> {
	const abs = sandboxPath(path);
	const result = await executeBash(`mkdir -p "${abs}"`);

	if (result.exitCode !== 0) {
		throw new Error(`Cannot create directory ${path}: ${result.stderr}`);
	}

	return `Created directory ${path}`;
}

export async function getFileInfo(path: string): Promise<string> {
	const abs = sandboxPath(path);

	// Get detailed file info
	const result = await executeBash(
		`stat -f "Size: %z bytes\nModified: %Sm\nType: %HT\nPermissions: %Sp" "${abs}" 2>/dev/null || stat --format="Size: %s bytes\nModified: %y\nType: %F\nPermissions: %A" "${abs}" 2>/dev/null`
	);

	if (result.exitCode !== 0) {
		throw new Error(`Cannot get info for ${path}: file not found`);
	}

	// Also count lines if it's a text file
	const wcResult = await executeBash(`wc -l "${abs}" 2>/dev/null`);
	const lines = wcResult.exitCode === 0 ? `\nLines: ${wcResult.stdout.trim().split(/\s+/)[0]}` : "";

	return result.stdout + lines;
}

export async function readFileRange(path: string, startLine: number, endLine: number): Promise<string> {
	const abs = sandboxPath(path);

	if (startLine < 1 || endLine < startLine) {
		throw new Error("Invalid line range. start_line must be ≥1 and ≤end_line");
	}

	const result = await executeBash(`sed -n '${startLine},${endLine}p' "${abs}" | head -1000`);

	if (result.exitCode !== 0) {
		throw new Error(`Cannot read ${path}: ${result.stderr}`);
	}

	if (!result.stdout) {
		return `Lines ${startLine}-${endLine} are empty or beyond end of file.`;
	}

	return result.stdout;
}

// ── Memory Management ─────────────────────────────────────────────────────────

const AGENT_DIR = ".agent";
const MEMORY_DIR = join(AGENT_DIR, "memory");

export async function readMemory(file: string): Promise<string> {
	// Normalize path - if it doesn't start with .agent, prepend it
	const memoryPath = file.startsWith(AGENT_DIR) ? file : join(AGENT_DIR, file);
	const abs = sandboxPath(memoryPath);

	try {
		const text = await Bun.file(abs).text();
		return text.slice(0, 50_000); // Memory files can be larger
	} catch (err) {
		throw new Error(`Cannot read memory file ${file}: ${err}`);
	}
}

export async function writeMemory(file: string, content: string, append = false): Promise<string> {
	const memoryPath = file.startsWith(AGENT_DIR) ? file : join(AGENT_DIR, file);
	const abs = sandboxPath(memoryPath);

	try {
		// Ensure parent directory exists
		const dir = abs.substring(0, abs.lastIndexOf("/"));
		await executeBash(`mkdir -p "${dir}"`);

		if (append) {
			const existing = await Bun.file(abs)
				.text()
				.catch(() => "");
			await Bun.write(abs, `${existing}\n${content}`);
		} else {
			await Bun.write(abs, content);
		}

		// If writing to memory/ subdirectory, check if MEMORY.md needs updating
		if (file.startsWith("memory/") && !append) {
			await updateMemoryIndex(file);
		}

		return `${append ? "Appended to" : "Written"}: ${file}`;
	} catch (err) {
		throw new Error(`Cannot write memory file ${file}: ${err}`);
	}
}

async function updateMemoryIndex(newFile: string): Promise<void> {
	// Check if the file is already registered in MEMORY.md
	const indexPath = sandboxPath(join(AGENT_DIR, "MEMORY.md"));
	try {
		const index = await Bun.file(indexPath).text();
		const fileName = newFile.replace("memory/", "");

		// Check if already listed
		if (index.includes(`[${fileName}]`) || index.includes(`(${newFile})`)) {
			return; // Already registered
		}

		// Add to the memory files table
		const tableEnd = index.indexOf("\n_Add rows here");
		if (tableEnd > 0) {
			const beforeTable = index.substring(0, tableEnd);
			const afterTable = index.substring(tableEnd);
			const newRow = `| [${fileName}](${newFile}) | _Add description here_ |\n`;
			await Bun.write(indexPath, beforeTable + newRow + afterTable);
		}
	} catch {
		// If MEMORY.md doesn't exist or can't be read, skip index update
	}
}

export async function searchMemory(pattern: string, caseSensitive = false): Promise<string> {
	const agentDir = sandboxPath(AGENT_DIR);
	const caseFlag = caseSensitive ? "" : "-i";

	// Search all files in .agent directory
	const cmd = `cd "${agentDir}" && grep -rn ${caseFlag} -E "${pattern.replace(/"/g, '\\"')}" . 2>/dev/null | head -50`;
	const result = await executeBash(cmd, 10_000);

	if (result.exitCode !== 0 && !result.stdout) {
		return "No matches found in memory.";
	}

	return result.stdout || "No matches found in memory.";
}

export async function appendDecision(
	title: string,
	context: string,
	decision: string,
	rationale: string,
	consequences?: string
): Promise<string> {
	const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
	const entry = `
## ${title} — ${date}
**Context:** ${context}
**Decision:** ${decision}
**Rationale:** ${rationale}
${consequences ? `**Consequences:** ${consequences}` : ""}
`;

	return await writeMemory("DECISIONS.md", entry, true);
}

export { sandboxPath };
