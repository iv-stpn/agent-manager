# Codebase Improvement Plan — Progress & Handoff

Status as of this session. Verification baseline: `bun run typecheck` (green),
`bunx biome check .` (green; 5 pre-existing `any` warnings in vendored
`apps/api/src/types/*.d.ts` — not ours), and `bun test` (**90 pass / 0 fail
across 9 files**). `bun run build` (web vite build) also green. Nothing has been
committed — all changes are in the working tree.

## What's done now (this + prior session)

- **Phase 0 (security)** — complete (prior session; see the DONE section below).
- **0.1b (finish auth wiring)** — DONE. Web client now attaches the token.
- **Phase 1 (safety net)** — DONE. CI workflow, test runner + scripts, 90 unit
  tests seeded on the security-critical units, stale scripts deleted.
- **Phase 2 (correctness bugs)** — DONE. H1, H1b, H2, H3, H4, H5, H6, M1 all fixed.
- **Phase 3 (robustness/hygiene)** — PARTIAL. Orchestrator DB additive migration,
  agent-proxy fetch timeouts, port-allocation race, dependency pinning +
  `engines`/`packageManager`, and doc drift are DONE. Remaining: graceful
  shutdown, web query-cache eviction, accessibility (see "Still remaining").
- **Phase 4 (structural cleanup)** — not started (LOW / opportunistic).

## Context

Four parallel sub-agent reviews produced the full findings list (API, packages/
infra, agent runtime, web). The dominant issue is that the orchestrator API had
**no authentication** while exposing Docker control, secret retrieval, and
recursive host-path deletion — turning several injection bugs into
unauthenticated RCE. Phase 0 (security) was prioritised and is now complete.

Two initial hypotheses were disproven by the reviews and are NOT issues: the DB
schema is not duplicated (re-export shims over a single source in
`packages/db`), and the LLM-client list route already masks keys (only `/raw`
returned them unmasked).

---

## DONE this session (Phase 0 security + cheap correctness wins)

All changes typecheck and lint clean.

### 0.1 — Auth on the orchestrator API
- New `apps/api/src/middleware/auth.ts`: `authGuard`, opt-in bearer token via
  `ORCHESTRATOR_API_TOKEN`. Constant-time compare; accepts `Authorization:
  Bearer` or `?token=` (for EventSource). When unset → disabled (loopback-trust)
  with a loud startup warning.
- Wired in `apps/api/src/index.ts` as `.use("/api/*", authGuard)` + startup warn.
- `apps/api/src/env.ts`: added `ORCHESTRATOR_API_TOKEN`.
- Token forwarded to project containers: `project-template/src/env.ts` +
  new `project-template/src/external/orchestrator.ts` (`orchestratorHeaders`),
  used in `external/memory... (memory.ts tool), agent-config.ts, context.ts,
  discord.ts`. Compose generation injects `ORCHESTRATOR_API_TOKEN` into the
  container env (`packages/projects/src/manager.ts`).
- NOTE: the **web client does not yet send the token** — see "Remaining / 0.1b".

### 0.2 — git clone command injection (RCE)
- `packages/projects/src/manager.ts`: `execWithTimeout` now takes an argv array
  and spawns with **no `shell: true`**. `cloneGitHubRepo` and `bun install`
  call sites converted to argv.
- `packages/projects/src/types.ts`: `CreateProjectSchema` templates now
  `superRefine` — github `source` must be an https/git URL (`isValidGitRemote`),
  local `source` must be a single safe path segment (`isSafePathSegment`, also
  closes the M4 local-template path traversal).

### 0.3 — agent tool command injection / sandbox escape
- New `project-template/src/agent/tools/implementations/sandbox.ts` — extracted
  `sandboxPath`/`isWithinWorkspace` (was inline in filesystem.ts; needed by
  commands.ts too without a circular import).
- `filesystem.ts`: `listDirectory`, `moveFile`, `deleteFile`, `createDirectory`,
  `readFileRange` rewritten to native `node:fs`/`Bun.file` — no more `bash -c`
  string building from paths.
- `commands.ts`: `grep` and `glob` now route `path` through `sandboxPath`
  (previously an absolute/`../` path escaped the workspace).
- `utils/git.ts`: commit now uses argv (`runArgv`) so the commit message can't be
  shell-interpreted (`$(...)`/backticks). `runCmd`/`drain` refactor.

