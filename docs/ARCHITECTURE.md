# Architecture

Agent Manager runs many isolated autonomous Claude agents, each scoped to its
own project (workspace, database, container, ports). A thin orchestrator layer
creates and supervises projects; each project runs as a Docker container.

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│                  Orchestrator layer                          │
│                                                                │
│  api  (port 3100, Hono)                                       │
│    • Project CRUD + Docker lifecycle (start/stop/build/logs)   │
│    • Reads each project's config.json + data/agent.db          │
│    • Centralized rendering: /api/render (mermaid)              │
│    • Own SQLite DB for logs & historical stats (not runtime)   │
│                                                                │
│  web  (port 3101, Vite + React)                               │
│    • Dashboard over API: list projects, view sessions,        │
│      messages, tool calls, check-ins, token charts             │
│                                                                │
│  cli  (apps/cli/projects.ts)                                   │
│    • Same operations as API, from the terminal                 │
└──────────────────────────────────────────────────────────────┘
                              │  manages
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                    .projects/<project-id>/                     │
│                                                                │
│  config.json            Project metadata (see below)           │
│  docker-compose.yml      Generated; one `agent` service        │
│  .env                    API keys, Discord, ports              │
│  Dockerfile.             Copied from project-template/         │
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
│    • Calls orchestrator API at host.docker.internal:3100      │
└──────────────────────────────────────────────────────────────┘
```

Key points:

- **The orchestrator has its own database for historical data.** It stores logs
  and statistics about past projects (e.g. aggregated token usage, session
  history snapshots). It does **not** store project-relevant data at runtime —
  that remains in each project's own `data/agent.db`. The orchestrator API still
  opens project DBs in readonly mode to compute live stats and list sessions.
- **`project-template/` is a template, never run directly.** Its `src/` and
  `Dockerfile` are copied into each project at creation time, so projects are
  fully isolated and can diverge.
- **Rendering is centralized.** Chromium lives only in the orchestrator (API).
  Project containers POST to `/api/render` to render Mermaid diagrams instead of
  bundling a browser into every image.
- **Each project gets one container** (`agent`) on its own bridge network, with
  a single orchestrator-exposed port (`config.ports.server`, auto-allocated from
  4000).

## Project configuration (`config.json`)

```jsonc
{
  "id": "my-app", // lowercase [a-z0-9_-], derived from name if omitted
  "name": "My App",
  "description": "…", // optional
  "createdAt": "2026-06-27T…",
  "updatedAt": "2026-06-27T…",
  "ports": { "server": 4000 }, // auto-allocated, orchestrator-exposed
  "workspace": {
    "path": "/abs/path", // mounted at /workspace in the container
    "type": "external" // "external" = user path | "internal" = .projects/<id>/workspace
  },
  "discord": { // optional
    "token": "…",
    "defaultChannelId": "…"
  },
  "agent": { // optional
    "anthropicApiKey": "…",
    "anthropicBaseUrl": "…",
    "model": "…"
  },
  "status": "stopped" // "active" | "stopped" | "error"
}
```

## Database

Each project owns one SQLite database at `.projects/<project-id>/data/agent.db`
(mounted into the container at `/data/agent.db`, set via `DATABASE_PATH`). It
uses WAL journaling with foreign keys enabled. The schema is defined with
Drizzle in
[project-template/src/db/schema.ts](../project-template/src/db/schema.ts) and is
the single source of truth. All timestamps are integer Unix epoch
**milliseconds** (`unixepoch() * 1000`); IDs are application-generated text. The
orchestrator reads this DB readonly; the agent container is the only writer.

A **session** is one autonomous agent run for a given task, and everything else
hangs off a session:

```
sessions ──┬─< messages ──< tool_calls
           ├─< checkins ──< questions
           ├─< reports
           ├─< compactions
           ├─< tasks
           └─< (questions may also attach directly to a session)
```

See [DATABASE.md](DATABASE.md) for the full per-table column reference (both the
per-project schema and the orchestrator database).

See [USAGE.md](USAGE.md) for running the system and [TOOLS.md](TOOLS.md) for the
agent's tool set.
