/**
 * Structured telemetry types for span tracing.
 *
 * Spans mirror agent phases: turn → model_call → tool_parse,
 * turn → tool_execution, turn → compaction.
 */

/** The kind of operation a span represents. */
export type SpanKind =
  | 'turn'
  | 'model_call'
  | 'tool_parse'
  | 'tool_execution'
  | 'compaction'
  | 'handoff'
  | 'verification';

/** A timestamped event within a span. */
export interface TimedEvent {
  name: string;
  timestamp: number;
  data?: unknown;
}

/** A tracing span with timing and metadata. */
export interface Span {
  id: string;
  parentId?: string;
  kind: SpanKind;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  metadata: Record<string, unknown>;
  events: TimedEvent[];
}

/** Options for starting a span. */
export interface StartSpanOptions {
  kind: SpanKind;
  parentId?: string;
  metadata?: Record<string, unknown>;
}

/** Summary of span timing for logging / dashboard use. */
export interface SpanSummary {
  id: string;
  parentId?: string;
  kind: SpanKind;
  durationMs: number;
  metadata: Record<string, unknown>;
  childSpans: SpanSummary[];
}
