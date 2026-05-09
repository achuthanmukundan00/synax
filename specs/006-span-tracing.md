# Spec 006 — Structured telemetry events with span tracing

**Issue:** #06  
**Milestone:** M2 — Observability Foundation  
**Owner:** Harry  
**Estimate:** 0.5d (AI-assisted)  
**Priority:** p1 — enables debugging agent failures

## Context

Synax's current observability is `onActivity` callbacks emitting ad-hoc strings and `onEvent` callbacks emitting typed events. There's no span tracing, no timing data, no correlation between model calls and tool executions.

From the SOTA review: "Codex uses OpenTelemetry on every phase — debuggable failures." The insight is that every phase of an agent turn (model call, parse, tool dispatch, tool execution, result append) should be a span with timing.

This is Harry's domain. His industry experience is in "metrics, logging, observability, telemetry." This issue creates the telemetry instrumentation layer that feeds into the event store (#05) and the metrics dashboard (#07).

## Scope

**Creates:** `src/telemetry/SpanTracer.ts`, `src/telemetry/types.ts`  
**Modifies:** `src/session/Session.ts`, `src/events/EventBus.ts`  
**Does NOT:** implement OpenTelemetry SDK export, add external service dependencies

## Tasks

1. **Create `src/telemetry/types.ts`** — define span types mirroring agent phases:
   ```typescript
   type SpanKind = 'turn' | 'model_call' | 'tool_parse' | 'tool_execution' | 'compaction' | 'handoff';
   interface Span {
     id: string;
     parentId?: string;
     kind: SpanKind;
     startTime: number;
     endTime?: number;
     durationMs?: number;
     metadata: Record<string, unknown>;
     events: TimedEvent[];
   }
   ```

2. **Create `src/telemetry/SpanTracer.ts`:**
   - `startSpan(kind, metadata): Span` — returns span, starts clock
   - `endSpan(span): Span` — sets endTime, computes durationMs
   - `addEvent(span, name, data)` — adds timestamped event to span
   - Emits spans through EventBus as `telemetry_span` events
   - Spans are nested: turn → model_call → tool_parse, turn → tool_execution

3. **Instrument Session.startTurn():**
   - Wrap model call in `tracer.startSpan('model_call', { step })`
   - Wrap tool parsing in `tracer.startSpan('tool_parse')`
   - Wrap each tool execution in `tracer.startSpan('tool_execution', { toolName })`

4. **Instrument Compactor** (when it exists in #09):
   - Wrap compaction in `tracer.startSpan('compaction', { stage, tokensBefore })`

5. **Write spans to EventStore** — each span becomes an event with timing data

## Acceptance Criteria

- [ ] Every turn has timing data: model_call ms, tool_parse ms, per-tool execution ms
- [ ] Spans are nested correctly (model_call is child of turn)
- [ ] Span events appear in EventStore with `durationMs` field
- [ ] No performance regression (span overhead <1ms per operation)
- [ ] Agent works without tracer (no dependency)
- [ ] Existing tests pass, new test verifies span nesting