### 0.4 — LanceDB memory filter injection
- `apps/api/src/routes/memory.ts`: `type` validated against the enum;
  `entryId` gated by `assertSafeId` (charset allowlist) on GET/PUT/DELETE and
  caller-supplied create id; `limit` clamped (`parseLimit`); `onError` maps
  validation throws to 400.

### 0.5 — destructive / traversal routes
- `apps/api/src/routes/projects.ts` `clear-path`: zod `PathBodySchema`, plus an
  is-directory `stat` check before recursive delete.
- `apps/api/src/routes/templates.ts` PUT: `templateName` restricted to a safe
  single segment (blocks `../` traversal); body validated with
  `TemplateMetadataSchema`; merge only applies defined keys.

### 0.6 — CORS origin reflection (CSRF)
- `apps/api/src/routes/projects.ts`: replaced 6 copies of "reflect any Origin"
  with `applyCorsOrigin(c)` which only echoes the configured
  `ORCHESTRATOR_WEB_URL`.

### 0.7 — secret logging + container network exposure
- `apps/api/src/middleware/logging.ts`: `redactSecrets` recursively masks
  secret-looking keys (apiKey, anthropicApiKey, token, authorization, …) in
  logged JSON bodies; invalid JSON no longer dumps the raw body.
- `packages/projects/src/manager.ts`: container port now bound to
  `127.0.0.1:<port>:<port>` (was `0.0.0.0`). Port-parse regex in `getProject`
  updated to match. Compose scalars now JSON-encoded via `yamlScalar` (fixes
  YAML/compose injection via name/model/keys) and `parseComposeEnvironment`
  reverses it with `JSON.parse`.

### 0.8 — SSRF in web_fetch
- `project-template/src/agent/tools/implementations/web.ts`: `assertPublicUrl`
  resolves host and rejects private/loopback/link-local/CGNAT/metadata ranges
  (v4+v6, incl. IPv4-mapped) and `localhost`/`host.docker.internal`; redirects
  followed manually (`redirect: "manual"`) and re-validated each hop; non-text
  content types and oversized `content-length` skipped.

### 0.9 — markdown XSS (web)
- `apps/web/src/components/markdown.tsx`: `safeUrl` allowlists
  http/https/mailto (+ relative/anchor); disallowed schemes (`javascript:`,
  `data:`) render as plain text, not a live link.

### Cheap correctness wins done alongside
- **H4**: `apps/api/src/db/orchestrator-database.ts:649` — `eq(...) && eq(...)`
  (JS `&&` dropped the projectId predicate → cross-project channel mixups)
  changed to drizzle `and(...)`.
- **Web crash**: `apps/web/src/components/timeline/tool-call-card.tsx` — the
  top-level `JSON.parse(tc.input)` is now guarded (was crashing the whole Tools
  tab, no error boundary).

---

## DONE this session (2) — 0.1b auth wiring, Phase 1, Phase 2, most of Phase 3

Verification for everything below: `bunx biome check .` (clean; the same 5
pre-existing `any` warnings in vendored `.d.ts`), full root `bun run typecheck`
(exit 0), and `bun test` — **90 tests across 9 files, all green**. CI's four
steps (lint / typecheck / test / build) all pass locally, and
`bun install --frozen-lockfile` succeeds. Still nothing committed.

### 0.1b — auth wiring finished ✅
- New `apps/web/src/lib/auth.ts`: `authHeaders()` (Bearer), `withAuthToken(url)`
  (`?token=`), `orchestratorApiToken`, sourced from
  `VITE_ORCHESTRATOR_API_TOKEN`. No-ops when unset.
- Hono client (`agent-api.ts`) now passes `headers: authHeaders`; the four raw
  `fetch` calls (create-stream + tasks CRUD) merge `authHeaders()`; host-events
  EventSource (`host-stream.ts`) uses `withAuthToken`; the progress stream
  (`packages/utils/event-stream.ts` `createProgressStream`) gained a `token`
  param, passed by `docker-progress-modal.tsx`. Session/project SSE streams hit
  the container port directly (no orchestrator auth) so they're deliberately
  untouched. `.env.example` documents the var.

### Phase 1 — safety net ✅
- `.github/workflows/ci.yml`: bun 1.3.14, `install --frozen-lockfile` → lint →
  typecheck → test → build, on PRs + pushes to master (concurrency-cancel).
- Root `test` / `test:watch` scripts (`bun test`). A bare `bun test` skips
  `.projects/` (gitignored dot-dir), verified.
