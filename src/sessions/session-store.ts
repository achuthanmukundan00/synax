/**
 * Session persistence for Synax.
 *
 * Sessions are stored as lightweight metadata in a JSON index plus
 * append-only event logs. The resume picker reads only metadata,
 * not full transcripts.
 *
 * Storage layout:
 *   ~/.local/share/synax/sessions/
 *     index.json          — session metadata index
 *     sessions/
 *       <YYYY>/
 *         <MM>/
 *           <session-id>.jsonl   — append-only event log
 */
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';

// ─── Types ──────────────────────────────────────────────────

export type SessionStatus = 'active' | 'completed' | 'failed' | 'cancelled';

export interface SessionMetadata {
  id: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  workspacePath?: string;
  repoRoot?: string;
  branch?: string;
  title?: string;
  summary?: string;
  activeProvider?: string;
  activeModel?: string;
  messageCount: number;
  eventCount: number;
  status: SessionStatus;
}

export interface SessionEvent {
  type: 'user_message' | 'assistant_message' | 'tool_call' | 'tool_result' | 'state_snapshot' | 'summary';
  at: string; // ISO 8601
  content?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  snapshot?: unknown;
}

export interface SessionIndex {
  version: 1;
  sessions: SessionMetadata[];
}

// ─── Paths ──────────────────────────────────────────────────

function sessionsDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return join(home, '.local', 'share', 'synax', 'sessions');
}

function indexPath(): string {
  return join(sessionsDir(), 'index.json');
}

// ─── Index operations ───────────────────────────────────────

export function loadSessionIndex(): SessionIndex {
  const path = indexPath();
  if (!existsSync(path)) {
    return { version: 1, sessions: [] };
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.version === 1 && Array.isArray(parsed.sessions)) {
      return parsed as SessionIndex;
    }
  } catch {
    // Corrupt index — start fresh
  }
  return { version: 1, sessions: [] };
}

export function saveSessionIndex(index: SessionIndex): void {
  const path = indexPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(index, null, 2), 'utf-8');
}

export function findSessionMeta(id: string): SessionMetadata | undefined {
  const index = loadSessionIndex();
  return index.sessions.find((s) => s.id === id);
}

export function upsertSessionMeta(meta: SessionMetadata): void {
  const index = loadSessionIndex();
  const existing = index.sessions.findIndex((s) => s.id === meta.id);
  if (existing >= 0) {
    index.sessions[existing] = meta;
  } else {
    index.sessions.push(meta);
  }
  // Keep most recent 200 sessions
  if (index.sessions.length > 200) {
    index.sessions = index.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 200);
  }
  saveSessionIndex(index);
}

// ─── Session creation ───────────────────────────────────────

export function createSession(meta: Partial<SessionMetadata> & { id: string }): SessionMetadata {
  const now = new Date().toISOString();
  const session: SessionMetadata = {
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    eventCount: 0,
    status: 'active',
    ...meta,
  };

  // Ensure event directory exists
  const eventsFile = sessionEventsPath(session.id);
  mkdirSync(dirname(eventsFile), { recursive: true });

  // Write initial empty event log
  if (!existsSync(eventsFile)) {
    writeFileSync(eventsFile, '', 'utf-8');
  }

  upsertSessionMeta(session);
  return session;
}

// ─── Event logging ──────────────────────────────────────────

export function appendSessionEvent(sessionId: string, event: SessionEvent): void {
  const session = findSessionMeta(sessionId);
  if (!session) return;

  const eventsFile = sessionEventsPath(sessionId);
  const line = JSON.stringify(event) + '\n';

  try {
    appendFileSync(eventsFile, line, 'utf-8');
    session.eventCount += 1;
    session.updatedAt = event.at;

    if (event.type === 'user_message') session.messageCount += 1;

    upsertSessionMeta(session);
  } catch {
    // Best-effort
  }
}

// ─── Session events path ────────────────────────────────────

