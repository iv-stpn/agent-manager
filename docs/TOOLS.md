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

## Web

### `web_search`

Search the web and return a ranked list of results (title, URL, snippet). Use to find current information, documentation, or sources. Follow up with web_fetch to read a specific result.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | Yes | Search query |
| `limit` | `number` |  | Max number of results to return (default: 8) |

### `web_fetch`

Fetch a URL and return its readable text content (HTML is stripped to plain text). Use to read documentation, articles, or any web page. Content is truncated to a character budget.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | `string` | Yes | Absolute URL to fetch (must start with http:// or https://) |
| `max_chars` | `number` |  | Max characters of content to return (default: 20000) |

## Memory Management

### `remember`

Store a new entry in the project's persistent vector memory. Use to record architecture decisions, conventions, context, plans, or any knowledge that should persist across sessions. Entries are semantically searchable. Do NOT use for todos (use task tools), reports (use send_report), or questions (use queue_question/urgent_question).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `decision` \| `plan` \| `memory` \| `context` | Yes | Category of the memory entry |
| `title` | `string` | Yes | Short descriptive title (used for search ranking) |
| `content` | `string` | Yes | Full content of the memory entry |
| `metadata` | `object` |  | Optional structured metadata (e.g. {priority: 'high', status: 'active'}) |

### `recall`

Semantically search project memory. Returns entries ranked by relevance to your query. Use natural language queries for best results (e.g. 'how is authentication implemented' rather than 'auth'). Searches across all entry types including auto-recorded todos, reports, and questions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | Yes | Natural language search query |
| `type` | `decision` \| `todo` \| `plan` \| `question` \| `memory` \| `report` \| `context` |  | Optional: filter results to a specific type |
| `limit` | `number` |  | Max results to return (default: 10) |

### `update_memory`

Update an existing memory entry by its ID. Use to modify content, title, or type of a previously stored entry. Only entries you created directly (decision, plan, memory, context) should be updated this way.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Memory entry ID (from recall or list_memories) |
| `title` | `string` |  | New title (optional) |
| `content` | `string` |  | New content (optional) |
| `type` | `decision` \| `plan` \| `memory` \| `context` |  | New type (optional) |
| `metadata` | `object` |  | New metadata (optional) |

### `delete_memory`

Delete a memory entry by its ID. Use when information is outdated or incorrect.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Memory entry ID (from recall or list_memories) |

### `list_memories`

List all memory entries, optionally filtered by type. Use to see everything stored or browse a category.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `decision` \| `todo` \| `plan` \| `question` \| `memory` \| `report` \| `context` |  | Filter by type (optional, lists all if omitted) |
| `limit` | `number` |  | Max results (default: 100) |

## Task Management

### `add_task`

Add a new task to the project-wide task list. Tasks persist in the DB and are shared across sessions. Optionally declare dependencies on other tasks that must be done first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | `string` | Yes | Task description |
| `status` | `pending` \| `in_progress` \| `done` \| `cancelled` |  | Initial status (default: pending) |
| `dependsOn` | `array` |  | IDs of tasks that must be done before this one can start |

### `list_tasks`

List tasks across the whole project (all sessions). Each line shows status and any dependencies, flagging tasks blocked by unfinished dependencies. Optionally filter by status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filter` | `all` \| `pending` \| `in_progress` \| `done` \| `cancelled` |  | Status filter (default: all) |

### `update_task`

Update a task's status, text, or dependencies by its ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Task ID (from list_tasks) |
| `status` | `pending` \| `in_progress` \| `done` \| `cancelled` |  | New status |
| `text` | `string` |  | Updated text |
| `dependsOn` | `array` |  | Replacement list of dependency task IDs |

### `get_current_task`

Get the task that is currently in progress (the active task), if any.

### `set_current_task`

Mark a task as the current task in progress. The given task becomes in_progress and assigned to this session; any other in_progress task is moved back to pending, so exactly one task is active at a time. Warns if the task is still blocked by unfinished dependencies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Task ID (from list_tasks) |

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

## Implementation checklist

### `ask_checklist`

Present a structured implementation checklist to the user via Discord BEFORE starting coding. Use this at the very start of a new implementation to surface ambiguities, confirm constraints, and avoid asking questions later. Group related questions into the same checklist call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | `string` | Yes | Checklist title (e.g. 'Implementation Requirements') |
| `items` | `array` | Yes | Questions to ask the user. All unanswered questions block implementation until Discord response. |

## Plan Mode

### `enter_plan_mode`

Enter plan mode — restricts available tools to read-only operations (grep, glob, read_file, list_directory, search_files, bash read-only commands). Use this when you need to explore the codebase and form a plan before making changes. Call exit_plan_mode when ready to implement.

### `exit_plan_mode`

Exit plan mode and resume full tool access. Optionally provide a plan summary documenting what you learned and intend to do.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `plan_summary` | `string` |  | Summary of what you explored and the implementation plan you've formed |

---

*Generated from `project-template/src/agent/tools/definitions.ts`*
