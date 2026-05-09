/**
 * SQLite-backed event store for agent history.
 *
 * Stores sessions and append-only events with structured payloads.
 * Optional — agent works without it when SQLite is unavailable.
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

import Database from 'better-sqlite3';
import type { AgentEvent } from '../agent/events';
import { ALL_DDL, SCHEMA_VERSION_PRAGMA, type SessionRecord } from './schema';

export type { SessionRecord };

export interface SessionStats {
  steps: number;
  toolCalls: number;
  changedFiles: string[];
}

function defaultDbPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return join(home, '.local', 'share', 'synax', 'history.db');
}

export class EventStore {
  private db: Database.Database | null = null;
  private insertEventStmt: Database.Statement | null = null;
  private insertSpanStmt: Database.Statement | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? defaultDbPath();
    try {
      this.open();
    } catch {
      // EventStore is optional — agent works without persistence
      this.db = null;
    }
  }

  get isOpen(): boolean {
    return this.db !== null;
  }

  /**
   * Open the database, create schema, and prepare statements.
   * Throws on failure so the caller can catch and continue without persistence.
   */
  private open(): void {
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const db = new Database(this.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');

    // Run schema migration
    for (const ddl of ALL_DDL) {
      db.exec(ddl);
    }
    db.exec(SCHEMA_VERSION_PRAGMA);

    this.insertEventStmt = db.prepare(`
      INSERT INTO events (session_id, sequence, type, timestamp, step_index, tool_name, payload)
      VALUES (@sessionId, @sequence, @type, @timestamp, @stepIndex, @toolName, @payload)
    `);

    this.insertSpanStmt = db.prepare(`
      INSERT OR REPLACE INTO spans (id, session_id, parent_id, kind, start_time, end_time, duration_ms, metadata, events)
      VALUES (@id, @sessionId, @parentId, @kind, @startTime, @endTime, @durationMs, @metadata, @events)
    `);

    this.db = db;
  }

  /** Start a new session record. */
  startSession(session: SessionRecord): void {
    if (!this.db) return;
    const changedFilesJson = JSON.stringify(session.changedFiles ?? []);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions (id, repo_root, mode, model, created_at, terminal_state, steps, tool_calls, changed_files)
       VALUES (@id, @repoRoot, @mode, @model, @createdAt, @terminalState, @steps, @toolCalls, @changedFiles)`,
      )
      .run({
        id: session.id,
        repoRoot: session.repoRoot,
        mode: session.mode,
        model: session.model,
        createdAt: session.createdAt,
        terminalState: session.terminalState ?? null,
        steps: session.steps ?? 0,
        toolCalls: session.toolCalls ?? 0,
        changedFiles: changedFilesJson,
      });
  }

  /** Append an agent event to the store. */
  appendEvent(sessionId: string, event: AgentEvent, sequence: number): void {
    if (!this.db || !this.insertEventStmt) return;
    const eventRec = event as unknown as Record<string, unknown>;
    const stepIndex = 'stepIndex' in eventRec ? eventRec.stepIndex : undefined;
    const toolName = 'toolName' in eventRec ? eventRec.toolName : undefined;

    this.insertEventStmt.run({
      sessionId,
      sequence,
      type: event.type,
      timestamp: event.timestamp,
      stepIndex: stepIndex ?? null,
      toolName: toolName ?? null,
      payload: JSON.stringify(event),
    });
  }

  /** Append a span record to the store. */
  upsertSpan(record: {
    id: string;
    sessionId: string;
    parentId?: string;
    kind: string;
    startTime: number;
    endTime?: number;
    durationMs?: number;
    metadata?: Record<string, unknown>;
    spanEvents?: Array<{ name: string; timestamp: number; data?: unknown }>;
  }): void {
    if (!this.db || !this.insertSpanStmt) return;
    this.insertSpanStmt.run({
      id: record.id,
      sessionId: record.sessionId,
      parentId: record.parentId ?? null,
      kind: record.kind,
      startTime: record.startTime,
      endTime: record.endTime ?? null,
      durationMs: record.durationMs ?? null,
      metadata: JSON.stringify(record.metadata ?? {}),
      events: JSON.stringify(record.spanEvents ?? []),
    });
  }

  /** Update session terminal state and stats. */
  closeSession(sessionId: string, terminalState: string, stats: SessionStats): void {
    if (!this.db) return;
    const changedFilesJson = JSON.stringify(stats.changedFiles);
    this.db
      .prepare(
        `UPDATE sessions SET terminal_state = @terminalState, steps = @steps, tool_calls = @toolCalls, changed_files = @changedFiles WHERE id = @id`,
      )
      .run({
        id: sessionId,
        terminalState,
        steps: stats.steps,
        toolCalls: stats.toolCalls,
        changedFiles: changedFilesJson,
      });
  }

  /** Get event count for a session (for sequence tracking). */
  getEventCount(sessionId: string): number {
    if (!this.db) return 0;
    const row = this.db.prepare('SELECT COUNT(*) as count FROM events WHERE session_id = ?').get(sessionId) as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  }

  /** Get all events for a session, ordered by sequence. */
  getEvents(
    sessionId: string,
    limit?: number,
  ): Array<{ sequence: number; type: string; timestamp: string; payload: string }> {
    if (!this.db) return [];
    const sql = limit
      ? 'SELECT sequence, type, timestamp, payload FROM events WHERE session_id = ? ORDER BY sequence ASC LIMIT ?'
      : 'SELECT sequence, type, timestamp, payload FROM events WHERE session_id = ? ORDER BY sequence ASC';
    const params = limit ? [sessionId, limit] : [sessionId];
    return this.db.prepare(sql).all(...params) as Array<{
      sequence: number;
      type: string;
      timestamp: string;
      payload: string;
    }>;
  }

  /** Close the database connection. */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * Create an EventStore or return undefined if it can't be opened.
 * Use this for opt-in persistence.
 */
export function createEventStore(dbPath?: string): EventStore | undefined {
  try {
    const store = new EventStore(dbPath);
    if (store.isOpen) return store;
    return undefined;
  } catch {
    return undefined;
  }
}
