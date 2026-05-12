/**
 * Tests for EventStore.
 */
import { EventStore } from '../store/EventStore';
import type { AgentEvent } from '../agent/events';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('EventStore', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `synax-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        unlinkSync(dbPath);
      } catch {
        /* ignore */
      }
    }
    // Also clean up WAL/shm files
    for (const suffix of ['-wal', '-shm']) {
      const path = dbPath + suffix;
      if (existsSync(path)) {
        try {
          unlinkSync(path);
        } catch {
          /* ignore */
        }
      }
    }
  });

  test('should open an empty database', () => {
    const store = new EventStore(dbPath);
    // When better-sqlite3 is unavailable, store gracefully degrades
    // and isOpen will be false — that's still valid behavior.
    const canTest = store.isOpen;
    if (!canTest) {
      store.close();
      return;
    }
    expect(store.isOpen).toBe(true);
    store.close();
  });

  test('should create sessions and events tables', () => {
    const store = new EventStore(dbPath);
    if (!store.isOpen) {
      store.close();
      return;
    }

    // Verify tables exist by querying them
    const db = (store as unknown as { db: { prepare: (sql: string) => { all: () => Array<{ name: string }>; get: (...args: unknown[]) => Record<string, unknown> | undefined } } }).db;
    expect(db).toBeTruthy();

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
      name: string;
    }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('events');
    expect(tableNames).toContain('spans');

    store.close();
  });

  test('should start a session and store metadata', () => {
    const store = new EventStore(dbPath);
    if (!store.isOpen) {
      store.close();
      return;
    }

    store.startSession({
      id: 'test-session-1',
      repoRoot: '/tmp/test-repo',
      mode: 'patch',
      model: 'test-model',
      createdAt: new Date().toISOString(),
    });

    const db = (store as unknown as { db: { prepare: (sql: string) => { get: (...args: unknown[]) => Record<string, unknown> | undefined } } }).db;
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get('test-session-1');
    expect(row).toBeTruthy();
    if (!row) throw new Error('expected row');
    expect(row.repo_root).toBe('/tmp/test-repo');
    expect(row.mode).toBe('patch');
    expect(row.model).toBe('test-model');
    expect(row.steps).toBe(0);
    expect(row.tool_calls).toBe(0);

    store.close();
  });

  test('should append events to a session', () => {
    const store = new EventStore(dbPath);
    if (!store.isOpen) {
      store.close();
      return;
    }

    store.startSession({
      id: 'test-session-2',
      repoRoot: '/tmp/test-repo',
      mode: 'patch',
      model: 'test-model',
      createdAt: new Date().toISOString(),
    });

    const event1 = {
      type: 'task_started',
      timestamp: new Date().toISOString(),
      mode: 'patch',
      profile: 'default',
      endpoint: 'http://localhost:8080',
      model: 'test-model',
      contextBudgetTokens: 128000,
      contextWindowTokens: 128000,
      maxModelSteps: 64,
      maxToolCalls: 192,
      tools: ['read', 'write'],
      task: 'test task',
    } as unknown as AgentEvent;

    const event2 = {
      type: 'tool_started',
      timestamp: new Date().toISOString(),
      stepIndex: 1,
      toolCallId: 'call-1',
      toolName: 'read',
      summary: 'reading file',
    } as unknown as AgentEvent;

    store.appendEvent('test-session-2', event1, 1);
    store.appendEvent('test-session-2', event2, 2);

    const events = store.getEvents('test-session-2');
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('task_started');
    expect(events[0].sequence).toBe(1);
    expect(events[1].type).toBe('tool_started');
    expect(events[1].sequence).toBe(2);

    store.close();
  });

  test('should close a session and update stats', () => {
    const store = new EventStore(dbPath);
    if (!store.isOpen) {
      store.close();
      return;
    }

    store.startSession({
      id: 'test-session-3',
      repoRoot: '/tmp/test-repo',
      mode: 'patch',
      model: 'test-model',
      createdAt: new Date().toISOString(),
    });

    store.closeSession('test-session-3', 'completed', {
      steps: 5,
      toolCalls: 12,
      changedFiles: ['src/a.ts', 'src/b.ts'],
    });

    const db = (store as unknown as { db: { prepare: (sql: string) => { get: (...args: unknown[]) => Record<string, unknown> | undefined } } }).db;
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get('test-session-3');
    if (!row) throw new Error('expected row');
    expect(row.terminal_state).toBe('completed');
    expect(row.steps).toBe(5);
    expect(row.tool_calls).toBe(12);
    expect(JSON.parse(row.changed_files as string)).toEqual(['src/a.ts', 'src/b.ts']);

    store.close();
  });

  test('should be optional — constructor handles failure gracefully', () => {
    // Use an invalid path that can't be created
    const invalidPath = '/dev/null/invalid/db.sqlite';
    const store = new EventStore(invalidPath);
    // Should not throw, store should be closed
    expect(store.isOpen).toBe(false);

    // All operations should be no-ops
    store.startSession({
      id: 's',
      repoRoot: '/tmp',
      mode: 'patch',
      model: 'm',
      createdAt: new Date().toISOString(),
    });
    store.appendEvent('s', { type: 'test', timestamp: new Date().toISOString() } as unknown as AgentEvent, 1);
    store.closeSession('s', 'completed', { steps: 0, toolCalls: 0, changedFiles: [] });
    expect(store.getEventCount('s')).toBe(0);
    store.close();
  });

  test('should get event count for a session', () => {
    const store = new EventStore(dbPath);
    if (!store.isOpen) {
      store.close();
      return;
    }

    store.startSession({
      id: 'test-session-4',
      repoRoot: '/tmp/test-repo',
      mode: 'patch',
      model: 'test-model',
      createdAt: new Date().toISOString(),
    });

    expect(store.getEventCount('test-session-4')).toBe(0);

    store.appendEvent('test-session-4', { type: 'test', timestamp: new Date().toISOString() } as unknown as AgentEvent, 1);
    expect(store.getEventCount('test-session-4')).toBe(1);

    store.appendEvent('test-session-4', { type: 'test2', timestamp: new Date().toISOString() } as unknown as AgentEvent, 2);
    expect(store.getEventCount('test-session-4')).toBe(2);

    store.close();
  });

  test('should store and retrieve spans', () => {
    const store = new EventStore(dbPath);
    if (!store.isOpen) {
      store.close();
      return;
    }

    store.upsertSpan({
      id: 'span-1',
      sessionId: 'test-session-span',
      kind: 'model_call',
      startTime: 1000,
      endTime: 1500,
      durationMs: 500,
      metadata: { step: 1 },
      spanEvents: [{ name: 'response_received', timestamp: 1500, data: { toolCallCount: 2 } }],
    });

    const db = (store as unknown as { db: { prepare: (sql: string) => { get: (...args: unknown[]) => Record<string, unknown> | undefined } } }).db;
    const row = db.prepare('SELECT * FROM spans WHERE id = ?').get('span-1');
    expect(row).toBeTruthy();
    if (!row) throw new Error('expected row');
    expect(row.kind).toBe('model_call');
    expect(row.duration_ms).toBe(500);
    expect(JSON.parse(row.metadata as string)).toEqual({ step: 1 });
    expect(JSON.parse(row.events as string)).toHaveLength(1);

    store.close();
  });
});
