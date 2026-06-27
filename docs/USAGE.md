# Usage

A monorepo run with [Bun](https://bun.sh). The master layer runs on the host;
each project runs in Docker. See [ARCHITECTURE.md](ARCHITECTURE.md) for how the
pieces fit together.

## Start the master layer

```bash
bun install

bun run dev          # master-api (3100) + master-web (3101) together
# or individually:
bun run master       # master-api  → http://localhost:3100
bun run master-web   # master-web  → http://localhost:3101
```

Open the dashboard at http://localhost:3101.

> Rendering (Mermaid + screenshots) needs Chromium on the host. master-api
> auto-detects it, or set `PUPPETEER_EXECUTABLE_PATH`. Without it, `/api/render`
> fails but everything else works.

## Manage projects from the CLI

```bash
bun run projects create <name> [description] [workspace-path]
bun run projects list
bun run projects start   <project-id>
bun run projects stop    <project-id>
bun run projects restart <project-id>
bun run projects status  <project-id>
bun run projects logs    <project-id> [service]
bun run projects build   <project-id>
bun run projects delete  <project-id>

bun run stop-all         # stop every running project
```

Creating a project copies `project-template/` into `.projects/<id>/`, generates
`docker-compose.yml` + `.env`, allocates a port (from 4000), and sets up the
workspace. Omit `workspace-path` for an internal workspace under
`.projects/<id>/workspace/`; pass an absolute path to mount an external repo.

## Master API

Base URL `http://localhost:3100`. Project-management and Docker lifecycle:

```
GET    /health
GET    /api/projects                      List projects (with stats)
GET    /api/projects/:id                  Project details
POST   /api/projects                      Create project
DELETE /api/projects/:id                  Delete project
POST   /api/projects/:id/start            Start container
POST   /api/projects/:id/stop             Stop container
POST   /api/projects/:id/restart          Restart container
POST   /api/projects/:id/build            Build image
GET    /api/projects/:id/logs             Container logs
GET    /api/projects/:id/stats            DB statistics
PUT    /api/projects/:id/settings         Update project settings
```

Reading a project's database (proxied readonly from `data/agent.db`):

```
GET    /api/projects/:id/reports
GET    /api/projects/:id/sessions
POST   /api/projects/:id/sessions                       Create a session
GET    /api/projects/:id/sessions/:sessionId
GET    /api/projects/:id/sessions/:sessionId/messages
GET    /api/projects/:id/sessions/:sessionId/tools
GET    /api/projects/:id/sessions/:sessionId/checkins
GET    /api/projects/:id/sessions/:sessionId/questions
POST   /api/projects/:id/sessions/:sessionId/stop
GET    /api/projects/:id/sessions/:sessionId/stream     SSE live stream
```

Centralized rendering (called by project containers, also usable directly):

```
POST   /api/render/...     Mermaid diagrams + screenshots (Chromium on host)
```

## Tests

```bash
bun run test:setup        # structure / config checks, <1s, no deps
bun run test:e2e          # project CRUD + API + DB queries, ~3s, no API key
bun run test:integration  # full Docker + live Anthropic run, 10 min
```

`test:integration` requires Docker running and `ANTHROPIC_API_KEY` set; it
builds a project, starts the container, exercises the agent (tools, memory,
reports, interruption), then tears everything down.
