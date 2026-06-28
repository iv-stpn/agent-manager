# Architecture

Agent Manager runs many isolated autonomous Claude agents, each scoped to its
own project (workspace, database, container, ports). A thin master layer on the
host creates and supervises projects; each project runs as a Docker container.

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│                      Master layer (host)                       │
│                                                                │
│  master-api  (port 3100, Hono)                                 │
│    • Project CRUD + Docker lifecycle (start/stop/build/logs)   │
│    • Reads each project's config.json + data/agent.db          │
│    • Centralized rendering: /api/render (mermaid + screenshots)│
│    • Own SQLite DB for logs & historical stats (not runtime)   │
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
│    • Calls master-api at host.docker.internal:3100 for renders │
└──────────────────────────────────────────────────────────────┘
```

Key points:

- **The master has its own database for historical data.** It stores logs and
  statistics about past projects (e.g. aggregated token usage, session history
  snapshots). It does **not** store project-relevant data at runtime — that
  remains in each project's own `data/agent.db`. master-api still opens project
  DBs in readonly mode to compute live stats and list sessions.
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
  "id": "my-app", // lowercase [a-z0-9_-], derived from name if omitted
  "name": "My App",
  "description": "…", // optional
  "createdAt": "2026-06-27T…",
  "updatedAt": "2026-06-27T…",
  "ports": { "server": 4000 }, // auto-allocated, host-exposed
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
master reads this DB readonly; the agent container is the only writer.

A **session** is one autonomous agent run for a given task, and everything else
hangs off a session:

```
sessions ──┬─< messages ──< tool_calls
           ├─< checkins ──< questions
           ├─< reports
           ├─< compactions
           ├─< todos
           └─< (questions may also attach directly to a session)
```

See [DATABASE.md](DATABASE.md) for the full per-table column reference (both the
per-project schema and the master database).

See [USAGE.md](USAGE.md) for running the system and [TOOLS.md](TOOLS.md) for the
agent's tool set.