- Seeded unit tests (all the plan's highest-risk units):
  `sandbox.test.ts` (traversal), `plan-mode.test.ts` (incl. the H4 pipe/newline
  cases), `token-budget.test.ts` (circuit-breaker half-open, injected clock),
  `compose-format.test.ts` (round-trip w/ quotes/`:`/newlines/injection),
  `memory-guards.test.ts` (`assertSafeId`/`parseLimit`/`tableName`),
  `update-schemas.test.ts` (the `.partial()`/`.default()` footgun — parses `{}`
  to `{}`, catches a revert), `manager.test.ts` (`dockerProjectName`),
  `ddl.test.ts` (`migrateSchema`).
- To make units testable without standing up Hono/Docker/env, extracted pure
  modules: `packages/projects/src/compose-format.ts` (`yamlScalar` +
  `parseComposeEnvironment`) and `apps/api/src/routes/memory-guards.ts`
  (`assertSafeId`/`parseLimit`/`tableName`); the four `Update*Schema`s are now
  `export`ed. Deleted stale `scripts/run-integration.sh` + `check-ports.sh`.
- NOT done: promoting biome `noExplicitAny`/`noNonNullAssertion` to `error`
  (would need to resolve the vendored-`.d.ts` `any`s first — left as-is).

### Phase 2 — correctness bugs ✅ (all H1–H6, M1)
- **H1** `token-budget.ts`: `CompactionCircuitBreaker` now has a
  `CIRCUIT_COOLDOWN_MS` (60s) half-open reset + injectable clock; `isOpen`
  reflects "tripped AND cooling down". New `mustCompact(est)` forces compaction
  at the blocking limit regardless of cooldown, wired into `loop.ts` (`|| mustCompact`)
  so the blocking limit is now *enforced*, not just a UI warning.
- **H3** `loop.ts` `doCompaction`: the four boundary writes (session-token reset,
  `markSessionMessagesCompacted`, primer insert, compaction record) are wrapped
  in `agent.db.transaction(...)` — SSE emits/report happen after commit. Verified
  drizzle+bun:sqlite tx rolls back outer-`db` helper writes.
- **H2** `runner-utils/api.ts`: on `max_tokens` escalation, the discarded first
  attempt's billed usage is now recorded via `addTokens`, and a `turn_start` is
  emitted before the escalated re-stream so the client clears its buffers (no
  duplicated text). `stores.ts` `turn_start` now also resets `streamText`.
- **H4** `plan-mode.ts`: the compound-command splitter now also splits on a
  single `|` and newlines (was `&&`/`||`/`;` only). Fails closed on quoted pipes.
- **H6** `loop.ts`: extracted `recordFatalError`; the pre-loop bootstrap in
  `run`/`resume`/`restart` is wrapped in try/catch → session moves to `error`
  instead of stuck `running`.
- **H5** `render/chromium.ts`: `page` hoisted out of the `try`, closed in
  `finally` (`.catch(()=>{})`) so the mermaid-timeout path no longer leaks tabs.
- **M1** `db/project-database.ts`: `isMissingDb(err)` distinguishes the expected
  "no agent.db yet" case from real faults; `safeList`/`getProjectStats`/
  `getSession` now log real errors instead of silently returning empty/null.

### Phase 3 — robustness/hygiene (partial) ✅
- **Orchestrator DB additive migrations**: new `migrateSchema(db, schema)` in
  `packages/db/src/ddl.ts` diffs live columns (`PRAGMA table_info`) vs the
  Drizzle schema and issues `ALTER TABLE ADD COLUMN` for anything absent
  (skips PK/UNIQUE/NOT-NULL-without-default with a warning). Schema-driven so it
  can't drift. Wired into `OrchestratorDatabase.migrate()` before the seed.
- **Port-allocation race**: `manager.ts` `findAvailablePort` now serialises via a
  `portAllocation` promise chain, tracks in-memory `reservedPorts`, and OS-probes
  each candidate (`isPortFree`, `node:net`). `createProject` releases the
  reservation in a `finally`.
- **Agent-proxy fetch timeouts**: `proxyToAgent` + the `POST sessions` proxy in
  `projects.ts` now use `AbortSignal.timeout(AGENT_PROXY_TIMEOUT_MS)` (15s).
- **Dependency pinning**: `@anthropic-ai/sdk` `^0.54.0`→`0.54.0` (2×),
  `@types/bun` `latest`→`1.3.14` (2×); root gained `packageManager`
  (`bun@1.3.14`) + `engines.bun`. Lockfile regenerated.
- **Doc drift**: `ARCHITECTURE.md` DB-schema path fixed to
  `@agent-manager/db/project-schema`; `.env.example` `NEXT_PUBLIC_API_URL` was
  already replaced in 0.1b.

---

## REMAINING — prioritized for the next agent

### Phase 3 — robustness/hygiene (still open, MED)
- **No graceful shutdown**: no SIGINT/SIGTERM handler in `apps/api/src/index.ts`
  to close the DB, abort EventHub upstreams, or destroy the Discord client.
  NOTE the footgun: a naive `stopAllProjects()` on shutdown would kill every
  container on each `bun --watch` reload in dev — gate container-stop behind an
  explicit env flag (default off); do the DB/EventHub/Discord cleanup always.
  (EventHub has no `close()` yet — add one that aborts every `upstreams`
  controller.)
- Web `query-cache.ts` never evicts (unbounded memory). TTL/ref-count or adopt
  `@tanstack/react-query` (already a transitive dep). Larger web refactor.
- Accessibility (web): icon-only buttons need `aria-label`; two custom modals in
  `GuidelinesPage`/`TechStacksPage` have broken focus/Escape — switch to Radix
  `Dialog` like the rest of the app. Larger web refactor.

### Phase 4 — structural cleanup (LOW, opportunistic)
- `projects.ts` SSE progress block duplicated ~5×; LLM-client resolution
  repeated ~5×; extract helpers.
- Oversized files: `new-project-dialog.tsx` (957 lines), `SessionPage.tsx`
  (741), `routes/sessions.ts` (`AgentStateConfig` block ×3).
- Dead code: `queryProject`/`getProjectSessions` in `project-database.ts`;
  statistics/archive subsystem in `orchestrator-database.ts` is never wired.

---

## Test coverage added this session
9 test files, 90 tests (was 1 file). Co-located `*.test.ts`, run with `bun test`:
- `project-template/src/agent/tools/implementations/sandbox.test.ts` — `sandboxPath` traversal
- `project-template/src/agent/utils/plan-mode.test.ts` — `isBashCommandReadOnly` incl. the H4 pipe/newline cases
- `project-template/src/agent/token-budget.test.ts` — circuit-breaker trip / cooldown / half-open / `mustCompact` (injectable clock)
- `packages/projects/src/compose-format.test.ts` — `yamlScalar`/`parseComposeEnvironment` round-trip (quotes/`:`/newlines/injection)
- `packages/projects/src/manager.test.ts` — `dockerProjectName`
- `apps/api/src/routes/memory-guards.test.ts` — `assertSafeId`/`parseLimit`/`tableName`
- `apps/api/src/routes/update-schemas.test.ts` — regression guard against a `.partial()` revert
- `packages/db/src/ddl.test.ts` — `migrateSchema` additive column backfill
- `project-template/src/agent/utils/errors.test.ts` — pre-existing

## New modules extracted for testability
- `packages/projects/src/compose-format.ts` — `yamlScalar` + `parseComposeEnvironment` (was private in manager.ts)
- `apps/api/src/routes/memory-guards.ts` — `assertSafeId`/`parseLimit`/`tableName` (was private in memory.ts)
- `packages/db/src/ddl.ts` — added `migrateSchema` (schema-driven additive migrator)

## Verify (all green as of this session)
```
bun run lint          # biome — 5 pre-existing `any` warnings in vendored .d.ts only
bun run typecheck     # all packages, exit 0
bun test              # 90 pass / 0 fail across 9 files
bun run build         # web vite build, exit 0
bun install --frozen-lockfile   # lockfile in sync (CI uses this)
```
CI (`.github/workflows/ci.yml`) runs exactly these on PRs + pushes to master.

Manual smoke test still recommended before shipping: create a project (github +
local template), start it, confirm the container reaches the orchestrator
(memory/discord), and confirm the web dashboard still loads. To exercise auth,
set `ORCHESTRATOR_API_TOKEN` (orchestrator) **and** `VITE_ORCHESTRATOR_API_TOKEN`
(web build) to the same value — mismatched/absent web token ⇒ 401s.

## Nothing committed
All changes remain in the working tree, uncommitted, per the original handoff.
