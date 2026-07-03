# Agent Tools Reference

Complete list of tools available to the autonomous agent.

---

## Commands

### `bash`

Run a shell command in the workspace root.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | `string` | Yes | Shell command |
| `timeout_ms` | `number` |  | Max ms (default: 30000) |

### `grep`

Regex search across files. Returns file:line matches.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | `string` | Yes | Regex pattern |
| `path` | `string` |  | Directory to search (default: workspace root) |
| `include` | `string` |  | File glob filter (e.g. '*.ts') |
| `flags` | `string` |  | Extra grep flags (e.g. '-i') |

### `glob`

Find files matching a glob pattern.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | `string` | Yes | Glob pattern |
| `path` | `string` |  | Directory to search (default: workspace root) |

## File system

### `read_file`

Read a workspace file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | Workspace-relative path |

### `write_file`

Write content to a workspace file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | Workspace-relative path |
| `content` | `string` | Yes | File content |

### `list_directory`

List a workspace directory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` |  | Directory path (default: workspace root) |

### `search_files`

Search files with grep. Returns file:line matches.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | `string` | Yes | Search pattern (regex) |
| `path` | `string` |  | Directory to search (default: workspace root) |
| `file_pattern` | `string` |  | File glob (e.g. '*.ts') |
| `case_sensitive` | `boolean` |  | Default: false |
| `max_results` | `number` |  | Default: 100 |

### `edit_file`

Replace old_string with new_string in a file (exact whitespace match required).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | Workspace-relative path |
| `old_string` | `string` | Yes | Exact string to replace |
| `new_string` | `string` | Yes | Replacement string |
| `replace_all` | `boolean` |  | Replace all occurrences (default: false) |

### `move_file`

Move or rename a file or directory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source` | `string` | Yes | Workspace-relative path |
| `destination` | `string` | Yes | Workspace-relative path |

### `delete_file`

Delete a file or directory (set recursive=true for directories).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | Workspace-relative path |
| `recursive` | `boolean` |  | Required true for directories |

### `create_directory`

Create a directory (including parents).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | Workspace-relative path |

### `read_file_range`

Read a line range from a file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | Workspace-relative path |
| `start_line` | `number` | Yes | Start line (1-indexed, inclusive) |
| `end_line` | `number` | Yes | End line (1-indexed, inclusive) |

## Web

### `web_search`

Search the web. Returns title/URL/snippet list. Follow up with web_fetch to read a page.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | Yes | Search query |
| `limit` | `number` |  | Max results (default: 8) |

### `web_fetch`

Fetch a URL and return its plain-text content.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | `string` | Yes | Absolute URL (http:// or https://) |
| `max_chars` | `number` |  | Max characters (default: 20000) |

## Memory

### `remember`

Store a persistent memory entry. Not for tasks, reports, or questions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `decision` \| `plan` \| `memory` \| `context` | Yes | Memory category |
| `title` | `string` | Yes | Short descriptive title |
| `content` | `string` | Yes | Memory content |
| `metadata` | `object` |  | Optional structured metadata |

### `recall`

Semantic search over project memory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | Yes | Natural language query |
| `type` | `decision` \| `plan` \| `memory` \| `context` \| `question` \| `report` |  | Filter by type (optional) |
| `limit` | `number` |  | Max results (default: 10) |

### `update_memory`

Update an existing memory entry by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Memory entry ID |
| `title` | `string` |  | New title |
| `content` | `string` |  | New content |
| `type` | `decision` \| `plan` \| `memory` \| `context` |  | New type |
| `metadata` | `object` |  | New metadata |

### `delete_memory`

Delete a memory entry by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Memory entry ID |

### `list_memories`

List memory entries, optionally filtered by type.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `decision` \| `plan` \| `memory` \| `context` \| `question` \| `report` |  | Filter by type (optional) |
| `limit` | `number` |  | Max results (default: 100) |

## Tasks

### `add_task`

Add a task to the project task list.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | `string` | Yes | Task description |
| `status` | `pending` \| `in_progress` \| `done` \| `cancelled` |  | Initial status (default: pending) |
| `dependsOn` | `array` |  | IDs of prerequisite tasks |

### `list_tasks`

List all project tasks with status and blocked-by info.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filter` | `all` \| `pending` \| `in_progress` \| `done` \| `cancelled` |  | Status filter (default: all) |

### `update_task`

Update a task's status, text, or dependencies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Task ID |
| `status` | `pending` \| `in_progress` \| `done` \| `cancelled` |  | New status |
| `text` | `string` |  | Updated text |
| `dependsOn` | `array` |  | Replacement dependency IDs |

### `get_current_task`

Get the currently active in-progress task.

### `set_current_task`

Set a task as active (demotes any other in-progress task). Warns if blocked by dependencies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Task ID |

## Questions

### `ask_user_question`

Ask the user questions and wait for answers. Set urgent=true only when fully blocked.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | `string` |  | Optional heading for the question group |
| `questions` | `array` | Yes | Questions sent and answered as a group |
| `context` | `string` |  | Background info explaining why you're asking |
| `urgent` | `boolean` |  | High-priority notification when fully blocked (default: false) |

## Reports

### `send_report`

Send a report via Discord and save it to the database. Use ONLY this for reports — do not use write_file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | `string` | Yes | Report title |
| `sections` | `array` | Yes | Text sections (auto-split at 1800 chars) |
| `mermaid_diagrams` | `array` |  | Mermaid diagrams rendered as PNG images |
| `await_override` | `await` \| `continue` |  | Override await_report_mode for this report |

## Git

### `commit_changes`

Stage all changes, run lint/typecheck/tests, and commit. Aborts if checks fail.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | `string` | Yes | Conventional commit message (e.g. 'feat(auth): add JWT middleware') |
| `skip_checks` | `boolean` |  | Skip quality checks before committing (default: false) |

## Context

### `compact_context`

Summarise older conversation to free context space. Call before intensive multi-step operations.

## Plan Mode

### `enter_plan_mode`

Restrict to read-only tools for codebase exploration. Call exit_plan_mode when ready to implement.

### `exit_plan_mode`

Exit plan mode and restore full tool access.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `plan_summary` | `string` | Yes | What you explored and your implementation plan |

---

*Generated from `project-template/src/agent/tools/definitions.ts`*
