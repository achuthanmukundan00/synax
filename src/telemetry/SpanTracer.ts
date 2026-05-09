/**
 * SpanTracer — lightweight span-based telemetry for agent operations.
 *
 * Creates nested spans with timing data. Emits spans through an optional
 * EventStore for persistence. No external service dependencies.
 *
 * Usage:
 *   const tracer = new SpanTracer({ sessionId: '...', eventStore });
 *   const turn = tracer.startSpan({ kind: 'turn' });
 *   const modelCall = tracer.startSpan({ kind: 'model_call', parentId: turn.id });
 *   // ... do work ...
 *   tracer.endSpan(modelCall);
 *   tracer.endSpan(turn);
 */

import type { Span, SpanKind, SpanSummary, StartSpanOptions, TimedEvent } from './types';
import type { EventStore } from '../store/EventStore';

let idCounter = 0;

function nextId(prefix: string): string {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${Date.now()}-${idCounter}-${rand}`;
}

export interface SpanTracerOptions {
  sessionId: string;
  eventStore?: EventStore;
}

export class SpanTracer {
  private sessionId: string;
  private eventStore: EventStore | undefined;
  private activeSpans: Map<string, Span> = new Map();
  /** Ordered list of completed span summaries for the session. */
  private completedSummaries: SpanSummary[] = [];

  constructor(options: SpanTracerOptions) {
    this.sessionId = options.sessionId;
    this.eventStore = options.eventStore;
  }

  /** Start a new span. Returns the span object. */
  startSpan(options: StartSpanOptions): Span {
    const span: Span = {
      id: nextId(options.kind),
      parentId: options.parentId,
      kind: options.kind,
      startTime: performanceNow(),
      metadata: options.metadata ?? {},
      events: [],
    };
    this.activeSpans.set(span.id, span);
    return span;
  }

  /** End a span, computing duration and persisting. */
  endSpan(span: Span): Span {
    const endTime = performanceNow();
    span.endTime = endTime;
    span.durationMs = Math.round((endTime - span.startTime) * 100) / 100;

    this.activeSpans.delete(span.id);

    // Persist to event store
    if (this.eventStore?.isOpen) {
      this.eventStore.upsertSpan({
        id: span.id,
        sessionId: this.sessionId,
        parentId: span.parentId,
        kind: span.kind,
        startTime: Math.round(span.startTime),
        endTime: Math.round(endTime),
        durationMs: span.durationMs,
        metadata: span.metadata,
        spanEvents: span.events,
      });
    }

    // Track completed summary for in-memory access
    this.completedSummaries.push({
      id: span.id,
      parentId: span.parentId,
      kind: span.kind,
      durationMs: span.durationMs,
      metadata: span.metadata,
      childSpans: [],
    });

    return span;
  }

  /** Add a timestamped event to an active span. */
  addEvent(span: Span, name: string, data?: unknown): void {
    const event: TimedEvent = {
      name,
      timestamp: performanceNow(),
      data,
    };
    span.events.push(event);
  }

  /** Create a child span of the given parent. */
  startChildSpan(parent: Span, kind: SpanKind, metadata?: Record<string, unknown>): Span {
    return this.startSpan({ kind, parentId: parent.id, metadata });
  }

  /** Get all completed span summaries. */
  getSummaries(): SpanSummary[] {
    return [...this.completedSummaries];
  }

  /** Get a tree of span summaries rooted at the given span kind. */
  getSpanTree(rootKind?: SpanKind): SpanSummary[] {
    const summaries = this.getSummaries();
    if (!rootKind) {
      // Build full tree from root spans
      const rootSpans = summaries.filter((s) => !this.hasParent(summaries, s));
      return rootSpans.map((s) => this.buildTree(s, summaries));
    }
    const roots = summaries.filter((s) => s.kind === rootKind && !this.hasParent(summaries, s));
    return roots.map((s) => this.buildTree(s, summaries));
  }

  private hasParent(all: SpanSummary[], span: SpanSummary): boolean {
    return all.some((s) => span.id !== s.id && s.parentId !== undefined);
  }

  private buildTree(root: SpanSummary, all: SpanSummary[]): SpanSummary {
    const children = all.filter((s) => {
      return s.parentId === root.id;
    });
    return {
      ...root,
      childSpans: children.map((c) => this.buildTree(c, all)),
    };
  }

  /** Get total elapsed time across all spans (useful for overhead checks). */
  getTotalSpanTime(): number {
    return this.completedSummaries.reduce((sum, s) => sum + s.durationMs, 0);
  }
}

/** Thin wrapper around performance.now for compatibility. */
function performanceNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}
