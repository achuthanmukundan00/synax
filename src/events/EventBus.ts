/**
 * Typed EventBus with lifecycle and control hooks.
 *
 * Replaces the raw EventEmitter on Session with a type-safe pub/sub bus.
 *
 * Lifecycle events are fire-and-forget (all handlers run, errors are caught).
 * Control hooks are sequential — each handler returns a ControlDecision, and
 * the first blocking decision short-circuits the chain.
 *
 * Backward compat: when a legacy onActivity / onEvent / onBudget callback is
 * provided to Session, an adapter subscribes it to the bus automatically so
 * existing consumers continue to receive the same events.
 */

import type { AgentEvent } from '../agent/events';
import type {
  ControlDecision,
  ControlHookEvent,
  LifecycleEvent,
  PreToolUseEvent,
  PostToolUseFailureEvent,
} from './types';

// ─── Handler types ───────────────────────────────────────────────────────────

/** Lifecycle handler: receives the event, can return void or Promise<void>. */
export type LifecycleHandler<E extends AgentEvent | LifecycleEvent> = (event: E) => void | Promise<void>;

/** Control hook handler: receives the event, returns a ControlDecision. */
export type ControlHookHandler<H extends PreToolUseEvent | PostToolUseFailureEvent> = (
  event: H,
) => ControlDecision | Promise<ControlDecision>;

// ─── EventBus ────────────────────────────────────────────────────────────────

export class EventBus {
  private lifecycleHandlers = new Map<string, Set<LifecycleHandler<AgentEvent | LifecycleEvent>>>();
  private controlHandlers = new Map<string, Set<ControlHookHandler<PreToolUseEvent | PostToolUseFailureEvent>>>();
  private wildcardHandlers = new Set<LifecycleHandler<AgentEvent | LifecycleEvent>>();

  // ── Lifecycle subscription ──────────────────────────────────────────────

  /**
   * Subscribe to a specific lifecycle event type.
   *
   * ```ts
   * bus.on('turn_start', (e) => console.log('turn', e.stepIndex));
   * bus.on('tool_execution_end', async (e) => { await log(e); });
   * ```
   */
  on<E extends (AgentEvent | LifecycleEvent) & { type: string }>(
    type: E['type'],
    handler: LifecycleHandler<E>,
  ): () => void {
    if (!this.lifecycleHandlers.has(type)) {
      this.lifecycleHandlers.set(type, new Set());
    }
    const handlers = this.lifecycleHandlers.get(type);
    if (handlers) handlers.add(handler as LifecycleHandler<AgentEvent | LifecycleEvent>);
    return () => {
      this.lifecycleHandlers.get(type)?.delete(handler as LifecycleHandler<AgentEvent | LifecycleEvent>);
    };
  }

  /**
   * Subscribe to all lifecycle events (wildcard).
   * Useful for logging, tracing, or metrics collection.
   */
  onAny(handler: LifecycleHandler<AgentEvent | LifecycleEvent>): () => void {
    this.wildcardHandlers.add(handler);
    return () => {
      this.wildcardHandlers.delete(handler);
    };
  }

  // ── Emit lifecycle ──────────────────────────────────────────────────────

  /**
   * Emit a lifecycle event to all matching subscribers.
   * Fire-and-forget — each handler runs independently; errors are caught.
   */
  async emit<E extends AgentEvent | LifecycleEvent>(event: E): Promise<void> {
    const typeHandlers = this.lifecycleHandlers.get(event.type);
    const wildcard = this.wildcardHandlers;

    const handlers: Array<LifecycleHandler<AgentEvent | LifecycleEvent>> = [];
    if (typeHandlers) handlers.push(...Array.from(typeHandlers));
    if (wildcard) handlers.push(...Array.from(wildcard));

    if (handlers.length === 0) return;

    // Run all handlers in parallel; swallow individual errors
    await Promise.all(
      handlers.map((h) =>
        Promise.resolve()
          .then(() => h(event))
          .catch(() => {
            // Swallow — lifecycle events must not crash the bus
          }),
      ),
    );
  }

  // ── Control hook subscription ───────────────────────────────────────────

  /**
   * Subscribe to a control hook.
   *
   * ```ts
   * bus.onControl('pre_tool_use', (e) => {
   *   if (e.toolName === 'bash' && dangerous(e.arguments)) {
   *     return { allow: false, reason: 'dangerous command blocked' };
   *   }
   *   return { allow: true };
   * });
   * ```
   */
  onControl<H extends ControlHookEvent>(hook: H['type'], handler: ControlHookHandler<H>): () => void {
    if (!this.controlHandlers.has(hook)) {
      this.controlHandlers.set(hook, new Set());
    }
    const handlers = this.controlHandlers.get(hook);
    if (handlers) handlers.add(handler as ControlHookHandler<PreToolUseEvent | PostToolUseFailureEvent>);
    return () => {
      this.controlHandlers.get(hook)?.delete(handler as ControlHookHandler<PreToolUseEvent | PostToolUseFailureEvent>);
    };
  }

  /**
   * Run control hook chain for an event.
   *
   * Handlers run sequentially. The first handler that returns a blocking
   * decision (`allow: false`) short-circuits the chain. If a handler returns
   * a modification (`modify: true`), the modified action is passed to
   * subsequent handlers.
   *
   * Returns the final ControlDecision — default is `{ allow: true }` if no
   * handlers are registered or all handlers return allow.
   */
  async emitControl<H extends ControlHookEvent>(event: H): Promise<ControlDecision> {
    const handlerSet = this.controlHandlers.get(event.type);
    if (!handlerSet || handlerSet.size === 0) return { allow: true };

    for (const handler of Array.from(handlerSet)) {
      try {
        const result = await handler(event);
        if (result.allow === false) return result; // block immediately
      } catch {
        // Swallow per-handler errors; don't block the chain
      }
    }

    return { allow: true };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Remove all listeners. Call during session shutdown.
   */
  destroy(): void {
    this.lifecycleHandlers.clear();
    this.controlHandlers.clear();
    this.wildcardHandlers.clear();
  }
}
