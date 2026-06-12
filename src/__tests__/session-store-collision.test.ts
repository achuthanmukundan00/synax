/**
 * Test session ID collision detection in both EventStore and session-store.
 *
 * Ensures concurrent Synax processes cannot share the same session
 * and corrupt history.db or JSONL event logs.
 */
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';

import { EventStore } from '../store/EventStore';
import { createSession, findSessionMeta, generateSessionId } from '../sessions/session-store';

// ─── Helpers ─────────────────────────────────────────────────

function tempDbPath(): string {
  return join(tmpdir(), `synax-collision-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

const TMP_SESSIONS = join(tmpdir(), 'synax-collision-sessions-' + Date.now());
const originalHome = process.env.HOME;

function setupSessionHome(): void {
  const homeDir = join(TMP_SESSIONS, 'home');
  if (existsSync(TMP_SESSIONS)) {
    rmSync(TMP_SESSIONS, { recursive: true, force: true });
  }
  mkdirSync(homeDir, { recursive: true });
  const localShare = join(homeDir, '.local', 'share', 'synax', 'sessions');
  mkdirSync(localShare, { recursive: true });
  writeFileSync(join(localShare, '..', 'index.json'), JSON.stringify({ version: 1, sessions: [] }));
  process.env.HOME = homeDir;
}

function teardownSessionHome(): void {
  process.env.HOME = originalHome;
  if (existsSync(TMP_SESSIONS)) {
    rmSync(TMP_SESSIONS, { recursive: true, force: true });
  }
}

// ─── EventStore collision test ──────────────────────────────

describe('EventStore collision detection', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
  });
  afterEach(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      try {
        if (existsSync(p)) require('fs').unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  });

  test('throws Session ID collision error on duplicate session', () => {
    const store = new EventStore(dbPath);
    if (!store.isOpen) {
      store.close();
      return;
    }

    store.startSession({
      id: 'dup-session-1',
      repoRoot: '/tmp/test',
      mode: 'patch',
      model: 'test-model',
      createdAt: new Date().toISOString(),
    });

    expect(() =>
      store.startSession({
        id: 'dup-session-1',
        repoRoot: '/tmp/test-2',
        mode: 'ask',
        model: 'other',
        createdAt: new Date().toISOString(),
      }),
    ).toThrow(/Session ID collision/);

    store.close();
  });
});

// ─── Session-store (JSONL) collision test ────────────────────

describe('session-store collision detection', () => {
  beforeEach(() => setupSessionHome());
  afterEach(() => teardownSessionHome());

  test('throws Session ID collision error on duplicate createSession', () => {
    const id = generateSessionId();
    // First creation succeeds
    createSession({ id, branch: 'main' });
    expect(findSessionMeta(id)).toBeDefined();

    // Second creation with same ID must throw
    expect(() => createSession({ id, branch: 'other' })).toThrow(/Session ID collision/);
  });
});
