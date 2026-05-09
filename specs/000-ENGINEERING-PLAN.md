# Synax Engineering Plan — From Alpha to Production

**Status:** Active  
**Created:** 2026-05-09  
**Based on:** [01-architecture-SOTA-review](../01-architecture-SOTA-review/) synthesis of Codex CLI, Pi, Claw Code, Warp, and current Synax alpha  
**Velocity model:** AI agents + heavy-prompting devs. Estimates are wall-clock with parallel agent execution.

---

## Context

Synax v0.0.22-alpha is a working local-first coding agent with 213 passing tests, 12 tool-call parsers for local models, 4-stage truncation-based compaction, and a promising extensions kernel. But it has architectural debt that blocks survival, extensibility, and production readiness:

1. **runner.ts is a 1,635-line God Object** — turn loop, tool dispatch, context budget, compaction, bash safety, patch approval, and read dedup all live in one file
2. **Compaction is deletion-only** — 4 stages of truncation, stage 4 = `budget_exhausted` (fail-closed). No summarization, no handoff, no recovery
3. **Parser repair is stubbed** — 12 parsers detect format but don't repair malformed tool calls
4. **No multi-agent, no persistent memory, no event bus** — the architecture can't express sub-agents, can't query history, and can't support extensions as first-class citizens
5. **Hardcoded context budget** — 128K window assumed for all models, no adaptation

## Core Thesis

From the five-codebase deconstruction, these are the architectural insights that matter:

| Insight | Source | Synax Action |
|---------|--------|-------------|
| Survival = success — every failure mode needs a recovery path | Terminus, Codex CLI | Recovery recipes, never `budget_exhausted` without handoff |
| Adaptive context — calibrate to model's native window | Novel (Achu) | `synax doctor` probes window, auto-selects strategy |
| Holographic memory — SQLite FTS5 beats summarization for local models | Novel (Achu) | Dump context to FTS5, agent searches what it needs |
| Deterministic compaction — zero-token structural compression | Claw Code | Tier 1 compaction before any LLM call |
| Extension-as-architecture — typed events, not plugins | Pi | EventBus with lifecycle hooks + tight control hooks |
| Typed actions — semantic metadata enables precise gating | Warp | Replace generic `tool_calls` with typed `AgentAction` |
| Session tree — navigate conversation like git branches | Pi | SQLite schema with `parentId` for conversation branching |
| Verification contracts — typed quality gates, not regex | Claw Code, Codex CLI | Replace `isPrematureCompletionClaim` with typed levels |

## What NOT to Build (From Research)

- ❌ Multi-language codebase (Rust+TypeScript) — Synax doesn't need Rust performance yet
- ❌ Custom UI framework — print-mode + existing TUI is sufficient
- ❌ Cloud service dependencies — Synax is local-first
- ❌ External agent harnesses — Synax IS the agent
- ❌ Tree-sitter semantic chunking — deferred to post-v1.0
- ❌ Generic OpenAI function-calling schemas — typed actions are better for local models
- ❌ Monolithic God Objects — runner.ts must die

---

## All Milestones

### M1: Architecture Foundation

**Goal:** Kill runner.ts. Extract Session, ActionExecutor, and ExecutionEnv. Lay the EventBus.

| # | Issue | Owner | Est. |
|---|-------|-------|------|
| 01 | Extract Session class from runner.ts | Achu | 0.5d |
| 02 | Extract typed ActionExecutor from runner.ts | Achu | 0.3d |
| 03 | Add ExecutionEnv abstraction | Achu | 0.2d |
| 04 | Add typed EventBus with lifecycle and control hooks | Achu | 0.5d |

