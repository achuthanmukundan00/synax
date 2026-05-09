/**
 * SQLite schema for Synax event store.
 *
 * Tables:
 *   sessions — run metadata
 *   events   — append-only agent events
 *   spans    — telemetry span records
 */

export const SCHEMA_VERSION = 1;

export const CREATE_SESSIONS_TABLE = `
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
`;

export const CREATE_EVENTS_TABLE = `
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
`;

export const CREATE_EVENTS_SESSION_INDEX = `
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, sequence);
`;

export const CREATE_EVENTS_TYPE_INDEX = `
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
`;

export const CREATE_SPANS_TABLE = `
CREATE TABLE IF NOT EXISTS spans (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  duration_ms INTEGER,
  metadata TEXT DEFAULT '{}',
  events TEXT DEFAULT '[]'
);
`;

export const CREATE_SPANS_SESSION_INDEX = `
CREATE INDEX IF NOT EXISTS idx_spans_session ON spans(session_id);
`;

export const CREATE_SPANS_PARENT_INDEX = `
CREATE INDEX IF NOT EXISTS idx_spans_parent ON spans(parent_id);
`;

export const CREATE_SPANS_KIND_INDEX = `
CREATE INDEX IF NOT EXISTS idx_spans_kind ON spans(kind);
`;

/** All DDL statements in order for a fresh database. */
export const ALL_DDL = [
  CREATE_SESSIONS_TABLE,
  CREATE_EVENTS_TABLE,
  CREATE_EVENTS_SESSION_INDEX,
  CREATE_EVENTS_TYPE_INDEX,
  CREATE_SPANS_TABLE,
  CREATE_SPANS_SESSION_INDEX,
  CREATE_SPANS_PARENT_INDEX,
  CREATE_SPANS_KIND_INDEX,
];

/** Schema version pragma for migration tracking. */
export const SCHEMA_VERSION_PRAGMA = `PRAGMA user_version = ${SCHEMA_VERSION};`;

export interface SessionRecord {
  id: string;
  repoRoot: string;
  mode: string;
  model: string;
  createdAt: string;
  terminalState?: string;
  steps?: number;
  toolCalls?: number;
  changedFiles?: string[];
}

export interface EventRecord {
  sessionId: string;
  sequence: number;
  type: string;
  timestamp: string;
  stepIndex?: number;
  toolName?: string;
  payload: string;
}
