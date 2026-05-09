/**
 * Tests for the typed EventBus: lifecycle events, control hooks,
 * emission ordering, and backward compatibility.
 */

import { EventBus } from '../events/EventBus';
import type { AgentEvent } from '../agent/events';
import type { PreToolUseEvent } from '../events/types';
import { Session } from '../session/Session';
import type { AgentClient } from '../session/Session';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const TMP = join(process.cwd(), 'tmp', 'synax-eventbus-tests');

function resetTmp(): void {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

function fakeClient(
  responses: Array<{
    content?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    toolCallFormat?: 'openai' | 'content_xml';
  }>,
): AgentClient & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    async chat(options) {
      requests.push(JSON.parse(JSON.stringify(options)));
      const next = responses.shift() ?? { content: 'done', toolCalls: [] };
      return {
        content: next.content ?? '',
        model: 'fake',
        finishReason: 'stop',
        toolCalls: next.toolCalls ?? [],
        toolCallFormat: next.toolCallFormat,
        usage: null,
      };
    },
  };
}

/** Flush pending microtasks so async event handlers settle. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('EventBus', () => {
  describe('lifecycle events', () => {
    it('emits events to typed subscribers', async () => {
      const bus = new EventBus();
      const events: AgentEvent[] = [];

      bus.on('model_step_started', (e) => {
        events.push(e as unknown as AgentEvent);
      });
      bus.on('tool_started', (e) => {
        events.push(e as unknown as AgentEvent);
      });

      await bus.emit({ type: 'model_step_started', timestamp: '2026-01-01T00:00:00Z', stepIndex: 1 });
      await bus.emit({
        type: 'tool_started',
        timestamp: '2026-01-01T00:00:01Z',
        stepIndex: 1,
        toolCallId: 'c1',
        toolName: 'read',
        summary: 'read a.txt',
      });

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('model_step_started');
      expect(events[1].type).toBe('tool_started');
    });

    it('supports wildcard subscribers (onAny)', async () => {
      const bus = new EventBus();
      const events: Array<{ type: string }> = [];

      bus.onAny((e) => {
        events.push({ type: e.type });
      });

      await bus.emit({ type: 'turn_start', timestamp: '2026-01-01T00:00:00Z', stepIndex: 1 });
      await bus.emit({
        type: 'turn_end',
        timestamp: '2026-01-01T00:00:00Z',
        stepIndex: 1,
        terminalState: 'completed',
        toolCalls: 0,
        steps: 1,
      });
      await bus.emit({
        type: 'session_shutdown',
        timestamp: '2026-01-01T00:00:00Z',
        terminalState: 'completed',
      });

      expect(events).toHaveLength(3);
      expect(events.map((e) => e.type)).toEqual(['turn_start', 'turn_end', 'session_shutdown']);
    });

    it('returns an unsubscribe function from on()', async () => {
      const bus = new EventBus();
      const events: unknown[] = [];

      const unsub = bus.on('model_step_started', (e) => {
        events.push(e);
      });
      await bus.emit({ type: 'model_step_started', timestamp: '2026-01-01T00:00:00Z', stepIndex: 1 });
      expect(events).toHaveLength(1);

      unsub();
      await bus.emit({ type: 'model_step_started', timestamp: '2026-01-01T00:00:01Z', stepIndex: 2 });
      expect(events).toHaveLength(1); // no new event
    });

    it('handles multiple subscribers for the same event type', async () => {
      const bus = new EventBus();
      const calls: string[] = [];

      bus.on('tool_execution_end', () => {
        calls.push('handler1');
      });
      bus.on('tool_execution_end', () => {
        calls.push('handler2');
      });
      bus.on('tool_execution_end', () => {
        calls.push('handler3');
      });

      await bus.emit({
        type: 'tool_execution_end',
        timestamp: '2026-01-01T00:00:00Z',
        stepIndex: 1,
        toolCallId: 'c1',
        toolName: 'read',
        success: true,
      });

      expect(calls).toHaveLength(3);
    });

    it('survives handler errors without crashing the bus', async () => {
      const bus = new EventBus();
      const calls: string[] = [];

      bus.on('model_step_started', () => {
        throw new Error('handler error');
      });
      bus.on('model_step_started', () => {
        calls.push('ok');
      });

      // Should not throw
      await bus.emit({ type: 'model_step_started', timestamp: '2026-01-01T00:00:00Z', stepIndex: 1 });

      expect(calls).toEqual(['ok']);
    });
  });

  describe('control hooks', () => {
    it('allows tool execution when no control handlers are registered', async () => {
      const bus = new EventBus();

      const decision = await bus.emitControl({
        type: 'pre_tool_use',
        timestamp: '2026-01-01T00:00:00Z',
        stepIndex: 1,
        toolCallId: 'c1',
        toolName: 'bash',
        arguments: { command: 'echo hello' },
      });

      expect(decision).toEqual({ allow: true });
    });

    it('blocks tool execution when a control handler returns allow: false', async () => {
      const bus = new EventBus();

      bus.onControl('pre_tool_use', (event: PreToolUseEvent) => {
        if (event.toolName === 'bash') {
          return { allow: false, reason: 'bash is disabled' };
        }
        return { allow: true };
      });

      const decision = await bus.emitControl({
        type: 'pre_tool_use',
        timestamp: '2026-01-01T00:00:00Z',
        stepIndex: 1,
        toolCallId: 'c1',
        toolName: 'bash',
        arguments: { command: 'rm -rf /' },
      });

      expect(decision).toEqual({ allow: false, reason: 'bash is disabled' });
    });

    it('allows tool execution when the control handler returns allow: true', async () => {
      const bus = new EventBus();

      bus.onControl('pre_tool_use', (event: PreToolUseEvent) => {
        const args = event.arguments as Record<string, unknown>;
        if (event.toolName === 'bash' && typeof args.command === 'string' && args.command.includes('rm')) {
          return { allow: false, reason: 'dangerous' };
        }
        return { allow: true };
      });

      const decision = await bus.emitControl({
        type: 'pre_tool_use',
        timestamp: '2026-01-01T00:00:00Z',
        stepIndex: 1,
        toolCallId: 'c1',
        toolName: 'read',
        arguments: { path: 'a.txt' },
      });

      expect(decision).toEqual({ allow: true });
    });

    it('short-circuits on first blocking handler', async () => {
      const bus = new EventBus();
      const calls: string[] = [];

      bus.onControl('pre_tool_use', () => {
        calls.push('first');
        return { allow: false, reason: 'blocked by first' };
      });
      bus.onControl('pre_tool_use', () => {
        calls.push('second');
        return { allow: true };
      });

      const decision = await bus.emitControl({
        type: 'pre_tool_use',
        timestamp: '2026-01-01T00:00:00Z',
        stepIndex: 1,
        toolCallId: 'c1',
        toolName: 'bash',
        arguments: {},
      });

      expect(decision).toEqual({ allow: false, reason: 'blocked by first' });
      expect(calls).toEqual(['first']); // second never called
    });

    it('returns an unsubscribe function from onControl()', async () => {
      const bus = new EventBus();

      const unsub = bus.onControl('pre_tool_use', () => ({ allow: false, reason: 'blocked' }));
      let decision = await bus.emitControl({
        type: 'pre_tool_use',
        timestamp: '2026-01-01T00:00:00Z',
        stepIndex: 1,
        toolCallId: 'c1',
        toolName: 'bash',
        arguments: {},
      });
      expect(decision).toEqual({ allow: false, reason: 'blocked' });

      unsub();
      decision = await bus.emitControl({
        type: 'pre_tool_use',
        timestamp: '2026-01-01T00:00:00Z',
        stepIndex: 1,
        toolCallId: 'c2',
        toolName: 'bash',
        arguments: {},
      });
      expect(decision).toEqual({ allow: true }); // default after unsub
    });
  });

  describe('destroy', () => {
    it('clears all handlers', async () => {
      const bus = new EventBus();
      const events: unknown[] = [];

      bus.on('model_step_started', (e) => {
        events.push(e);
      });
      bus.onControl('pre_tool_use', () => ({ allow: false, reason: 'block' }));

      bus.destroy();

      await bus.emit({ type: 'model_step_started', timestamp: '2026-01-01T00:00:00Z', stepIndex: 1 });
      const decision = await bus.emitControl({
        type: 'pre_tool_use',
        timestamp: '2026-01-01T00:00:00Z',
        stepIndex: 1,
        toolCallId: 'c1',
        toolName: 'bash',
        arguments: {},
      });

      expect(events).toHaveLength(0);
      expect(decision).toEqual({ allow: true });
    });
  });
});

describe('EventBus integration with Session', () => {
  beforeEach(() => resetTmp());
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it('emits turn_start and turn_end lifecycle events through the bus', async () => {
    const busEvents: Array<{ type: string }> = [];
    const client = fakeClient([{ content: 'done' }]);

    const session = new Session({ repoRoot: TMP, client });
    session.eventBus.onAny((e) => {
      busEvents.push({ type: e.type });
    });

    await session.startTurn('hello');
    await flushMicrotasks();

    const types = busEvents.map((e) => e.type);
    expect(types).toContain('turn_start');
    expect(types).toContain('session_start');
    expect(types).toContain('turn_end');
  });

  it('emits tool_execution_start and tool_execution_end lifecycle events', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello\n', 'utf-8');
    const busEvents: Array<{ type: string; toolName?: string }> = [];

    const client = fakeClient([
      { toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.txt' } }] },
      { content: 'done' },
    ]);

    const session = new Session({ repoRoot: TMP, client, mode: 'read-only' });
    session.eventBus.onAny((e) => {
      const rec = e as unknown as Record<string, unknown>;
      busEvents.push({ type: e.type, toolName: rec.toolName as string | undefined });
    });

    await session.startTurn('read the file');
    await flushMicrotasks();

    const types = busEvents.map((e) => e.type);
    expect(types).toContain('tool_execution_start');
    expect(types).toContain('tool_execution_end');
  });

  it('blocks tool execution via pre_tool_use control hook', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello\n', 'utf-8');
    const busEvents: Array<{ type: string; error?: string }> = [];

    const client = fakeClient([
      { toolCalls: [{ id: 'c1', name: 'bash', arguments: { command: 'echo hello' } }] },
      { content: 'done' },
    ]);

    const session = new Session({ repoRoot: TMP, client });

    // Register a control hook that blocks all bash commands
    session.eventBus.onControl('pre_tool_use', (event) => {
      if (event.toolName === 'bash') {
        return { allow: false, reason: 'bash blocked in test' };
      }
      return { allow: true };
    });

    session.eventBus.onAny((e) => {
      const rec = e as unknown as Record<string, unknown>;
      busEvents.push({ type: e.type, error: rec.error as string | undefined });
    });

    const result = await session.startTurn('run a command');
    await flushMicrotasks();

    // The bash tool should be blocked, so the agent completes without executing it
    expect(result.terminalState).toBe('completed');
    // tool_execution_end should show the block
    const blockedEnd = busEvents.find((e) => e.type === 'tool_execution_end' && e.error !== undefined);
    expect(blockedEnd).toBeDefined();
  });

  it('emits session_shutdown on shutdown()', async () => {
    const busEvents: Array<{ type: string }> = [];
    const client = fakeClient([{ content: 'done' }]);

    const session = new Session({ repoRoot: TMP, client });
    session.eventBus.onAny((e) => {
      busEvents.push({ type: e.type });
    });

    session.shutdown('completed');
    await flushMicrotasks();

    expect(busEvents.map((e) => e.type)).toContain('session_shutdown');
  });

  it('preserves legacy onEvent callback behavior (backward compat)', async () => {
    const legacyEvents: Array<{ type: string }> = [];
    const client = fakeClient([{ content: 'done' }]);

    const session = new Session({
      repoRoot: TMP,
      client,
      onEvent: (event) => {
        legacyEvents.push({ type: event.type });
      },
    });

    await session.startTurn('hello');

    // Legacy callback should still receive events synchronously
    expect(legacyEvents.length).toBeGreaterThan(0);
    expect(legacyEvents.map((e) => e.type)).toContain('model_step_started');
  });
});
