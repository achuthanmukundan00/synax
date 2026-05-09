# Spec 004 — Add typed EventBus with lifecycle and control hooks

**Issue:** #04  
**Milestone:** M1 — Architecture Foundation  
**Owner:** Achu  
**Estimate:** 0.5d (AI-assisted)  
**Priority:** p0 — foundation for observability (M2) and extensions

## Context

Synax currently has ad-hoc event emission via `onActivity` and `onEvent` callbacks passed through `AgentRunnerOptions`. Pi's architecture shows the right pattern: a typed EventBus with 20+ event types for session lifecycle, agent lifecycle, tool lifecycle, and model events. Extensions tap into the same event surface as the core.

From the Pi deconstruction: "1,567 lines of typed event interfaces define a contract that every internal feature adheres to. Extensions don't 'plug in' — they participate in the same event bus as the core."

Additionally, Claw Code shows that some hooks need to be *control* hooks (can modify input, cancel actions, deny operations), not just *observation* hooks. The EventBus needs both:
- **Lifecycle events** (fire-and-forget): `turn_started`, `tool_finished`, `session_shutdown`
- **Control hooks** (can intercept): `preToolUse`, `postToolUse`, `preCompaction`

## Scope

**Creates:** `src/events/EventBus.ts`, `src/events/types.ts`  
**Modifies:** `src/agent/events.ts` (extend existing event types), `src/session/Session.ts`  
**Does NOT:** implement extensions, add MCP support, or change CLI behavior

## Tasks

1. **Create `src/events/types.ts`** — extend the existing `AgentEvent` discriminated union with new lifecycle events:
   - Session: `session_start`, `before_compact`, `session_compact`, `session_shutdown`
   - Turn: `turn_start`, `turn_end` (extends existing `model_step_started`)
   - Tool: `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
   - Control: `pre_tool_use` (can block), `post_tool_use_failure` (can retry)

2. **Create `src/events/EventBus.ts`:**
   ```typescript
   class EventBus {
     on<E extends AgentEvent>(type: E['type'], handler: (event: E) => void | Promise<void>): void;
     emit<E extends AgentEvent>(event: E): Promise<void>;
     // Control hooks return decisions
     onControl<H extends ControlHook>(hook: H['type'], handler: (event: H) => ControlDecision): void;
     emitControl<H extends ControlHook>(event: H): Promise<ControlDecision>;
   }
   ```

3. **Replace `onActivity`/`onEvent` callbacks in Session** with EventBus:
   - Session creates an EventBus at construction
   - `session.startTurn()` emits lifecycle events at each phase
   - ActionExecutor emits tool events through the bus
   - External consumers (CLI, TUI) subscribe to the bus instead of passing callbacks

4. **Keep backward compat** — existing `onActivity`/`onEvent` callbacks still work (they subscribe to the bus internally)

5. **Add at least one control hook:** `pre_tool_use` — handler can return `{ block: true, reason: "..." }` to prevent dangerous tool execution

## Acceptance Criteria

- [ ] `EventBus` class in `src/events/EventBus.ts` with typed `on`/`emit` methods
- [ ] Session emits `session_start`, `turn_start`, `turn_end`, `tool_execution_start`, `tool_execution_end`
- [ ] CLI output is unchanged (TUI/print renderers subscribe to EventBus, not callbacks)
- [ ] `pre_tool_use` hook can block a tool call; blocked calls don't execute
- [ ] All 213+ existing tests pass
- [ ] At least one test verifies event emission order
- [ ] At least one test verifies control hook blocking
