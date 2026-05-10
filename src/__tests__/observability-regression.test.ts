/**
 * Regression tests for Lane 2 observability features.
 *
 * Covers public contracts only — no implementation details:
 * - EventStore query methods (getRecentSessions, getSessionTimeline, getAggregateStats)
 * - appendLogEvent contract (never throws, safe when closed)
 * - getTokenStats
 * - TokenCounter
 * - CostTracker with provider pricing
 * - token_usage event shape (via public EventStore API)
 * - inspect --metrics --json CLI output shape (smoke)
 *
 * These tests must pass before and after rebase onto Lane 1 changes.
 */

import { existsSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

import { EventStore } from '../store/EventStore';
import { TokenCounter } from '../metrics/TokenCounter';
import { CostTracker } from '../metrics/CostTracker';
import { resolvePricing, isLocalModel } from '../metrics/provider-pricing';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let testDbCounter = 0;

function tempDbPath(): string {
  testDbCounter += 1;
  return join(
    tmpdir(),
    `synax-obs-regression-${Date.now()}-${testDbCounter}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const path = dbPath + suffix;
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
    }
  }
}

function seedTestSessions(store: EventStore, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `session-${i}-${Date.now()}`;
    ids.push(id);
    const terminalState = i % 3 === 0 ? 'completed' : i % 3 === 1 ? 'blocked' : 'user_input_required';
    store.startSession({
      id,
      repoRoot: '/tmp/test-repo',
      mode: i % 2 === 0 ? 'patch' : 'read-only',
      model: i % 4 === 0 ? 'openai/gpt-4o-mini' : 'anthropic/claude-sonnet-4-20250514',
      createdAt: new Date(Date.now() - i * 60_000).toISOString(),
      steps: terminalState === 'completed' ? 2 : 0,
      toolCalls: terminalState === 'completed' ? 3 : 0,
      changedFiles: terminalState === 'completed' ? ['src/app.ts'] : [],
    });
    store.closeSession(id, terminalState, {
      steps: terminalState === 'completed' ? 2 : 0,
      toolCalls: terminalState === 'completed' ? 3 : 0,
      changedFiles: terminalState === 'completed' ? ['src/app.ts'] : [],
    });
  }
  return ids;
}

function seedTokenUsageEvents(
  store: EventStore,
  sessionId: string,
  turns: Array<{ input: number; output: number; cost: number }>,
): void {
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    store.appendEvent(
      sessionId,
      {
        type: 'token_usage',
        timestamp: new Date().toISOString(),
        stepIndex: i + 1,
        inputTokens: t.input,
        outputTokens: t.output,
        estimatedCost: t.cost,
      } as any,
      i + 1,
    );
  }
}

// ─── EventStore Query Methods ────────────────────────────────────────────────

describe('EventStore query methods', () => {
  let dbPath: string;
  let store: EventStore;

  beforeEach(() => {
    dbPath = tempDbPath();
    store = new EventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    cleanupDb(dbPath);
  });

  describe('getRecentSessions', () => {
    test('returns empty array when no sessions exist', () => {
      const sessions = store.getRecentSessions();
      expect(sessions).toEqual([]);
    });

    test('returns sessions ordered by created_at DESC', () => {
      if (!store.isOpen) return;
      seedTestSessions(store, 5);
      const sessions = store.getRecentSessions(3);
      expect(sessions).toHaveLength(3);
      for (let i = 1; i < sessions.length; i++) {
        expect(sessions[i - 1].createdAt >= sessions[i].createdAt).toBe(true);
      }
    });

    test('returns all fields expected by the dashboard contract', () => {
      if (!store.isOpen) return;
      seedTestSessions(store, 1);
      const sessions = store.getRecentSessions();
      expect(sessions).toHaveLength(1);
      const s = sessions[0];
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('repoRoot');
      expect(s).toHaveProperty('mode');
      expect(s).toHaveProperty('model');
      expect(s).toHaveProperty('createdAt');
      expect(s).toHaveProperty('terminalState');
      expect(s).toHaveProperty('steps');
      expect(s).toHaveProperty('toolCalls');
      expect(s).toHaveProperty('changedFiles');
      expect(Array.isArray(s.changedFiles)).toBe(true);
    });

    test('defaults to 20 sessions', () => {
      if (!store.isOpen) return;
      seedTestSessions(store, 25);
      const sessions = store.getRecentSessions();
      expect(sessions).toHaveLength(20);
    });

    test('respects custom limit', () => {
      if (!store.isOpen) return;
      seedTestSessions(store, 10);
      const sessions = store.getRecentSessions(5);
      expect(sessions).toHaveLength(5);
    });
  });

  describe('getSessionTimeline', () => {
    test('returns empty array for unknown session', () => {
      const events = store.getSessionTimeline('nonexistent');
      expect(events).toEqual([]);
    });

    test('returns events in sequence order', () => {
      if (!store.isOpen) return;
      const [sessionId] = seedTestSessions(store, 1);
      store.appendEvent(
        sessionId,
        {
          type: 'task_started',
          timestamp: new Date().toISOString(),
          task: 'test task',
          mode: 'patch',
          profile: 'default',
          endpoint: 'http://localhost',
          model: 'test',
          contextBudgetTokens: 1000,
          maxModelSteps: 10,
          maxToolCalls: 5,
          tools: ['read'],
        } as any,
        1,
      );

      store.appendEvent(
        sessionId,
        {
          type: 'task_finished',
          timestamp: new Date().toISOString(),
          status: 'completed',
          toolCalls: 0,
          maxToolCalls: 5,
          modelSteps: 1,
          maxModelSteps: 10,
          changedFiles: [],
          verification: 'skipped',
        } as any,
        2,
      );

      const events = store.getSessionTimeline(sessionId);
      expect(events).toHaveLength(2);
      expect(events[0].sequence).toBe(1);
      expect(events[1].sequence).toBe(2);
      expect(events[0].type).toBe('task_started');
      expect(events[1].type).toBe('task_finished');
    });

    test('includes payload as parsed object', () => {
      if (!store.isOpen) return;
      const [sessionId] = seedTestSessions(store, 1);
      store.appendEvent(
        sessionId,
        {
          type: 'task_started',
          timestamp: new Date().toISOString(),
          task: 'hello world',
          mode: 'patch',
          profile: 'default',
          endpoint: 'http://localhost',
          model: 'test',
          contextBudgetTokens: 1000,
          maxModelSteps: 10,
          maxToolCalls: 5,
          tools: ['read'],
        } as any,
        1,
      );

      const events = store.getSessionTimeline(sessionId);
      expect(events[0].payload).toBeDefined();
      expect(events[0].payload.task).toBe('hello world');
    });
  });

  describe('getAggregateStats', () => {
    test('returns zeroed stats when no sessions exist', () => {
      const stats = store.getAggregateStats();
      expect(stats.totalSessions).toBe(0);
      expect(stats.completedSessions).toBe(0);
      expect(stats.successRate).toBe(0);
    });

    test('computes success rate correctly', () => {
      if (!store.isOpen) return;
      seedTestSessions(store, 6);
      const stats = store.getAggregateStats();
      expect(stats.totalSessions).toBe(6);
      expect(stats.completedSessions).toBe(2);
      expect(stats.failedSessions).toBe(4);
      expect(stats.successRate).toBe(33);
    });

    test('includes model distribution', () => {
      if (!store.isOpen) return;
      seedTestSessions(store, 10);
      const stats = store.getAggregateStats();
      expect(stats.topModels.length).toBeGreaterThan(0);
      expect(stats.topModels[0]).toHaveProperty('model');
      expect(stats.topModels[0]).toHaveProperty('count');
    });

    test('includes failure modes', () => {
      if (!store.isOpen) return;
      seedTestSessions(store, 10);
      const stats = store.getAggregateStats();
      expect(stats.topFailureModes.length).toBeGreaterThan(0);
      expect(stats.topFailureModes[0]).toHaveProperty('state');
      expect(stats.topFailureModes[0]).toHaveProperty('count');
    });

    test('returns valid shape even when EventStore is empty', () => {
      const stats = store.getAggregateStats();
      expect(stats).toHaveProperty('totalSessions', 0);
      expect(stats).toHaveProperty('avgSteps', 0);
      expect(stats).toHaveProperty('topModels');
      expect(stats).toHaveProperty('topFailureModes');
    });
  });
});

// ─── Log Events Persistence ──────────────────────────────────────────────────

describe('appendLogEvent persistence', () => {
  let dbPath: string;
  let store: EventStore;

  beforeEach(() => {
    dbPath = tempDbPath();
    store = new EventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    cleanupDb(dbPath);
  });

  test('appendLogEvent does not throw on valid input (open store)', () => {
    expect(() => {
      store.appendLogEvent({
        level: 'info',
        message: 'test log message',
        timestamp: new Date().toISOString(),
        context: { sessionId: 'abc123' },
      });
    }).not.toThrow();
  });

  test('appendLogEvent does not throw with error field', () => {
    expect(() => {
      store.appendLogEvent({
        level: 'error',
        message: 'something broke',
        timestamp: new Date().toISOString(),
        error: 'stack trace here',
      });
    }).not.toThrow();
  });

  test('appendLogEvent does not throw when store is closed', () => {
    store.close();
    expect(() => {
      store.appendLogEvent({
        level: 'info',
        message: 'should be safe',
        timestamp: new Date().toISOString(),
      });
    }).not.toThrow();
  });

  test('available getter reflects store state', () => {
    if (!store.isOpen) {
      // When SQLite is unavailable, the store starts closed
      expect(store.available).toBe(false);
      return;
    }
    expect(store.available).toBe(true);
    store.close();
    expect(store.available).toBe(false);
  });

  test('logger-compatible interface is usable after store open', () => {
    if (!store.isOpen) return;
    // EventStore implements LoggerEventStore: requires appendLogEvent + available
    expect(store.available).toBe(true);
    expect(typeof store.appendLogEvent).toBe('function');
    store.appendLogEvent({
      level: 'warn',
      message: 'interface check',
      timestamp: new Date().toISOString(),
    });
  });
});

// ─── Token Stats ─────────────────────────────────────────────────────────────

describe('getTokenStats', () => {
  let dbPath: string;
  let store: EventStore;

  beforeEach(() => {
    dbPath = tempDbPath();
    store = new EventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    cleanupDb(dbPath);
  });

  test('returns zeroes when no token_usage events exist', () => {
    const stats = store.getTokenStats();
    expect(stats.totalInputTokens).toBe(0);
    expect(stats.totalOutputTokens).toBe(0);
    expect(stats.totalTokens).toBe(0);
    expect(stats.totalEstimatedCost).toBe(0);
    expect(stats.turnCount).toBe(0);
  });

  test('aggregates across all sessions', () => {
    if (!store.isOpen) return;
    const [s1] = seedTestSessions(store, 1);
    seedTokenUsageEvents(store, s1, [
      { input: 100, output: 50, cost: 0.001 },
      { input: 200, output: 75, cost: 0.002 },
    ]);

    const stats = store.getTokenStats();
    expect(stats.totalInputTokens).toBe(300);
    expect(stats.totalOutputTokens).toBe(125);
    expect(stats.totalTokens).toBe(425);
    expect(stats.totalEstimatedCost).toBe(0.003);
    expect(stats.turnCount).toBe(2);
  });

  test('filters by sessionId', () => {
    if (!store.isOpen) return;
    const [s1, s2] = seedTestSessions(store, 2);
    seedTokenUsageEvents(store, s1, [{ input: 100, output: 50, cost: 0.001 }]);
    seedTokenUsageEvents(store, s2, [{ input: 200, output: 100, cost: 0.003 }]);

    const stats1 = store.getTokenStats(s1);
    expect(stats1.totalInputTokens).toBe(100);
    expect(stats1.turnCount).toBe(1);

    const stats2 = store.getTokenStats(s2);
    expect(stats2.totalInputTokens).toBe(200);
    expect(stats2.turnCount).toBe(1);
  });

  test('rounds cost to 4 decimal places', () => {
    if (!store.isOpen) return;
    const [s1] = seedTestSessions(store, 1);
    seedTokenUsageEvents(store, s1, [{ input: 1000, output: 500, cost: 0.12345678 }]);

    const stats = store.getTokenStats();
    expect(stats.totalEstimatedCost).toBe(0.1235);
  });
});

// ─── TokenCounter ────────────────────────────────────────────────────────────

describe('TokenCounter', () => {
  test('countInput estimates tokens from messages', () => {
    const counter = new TokenCounter();
    const tokens = counter.countInput([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello, how are you?' },
    ]);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeGreaterThan(10);
  });

  test('countOutput estimates response tokens', () => {
    const counter = new TokenCounter();
    const tokens = counter.countOutput({
      content: 'I am doing well, thank you for asking!',
    });
    expect(tokens).toBeGreaterThan(0);
  });

  test('countOutput includes tool call arguments in estimate', () => {
    const counter = new TokenCounter();
    const tokens = counter.countOutput({
      content: 'Let me read that file.',
      toolCalls: [{ name: 'read', arguments: { path: 'src/index.ts', startLine: 1, endLine: 50 } }],
    });
    expect(tokens).toBeGreaterThan(15);
  });

  test('records cumulative stats correctly', () => {
    const counter = new TokenCounter();
    counter.recordTurn({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    counter.recordTurn({ inputTokens: 200, outputTokens: 75, totalTokens: 275 });

    const cum = counter.getCumulative();
    expect(cum.inputTokens).toBe(300);
    expect(cum.outputTokens).toBe(125);
    expect(cum.totalTokens).toBe(425);
  });

  test('getCumulative starts at zero for fresh counter', () => {
    const counter = new TokenCounter();
    const cum = counter.getCumulative();
    expect(cum.inputTokens).toBe(0);
    expect(cum.outputTokens).toBe(0);
    expect(cum.totalTokens).toBe(0);
  });
});

// ─── CostTracker + Provider Pricing ──────────────────────────────────────────

describe('CostTracker and provider pricing', () => {
  test('resolvePricing returns zero for local models', () => {
    const pricing = resolvePricing('qwen-32b');
    expect(pricing.inputPer1M).toBe(0);
    expect(pricing.outputPer1M).toBe(0);
  });

  test('resolvePricing matches by prefix', () => {
    const pricing = resolvePricing('openai/gpt-4o-2024-08-06');
    expect(pricing.inputPer1M).toBe(2.5);
    expect(pricing.outputPer1M).toBe(10.0);
  });

  test('resolvePricing matches exact model name', () => {
    const pricing = resolvePricing('deepseek/deepseek-chat');
    expect(pricing.inputPer1M).toBe(0.14);
    expect(pricing.outputPer1M).toBe(0.28);
  });

  test('isLocalModel returns true for free/local models', () => {
    expect(isLocalModel('qwen-32b')).toBe(true);
    expect(isLocalModel('llama-3-70b')).toBe(true);
  });

  test('isLocalModel returns false for paid API models', () => {
    expect(isLocalModel('openai/gpt-4o')).toBe(false);
    expect(isLocalModel('deepseek/deepseek-chat')).toBe(false);
  });

  test('CostTracker estimates turn cost proportionally', () => {
    const counter = new TokenCounter();
    const tracker = new CostTracker(counter, 'openai/gpt-4o-mini');
    const cost = tracker.estimateTurnCost({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 });
    expect(cost.inputCost).toBeGreaterThan(0);
    expect(cost.outputCost).toBeGreaterThan(0);
    // totalCost rounds to 4 decimal places; input+output sum may differ by rounding
    expect(cost.totalCost).toBeGreaterThan(0);
    expect(cost.totalCost).toBeLessThanOrEqual(cost.inputCost + cost.outputCost + 0.0001);
  });

  test('CostTracker accumulates cost across multiple turns', () => {
    const counter = new TokenCounter();
    const tracker = new CostTracker(counter, 'openai/gpt-4o-mini');
    tracker.recordTurn({ inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 });
    tracker.recordTurn({ inputTokens: 2_000_000, outputTokens: 1_000_000, totalTokens: 3_000_000 });

    const cum = tracker.getCumulativeCost();
    // gpt-4o-mini: 0.15 input, 0.60 output per 1M
    // Turn 1: 1 * 0.15 + 0.5 * 0.60 = 0.15 + 0.30 = 0.45
    // Turn 2: 2 * 0.15 + 1 * 0.60 = 0.30 + 0.60 = 0.90
    expect(cum).toBeCloseTo(1.35, 2);
  });

  test('CostTracker.isOverBudget returns false when under budget', () => {
    const counter = new TokenCounter();
    const tracker = new CostTracker(counter, 'openai/gpt-4o-mini');
    tracker.recordTurn({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 });
    expect(tracker.isOverBudget(5.0)).toBe(false);
  });

  test('CostTracker.isOverBudget returns true when cost exceeds budget', () => {
    const counter = new TokenCounter();
    const tracker = new CostTracker(counter, 'openai/gpt-4o-mini');
    tracker.recordTurn({ inputTokens: 100_000_000, outputTokens: 50_000_000, totalTokens: 150_000_000 });
    expect(tracker.isOverBudget(0.01)).toBe(true);
  });

  test('local models always report zero cost', () => {
    const counter = new TokenCounter();
    const tracker = new CostTracker(counter, 'qwen-32b');
    const cost = tracker.recordTurn({ inputTokens: 10000, outputTokens: 5000, totalTokens: 15000 });
    expect(cost.totalCost).toBe(0);
    expect(tracker.getCumulativeCost()).toBe(0);
  });

  test('cost accumulation is additive', () => {
    const counter = new TokenCounter();
    const tracker = new CostTracker(counter, 'openai/gpt-4o-mini');
    const c1 = tracker.recordTurn({ inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 });
    const c2 = tracker.recordTurn({ inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 });
    expect(tracker.getCumulativeCost()).toBeCloseTo(c1.totalCost + c2.totalCost, 10);
  });
});

// ─── Token Usage Event Shape ─────────────────────────────────────────────────

describe('token_usage event shape', () => {
  let dbPath: string;
  let store: EventStore;

  beforeEach(() => {
    dbPath = tempDbPath();
    store = new EventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    cleanupDb(dbPath);
  });

  test('token_usage event round-trips through EventStore with correct fields', () => {
    if (!store.isOpen) return;
    const [sessionId] = seedTestSessions(store, 1);
    const event: any = {
      type: 'token_usage',
      timestamp: new Date().toISOString(),
      stepIndex: 1,
      inputTokens: 500,
      outputTokens: 200,
      estimatedCost: 0.0005,
    };

    store.appendEvent(sessionId, event, 1);

    const events = store.getSessionTimeline(sessionId);
    expect(events).toHaveLength(1);
    const payload = events[0].payload;
    expect(payload.type).toBe('token_usage');
    expect(payload.inputTokens).toBe(500);
    expect(payload.outputTokens).toBe(200);
    expect(payload.estimatedCost).toBe(0.0005);
    expect(payload.stepIndex).toBe(1);
  });

  test('token_usage events are queryable via getTokenStats', () => {
    if (!store.isOpen) return;
    const [sessionId] = seedTestSessions(store, 1);
    seedTokenUsageEvents(store, sessionId, [
      { input: 300, output: 100, cost: 0.001 },
      { input: 700, output: 300, cost: 0.003 },
    ]);

    const stats = store.getTokenStats(sessionId);
    expect(stats.totalInputTokens).toBe(1000);
    expect(stats.totalOutputTokens).toBe(400);
    expect(stats.totalEstimatedCost).toBe(0.004);
    expect(stats.turnCount).toBe(2);
  });
});

// ─── CLI Smoke: inspect --metrics public contract ────────────────────────────

describe('inspect --metrics CLI contract', () => {
  const hasDist = (() => {
    try {
      execSync('node dist/cli.js --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  const runCli = (args: string): string => {
    return execSync(`node dist/cli.js ${args}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  };

  test('--metrics outputs valid JSON array or graceful unavailable message', () => {
    if (!hasDist) return;
    const output = runCli('inspect --metrics --json').trim();
    try {
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
    } catch {
      expect(output).toContain('not available');
    }
  });

  test('--metrics --stats --json outputs object with expected keys', () => {
    if (!hasDist) return;
    const output = runCli('inspect --metrics --stats --json').trim();
    try {
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty('totalSessions');
      expect(parsed).toHaveProperty('tokenStats');
    } catch {
      expect(output).toContain('not available');
    }
  });

  test('--metrics --session with unknown id returns graceful message', () => {
    if (!hasDist) return;
    const output = runCli('inspect --metrics --session nonexistent-id').trim();
    // Accept either: session not found (when store is available) or store unavailable
    expect(output.includes('No events found') || output.includes('not available')).toBe(true);
  });

  test('--budget flag is documented in run --help', () => {
    if (!hasDist) return;
    const output = runCli('run --help');
    expect(output).toContain('--budget');
  });

  test('inspect --help documents --metrics flag', () => {
    if (!hasDist) return;
    const output = runCli('inspect --help');
    expect(output).toContain('--metrics');
    expect(output).toContain('--session');
    expect(output).toContain('--stats');
  });
});
