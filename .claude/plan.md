# Implementation Plan: Token Tracking, Timeline Tabs, and SSE Fix

## Overview
Three interconnected features:
1. **Token counts since last compaction** - Track and display tokens consumed between compactions
2. **Timeline tabs** - Split checkins/compactions into "Since Last Compaction" and "Full Timeline" tabs
3. **SSE bug fix** - Emit startup user messages so they appear immediately without refresh

## Architecture

### 1. Token Counts Since Last Compaction

**Database Schema Changes:**
- Add 4 new fields to `sessions` table in `packages/db/src/project-schema.ts`:
  - `tokensInputSinceCompaction` (integer, default 0)
  - `tokensOutputSinceCompaction` (integer, default 0)
  - `tokensCacheReadSinceCompaction` (integer, default 0)
  - `tokensCacheWriteSinceCompaction` (integer, default 0)

**Backend Logic:**
- `project-template/src/agent/runner-utils/api.ts` `recordApiTokens()`:
  - Currently updates only total tokens via `addTokens()`
  - Add: also increment the "since compaction" fields directly on the session record
  - Emit both totals and "since compaction" counts in the `token_update` SSE event

- `project-template/src/agent/runner-utils/loop.ts` `doCompaction()`:
  - After compaction succeeds, reset all 4 "since compaction" fields to 0
  - This happens at the DB level via `updateSession()`

- `project-template/src/db/client.ts` migration:
  - Add ALTER TABLE statements for the 4 new columns (idempotent check)

**Frontend:**
- `packages/utils/src/sse.ts`: Add 4 new fields to `TokenUpdatePayload` type
- `packages/projects/src/records.ts`: Add 4 new fields to `SessionRecord` interface
- `apps/web/src/lib/stores.ts`: Update `token_update` handler to patch the new fields
- `apps/web/src/app/projects/[id]/sessions/[sessionId]/SessionPage.tsx`:
  - Add a new card grid showing "Since Last Compaction" token counts
  - Position it above the existing cumulative token grid
  - Use different colors to distinguish (e.g., blue tones for "since compaction", existing colors for totals)

### 2. Timeline Tabs (Since Last Compaction / Full Timeline)

**Component Changes:**
- `apps/web/src/components/timeline/checkin-timeline.tsx`:
  - Add `mode?: "full" | "sinceLastCompaction"` prop (default "full")
  - When mode is "sinceLastCompaction", filter the merged timeline to only items created after the latest compaction's `createdAt`
  - If no compactions exist, "sinceLastCompaction" shows everything

**SessionPage Integration:**
- Replace the single "Check-ins" TabsContent with an inner nested Tabs structure:
  - Outer tab: "Check-ins" (existing)
  - Inner tabs: "Since Last Compaction" | "Full Timeline"
- Track the active inner tab in local state (default: "sinceLastCompaction")
- **Auto-switch on compaction**: Watch for new compaction events via a `useEffect` on `compactions.length`
  - When a new compaction is detected, automatically switch the inner tab to "sinceLastCompaction"

### 3. SSE Bug Fix - Startup User Messages Not Emitted

**Root Cause:**
- `project-template/src/agent/runner-utils/loop.ts` line 454-458 in `run()`:
  - Startup messages from `buildStartupContext()` are inserted into DB but `emitMessage()` is never called
  - Same issue at lines 280-290 for the "always-improve" continue message

**Fix:**
- After each `insertMessage()` call for startup messages, immediately call `emitMessage(agent, { id: row.id, role: "user", content })`
- Same fix for the always-improve continue message at line 290

**Memory Note:**
- This aligns with the existing memory: "every insertMessage in the agent loop must pair with emitMessage or live viewers miss it"

## Implementation Order

1. **Backend DB schema** (packages/db/src/project-schema.ts)
2. **Backend DB migration** (project-template/src/db/client.ts)
3. **Backend token tracking** (project-template/src/agent/runner-utils/api.ts)
4. **Backend compaction reset** (project-template/src/agent/runner-utils/loop.ts)
5. **Backend SSE bug fixes** (project-template/src/agent/runner-utils/loop.ts - emit startup messages)
6. **SSE type definitions** (packages/utils/src/sse.ts)
7. **Frontend types** (packages/projects/src/records.ts)
8. **Frontend stores** (apps/web/src/lib/stores.ts)
9. **Frontend SessionPage summary** (apps/web/src/app/projects/[id]/sessions/[sessionId]/SessionPage.tsx)
10. **Frontend CheckinTimeline** (apps/web/src/components/timeline/checkin-timeline.tsx)
11. **Frontend SessionPage tabs** (apps/web/src/app/projects/[id]/sessions/[sessionId]/SessionPage.tsx)

## Trade-offs

**Token Tracking:**
- Adding 4 new DB fields increases storage slightly, but essential for the feature
- Reset on compaction is straightforward since compaction already updates the session

**Timeline Tabs:**
- Could add "Since Last Compaction" as a filter instead of tabs, but tabs provide clearer UX
- Auto-switch on compaction ensures users see fresh context immediately

**SSE Fix:**
- Simple fix with zero trade-offs - this is a bug that needs fixing
- Aligns with the existing pattern used everywhere else in the codebase

## Testing Strategy

After implementation:
1. Create a new session → verify startup messages appear immediately (no refresh needed)
2. Let the session run → verify "since compaction" token counts increment
3. Trigger a compaction → verify:
   - "Since compaction" counts reset to 0
   - Timeline automatically switches to "Since Last Compaction" tab
   - The new tab only shows items after the compaction
4. Switch to "Full Timeline" tab → verify all checkins/compactions are visible
5. Refresh the page → verify all data persists correctly
