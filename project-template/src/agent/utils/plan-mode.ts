/**
 * Plan mode: restricts the agent to read-only tools during planning phases.
 */

import { ToolName } from "../tools/definitions";

// Tools allowed in plan mode (read-only operations)
export const PLAN_MODE_TOOLS = new Set<string>([
	ToolName.Grep,
	ToolName.Glob,
	ToolName.ReadFile,
	ToolName.ListDirectory,
	ToolName.SearchFiles,
	ToolName.ReadFileRange,
	ToolName.Recall,
	ToolName.ListMemories,
	ToolName.ListTasks,
	ToolName.CompactContext,
	ToolName.ExitPlanMode,
	ToolName.Bash, // conditionally allowed — checked separately
]);

// Bash commands that are allowed in plan mode (read-only patterns)
const BASH_READONLY_PREFIXES = [
	"cat ",
	"head ",
	"tail ",
	"less ",
	"more ",
	"ls",
	"find ",
	"tree ",
	"wc ",
	"du ",
	"df ",
	"echo ",
	"printf ",
	"git log",
	"git diff",
	"git show",
	"git status",
	"git branch",
	"git tag",
	"git rev-parse",
	"grep ",
	"rg ",
	"ag ",
	"ack ",
	"file ",
	"stat ",
	"which ",
	"whereis ",
	"type ",
	"env",
	"printenv",
	"pwd",
	"whoami",
	"id ",
	"hostname",
	"ps ",
	"top ",
	"uptime",
	"curl ", // writes to stdout by default (unlike wget, which writes a file and is therefore not listed)
	"jq ",
	"yq ",
];

// Bash patterns that indicate a write operation
const BASH_WRITE_PATTERNS = [
	/\s*>/, // redirect output
	/\s*>>/, // append redirect
	/\|.*tee\s/, // pipe to tee
	/\brm\s/, // remove
	/\brmdir\s/, // remove dir
	/\bmv\s/, // move
	/\bcp\s/, // copy
	/\bmkdir\s/, // create dir
	/\btouch\s/, // create file
	/\bchmod\s/, // change permissions
	/\bchown\s/, // change owner
	/\bln\s/, // create link
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|stash|cherry-pick|revert)\b/,
	/\bnpm\s+(install|uninstall|update|publish|link)\b/,
	/\bbun\s+(add|remove|install|link|publish)\b/,
	/\byarn\s+(add|remove|install)\b/,
	/\bpip\s+(install|uninstall)\b/,
	/\bapt(-get)?\s+(install|remove|purge)\b/,
	/\bsed\s+-i/, // in-place sed
	/\bdd\s/, // disk operations
];

export function isBashCommandReadOnly(command: string): boolean {
	const trimmed = command.trim();

	// Check for write patterns first (higher priority)
	for (const pattern of BASH_WRITE_PATTERNS) {
		if (pattern.test(trimmed)) return false;
	}

	// Command substitution can smuggle an arbitrary command into an otherwise
	// read-only one (`cat $(rm -rf x)`) — reject outright.
	if (trimmed.includes("$(") || trimmed.includes("`")) return false;

	// Split compound commands and verify every part. This must run BEFORE the
	// prefix check: `cat x; unknown-cmd` would otherwise be approved on the
	// strength of its `cat ` prefix alone. We split on every shell separator that
	// starts a new command: `&&`, `||`, `;`, a NEWLINE, and a single pipe `|`.
	// The pipe and newline matter for safety — `cat f | some-writer` and a
	// two-line script both used to slip through because the splitter only saw
	// `&&`/`||`/`;`, leaving the destructive half unchecked behind the `cat `
	// prefix. (A `|` inside a quoted arg like `grep 'a|b'` will now over-split and
	// be rejected — acceptable: plan mode fails closed.)
	if (/&&|\|\||;|\||\n/.test(trimmed)) {
		const parts = trimmed.split(/\s*(?:&&|\|\||;|\||\n)\s*/).filter(Boolean);
		return parts.every((part) => isBashCommandReadOnly(part));
	}

	// Check if starts with a known readonly prefix
	for (const prefix of BASH_READONLY_PREFIXES) {
		if (trimmed.startsWith(prefix) || trimmed === prefix.trim()) return true;
	}

	// Default: reject unknown commands in plan mode
	return false;
}

export const PLAN_MODE_BLOCKED_MESSAGE =
	"⚠️ Tool blocked: you are in plan mode (read-only). Use `exit_plan_mode` to resume full access, or use read-only tools (grep, glob, read_file, list_directory, search_files, bash with read-only commands) to continue planning.";

export const PLAN_MODE_BASH_BLOCKED_MESSAGE =
	"⚠️ Command blocked: this bash command appears to perform write operations. In plan mode, only read-only commands are allowed (ls, cat, find, git log, git diff, grep, etc.).";
