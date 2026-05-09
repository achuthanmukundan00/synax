# Spec 014 — Handoff sub-agents with FTS5 inheritance

**Issue:** #14  
**Milestone:** M4 — Holographic Memory  
**Owner:** Achu  
**Estimate:** 0.5d (AI-assisted)  
**Priority:** p0 — this is the context exhaustion solution

## Context

When context is exhausted (even after deterministic compaction), the current behavior is `budget_exhausted` — the agent dies. This is the failure mode the entire architecture is designed to eliminate.

From the synthesis: "Handoff sub-agents with FTS5 inheritance. When context approaches budget: checkpoint to FTS5, generate handoff JSON, child spawns with fresh context + handoff + FTS5 search. Child writes results back to shared FTS5. Parent consumes and continues."

The handoff protocol:
1. Parent agent's context is ~90% full → `before_compact` event fires
2. Deterministic compaction runs (Tier 1) → still at ~85%
3. Parent triggers handoff: writes `HandoffManifest` to FTS5, spawns child Session
4. Child starts with: system prompt + handoff JSON + original user task
5. Child has `search_memory` tool connected to parent's FTS5
6. Child works autonomously until completion or its own handoff
7. Child writes results back; parent reads results and continues (or the child IS the final answer)

This is architecturally similar to Codex's fork/resume but better: the child doesn't inherit bloated context — it gets a clean slate with a search index.

## Scope

**Creates:** `src/handoff/HandoffManager.ts`, `src/handoff/types.ts`  
**Modifies:** `src/session/Session.ts` (add `handoff()` method), `src/agent/runner.ts` (integrate handoff into compaction pipeline)  
**Does NOT:** implement multi-agent orchestration, parallel agent execution, or agent trees (deferred)

## Tasks

1. **Create `src/handoff/types.ts`:**
   ```typescript
   interface HandoffManifest {
     parentSessionId: string;
     handoffReason: 'context_exhaustion' | 'task_delegation';
     task: string; // original user task
     status: string; // what was accomplished so far
     keyFindings: string[]; // critical discoveries
     filesChanged: string[];
     filesRead: string[];
     pendingWork: string[]; // what still needs to be done
     suggestedSearchTerms: string[]; // for FTS5 lookup
     contextWindowUsed: number; // tokens consumed
     createdAt: string;
   }
   ```

2. **Create `src/handoff/HandoffManager.ts`:**
   - `createHandoff(session: Session, reason: HandoffReason): HandoffManifest`
   - Generates manifest from: conversation state, inspection ledger, memory store, compacted file paths
   - Writes manifest to FTS5 memory
   - `resumeFromHandoff(manifest: HandoffManifest, parentMemory: HolographicMemory): Session`
   - Creates child Session with: system prompt + manifest injected as initial user message
   - Child's memory is connected to parent's FTS5 database (shared connection)

3. **Integrate into Session:**
   - `Session.handoff(reason)` → creates manifest, spawns child, returns child's result
   - Child session runs `startTurn(task)` where task is the original user task
   - Child's `search_memory` tool searches BOTH its own entries AND the parent's entries

4. **Integrate into compaction pipeline:**
   - In `compactMessagesMultiStage`, after Stage 3 (deterministic compression): if still over budget, trigger handoff
   - Handoff becomes the replacement for Stage 4 (fail-closed)
   - Old Stage 4 (`budget_exhausted` terminal state) is only reached if handoff itself fails

5. **Add handoff depth limit** — max 3 nested handoffs to prevent infinite chains

## Acceptance Criteria

- [ ] When context reaches 95%+ after deterministic compaction, handoff triggers automatically
- [ ] Handoff manifest includes: task, status, keyFindings, filesChanged, pendingWork, suggestedSearchTerms
- [ ] Child session starts with clean context + manifest + original task
- [ ] Child's `search_memory` returns results from parent's history
- [ ] Child can complete the task autonomously
- [ ] Max 3 nested handoffs (4th attempt returns error)
- [ ] Handoff events emitted to EventBus
- [ ] `budget_exhausted` is only reached if handoff itself fails (not for normal context exhaustion)
- [ ] Existing tests pass; new test simulates context exhaustion → handoff → child completion
