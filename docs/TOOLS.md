# Agent Tools Reference

Complete list of tools available to the autonomous agent.

---

## 📁 File System Operations (15 tools)

### Basic Operations

#### `read_file`
Read a file's contents.
```json
{
  "path": "src/index.ts"
}
```
**Returns:** File content (truncated at 20,000 chars)

#### `write_file`
Create or overwrite a file.
```json
{
  "path": "src/config.json",
  "content": "{\"key\": \"value\"}"
}
```
**Returns:** Confirmation message

#### `list_directory`
List files in a directory.
```json
{
  "path": "src"  // optional, defaults to workspace root
}
```
**Returns:** `ls -la` output

### Advanced File Operations

#### `search_files` 🆕
Search for text patterns across files (grep).
```json
{
  "pattern": "function.*hello",
  "path": "src",              // optional
  "file_pattern": "*.ts",     // optional glob
  "case_sensitive": false,    // optional
  "max_results": 100          // optional
}
```
**Returns:** Matching lines with file:line:content
**Use cases:** Find function definitions, imports, TODOs, debug logs

#### `edit_file` 🆕
Replace specific content in a file without reading the entire file.
```json
{
  "path": "src/config.ts",
  "old_string": "const PORT = 3000;",
  "new_string": "const PORT = 8080;",
  "replace_all": false  // optional, default: false (first match only)
}
```
**Returns:** Number of replacements made
**Important:** `old_string` must match exactly (including whitespace)

#### `read_file_range` 🆕
Read specific line range from a file (efficient for large files).
```json
{
  "path": "logs/output.log",
  "start_line": 100,
  "end_line": 200
}
```
**Returns:** Lines 100-200 (1-indexed, inclusive)

#### `get_file_info` 🆕
Get file metadata (size, modified time, permissions, type).
```json
{
  "path": "build/app.js"
}
```
**Returns:** Size, modification date, type, permissions, line count (for text files)
**Use cases:** Check if file exists, check size before reading, get last modified time

### File Management

#### `move_file` 🆕
Move or rename a file/directory.
```json
{
  "source": "old-name.ts",
  "destination": "new-name.ts"
}
```
**Returns:** Confirmation message
**Note:** Creates parent directories automatically

#### `delete_file` 🆕
Delete a file or directory.
```json
{
  "path": "temp/cache",
  "recursive": true  // required for directories
}
```
**Returns:** Confirmation message
**Warning:** Use with caution, deletion is permanent

#### `create_directory` 🆕
Create a directory (and parent directories).
```json
{
  "path": "src/components/ui"
}
```
**Returns:** Confirmation message
**Note:** Equivalent to `mkdir -p`

### Shell Access

#### `bash`
Execute arbitrary shell commands.
```json
{
  "command": "npm install lodash",
  "timeout_ms": 60000  // optional, default: 30000
}
```
**Returns:** stdout, stderr, exit code
**Use cases:** Run build tools, package managers, git commands, system utilities

---

## 🧠 Memory Management (4 tools)

The agent has persistent memory stored in `.agent/` directory. These tools allow reading, writing, and searching across memory files to maintain context between sessions.

#### `read_memory` 🆕
Read from the agent's persistent memory system.
```json
{
  "file": "MEMORY.md"  // or: "DECISIONS.md", "TODO.md", "memory/architecture.md", etc.
}
```
**Available files:**
- `MEMORY.md` — Memory index (lists all memory/ files)
- `DECISIONS.md` — Architectural decisions log
- `TODO.md` — Task queue
- `QUESTIONS.md` — Pending questions
- `plans/CURRENT_PLAN.md` — Active plan
- `memory/*.md` — Topic-specific memories (architecture, codebase, conventions, etc.)

**Returns:** File contents (up to 50,000 chars)

#### `write_memory` 🆕
Write to the agent's persistent memory system.
```json
{
  "file": "memory/authentication.md",
  "content": "---\nname: authentication\ndescription: Auth system design\nmetadata:\n  type: project\n---\n\nWe use JWT tokens...",
  "append": false  // optional, set true to append instead of overwrite
}
```
**Features:**
- Creates parent directories automatically
- Writing to `memory/*.md` auto-updates `MEMORY.md` index
- Append mode useful for `DECISIONS.md`, `TODO.md`

**Returns:** Confirmation message

#### `search_memory` 🆕
Search across all memory files for patterns.
```json
{
  "pattern": "database.*choice",
  "case_sensitive": false  // optional
}
```
**Returns:** Matching lines with file names and line numbers
**Use cases:**
- Find where you documented something
- Check if a decision was already made
- Discover related context across memory files

#### `append_decision` 🆕
Add a new decision to `DECISIONS.md` (append-only log).
```json
{
  "title": "Use PostgreSQL for persistence",
  "context": "Need to store user data and relationships",
  "decision": "Use PostgreSQL with Prisma ORM",
  "rationale": "Better relational support than MongoDB, mature ecosystem",
  "consequences": "Need to run migrations, but get strong typing"  // optional
}
```
**Automatically adds:**
- Current date
- Proper formatting
- Never overwrites previous decisions

**Returns:** Confirmation message

---

## 💬 Communication (4 tools)

