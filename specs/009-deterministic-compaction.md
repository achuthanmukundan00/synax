# Spec 009 — Deterministic compaction: Tier 1 zero-token compression

**Issue:** #09  
**Milestone:** M3 — Adaptive Context Survival  
**Owner:** Achu  
**Estimate:** 0.5d (AI-assisted)  
**Priority:** p0 — replaces deletion-only "compaction" with actual compression

## Context

Synax's current "compaction" is 4 stages of deletion:
1. Truncate old tool results
2. Remove duplicate reads
3. Keep N recent turns
4. Fail-closed (`budget_exhausted`)

This is not compaction. It's amputation. From the SOTA review: "Synax's 'compaction' is token-count-based deletion. Pi's approach is the most sophisticated of the three." But we don't want LLM-driven summarization (burns tokens). We want Claw Code's approach: deterministic structural compression.

From Claw Code deconstruction: "Deterministic compaction (zero tokens) — structural analysis of conversation produces XML summaries without LLM. Structural analysis of the conversation (tool names, file paths, user requests, pending work) produces structured summaries."

The key insight: before every model call, apply zero-token deterministic compression. Only if still over budget, escalate to summarization (#14) or handoff (#14). This is Tier 1 of the 3-tier compaction pipeline.

## Scope

**Creates:** `src/compaction/DeterministicCompactor.ts`, `src/compaction/techniques/`  
**Modifies:** `src/agent/context-budget.ts` (add deterministic stage before existing 4-stage deletion)  
**Does NOT:** implement LLM summarization, handoff, or FTS5 memory

## Tasks

1. **Create `src/compaction/techniques/` with individual compression functions:**

   - `stripDuplicateLines.ts` — detect and collapse repeated stdout lines (npm install spam)
   - `stripAnsiCodes.ts` — remove terminal color codes from tool output
   - `stripStackTraces.ts` — remove `node_modules/...` lines from error stacks
   - `collapseWhitespace.ts` — collapse multiple blank lines, trim indentation
   - `dedupRepeatedPatterns.ts` — detect compiler errors repeating same message

2. **Create `src/compaction/DeterministicCompactor.ts`:**
   ```typescript
   class DeterministicCompactor {
     compact(messages: AgentMessage[]): {
       messages: AgentMessage[];
       stats: { originalTokens: number; savedTokens: number; techniques: string[] };
     }
   }
   ```
   Applies techniques in priority order, measures token savings, stops when under budget.

3. **Integrate into existing `compactMessagesMultiStage`:**
   - Insert deterministic compaction as **Stage 0** (before current stages 1-4)
   - Only run when context strategy is `moderate` or `aggressive`
   - For `light`/`none` strategies, skip entirely

4. **Measure and log** — `stats.savedTokens` and `stats.techniques` emitted as events

5. **Add unit tests** for each technique with real-world output samples (npm install, tsc errors, jest output)

## Acceptance Criteria

- [ ] Deterministic compaction runs before deletion stages
- [ ] Strip duplicate lines: 500-line npm output → ~80 lines
- [ ] Strip ANSI codes: colorized jest output → plain text
- [ ] Strip stack traces: error with 40 lines of node_modules → 5 lines
- [ ] No information loss for semantically important content (actual error messages preserved)
- [ ] `stats.savedTokens` reported in telemetry spans
- [ ] Existing 213+ tests pass
- [ ] New tests cover each compression technique
- [ ] For `light`/`none` strategies, deterministic compaction is a no-op
