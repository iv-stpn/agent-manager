# Agent Tools Reference

Complete list of tools available to the autonomous agent.

---

## Commands

### `bash`

Execute a shell command inside the sandboxed workspace. Working directory is always the workspace root. All file operations are relative to the workspace.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | `string` | Yes | Shell command to execute |
| `timeout_ms` | `number` |  | Max execution time in ms (default: 30000) |

### `grep`

Search for a regex pattern in files. Returns matching lines with file paths and line numbers.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | `string` | Yes | Regex pattern to search for |
| `path` | `string` |  | Directory to search in (default: workspace root) |
| `include` | `string` |  | File glob filter (e.g. '*.ts') |
| `flags` | `string` |  | Extra grep flags (e.g. '-i' for case-insensitive) |

### `glob`

Find files and directories matching a glob pattern (e.g. '**/*.ts', 'src/**/*.{ts,js}').

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | `string` | Yes | Glob pattern to match |
| `path` | `string` |  | Base directory (default: workspace root) |

## File system

### `read_file`

Read a file from the workspace. Path is relative to workspace root.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | File path (relative to workspace) |

### `write_file`

Write content to a file in the workspace. Cannot write to .agent/memory/ — use write_memory for that.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | File path (relative to workspace) |
| `content` | `string` | Yes | Content to write |

### `list_directory`

List files in a workspace directory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` |  | Directory path (default: workspace root) |

### `search_files`

Search for patterns in files using grep. Returns matching lines with file paths and line numbers. Useful for finding function definitions, imports, TODOs, or any text pattern across the codebase.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | `string` | Yes | Search pattern (supports regex) |
| `path` | `string` |  | Directory to search in (default: workspace root) |
| `file_pattern` | `string` |  | File glob pattern (e.g., '*.ts', '*.py'). Default: all files |
| `case_sensitive` | `boolean` |  | Case-sensitive search. Default: false |
| `max_results` | `number` |  | Maximum results to return. Default: 100 |

### `edit_file`

Edit a file by replacing specific content. Searches for old_string and replaces with new_string. More efficient than reading entire file, modifying, and writing back. The old_string must match exactly (including whitespace).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | File path (relative to workspace) |
| `old_string` | `string` | Yes | Exact string to find and replace (must match exactly) |
| `new_string` | `string` | Yes | Replacement string |
| `replace_all` | `boolean` |  | Replace all occurrences (default: false, only first match) |

### `move_file`

Move or rename a file or directory. Creates parent directories if needed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source` | `string` | Yes | Source path (relative to workspace) |
| `destination` | `string` | Yes | Destination path (relative to workspace) |

### `delete_file`

Delete a file or directory. Use with caution. For directories, deletes recursively.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | Path to delete (relative to workspace) |
| `recursive` | `boolean` |  | Required true for directories. Default: false |

### `create_directory`

Create a directory (and any missing parent directories).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | Directory path (relative to workspace) |

### `get_file_info`

Get metadata about a file or directory: size, modification time, permissions, type. Useful before reading large files or checking if a path exists.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | Path to inspect (relative to workspace) |

### `read_file_range`

Read a specific range of lines from a file. Efficient for large files when you only need a portion.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | File path (relative to workspace) |
| `start_line` | `number` | Yes | Starting line number (1-indexed, inclusive) |
| `end_line` | `number` | Yes | Ending line number (1-indexed, inclusive) |

## Memory Management

### `read_memory`

Read from the agent's persistent memory system (.agent/ directory). Use this to recall project context, architecture, decisions, TODOs, and conventions stored from previous sessions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file` | `string` | Yes | Memory file to read. Options: 'MEMORY.md' (index), 'DECISIONS.md', 'TODO.md', 'QUESTIONS.md', 'plans/CURRENT_PLAN.md', or any file in memory/ subdirectory like 'memory/architecture.md', 'memory/codebase.md', 'memory/conventions.md', etc. |

### `write_memory`

Write to the agent's persistent memory system. Updates memory files with new information. If writing to memory/ subdirectory, automatically updates MEMORY.md index. Use this to record architecture decisions, update TODOs, document conventions, etc.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file` | `string` | Yes | Memory file to write. For topic files use 'memory/filename.md'. For root files use 'DECISIONS.md', 'TODO.md', etc. New memory/ files are auto-registered in MEMORY.md. |
| `content` | `string` | Yes | Full content to write. For memory/ files, include frontmatter if needed. For DECISIONS.md, append new entries without deleting old ones. |
| `append` | `boolean` |  | If true, append to file instead of overwriting. Useful for DECISIONS.md and TODO.md. Default: false |

### `search_memory`

Search across all memory files for specific patterns or keywords. Returns matches with file names and context. Useful for finding where you documented something, checking if a decision was made, or discovering related context.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | `string` | Yes | Search pattern (supports regex). Examples: 'authentication', 'database.*choice', 'TODO.*urgent' |
| `case_sensitive` | `boolean` |  | Case-sensitive search. Default: false |

### `append_decision`

Append a new architectural or design decision to DECISIONS.md. Automatically formats it with timestamp and proper structure. Never deletes previous decisions (append-only log).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | `string` | Yes | Short decision title (e.g., 'Use PostgreSQL for persistence') |
| `context` | `string` | Yes | Why this decision was needed |
| `decision` | `string` | Yes | What was decided |
| `rationale` | `string` | Yes | Why this option over alternatives |
| `consequences` | `string` |  | Trade-offs, implications, or follow-up actions |

## Questions

### `queue_question`

Add a question to the pending queue. Whether it blocks or is deferred depends on freeze_ask_mode. Use for non-urgent questions. Provide suggestions when possible to make answering easier.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `question` | `string` | Yes |  |
| `context` | `string` |  | Background info to help the user answer |
| `suggestions` | `array` |  | Premade answer suggestions rendered as clickable buttons in Discord. The user can pick one or type a custom free-form answer. |

