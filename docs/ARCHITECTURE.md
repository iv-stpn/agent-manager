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

## Windows / WSL2 networking setup

Project containers call back to the orchestrator API at
`http://host.docker.internal:3100` (see diagram above). If you develop on
**Windows with Docker Desktop + WSL2**, this fails with connection-refused /
"Unable to connect" errors (e.g. from `sendReport` in
[discord.ts](../project-template/src/external/discord.ts)) unless two things
are set up first: WSL2 mirrored networking, and Windows Firewall inbound rules
for the ports involved. In default (NAT) WSL2 networking mode,
`host.docker.internal` cannot reliably reach ports bound only inside your WSL2
distro — this is a Docker Desktop limitation, not a bug in this repo.

### 1. Enable WSL2 mirrored networking

1. On Windows, open (or create) `C:\Users\<you>\.wslconfig`.
2. Add (or merge into) the `[wsl2]` section:
   ```ini
   [wsl2]
   networkingMode=mirrored
   ```
3. Open a **Windows** PowerShell or cmd prompt (not a WSL terminal) and run:
   ```
   wsl --shutdown
   ```
   This restarts all WSL distros, killing any running dev servers, terminals,
   and VS Code WSL connections — save your work first.
4. Reopen your WSL terminal and restart the dev servers (`bun run dev`, etc.).

### 2. Allow the ports through Windows Firewall

Mirrored networking exposes WSL2's ports on the Windows host network, but
Windows Firewall still blocks unsolicited inbound connections to them by
default. Allow the ports this project uses:

- `3100` — orchestrator API
- `3101` — orchestrator web dashboard
- `4000+` — one per project's `agent` container (`config.ports.server`,
  auto-allocated upward from 4000; check `.projects/<project-id>/config.json`
  for the exact port(s) in use)

Step-by-step (GUI):

1. Press `Win`, search for **Windows Defender Firewall with Advanced
   Security**, and open it.
2. Click **Inbound Rules** (left pane) → **New Rule…** (right pane).
3. Rule type: **Port** → Next.
4. **TCP**, then **Specific local ports**: enter `3100,3101,4000-4010` (adjust
   the range to cover however many projects you run) → Next.
5. **Allow the connection** → Next.
6. Leave Domain/Private/Public all checked (or restrict to Private if you only
   develop on trusted networks) → Next.
7. Name it e.g. `Agent Manager (WSL2)` → Finish.

Or equivalently, from an **elevated** Windows PowerShell prompt:

```powershell
New-NetFirewallRule -DisplayName "Agent Manager (WSL2)" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 3100,3101,4000-4010
```

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
