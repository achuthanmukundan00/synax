# Spec 021 — Proactive orchestration with child sessions and FTS5 inheritance

**Issue:** #59
**Milestone:** 
**Owner:** Harry
**Estimate:** 0.5d (investigation + spec writing)
**Priority:** p0 — prevents context exhaustion on large tasks

## Context

Synax currently runs a single agent turn loop via `Session.startTurn()` / `startTurnWithRecovery()`. That single session carries the entire conversation, inspection ledger, verification contract, and file patching process in one context. For large tasks, this ballooning context can exhaust model budget and trigger a reactive handoff or fail-closed.

Spec 014 already introduces reactive handoff: when context is exhausted after compaction, the parent session checkpoints state into a `HandoffManifest`, spawns a child session with clean context, and shares FTS5 memory for search. This spec investigates how to make that mechanism proactive and orchestrated rather than only rescue-based.

This design also builds on spec 008 (`context-strategy`), which defines budget stages and compaction tiers, and spec 012 (`holographic-memory`), which defines the shared `HolographicMemory` / FTS5 behavior that child sessions inherit.

## Goal

Design a proactive orchestration layer that:

- estimates task budget needs before execution,
- decomposes work into scoped sub-tasks,
- plans whether the task can run inline or needs sequential/parallel child sessions,
- orchestrates subagents with fresh contexts and parent handoff summaries,
- aggregates results back into a parent conclusion,
- preserves reactive handoff as a safety net.

---

(T1 to T9 investigation tasks)


## T1 — Current Session state mapping

### Shared state between parent and child

The child session must inherit the project-level shared resources that are necessary to complete the task and preserve repository coherence:

- `repoRoot` — same repository root and file resolution context
- `client` / tool definitions — same agent capabilities, tools, and policies
- `memory` reference — shared `HolographicMemory` / FTS5 store for search inheritance
- shared `logger`, `tracer`, `tokenCounter`, `costTracker` — observability and global budget tracking
- handoff metadata — `HandoffManifest` carries parent progress, task, files touched, and search hints

### Isolated state inside child sessions

Each child session must keep its own local execution state separate:

- `conversation.messages` — clean child context containing only the handoff summary and task
- `tokenLedger` — per-child token accounting and model-step accounting
- `inspectionLedger` — child-specific file inspection history and reads
- `latestCompaction` / own compaction history — child should not inherit full parent context state
- `assemblyStats` / current prompt assembly stats — only child-local
- `sessionId` — child identity separate from parent, with parent-child linkage in manifest
- `onEvent` / callbacks may be wired separately if desired, but parent can subscribe to child events for orchestration

### What must not be copied as raw context

- any full parent conversation history beyond the handoff manifest
- parent tool output or patch approval history as message history
- parent token/budget state as a direct prompt
- bloated context that would defeat the point of fresh child sessions

### Current implementation evidence

`HandoffManager.executeHandoff()` currently builds the child session with the parent's `memory`, but a fresh child `conversation`, new `tokenLedger`, and a clean `inspectionLedger`. That is the correct isolation boundary for proactive orchestration.

---

## T2 — Context budget estimation heuristic

### Objective

Estimate required tokens for a task before execution so Synax can decide whether to run inline or orchestrate subagents.

### Inputs

- original task text length and complexity
- repo shape: file count, file sizes, language mix, candidate source files
- existing heuristic from `context-budget` / model prompt budget
- expected verification overhead and patch approval
- `HandoffManifest` search hints when reuse occurs

### Proposed heuristic

1. `taskBaseTokens` = token estimate for the task prompt plus system/instruction framing.
2. `repoVisibilityFactor` = function of repository metadata:
   - small repo: 0.5–1x
   - medium repo: 1–2x
   - large repo: 2–4x
   - huge repo: 4x+
3. `fileScopeFactor` = based on likely touched files
   - if task mentions specific files, use file sizes
   - if task is broad (`fix tests`, `refactor`), estimate using total repo KB and file count
4. `verificationReserve` = fixed overhead for verification + patch preview + summary (~2k–4k tokens)
5. `childSafetyBuffer` = extra reserve for proactive orchestration planning (~10–15% of estimated budget)

