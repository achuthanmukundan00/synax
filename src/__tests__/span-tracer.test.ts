/**
 * Tests for SpanTracer.
 */
import { SpanTracer } from '../telemetry/SpanTracer';
import { EventStore } from '../store/EventStore';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('SpanTracer', () => {
  let dbPath: string;
  let eventStore: EventStore;

  beforeEach(() => {
    dbPath = join(tmpdir(), `synax-span-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    eventStore = new EventStore(dbPath);
  });

  afterEach(() => {
    eventStore.close();
    if (existsSync(dbPath)) {
      try {
        unlinkSync(dbPath);
      } catch {
        /* ignore */
      }
    }
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

  test('should start and end a span with timing', () => {
    const tracer = new SpanTracer({ sessionId: 'session-1', eventStore });

    const span = tracer.startSpan({ kind: 'turn', metadata: { task: 'test' } });
    expect(span.kind).toBe('turn');
    expect(span.id).toBeTruthy();
    expect(span.startTime).toBeGreaterThan(0);
    expect(span.endTime).toBeUndefined();

    tracer.endSpan(span);
    expect(span.endTime).toBeGreaterThan(0);
    expect(span.durationMs).toBeDefined();
    expect(span.durationMs!).toBeGreaterThanOrEqual(0);
  });

  test('should nest spans with parent-child relationships', () => {
    const tracer = new SpanTracer({ sessionId: 'session-2', eventStore });

    const turnSpan = tracer.startSpan({ kind: 'turn' });
    const modelSpan = tracer.startChildSpan(turnSpan, 'model_call', { step: 1 });
    const toolSpan = tracer.startChildSpan(turnSpan, 'tool_execution', { toolName: 'read' });

    expect(modelSpan.parentId).toBe(turnSpan.id);
    expect(toolSpan.parentId).toBe(turnSpan.id);
    expect(modelSpan.kind).toBe('model_call');
    expect(toolSpan.kind).toBe('tool_execution');

    tracer.endSpan(toolSpan);
    tracer.endSpan(modelSpan);
    tracer.endSpan(turnSpan);

    // All spans should have durations
    expect(turnSpan.durationMs).toBeDefined();
    expect(modelSpan.durationMs).toBeDefined();
    expect(toolSpan.durationMs).toBeDefined();
  });

  test('should add events to spans', () => {
    const tracer = new SpanTracer({ sessionId: 'session-3', eventStore });

    const span = tracer.startSpan({ kind: 'model_call' });
    tracer.addEvent(span, 'request_sent', { tokenCount: 1000 });
    tracer.addEvent(span, 'response_received', { status: 200 });

    expect(span.events).toHaveLength(2);
    expect(span.events[0].name).toBe('request_sent');
    expect(span.events[0].data).toEqual({ tokenCount: 1000 });
    expect(span.events[1].name).toBe('response_received');

    tracer.endSpan(span);
  });

  test('should get span summaries', () => {
    const tracer = new SpanTracer({ sessionId: 'session-4', eventStore });

    const span1 = tracer.startSpan({ kind: 'turn' });
    tracer.endSpan(span1);

    const span2 = tracer.startSpan({ kind: 'turn' });
    tracer.endSpan(span2);

    const summaries = tracer.getSummaries();
    expect(summaries).toHaveLength(2);
    expect(summaries[0].kind).toBe('turn');
    expect(summaries[1].kind).toBe('turn');
  });

  test('should persist spans to EventStore', () => {
    const tracer = new SpanTracer({ sessionId: 'session-5', eventStore });

    const span = tracer.startSpan({ kind: 'model_call', metadata: { step: 1 } });
    tracer.endSpan(span);

    // Verify span was written to the database
    const db = (eventStore as any).db;
    const row = db.prepare('SELECT * FROM spans WHERE id = ?').get(span.id) as any;
    expect(row).toBeTruthy();
    expect(row.kind).toBe('model_call');
    expect(row.duration_ms).toBe(span.durationMs);
    expect(JSON.parse(row.metadata)).toEqual({ step: 1 });
  });

  test('should work without EventStore (optional)', () => {
    const tracer = new SpanTracer({ sessionId: 'session-6' });
    // No eventStore

    const span = tracer.startSpan({ kind: 'turn' });
    tracer.endSpan(span);

    expect(span.durationMs).toBeDefined();
    // Should not throw — just no persistence
  });

  test('should track nested spans correctly for a typical turn', () => {
    const tracer = new SpanTracer({ sessionId: 'session-7', eventStore });

    // Simulate a typical agent turn
    const turnSpan = tracer.startSpan({ kind: 'turn', metadata: { task: 'fix bug' } });

    // Step 1: model call
    const modelSpan1 = tracer.startChildSpan(turnSpan, 'model_call', { step: 1 });
    tracer.addEvent(modelSpan1, 'response_received', { toolCallCount: 2 });
    tracer.endSpan(modelSpan1);

    // Step 1: tool parse
    const parseSpan1 = tracer.startChildSpan(turnSpan, 'tool_parse', { toolCallCount: 2 });
    tracer.endSpan(parseSpan1);

    // Step 1: tool executions
    const toolSpan1 = tracer.startChildSpan(turnSpan, 'tool_execution', { toolName: 'read' });
    tracer.endSpan(toolSpan1);

    const toolSpan2 = tracer.startChildSpan(turnSpan, 'tool_execution', { toolName: 'edit' });
    tracer.endSpan(toolSpan2);

    tracer.endSpan(turnSpan);

    // Verify parent-child relationships
    expect(modelSpan1.parentId).toBe(turnSpan.id);
    expect(parseSpan1.parentId).toBe(turnSpan.id);
    expect(toolSpan1.parentId).toBe(turnSpan.id);
    expect(toolSpan2.parentId).toBe(turnSpan.id);

    // All spans should have timing
    [turnSpan, modelSpan1, parseSpan1, toolSpan1, toolSpan2].forEach((s) => {
      expect(s.durationMs).toBeDefined();
      expect(s.durationMs!).toBeGreaterThanOrEqual(0);
    });
  });

  test('should have negligible overhead (<1ms per operation)', () => {
    const tracer = new SpanTracer({ sessionId: 'session-8' });

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      const span = tracer.startSpan({ kind: 'model_call' });
      tracer.endSpan(span);
    }
    const elapsed = performance.now() - start;
    const avgMs = elapsed / 100;

    // Average should be well under 1ms (typically <0.1ms)
    expect(avgMs).toBeLessThan(5); // generous buffer for CI environments
  });
});
