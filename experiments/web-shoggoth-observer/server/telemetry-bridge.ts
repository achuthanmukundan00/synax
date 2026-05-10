/**
 * Telemetry Bridge — connects Synax chat session to the Shoggoth Observer.
 *
 * This module is imported by the Synax chat command when observer mode is
 * enabled. It POSTs events to the observer server's /ingest endpoint.
 *
 * Safe if no observer server is running — fetch errors are silently swallowed.
 * Read-only. Does not alter agent behavior.
 */

const OBSERVER_INGEST_URL = 'http://127.0.0.1:8559/ingest';

interface BridgeEvent {
  type: string;
  time?: string;
  phase?: string;
  text?: string;
  toolName?: string;
  summary?: string;
  tool?: {
    name: string;
    summary: string;
    status: string;
    arguments: Record<string, unknown>;
  };
  arguments?: Record<string, unknown>;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  modelId?: string;
  providerName?: string;
}

interface BridgeOptions {
  modelId?: string;
  providerName?: string;
  enabled?: boolean;
}

let bridgeEnabled = false;
let bridgeModelId = '';
let bridgeProviderName = '';
let pendingEvents: BridgeEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 200; // batch events every 200ms

/**
 * Initialize the telemetry bridge.
 * Call once at session start.
 */
export function initTelemetryBridge(options: BridgeOptions = {}): void {
  bridgeEnabled = options.enabled !== false;
  bridgeModelId = options.modelId ?? '';
  bridgeProviderName = options.providerName ?? '';
}

/**
 * Push an event to the observer. Events are batched and flushed periodically.
 * Safe to call at any time — silently ignored if bridge is disabled or server unavailable.
 */
export function pushObserverEvent(event: BridgeEvent): void {
  if (!bridgeEnabled) return;
  if (!event.time) event.time = new Date().toISOString();
  if (bridgeModelId && !event.modelId) event.modelId = bridgeModelId;
  if (bridgeProviderName && !event.providerName) event.providerName = bridgeProviderName;
  pendingEvents.push(event);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNow();
  }, FLUSH_INTERVAL_MS);
}

function flushNow(): void {
  if (pendingEvents.length === 0) return;
  const batch = pendingEvents;
  pendingEvents = [];

  fetch(OBSERVER_INGEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  }).catch(() => {
    // Observer server not running — silently ignore
  });
}

/**
 * Shut down the bridge, flushing any pending events.
 */
export function shutdownTelemetryBridge(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushNow();
  bridgeEnabled = false;
}

/**
 * Create an event sink function compatible with chat.ts setEventSink.
 * This wraps raw Synax AgentEvents into bridge events.
 */
export function createObserverEventSink(): (event: { type: string; [key: string]: unknown }) => void {
  return (synaxEvent) => {
    const bridgeEvent: BridgeEvent = {
      type: synaxEvent.type,
      time: (synaxEvent.timestamp as string) ?? new Date().toISOString(),
    };

    switch (synaxEvent.type) {
      case 'task_started': {
        bridgeEvent.type = 'session_started';
        bridgeEvent.modelId = (synaxEvent as Record<string, unknown>).model as string;
        bridgeEvent.providerName = (synaxEvent as Record<string, unknown>).providerName as string;
        bridgeEvent.text = `Session started: ${(synaxEvent as Record<string, unknown>).task as string}`;
        bridgeEvent.phase = 'idle';
        break;
      }

      case 'assistant_message': {
        bridgeEvent.type = 'model_note';
        bridgeEvent.text = (synaxEvent as Record<string, unknown>).content as string;
        bridgeEvent.phase = 'thinking';
        break;
      }

      case 'assistant_delta': {
        bridgeEvent.type = 'assistant_delta';
        const content = (synaxEvent as Record<string, unknown>).content as string | undefined;
        const reasoning = (synaxEvent as Record<string, unknown>).reasoningContent as string | undefined;
        bridgeEvent.text = [reasoning, content].filter(Boolean).join('') || undefined;
        bridgeEvent.phase = 'streaming';
        break;
      }

      case 'model_step_started': {
        bridgeEvent.type = 'model_note';
        bridgeEvent.text = 'model step started';
        bridgeEvent.phase = 'thinking';
        break;
      }

      case 'tool_started': {
        bridgeEvent.type = 'tool_call_started';
        const toolName = (synaxEvent as Record<string, unknown>).toolName as string ?? 'unknown';
        const summary = (synaxEvent as Record<string, unknown>).summary as string;
        bridgeEvent.tool = {
          name: toolName,
          summary: summary ?? toolName,
          status: 'running',
          arguments: {},
        };
        bridgeEvent.phase = 'tool_running';
        break;
      }

      case 'tool_finished': {
        const toolName = (synaxEvent as Record<string, unknown>).toolName as string ?? 'unknown';
        const summary = (synaxEvent as Record<string, unknown>).summary as string;
        const status = (synaxEvent as Record<string, unknown>).status as string;
        const detail = (synaxEvent as Record<string, unknown>).detail as string;
        bridgeEvent.type = status === 'ok' ? 'tool_call_finished' : 'tool_call_failed';
        bridgeEvent.tool = {
          name: toolName,
          summary: summary ?? detail ?? toolName,
          status: status === 'ok' ? 'completed' : 'failed',
          arguments: {},
        };
        bridgeEvent.phase = 'thinking';
        break;
      }

      case 'context_budget_updated': {
        bridgeEvent.type = 'budget_update';
        bridgeEvent.contextUsedTokens = (synaxEvent as Record<string, unknown>).estimatedInputTokens as number;
        bridgeEvent.contextWindowTokens = (synaxEvent as Record<string, unknown>).contextWindowTokens as number;
        bridgeEvent.phase = 'thinking';
        break;
      }

      case 'task_finished': {
        bridgeEvent.type = 'session_finished';
        const status = (synaxEvent as Record<string, unknown>).status as string;
        bridgeEvent.text = `Session finished: ${status}`;
        bridgeEvent.phase = status === 'completed' ? 'completed' : 'error';
        break;
      }

      case 'error': {
        bridgeEvent.type = 'error';
        bridgeEvent.text = (synaxEvent as Record<string, unknown>).message as string;
        bridgeEvent.phase = 'error';
        break;
      }

      default:
        // Pass through unknown types for extensibility
        break;
    }

    pushObserverEvent(bridgeEvent);
  };
}