### Example formula

- `estimatedTokens = taskBaseTokens + floor(repoVisibilityFactor * relevantRepoTokens) + verificationReserve`
- `relevantRepoTokens = min(1000, repoKB / 1)` for small tasks, else use heuristic from file metadata
- if `estimatedTokens > model.contextWindow * 0.7`, prefer subagent orchestration
- if `estimatedTokens > model.contextWindow * 0.9`, require sequential child sessions or proactive decomposition

### Practical implementation

A lightweight estimator can be built from repo shape metadata without reading all file content. This fits into spec 008's context strategy framework by providing a pre-execution budget prediction layer before compaction or handoff.

- `repoFileCount`
- `repoTotalKB`
- `candidateSourceKB`
- `taskTargets` detected from task text (`fix`, `add`, `refactor`, `audit`, `verify`)
- `explicit file mentions`

This is not perfect, but good enough to decide whether to run inline or orchestrate.

### Triaging thresholds

- `inline`: estimated budget under `0.5 * contextWindow`
- `plan child sessions`: estimated budget between `0.5*` and `0.9*`
- `require decomposition`: estimated budget above `0.9*`

### Decision tree for inline vs sequential vs parallel

The orchestration decision tree is a simple rule-based workflow that selects execution strategy before the child session phase.

```ts
function chooseExecutionStrategy(estimatedTokens: number, contextWindow: number, hasExplicitFiles: boolean, isIndependentWork: boolean): 'inline' | 'sequential' | 'parallel' {
  if (estimatedTokens < contextWindow * 0.5) {
    return 'inline';
  }

  if (estimatedTokens >= contextWindow * 0.9) {
    return 'sequential';
  }

  // Choose parallel only when scope and output files are disjoint.
  if (isIndependentWork && hasExplicitFiles) {
    return 'parallel';
  }

  return 'sequential';
}
```

This decision tree is intentionally conservative: use parallel child sessions only when the task decomposition clearly identifies independent, disjoint work.

---

## T3 — Task decomposition contract

### SubTask shape

A sub-task should be a structured object with the following fields:

- `id: string` — stable local identifier
- `title: string` — short human-readable description
- `description: string` — explicit scope and acceptance criteria
- `inputFiles: string[]` — files the sub-task reads/inspects
- `outputFiles: string[]` — files the sub-task may modify
- `dependencies: string[]` — other sub-task ids that must complete first
- `estimatedBudget: number` — token budget estimate for this child
- `verification: string` — pass conditions or contract for the child
- `status: 'pending' | 'running' | 'completed' | 'failed'`
- `handoffSummary?: string` — parent context summary for the child

### Model-produced decomposition contract

The model should output a JSON contract such as:

```json
{
  "subtasks": [
    {
      "id": "task-1",
      "title": "Audit package.json and lockfile",
      "description": "Ensure dependencies are up to date and no incompatible versions are introduced.",
      "inputFiles": ["package.json", "package-lock.json"],
      "outputFiles": ["package.json"],
      "dependencies": [],
      "estimatedBudget": 2800,
      "verification": "All package upgrades preserve semver and tests still run."
    }
  ]
}
```

### Contract design rules

- require exact JSON schema with `subtasks` at top level
- enforce `inputFiles` / `outputFiles` arrays to ground the child
- require `dependencies` for sequencing
- allow `estimatedBudget` to be absent or approximate, but prefer numeric values
- include `reviewNotes` / `pendingWork` if the decomposition is uncertain

### Decomposition patterns

- `horizontal split` — separate independent feature areas or file groups
- `vertical split` — break a large task into research/analysis, edit, and verify steps
- `review split` — one child audits another child's patch set
- `verification split` — one child generates code, another verifies behavior

---

## T4 — Sequential orchestration loop

### Parent orchestration flow

1. `plan` — parent session estimates budget and asks the model to decompose the task into sub-tasks.
2. `schedule` — build a linear or dependency-resolved sequence of child sessions.
3. `execute` — run each child session sequentially with fresh context and handoff summary.
4. `absorb` — elevate child results back into parent state, updating `filesChanged`, `pendingWork`, and `summary`.
5. `finalize` — parent composes the final answer from aggregated child outputs.