### `urgent_question`

Ask a critical question that blocks progress. In requiredOnly/always modes this sends immediately and waits. In onReportOnly mode it triggers an early report. In never mode it writes to QUESTIONS.md. Provide suggestions when possible.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `question` | `string` | Yes |  |
| `context` | `string` |  | Why this is blocking your progress |
| `suggestions` | `array` |  | Premade answer suggestions rendered as clickable buttons in Discord. The user can pick one or type a custom free-form answer. |

## Reports

### `send_report`

Send a structured progress report via Discord and save it as an immutable record in the database. Supports text sections (auto-split at 1800 chars), Mermaid diagrams (rendered to PNG), and web page / HTML screenshots. Whether the agent freezes after sending depends on freeze_report_mode.

IMPORTANT: This is the ONLY correct way to record reports. Do NOT use write_file to save reports — file-based reports are mutable and can be accidentally overwritten. Reports saved via send_report are permanent database records that cannot be modified.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | `string` | Yes | Report title |
| `sections` | `array` | Yes | Text sections. Each section is split into ≤1800-char chunks automatically. |
| `mermaid_diagrams` | `array` |  | Mermaid diagrams to render as PNG images and attach to the report. |
| `screenshot_targets` | `array` |  | Pages to screenshot. Each target can be: a URL (https://...), a workspace-relative file path (.html), or a raw HTML string (starts with '<'). |
| `freeze_override` | `freeze` \| `continue` |  | Override the current freeze_report_mode for this specific report. 'freeze' = pause agent until user confirms; 'continue' = send report and keep working. |

## Mode controls

### `change_timeout`

Change the total agent run timeout (default: 240 minutes). After timeout, agent freezes and awaits user input.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `minutes` | `number` | Yes | New total timeout in minutes (1–1440) |

### `change_report_time_interval`

Change the automatic report interval (default: 15 minutes). Set to 0 to disable automatic reports entirely.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `minutes` | `number` | Yes | Minutes between auto-reports (0 to disable) |

### `change_freeze_report_mode`

Control whether reports cause the agent to freeze and await user input.
- always: freeze on every report
- never: reports are async, agent continues immediately
- custom: agent evaluates custom_rule to decide per-report

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | `always` \| `never` \| `custom` | Yes |  |
| `custom_rule` | `string` |  | When mode=custom: describe the condition under which the agent should freeze (e.g. 'freeze if the report involves a security concern or major architecture decision') |

### `change_freeze_ask_mode`

Control how questions are sent to the user.
- always: ask questions at every opportunity, grouped
- requiredOnly: only urgent questions block; others accumulate for next report
- onReportOnly: all questions accumulate until the next report cycle; urgent questions trigger an early report
- never: all questions written to QUESTIONS.md; agent decides autonomously; asks at total timeout

Note: freeze_report_mode takes precedence — if a report freezes, questions are always asked then.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | `always` \| `requiredOnly` \| `onReportOnly` \| `never` | Yes |  |

## Git

### `commit_changes`

Stage all workspace changes, run quality checks (lint, typecheck, tests), and create a git commit with a conventional commit message. Commit is aborted if any quality check fails. Use this regularly after completing meaningful units of work.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | `string` | Yes | Conventional commit message (e.g. 'feat(auth): add JWT middleware', 'fix(login): handle token expiry', 'chore: update dependencies'). Be descriptive and specific. |
| `skip_checks` | `boolean` |  | Skip lint/typecheck/test before committing. Only use when checks are known to be unavailable. Default: false. |

## Context management

### `compact_context`

Summarise the older portion of the conversation into a concise context block, freeing up context window space. Call this proactively when the conversation grows long or before an intensive multi-step operation.

### `change_compact_threshold`

Change the estimated context token threshold that triggers automatic context compaction (default: 80 000). Set to 0 to disable automatic compaction.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tokens` | `number` | Yes | Threshold in tokens (0 to disable) |

### `change_stop_threshold`

Change the cumulative token budget at which the agent auto-stops (default: 400 000 tokens). The agent freezes and surfaces all pending questions when this limit is reached. Set to 0 to disable.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tokens` | `number` | Yes | Cumulative token budget (0 to disable) |

## Always-improve

### `change_always_improve_mode`

Control what happens after the original task is complete.
- no (default): agent completes and reports done
- yes: agent never stops; always looks for further improvements (code quality, tests, docs, performance, refactoring)
- custom: agent continues within a specific scope defined by the user

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | `yes` \| `no` \| `custom` | Yes |  |
| `scope` | `string` |  | When mode=custom: describe exactly what kinds of improvements are in scope (e.g. 'add tests and improve docs only; do not add new features') |

## Implementation checklist

### `ask_checklist`

Present a structured implementation checklist to the user via Discord BEFORE starting coding. Use this at the very start of a new implementation to surface ambiguities, confirm constraints, and avoid asking questions later. Group related questions into the same checklist call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | `string` | Yes | Checklist title (e.g. 'Implementation Requirements') |
| `items` | `array` | Yes | Questions to ask the user. All unanswered questions block implementation until Discord response. |

## Session Management

### `set_session_name`

Give this session a short, memorable name that describes what you're working on. This helps the user identify sessions at a glance. Call this early in the session, ideally after understanding the task. Keep names concise (2-5 words) and descriptive (e.g. 'Auth System Refactor', 'Payment API', 'Bug Fix: Login Flow').

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | `string` | Yes | Short, descriptive name for this session (2-5 words recommended) |

---

*Generated from `project-template/src/agent/tools/definitions.ts`*