**M1 total:** ~1.5d (parallel agents on #01+#02, then #03+#04)

### M2: Observability Foundation

**Goal:** Structured telemetry, queryable agent history, run metrics. Runs parallel to M1.

| # | Issue | Owner | Est. |
|---|-------|-------|------|
| 05 | SQLite-backed event store for agent history | Harry | 0.5d |
| 06 | Structured telemetry events with span tracing | Harry | 0.5d |
| 07 | `synax inspect --metrics` run dashboard | Harry | 0.3d |

**M2 total:** ~1.3d (parallel with M1)

### M3: Adaptive Context Survival

**Goal:** The agent never dies on context exhaustion. Model-aware strategy, deterministic compaction, recovery recipes, parser repair.

| # | Issue | Owner | Est. |
|---|-------|-------|------|
| 08 | Model-aware context strategy (synax doctor probes) | Achu | 0.3d |
| 09 | Deterministic compaction — Tier 1 zero-token compression | Achu | 0.5d |
| 10 | Recovery recipes — 7 failure scenarios, never fail-closed | Achu | 0.5d |
| 11 | Parser repair implementation — JSON/XML auto-recovery | Achu | 0.5d |

**M3 total:** ~1.8d

### M4: Holographic Memory

**Goal:** SQLite+FTS5 memory that survives context exhaustion. Agent searches history instead of reading summaries.

| # | Issue | Owner | Est. |
|---|-------|-------|------|
| 12 | SQLite+FTS5 holographic memory store | Achu | 0.5d |
| 13 | search_memory tool for the agent | Achu | 0.3d |
| 14 | Handoff sub-agents with FTS5 inheritance | Achu | 0.5d |

**M4 total:** ~1.3d

### M5: Production Hardening

**Goal:** CI/CD, structured logging, token metrics, safety hardening. Runs parallel to M3/M4.

| # | Issue | Owner | Est. |
|---|-------|-------|------|
| 15 | CI/CD pipeline with quality gates | Harry | 0.5d |
| 16 | Structured logging with levels, context, and redaction | Harry | 0.5d |
| 17 | Token usage metrics and cost tracking | Harry | 0.5d |

**M5 total:** ~1.5d (parallel with M3/M4)

### M6: Community Readiness

**Goal:** Verification contracts, skills system, public docs. The polish layer.

| # | Issue | Owner | Est. |
|---|-------|-------|------|
| 18 | Typed verification contracts (replace regex completion detection) | Achu | 0.5d |
| 19 | Skills system — file-system-based skill discovery with injection | Achu | 0.3d |
| 20 | Public docs, CONTRIBUTING.md, example extensions | Harry | 0.5d |

**M6 total:** ~1.3d

---

## Total Timeline

```
~5-7 days wall-clock with parallel agent execution:

Phase A (Day 1-2):  M1 Architecture + M2 Observability (parallel)
Phase B (Day 2-4):  M3 Context Survival + M5 Production Hardening (parallel)  
Phase C (Day 4-5):  M4 Holographic Memory + M5 continued
Phase D (Day 5-7):  M6 Community Readiness
```

Achu runs 2-3 agents in parallel. Harry ships one focused PR at a time. Hardening (regression tests, edge cases, docs) is where real time goes — the feature code is the fast part.

---

## Ownership Split

| Achu (Engine) | Harry (Dashboard) |
|---------------|-------------------|
| Session, Turner, Compactor, Memory | Observability, telemetry, metrics |
| Typed actions, parser repair, recovery | Structured logging, event store |
| EventBus, extension kernel | CI/CD, quality gates |
| Handoff sub-agents, verification contracts | Token metrics, cost tracking |
| Skills system | Public docs, community surfaces |
| All architectural decisions | Safety hardening, sandboxing |

---

## Issue Template

Every issue follows:
- **Title:** Verb-first, specific scope
- **Context:** Problem + why now + research backing
- **Scope:** Files touched, files NOT touched
- **Tasks:** Ordered checklist, each ~30min-2hr
- **Acceptance Criteria:** Testable, gated on existing tests passing
- **Owner:** Achu or Harry
- **Labels:** `area:*`, `priority:p0|p1`, `milestone:M1-M6`
- **Estimate:** 0.2–0.5d (AI-assisted)

Every PR must:
- Pass `npm test` (213 existing tests)
- Pass `npm run typecheck && npm run build`
- Be <400 lines diff where possible
- Not break the existing CLI (`synax run`, `synax chat`)
