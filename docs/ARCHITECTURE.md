# Architecture

Agent Manager runs many isolated autonomous Claude agents, each scoped to its own
project (workspace, database, container, ports). A thin master layer on the host
creates and supervises projects; each project runs as a Docker container.

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│                      Master layer (host)                       │
│                                                                │
│  master-api  (port 3100, Hono)                                 │
│    • Project CRUD + Docker lifecycle (start/stop/build/logs)   │
│    • Reads each project's config.json + data/agent.db          │
│    • Centralized rendering: /api/render (mermaid + screenshots)│
│    • Stateless — there is no master database                   │
│                                                                │
│  master-web  (port 3101, Next.js)                              │
│    • Dashboard over master-api: list projects, view sessions,  │
│      messages, tool calls, check-ins, token charts             │
│                                                                │
│  cli  (apps/cli/projects.ts)                                   │
│    • Same operations as master-api, from the terminal          │
└──────────────────────────────────────────────────────────────┘
                              │  manages
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                    .projects/<project-id>/                     │
│                                                                │
│  config.json            Project metadata (see below)           │
│  docker-compose.yml      Generated; one `agent` service        │
│  .env                    API keys, Discord, ports              │
│  Dockerfile + src/       Copied from project-template/         │
│  data/agent.db           Per-project SQLite database           │
│  workspace/              Internal workspace (or external mount) │
└──────────────────────────────────────────────────────────────┘
                              │  docker compose up
                              ▼
┌──────────────────────────────────────────────────────────────┐
│            Project container (isolated bridge network)         │
│                                                                │
│  agent  (port <config.ports.server>)                           │
│    • Autonomous Claude agent loop + REST API                   │
│    • Optional Discord bot for check-ins / questions / reports  │
│    • Mounts workspace at /workspace, DB at /data/agent.db      │
│    • Calls master-api at host.docker.internal:3100 for renders │
└──────────────────────────────────────────────────────────────┘
```

Key points:

- **The master is stateless.** All project state lives on the filesystem:
  `config.json` (metadata) and `data/agent.db` (runtime data). master-api opens
  each project DB in readonly mode to compute stats and list sessions.
- **`project-template/` is a template, never run directly.** Its `src/` and
  `Dockerfile` are copied into each project at creation time, so projects are
  fully isolated and can diverge.
- **Rendering is centralized.** Chromium lives only on the host (master-api).
  Project containers POST to `/api/render` for Mermaid diagrams and screenshots
  instead of bundling a browser into every image.
- **Each project gets one container** (`agent`) on its own bridge network, with
  a single host-exposed port (`config.ports.server`, auto-allocated from 4000).

## Project configuration (`config.json`)

```jsonc
{
  "id": "my-app",                 // lowercase [a-z0-9_-], derived from name if omitted
  "name": "My App",
  "description": "…",             // optional
  "createdAt": "2026-06-27T…",
  "updatedAt": "2026-06-27T…",
  "ports": { "server": 4000 },    // auto-allocated, host-exposed
  "workspace": {
    "path": "/abs/path",          // mounted at /workspace in the container
    "type": "external"            // "external" = user path | "internal" = .projects/<id>/workspace
  },
  "discord": {                    // optional
    "token": "…",
    "defaultChannelId": "…"
  },
  "agent": {                      // optional
    "anthropicApiKey": "…",
    "anthropicBaseUrl": "…",
    "model": "…"
  },
  "status": "stopped"             // "active" | "stopped" | "error"
}
```

## Database

Each project owns one SQLite database at `.projects/<project-id>/data/agent.db`
(mounted into the container at `/data/agent.db`, set via `DATABASE_PATH`). It uses
WAL journaling with foreign keys enabled. The schema is defined with Drizzle in
[project-template/src/db/schema.ts](../project-template/src/db/schema.ts) and is
the single source of truth.

All timestamps are integer Unix epoch **milliseconds** (`unixepoch() * 1000`). IDs
are application-generated text. The master reads this DB readonly; the agent
container is the only writer.

### Entity overview

```
sessions ──┬─< messages ──< tool_calls
           ├─< checkins ──< questions
           ├─< reports
           └─< (questions may also attach directly to a session)