function sessionEventsPath(sessionId: string): string {
  // Extract timestamp from session ID (format: YYYYMMDDHHmmssSSS)
  const year = sessionId.slice(0, 4) || new Date().getFullYear().toString();
  const month = sessionId.slice(4, 6) || '01';
  return join(sessionsDir(), 'sessions', year, month, `${sessionId}.jsonl`);
}

// ─── Event reading ──────────────────────────────────────────

export function readSessionEvents(sessionId: string): SessionEvent[] {
  const eventsFile = sessionEventsPath(sessionId);
  if (!existsSync(eventsFile)) return [];

  try {
    const raw = readFileSync(eventsFile, 'utf-8');
    const events: SessionEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // Skip corrupt lines
      }
    }
    return events;
  } catch {
    return [];
  }
}

export function readSessionEventsStream(
  sessionId: string,
  onEvent: (event: SessionEvent) => void,
  maxEvents = 500,
): void {
  const eventsFile = sessionEventsPath(sessionId);
  if (!existsSync(eventsFile)) return;

  try {
    const raw = readFileSync(eventsFile, 'utf-8');
    let count = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      if (count >= maxEvents) break;
      try {
        onEvent(JSON.parse(line));
        count += 1;
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
}

// ─── Resume metadata generation ─────────────────────────────

export function generateSessionTitle(events: SessionEvent[]): string {
  for (const event of events) {
    if (event.type === 'user_message' && event.content) {
      const firstLine = event.content.split('\n')[0].trim();
      if (firstLine.length > 80) return firstLine.slice(0, 77) + '...';
      return firstLine;
    }
  }
  return 'Empty session';
}

export function generateSessionSummary(events: SessionEvent[], maxLength = 120): string {
  const messages = events.filter((e) => e.type === 'user_message' || e.type === 'assistant_message');
  if (messages.length === 0) return 'No messages';
  const last = messages[messages.length - 1];
  const content = last.content ?? '';
  const firstLine = content.split('\n')[0].trim();
  if (firstLine.length <= maxLength) return firstLine;
  return firstLine.slice(0, maxLength - 3) + '...';
}

// ─── Session listing (for resume picker) ────────────────────

export function listSessionsSorted(sortBy: 'updated' | 'created' = 'updated'): SessionMetadata[] {
  const index = loadSessionIndex();
  return [...index.sessions].sort((a, b) => {
    if (sortBy === 'created') {
      return b.createdAt.localeCompare(a.createdAt);
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function filterSessions(query: string, sessions: SessionMetadata[]): SessionMetadata[] {
  if (!query.trim()) return sessions;
  const lower = query.toLowerCase();
  return sessions.filter(
    (s) =>
      s.title?.toLowerCase().includes(lower) ||
      s.summary?.toLowerCase().includes(lower) ||
      s.branch?.toLowerCase().includes(lower) ||
      s.activeModel?.toLowerCase().includes(lower) ||
      s.id.toLowerCase().includes(lower),
  );
}

// ─── Session ID generation ──────────────────────────────────

export function generateSessionId(): string {
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  const dd = now.getDate().toString().padStart(2, '0');
  const hh = now.getHours().toString().padStart(2, '0');
  const min = now.getMinutes().toString().padStart(2, '0');
  const ss = now.getSeconds().toString().padStart(2, '0');
  const ms = now.getMilliseconds().toString().padStart(3, '0');
  const pid = process.pid.toString(36);
  const rand = randomBytes(4).toString('hex');
  return `${yyyy}${mm}${dd}${hh}${min}${ss}${ms}-${pid}-${rand}`;
}

// ─── Cleanup ────────────────────────────────────────────────

export function pruneOldSessions(maxSessions = 200): void {
  const index = loadSessionIndex();
  if (index.sessions.length <= maxSessions) return;

  index.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const toRemove = index.sessions.slice(maxSessions);
  index.sessions = index.sessions.slice(0, maxSessions);
  saveSessionIndex(index);

  // Best-effort: remove old event files
  for (const session of toRemove) {
    try {
      const path = sessionEventsPath(session.id);
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // ignore
    }
  }
}
