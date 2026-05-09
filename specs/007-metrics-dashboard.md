# Spec 007 — `synax inspect --metrics` run dashboard

**Issue:** #07  
**Milestone:** M2 — Observability Foundation  
**Owner:** Harry  
**Estimate:** 0.3d (AI-assisted)  
**Priority:** p1 — user-facing observability

## Context

Users need to see what happened. Currently `synax inspect` supports `--docs` and `--doc <path>`. This issue adds `--metrics` to surface: recent runs, success/failure rates, token usage, files changed, tool call frequency, and per-session timelines.

From Harry's domain expertise: "Good devops, metrics, logging, observability, telemetry." This is the CLI dashboard that makes the event store (#05) and span tracer (#06) user-visible.

The dashboard should be text-first (CLI), not graphical. Think `git log --stat` meets `npm audit`. Simple tables, no TUI dependency.

## Scope

**Creates:** `src/commands/inspect-metrics.ts`  
**Modifies:** `src/commands/inspect.ts` (add `--metrics` flag), `src/store/EventStore.ts` (add query methods)  
**Does NOT:** add TUI dashboards, Grafana integration, or real-time monitoring

## Tasks

1. **Add query methods to EventStore:**
   - `getRecentSessions(limit: number): SessionSummary[]`
   - `getSessionTimeline(sessionId: string): Event[]`
   - `getAggregateStats(days: number): AggregateStats` — success rate, avg steps, avg tool calls, common failure modes

2. **Create `src/commands/inspect-metrics.ts`:**
   - `synax inspect --metrics` → table of last 20 sessions with: date, mode, model, steps, toolCalls, status, changedFiles count
   - `synax inspect --metrics --session <id>` → event timeline for that session
   - `synax inspect --metrics --stats` → aggregate: success rate %, avg steps, top failure modes, total runs
   - Support `--json` for machine-readable output

3. **Wire into `inspect.ts`** — add `--metrics` flag to the existing `inspect` command

4. **Format output cleanly:**
   ```
   Recent Sessions (last 20):
   ┌─────────────────────┬────────┬──────────┬───────┬────────────┬──────────┬────────┐
   │ Date                │ Mode   │ Model    │ Steps │ Tool Calls │ Status   │ Files  │
   ├─────────────────────┼────────┼──────────┼───────┼────────────┼──────────┼────────┤
   │ 2026-05-09 14:23:01 │ patch  │ qwen-32b │    12 │         34 │ completed│      3 │
   │ 2026-05-09 13:15:44 │ verify │ deepseek │     4 │          8 │ completed│      0 │
   │ 2026-05-09 12:02:11 │ patch  │ qwen-32b │    28 │         67 │ budget   │      1 │
   └─────────────────────┴────────┴──────────┴───────┴────────────┴──────────┴────────┘
   ```

## Acceptance Criteria

- [ ] `synax inspect --metrics` shows recent sessions table
- [ ] `synax inspect --metrics --session <id>` shows event timeline
- [ ] `synax inspect --metrics --stats` shows aggregate statistics
- [ ] `--json` flag outputs JSON for all three modes
- [ ] Works when EventStore is empty (graceful "no data" message)
- [ ] Works when EventStore is not configured (no crash)
- [ ] `npm test` passes (add CLI test for new flags)