```

A **session** is one autonomous agent run for a given task. Everything else hangs
off a session.

### `sessions`

One row per agent run. Holds the task, lifecycle status, all runtime
configuration knobs, and rolled-up token usage.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `name` | text | Optional human label |
| `task` | text | The task prompt (required) |
| `status` | text | `running` \| `paused` \| `completed` \| `stopped` \| `error` (default `running`) |
| `report_interval_mins` | int | Auto-report cadence (default 15) |
| `total_timeout_mins` | int | Hard session timeout (default 240) |
| `freeze_report_mode` | text | `always` \| `never` \| `custom` (default `never`) — whether sending a report pauses the agent |
| `freeze_report_custom_rule` | text | Rule used when mode is `custom` |
| `freeze_ask_mode` | text | `always` \| `requiredOnly` \| `onReportOnly` \| `never` (default `always`) — when questions pause the agent |
| `compact_threshold_tokens` | int | Auto-compaction trigger (default 80 000; 0 disables) |
| `stop_threshold_tokens` | int | Hard token budget (default 400 000; 0 disables) |
| `always_improve_mode` | text | `yes` \| `no` \| `custom` (default `no`) — continuous-improvement loop |
| `always_improve_scope` | text | Focus used when mode is `custom` |
| `total_input_tokens` / `total_output_tokens` | int | Rolled-up usage |
| `total_cache_read_tokens` / `total_cache_write_tokens` | int | Rolled-up prompt-cache usage |
| `discord_channel_id` | text | Channel the session reports to |
| `created_at` / `updated_at` | int | epoch ms |

### `messages`

The conversation transcript. One row per Anthropic message.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `session_id` | text FK → `sessions.id` | |
| `role` | text | `user` \| `assistant` |
| `content` | text | JSON-serialized Anthropic `ContentBlock[]` |
| `input_tokens` / `output_tokens` | int | Per-message usage |
| `cache_read_tokens` / `cache_write_tokens` | int | Per-message cache usage |
| `error` / `error_details` | text | Set when the turn failed |
| `created_at` | int | epoch ms |

### `tool_calls`

One row per tool invocation, linked to the assistant message that requested it.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `session_id` | text FK → `sessions.id` | |
| `message_id` | text FK → `messages.id` | |
| `tool_name` | text | e.g. `read_file`, `bash` |
| `tool_use_id` | text | Anthropic tool-use id |
| `input` | text | JSON arguments |
| `output` | text | JSON result (null until complete) |
| `status` | text | `pending` \| `success` \| `error` (default `pending`) |
| `created_at` / `completed_at` | int | epoch ms |

### `checkins`

A point where the agent pauses to surface progress or a question to the user
(typically via Discord).

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `session_id` | text FK → `sessions.id` | |
| `trigger` | text | `timer` \| `urgent` \| `manual` \| `completion` \| `compaction` |
| `summary` | text | What the agent reports at this check-in |
| `discord_message_id` | text | Discord message backing the check-in |
| `status` | text | `pending` \| `answered` \| `skipped` \| `timeout` (default `pending`) |
| `created_at` / `completed_at` | int | epoch ms |

### `questions`

Questions the agent asks. May belong to a check-in, or attach directly to the
session.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `session_id` | text FK → `sessions.id` | |
| `checkin_id` | text FK → `checkins.id` | Nullable |
| `text` | text | The question |
| `context` | text | Optional supporting context |
| `answer` | text | Filled when answered |
| `is_urgent` | bool | Blocks progress when true |
| `created_at` / `answered_at` | int | epoch ms |

### `reports`

Structured progress reports generated on the report interval or on demand.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `session_id` | text FK → `sessions.id` | |
| `trigger` | text | What caused the report |
| `title` | text | |
| `content` | text | JSON-serialized `ReportData` (sections, mermaid diagrams, …) |
| `created_at` | int | epoch ms |

See [USAGE.md](USAGE.md) for running the system and [TOOLS.md](TOOLS.md) for the
agent's tool set.