### Child session execution

- child receives:
  - clean `system` context
  - `HandoffManifest` summary from parent
  - original task and explicit sub-task scope
- child uses shared `memory` FTS5 search to access parent insights and prior progress
- child runs `startTurnWithRecovery(subtask.description)` or a new `startSubTask()` API
- child returns:
  - `terminalState`, `toolCalls`, `changedFiles`, `finalAnswer`, `conversation` summary

### Parent aggregation after each child

- merge `changedFiles` into parent’s task state
- add `keyFindings` / `pendingWork` from child result into parent summary
- detect overlap between the just-completed child and future subtasks
- if a child fails, optionally retry with smaller sub-tasks or abort orchestration

### Orchestration invariants

- only one child session is active at a time in sequential mode
- each child shares parent FTS5 memory but has isolated conversation and budget
- parent retains global task context and can still invoke reactive handoff if a child also exhausts
- parent may re-plan mid-orchestration if sub-task results change scope

---

## T5 — Parallel fan-out model

### When parallel is applicable

Run N children concurrently only when sub-tasks are:

- independent by files and domain
- largely read-only or non-overlapping in write scope
- low risk for merge conflicts
- not dependent on sequential discoveries

Examples:

- generate unit tests for separate modules
- audit independent config files
- add docs to unrelated directories

### Parallel orchestration design

- parent computes an execution graph from `dependencies`
- spawn up to `maxParallelChildren` child sessions simultaneously
- each child uses shared `memory` and clean context
- parent waits for all parallel children to finish before aggregation

### Coordination rules

- only allow parallel execution when `outputFiles` sets are disjoint
- collect all child results and run conflict detection before applying changes
- if conflicts exist, convert the remaining work into sequential sub-tasks

### Practical caution

Because Synax targets local-model, low-resource workflows, parallel fan-out should be optional and conservative. The default should remain sequential unless the decomposition contract explicitly labels sub-tasks as parallelizable.

---

## T6 — 014 handoff safety-net vs primary orchestration

### Recommended role split

- keep reactive handoff as a safety-net for unexpected budget explosions
- absorb the same child-session + FTS5 inheritance pattern into proactive orchestration
- do not remove the reactive fallback; it guards against bad decomposition, unexpected reasoning loops, or unbounded tool output

### Why not make handoff primary only?

- handoff by itself is a recovery mechanism, not a planning mechanism
- if the task is large enough, waiting until exhaustion wastes compute and can still fail if the parent learns too much before handoff
- proactive orchestration should use handoff infrastructure intentionally, but with a plan rather than only when forced
- this spec therefore extends spec 014: it reuses the same `HandoffManager` / `HandoffManifest` mechanism, but uses it as part of a proactive orchestration layer instead of only as a reactive fallback

### Recommended architecture

- `HandoffManager` remains the shared implementation of child spawning and manifest injection
- `OrchestrationManager` or `Session.planTurn()` sits above it to decide when to use child sessions proactively
- reactive `tryHandoffRecovery()` remains in `Session.startTurn()` as a last-resort path

---

## T7 — Result aggregation

### Changed files merge

- maintain a parent file-change map across child sessions
- when a child returns `changedFiles`, record the modified files and the child’s edit rationale
- if multiple children modify the same file, run a deterministic merge step before applying changes
- detect conflicts by comparing changed ranges or patch overlap
- if conflict occurs:
  - prefer parent-driven resolution if one child is clearly sequentially prior
  - else ask a dedicated child to reconcile the conflict with the merged file diff

### Conflict detection

- use file-level output metadata and patch ranges if available
- if child reports the same `outputFile` twice, escalate to merge verification
- if child result is ambiguous about exact edits, fall back to parent review

### Error propagation

- if a child session fails with `terminalState !== completed`, propagate the failure to parent orchestration
- parent may:
  - retry the same subtask with larger budget or more explicit scope,
  - break the subtask into safer pieces,
  - abort orchestration and return the failure to the user
- preserve child error details in the final answer and logs

### Parent conclusion

- parent aggregates child summaries into a single final answer
- include:
  - overall completion status,
  - files changed,
  - verification results,
  - any unresolved pending work,
  - if orchestration was used, the child run summaries