#### `queue_question`
Ask a non-urgent question (behavior depends on `freeze_ask_mode`).
```json
{
  "question": "Should I use TypeScript strict mode?",
  "context": "The codebase currently has strict: false in tsconfig.json"
}
```

#### `urgent_question`
Ask a critical question that blocks progress.
```json
{
  "question": "Which database should I use?",
  "context": "Need to choose between PostgreSQL, MySQL, or MongoDB for user data"
}
```

#### `ask_checklist`
Send a multi-question form (Discord modal).
```json
{
  "title": "Implementation Requirements",
  "items": [
    {
      "id": "auth_method",
      "question": "Which authentication method?",
      "description": "Options: JWT, Session, OAuth2",
      "required": true
    },
    {
      "id": "db_choice",
      "question": "Which database?",
      "description": "e.g., PostgreSQL, MongoDB",
      "required": true
    }
  ]
}
```
**Best practice:** Call at the start of implementation to surface all ambiguities upfront

#### `send_report`
Send a structured progress report (Discord).
```json
{
  "title": "Implementation Progress",
  "sections": [
    {
      "title": "Completed",
      "content": "- Created API endpoints\n- Added authentication"
    }
  ],
  "mermaid_diagrams": [
    {
      "title": "Architecture",
      "code": "graph LR\nA[Client] --> B[API]\nB --> C[DB]"
    }
  ]
}
```
**Features:** Auto-splits long sections, renders Mermaid to PNG, supports screenshots

---

## 🔧 Git & Quality (1 tool)

#### `commit_changes`
Stage all changes and create a git commit with quality checks.
```json
{
  "message": "feat(auth): add JWT middleware",
  "skip_checks": false  // optional, default: false
}
```
**Automatic checks (unless `skip_checks=true`):**
1. Runs linter (if available)
2. Runs type checker (if available)
3. Runs tests (if available)
4. Blocks commit if any check fails

**Returns:** Commit hash or error details

---

## ⚙️ Runtime Configuration (7 tools)

#### `change_timeout`
Adjust total session timeout.
```json
{
  "minutes": 60
}
```

#### `change_report_time_interval`
Adjust automatic report frequency.
```json
{
  "minutes": 15
}
```

#### `change_freeze_report_mode`
Control whether sending reports pauses the agent.
```json
{
  "mode": "always"  // or: "never", "custom"
}
```

#### `change_freeze_ask_mode`
Control question handling behavior.
```json
{
  "mode": "requiredOnly"  // or: "always", "onReportOnly", "never"
}
```

#### `change_always_improve_mode`
Enable/disable continuous improvement loop.
```json
{
  "mode": "yes",  // or: "no", "custom"
  "scope": "Focus on performance optimization"  // optional
}
```

#### `compact_context`
Manually trigger context window compression.
```json
{}
```
**Use cases:** Before starting a large task, when approaching token limits

#### `change_compact_threshold`
Set automatic context compaction trigger.
```json
{
  "tokens": 80000  // 0 to disable
}
```

#### `change_stop_threshold`
Set hard token budget limit.
```json
{
  "tokens": 400000  // 0 to disable
}
```

---

## 📊 Tool Statistics

| Category | Count |
|----------|-------|
| File system | 11 |
| Memory management | 4 |
| Communication | 4 |
| Git & Quality | 1 |
| Configuration | 7 |
| Context management | 1 |
| **Total** | **28** |

---

## 🆕 Recently Added

### File Operations
- `search_files` — Grep across codebase
- `edit_file` — Targeted content replacement
- `read_file_range` — Read specific line ranges
- `get_file_info` — File metadata inspection
- `move_file` — File/directory moving
- `delete_file` — File/directory deletion
- `create_directory` — Directory creation

### Memory Management
- `read_memory` — Read from .agent/ memory system
- `write_memory` — Write to memory with auto-indexing
- `search_memory` — Search across all memory files
- `append_decision` — Add architectural decisions

---

## 💡 Best Practices

### Memory Management
- **Start each session** by reading `MEMORY.md` to load context
- Use `search_memory` to check if something was already documented
- Use `append_decision` instead of manually writing to `DECISIONS.md`
- Store architectural knowledge in `memory/architecture.md`
- Store coding conventions in `memory/conventions.md`
- Use `write_memory` with `append: true` for `TODO.md` and `DECISIONS.md`

### File Operations
- Use `get_file_info` before reading large files
- Use `read_file_range` for logs or large files when you only need a portion
- Use `edit_file` instead of read → modify → write for small changes
- Use `search_files` to locate code patterns before editing

### Questions
- Call `ask_checklist` at the start of implementations to batch all questions
- Use `urgent_question` only when truly blocked
- Use `queue_question` for nice-to-know information

### Git
- Always use `commit_changes` instead of `bash git commit` (it runs quality checks)
- Write conventional commit messages: `type(scope): description`

### Context Management
- Call `compact_context` proactively when starting multi-step operations
- Monitor token usage via session API

---

## 🔍 Tool Discovery

To see the exact schema for any tool, check:
- **Code:** `project-template/src/agent/tools.ts`
- **Runtime:** Tool definitions are sent to Claude in the system prompt
