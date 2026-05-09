# Spec 012 — SQLite+FTS5 holographic memory store

**Issue:** #12  
**Milestone:** M4 — Holographic Memory  
**Owner:** Achu  
**Estimate:** 0.5d (AI-assisted)  
**Priority:** p0 — this is the architectural differentiator

## Context

This is the novel idea from the SOTA review synthesis. Instead of summarizing old context (loses information, costs tokens) or truncating it (loses everything), dump it to a searchable SQLite FTS5 database. The agent can search for exactly what it needs instead of reading a degraded summary.

From the synthesis: "Holographic memory (SQLite FTS5) — dump context there instead of summarizing. Better than summarization because: zero model tokens burned, zero information loss, agent queries what it needs rather than reading a degraded summary."

Architecture:
```
Every turn → INSERT into FTS5 (async, non-blocking)
Agent needs history → search_memory("error from 5 turns ago") → relevant rows
Context exhausted → checkpoint to FTS5 → handoff to child with FTS5 search
```

The memory table schema:
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  turn_id, session_id, role, tool_name, file_paths, content, metadata,
  tokenize='porter unicode61'
);
```

This builds on top of the EventStore from #05. Events store structured observability data. Memory stores unstructured semantic content for retrieval.

## Scope

**Creates:** `src/memory/HolographicMemory.ts`, `src/memory/schema.ts`  
**Modifies:** `src/store/EventStore.ts` (add FTS5 table alongside events table), `src/session/Session.ts` (wire memory)  
**Does NOT:** add search_memory tool (#13), implement handoff (#14)

## Tasks

1. **Extend `src/store/schema.ts`** — add FTS5 virtual table to the SQLite schema:
   ```sql
   CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
     turn_id, session_id, role, tool_name, file_paths, content,
     prefix='2 3', tokenize='porter unicode61'
   );
   ```

2. **Create `src/memory/HolographicMemory.ts`:**
   ```typescript
   class HolographicMemory {
     constructor(db: Database); // shares SQLite connection with EventStore
     
     // Write on every turn
     store(turnId: string, entry: MemoryEntry): void;
     
     // Full-text search
     search(query: string, limit?: number): MemorySearchResult[];
     
     // Generate structured handoff manifest
     handoff(): HandoffManifest;
     
     // Suggested search terms for the next agent
     getSuggestedSearchTerms(): string[];
   }
   
   interface MemoryEntry {
     sessionId: string;
     turnId: number;
     role: 'user' | 'assistant' | 'tool';
     toolName?: string;
     filePaths?: string[];
     content: string;
     metadata?: Record<string, unknown>;
   }
   ```

3. **Wire into Session:**
   - On every model response → `memory.store(turnId, { role: 'assistant', content })`
   - On every tool result → `memory.store(turnId, { role: 'tool', toolName, filePaths, content })`
   - On user messages → `memory.store(turnId, { role: 'user', content })`
   - Store is fire-and-forget (async, non-blocking for turn loop)

4. **Add `getSuggestedSearchTerms()`** — analyzes recent entries and extracts key terms (error messages, file paths, tool names) for the handoff manifest

5. **Make memory optional** — if SQLite is unavailable, memory degrades gracefully (no persistence, no search)

## Acceptance Criteria

- [ ] FTS5 table created alongside events table
- [ ] Every turn stores model response and tool results in FTS5
- [ ] `memory.search("error")` returns relevant entries ranked by FTS5
- [ ] `memory.search("login form")` finds entries about login form even with different phrasing (Porter stemming)
- [ ] `memory.handoff()` returns structured manifest with key findings, files changed, suggested search terms
- [ ] Agent works without SQLite (memory is a no-op, not a crash)
- [ ] Store operations are non-blocking (<5ms each)
- [ ] Existing tests pass