---

## T8 — Depth / abort constraints

### Max depth

- allow `maxOrchestrationDepth = 2` by default:
  1. parent orchestration layer
  2. child subagent layer
  3. optional grandchild if a child itself needs reactive handoff
- limit nested child sessions to prevent runaway trees
- align with existing `HandoffManager` max depth (currently 3)

### Timeouts

- enforce per-child wall-clock timeout, e.g. `childTimeoutMs`
- enforce overall orchestration timeout, e.g. `orchestrationTimeoutMs`
- if a timeout is reached, abort remaining sub-tasks and return a partial result

### Cancellation

- support explicit cancellation from the CLI or environment
- if a child fails fatally, cancel downstream children and surface a parent-level failure
- if the task scope changes mid-run, optionally replan and cancel unused child branches

### Safety constraints

- `maxParallelChildren` to constrain local compute
- `maxChildTokenBudget` to prevent individual children from exhausting available model context
- `maxTotalChildBudget` to preserve a parent-level verification reserve

---

## T9 — Implementation spec

### New module and API

- add `src/session/OrchestrationManager.ts` or `src/agent/orchestration.ts`
- add type definitions in `src/session/types.ts` or `src/agent/types.ts`:
  - `OrchestrationPlan`
  - `SubTask`
  - `SubTaskResult`
  - `OrchestrationResult`

### New Session flow

1. `Session.startTurnWithRecovery(task)` remains the default entrypoint.
2. before building the main prompt, call `Session.estimateTaskBudget(task)`.
3. if the estimate exceeds threshold, call `Session.planOrchestratedTurn(task)`.
4. `planOrchestratedTurn()` produces:
   - a parent-level summary prompt,
   - a JSON `OrchestrationPlan` with `subtasks`, `mode`, `order`, and `parallelCandidates`
5. create a parent `HandoffManifest` template that summarizes task intent and repository state.
6. for each subtask in plan order:
   - spawn child via `HandoffManager.tryHandoff()` or a new `OrchestrationManager.spawnChild()` wrapper,
   - pass `manifest` plus explicit `subtask` scope,
   - await child completion,
   - merge child result into parent state,
   - if child fails, optionally replan or abort.

### Orchestration prompt templates

- `plan` prompt should ask the model to:
  - analyze the task,
  - decide if inline execution is safe,
  - decompose into sub-tasks when necessary,
  - mark tasks as sequential or parallel,
  - estimate budget for each task,
  - output strict JSON.
- `child` prompt should say:
  - "You are a fresh child agent continuing the task from parent."
  - include handoff manifest and subtask scope.
  - instruct the child to use `search_memory` over FTS5 for parent context.

### Integration with handoff

- reuse `HandoffManager` for child session creation and FTS5 inheritance.
- extend `HandoffManifest` to include orchestration-specific fields if needed:
  - `subtaskId`
  - `orchestrationPlanId`
  - `parentSummary`
- preserve reactive `tryHandoffRecovery()` inside child sessions so a child can still handoff if it exhausts.

### Aggregation and merge

- add an `OrchestrationAggregator` that merges subtask output metadata into parent state
- parent should keep a timeline of child results and a cumulative `filesChanged` list
- the final answer should present a merged narrative plus any unresolved issues

### Backward compatibility

- if decomposition fails or the task is small, fall back to single-session inline execution
- if proactive orchestration is disabled, preserve current `Session.startTurnWithRecovery()` behavior
- keep the existing reactive handoff path intact

### Tests and verification

- add spec-driven tests for:
  - `estimateTaskBudget()` thresholds,
  - subtask decomposition contract parsing,
  - sequential child orchestration with summary inheritance,
  - aggregation of child changed files,
  - fallback to inline execution for small tasks,
  - preservation of reactive handoff as a safety-net.

---

## Summary

This spec defines the proactive orchestration layer as a deliberate planning stage above the existing child handoff mechanism. It uses the same FTS5-memory inheritance that is currently implemented by `HandoffManager`, but changes the trigger from "context exhausted" to "task judged too large for one session." The reactive handoff remains a second line of defense.
