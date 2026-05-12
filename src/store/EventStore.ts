/**
 * SQLite-backed event store for agent history.
 *
 * Stores sessions and append-only events with structured payloads.
 * Optional — agent works without it when SQLite is unavailable.
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

import { loadBetterSqlite3, type Database } from './sqlite-loader';
import type { AgentEvent } from '../agent/events';
import {
  ALL_DDL,
  MIGRATE_MEMORY_FTS_ADD_DOMAIN_TAGS,
  SCHEMA_VERSION,
  SCHEMA_VERSION_PRAGMA,
  type SessionRecord,
} from './schema';
import { HolographicMemory } from '../memory/HolographicMemory';

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
  /** Holographic memory — shares this store's DB connection. */
  readonly memory: HolographicMemory;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? defaultDbPath();
    try {
      this.open();
    } catch {
      // EventStore is optional — agent works without persistence
      this.db = null;
    }
    this.memory = new HolographicMemory(this.db);
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

    const SQLite = loadBetterSqlite3();
    if (!SQLite) {
      // better-sqlite3 unavailable — Synax runs without persistence
      return;
    }

    const db = new SQLite(this.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');

    // Run schema creation
    for (const ddl of ALL_DDL) {
      db.exec(ddl);
    }

    // Schema migration: check and apply incremental upgrades
    const currentVersion = (db.pragma('user_version', { simple: true }) as number) || 0;
    if (currentVersion < SCHEMA_VERSION) {
      this.migrateSchema(db, currentVersion);
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

  /** Apply incremental schema migrations based on current version. */
  private migrateSchema(db: Database.Database, currentVersion: number): void {
    // v3 → v4: add domain_tags column to memory_fts
    if (currentVersion < 4) {
      try {
        db.exec(MIGRATE_MEMORY_FTS_ADD_DOMAIN_TAGS);
      } catch {
        // Column may already exist (e.g. table created by updated DDL on fresh DB)
        // This is safe to ignore — the new DDL already includes the column.
      }
    }
    // Future migrations go here.
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

  /**
   * Append a structured log event to the store.
   * Implements LoggerEventStore interface for Logger integration.
   */
  appendLogEvent(entry: {
    level: string;
    message: string;
    timestamp: string;
    context?: Record<string, unknown>;
    error?: string;
  }): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT INTO log_events (level, message, timestamp, context, session_id, error)
         VALUES (@level, @message, @timestamp, @context, @sessionId, @error)`,
        )
        .run({
          level: entry.level,
          message: entry.message,
          timestamp: entry.timestamp,
          context: entry.context ? JSON.stringify(entry.context) : null,
          sessionId: (entry.context?.sessionId as string) ?? null,
          error: entry.error ?? null,
        });
    } catch {
      // Best-effort — logging must not crash
    }
  }

  /** Whether the store is available (connected, ready). */
  get available(): boolean {
    return this.isOpen;
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

  // ── Query methods for inspect --metrics ─────────────────────────────────

  /** Get the most recent N sessions with summary data. */
  getRecentSessions(limit = 20): SessionRecord[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT id, repo_root, mode, model, created_at, terminal_state, steps, tool_calls, changed_files
       FROM sessions ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      repo_root: string;
      mode: string;
      model: string;
      created_at: string;
      terminal_state: string | null;
      steps: number;
      tool_calls: number;
      changed_files: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      repoRoot: r.repo_root,
      mode: r.mode,
      model: r.model,
      createdAt: r.created_at,
      terminalState: r.terminal_state ?? undefined,
      steps: r.steps,
      toolCalls: r.tool_calls,
      changedFiles: safeJsonParse(r.changed_files),
    }));
  }

  /** Get the full event timeline for a session. */
  getSessionTimeline(sessionId: string): Array<{
    sequence: number;
    type: string;
    timestamp: string;
    stepIndex?: number;
    toolName?: string;
    payload: Record<string, unknown>;
  }> {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT sequence, type, timestamp, step_index, tool_name, payload
       FROM events WHERE session_id = ? ORDER BY sequence ASC`,
      )
      .all(sessionId) as Array<{
      sequence: number;
      type: string;
      timestamp: string;
      step_index: number | null;
      tool_name: string | null;
      payload: string;
    }>;
    return rows.map((r) => ({
      sequence: r.sequence,
      type: r.type,
      timestamp: r.timestamp,
      stepIndex: r.step_index ?? undefined,
      toolName: r.tool_name ?? undefined,
      payload: safeJsonParse(r.payload),
    }));
  }

  /** Get cumulative token usage and cost from token_usage events. */
  getTokenStats(sessionId?: string): {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    totalEstimatedCost: number;
    turnCount: number;
  } {
    if (!this.db) {
      return { totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0, totalEstimatedCost: 0, turnCount: 0 };
    }

    const clause = sessionId ? 'AND session_id = ?' : '';
    const params = sessionId ? [sessionId] : [];

    const rows = this.db
      .prepare(`SELECT payload FROM events WHERE type = 'token_usage' ${clause} ORDER BY sequence ASC`)
      .all(...params) as Array<{ payload: string }>;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalEstimatedCost = 0;

    for (const row of rows) {
      const payload = safeJsonParse<Record<string, unknown>>(row.payload, {});
      totalInputTokens += (payload.inputTokens as number) ?? 0;
      totalOutputTokens += (payload.outputTokens as number) ?? 0;
      totalEstimatedCost += (payload.estimatedCost as number) ?? 0;
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      totalEstimatedCost: Math.round(totalEstimatedCost * 10000) / 10000,
      turnCount: rows.length,
    };
  }

  /** Get aggregated statistics for sessions within the given number of days. */
  getAggregateStats(days = 30): {
    totalSessions: number;
    completedSessions: number;
    failedSessions: number;
    successRate: number;
    avgSteps: number;
    avgToolCalls: number;
    totalToolCalls: number;
    topModels: Array<{ model: string; count: number }>;
    topFailureModes: Array<{ state: string; count: number }>;
  } {
    if (!this.db) {
      return {
        totalSessions: 0,
        completedSessions: 0,
        failedSessions: 0,
        successRate: 0,
        avgSteps: 0,
        avgToolCalls: 0,
        totalToolCalls: 0,
        topModels: [],
        topFailureModes: [],
      };
    }

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const countRow = this.db.prepare('SELECT COUNT(*) as total FROM sessions WHERE created_at >= ?').get(since) as
      | { total: number }
      | undefined;
    const totalSessions = countRow?.total ?? 0;

    const completedRow = this.db
      .prepare("SELECT COUNT(*) as count FROM sessions WHERE created_at >= ? AND terminal_state = 'completed'")
      .get(since) as { count: number } | undefined;
    const completedSessions = completedRow?.count ?? 0;

    const failedRow = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM sessions WHERE created_at >= ? AND terminal_state IS NOT NULL AND terminal_state != 'completed'",
      )
      .get(since) as { count: number } | undefined;
    const failedSessions = failedRow?.count ?? 0;

    const avgRow = this.db
      .prepare(
        'SELECT AVG(steps) as avgSteps, AVG(tool_calls) as avgToolCalls, SUM(tool_calls) as totalToolCalls FROM sessions WHERE created_at >= ?',
      )
      .get(since) as
      | { avgSteps: number | null; avgToolCalls: number | null; totalToolCalls: number | null }
      | undefined;

    const topModels = this.db
      .prepare(
        'SELECT model, COUNT(*) as count FROM sessions WHERE created_at >= ? GROUP BY model ORDER BY count DESC LIMIT 5',
      )
      .all(since) as Array<{ model: string; count: number }>;

    const topFailureModes = this.db
      .prepare(
        "SELECT terminal_state as state, COUNT(*) as count FROM sessions WHERE created_at >= ? AND terminal_state IS NOT NULL AND terminal_state != 'completed' GROUP BY terminal_state ORDER BY count DESC LIMIT 5",
      )
      .all(since) as Array<{ state: string; count: number }>;

    return {
      totalSessions,
      completedSessions,
      failedSessions,
      successRate: totalSessions > 0 ? Math.round((completedSessions / totalSessions) * 100) : 0,
      avgSteps: avgRow?.avgSteps ? Math.round(avgRow.avgSteps * 10) / 10 : 0,
      avgToolCalls: avgRow?.avgToolCalls ? Math.round(avgRow.avgToolCalls * 10) / 10 : 0,
      totalToolCalls: avgRow?.totalToolCalls ?? 0,
      topModels,
      topFailureModes,
    };
  }

  /** Close the database connection. */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/** Safely parse a JSON string, returning a default on failure. */
function safeJsonParse<T>(json: string, fallback?: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return (fallback ?? ([] as unknown)) as T;
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
