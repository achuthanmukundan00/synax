# Spec 005 — SQLite-backed event store for agent history

**Issue:** #05  
**Milestone:** M2 — Observability Foundation  
**Owner:** Harry  
**Estimate:** 0.5d (AI-assisted)  
**Priority:** p0 — foundation for all observability

## Context

Synax currently has no persistent history. Agent conversations live in transient `AgentConversation.messages[]` arrays and are lost when the process exits. There's no way to query "what happened in the last 5 runs?" or "what files did the agent modify yesterday?"

From the SOTA review: Codex uses `AgentGraphStore` for persisted spawn edges. Pi uses JSONL append-only files with `parentId` for session trees. Warp uses SQLite with Diesel ORM. The research synthesis recommends SQLite because:
- Zero setup (file-based, no server)
- Queryable (SQL for metrics, event correlation)
- FTS5 for full-text search (holographic memory in M4)
- Single-file portability

This issue creates the event store schema and write path. Querying comes in #07. FTS5 search comes in #12.

## Scope

**Creates:** `src/store/EventStore.ts`, `src/store/schema.ts`  
**Adds dependency:** `better-sqlite3` (sync SQLite, no async overhead)  
**Modifies:** `src/session/Session.ts` (writes events to store)  
**Does NOT:** add FTS5 indexing, implement query APIs, or create dashboards

## Tasks

1. **Add `better-sqlite3` dependency** with TypeScript types (`@types/better-sqlite3`)

2. **Create `src/store/schema.ts`** — define and migrate SQLite schema:
   ```sql
   CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     repo_root TEXT NOT NULL,
     mode TEXT NOT NULL,
     model TEXT NOT NULL,
     created_at TEXT NOT NULL,
     terminal_state TEXT,
     steps INTEGER DEFAULT 0,
     tool_calls INTEGER DEFAULT 0,
     changed_files TEXT DEFAULT '[]'
   );
   CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL REFERENCES sessions(id),
     sequence INTEGER NOT NULL,
     type TEXT NOT NULL,
     timestamp TEXT NOT NULL,
     step_index INTEGER,
     tool_name TEXT,
     payload TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, sequence);
   CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
   ```

3. **Create `src/store/EventStore.ts`:**
   ```typescript
   class EventStore {
     constructor(dbPath: string); // ~/.synax/history.db
     startSession(session: SessionRecord): void;
     appendEvent(sessionId: string, event: AgentEvent): void;
     closeSession(sessionId: string, terminalState: string, stats: SessionStats): void;
   }
   ```

4. **Wire into Session** — Session creates/opens EventStore on construction, writes events on every `eventBus.emit()`

5. **Make EventStore optional** — if dbPath is not configured (or SQLite fails), agent still works, just no persistence

## Acceptance Criteria

- [ ] `better-sqlite3` compiles and works on macOS (primary dev platform)
- [ ] Starting a session writes a row to `sessions` table
- [ ] Every agent event writes a row to `events` table
- [ ] Closing a session updates `terminal_state`, `steps`, `tool_calls`
- [ ] Agent works without EventStore (no SQLite dependency for basic use)
- [ ] Existing 213+ tests pass (EventStore is opt-in for tests)
- [ ] `npm run typecheck && npm run build` pass
