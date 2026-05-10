/**
 * Telemetry Bridge — connects Synax chat session to the Shoggoth Observer.
 *
 * This module is imported by the Synax chat command when observer mode is
 * enabled. It POSTs events to the observer server's /ingest endpoint.
 *
 * Safe if no observer server is running — fetch errors are silently swallowed.
 * Read-only. Does not alter agent behavior.
 */

import type { ShellRisk } from "../src/eventTypes";

const OBSERVER_INGEST_URL = "http://127.0.0.1:8559/ingest";

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
    argsPreview?: string;
  };
  arguments?: Record<string, unknown>;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  modelId?: string;
  providerName?: string;
  risk?: ShellRisk;
  command?: string;
  exitCode?: number;
  path?: string;
  query?: string;
  hitCount?: number;
  status?: string;
}

interface BridgeOptions {
  modelId?: string;
  providerName?: string;
  enabled?: boolean;
}

let bridgeEnabled = false;
let bridgeModelId = "";
let bridgeProviderName = "";
let pendingEvents: BridgeEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 200;

/**
 * Initialize the telemetry bridge.
 */
export function initTelemetryBridge(options: BridgeOptions = {}): void {
  bridgeEnabled = options.enabled !== false;
  bridgeModelId = options.modelId ?? "";
  bridgeProviderName = options.providerName ?? "";
}

/**
 * Push an event to the observer. Events are batched and flushed periodically.
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
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

// ─── Shell command risk scoring ─────────────────────────────────────────

const HIGH_RISK_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bcurl\s+.*\|\s*(ba)?sh\b/i,
  /\bsudo\b/i,
  /\bchmod\s+.*777\b/i,
  /\bgit\s+push\s+--force\b/i,
  /\bgit\s+push\s+-f\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\./i,
  /\b:(){ :|:& };:/,
  />\s*\/dev\/sd[a-z]/i,
];

const MEDIUM_RISK_PATTERNS = [
  /\bchmod\s+-R\b/i,
  /\bchown\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bnc\b/i,
  /\bssh\b(?!\s+-[tT])/i,
  /\bnpm\s+(i|install)\s+-g\b/i,
  /\bpip\s+install\b/i,
  /\bdocker\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bgit\s+remote\s+(add|set-url)\b/i,
  /\bbrew\s+install\b/i,
  /\bapt-get\b/i,
  /\bscp\b/i,
];

function scoreShellRisk(command: string): { risk: ShellRisk; reasons: string[] } {
  const reasons: string[] = [];

  for (const p of HIGH_RISK_PATTERNS) {
    if (p.test(command)) {
      reasons.push(`matches high-risk pattern: ${p.source}`);
      return { risk: "high", reasons };
    }
  }
  for (const p of MEDIUM_RISK_PATTERNS) {
    if (p.test(command)) {
      reasons.push(`matches medium-risk pattern: ${p.source}`);
      return { risk: "medium", reasons };
    }
  }
  return { risk: "low", reasons: [] };
}

function scoreToolRisk(toolName: string, args: Record<string, unknown>): ShellRisk {
  // Bash commands
  if (toolName === "bash" || toolName === "shell") {
    const cmd = (args.command ?? args.cmd ?? args.cmdline ?? "") as string;
    if (typeof cmd === "string") return scoreShellRisk(cmd).risk;
  }

  // File paths
  const path = (args.path ?? args.filepath ?? args.file ?? args.target ?? "") as string;
  if (typeof path === "string") {
    if (/\/etc\/|\/private\/|\.ssh\/|\.aws\/|\.config\/hub|\.git\/config/.test(path)) return "high";
    if (/\.env|\.secrets?|credentials|\.pem|\.key/.test(path)) return "medium";
  }

  return "low";
}

// ─── Event sink factory ─────────────────────────────────────────────────

/**
 * Create an event sink function compatible with chat.ts setEventSink.
 * Wraps raw Synax AgentEvents into rich bridge events.
 */
export function createObserverEventSink(): (event: { type: string; [key: string]: unknown }) => void {
  return (synaxEvent) => {
    const bridgeEvent: BridgeEvent = {
      type: synaxEvent.type,
      time: (synaxEvent.timestamp as string) ?? new Date().toISOString(),
    };

    switch (synaxEvent.type) {
      case "task_started": {
        bridgeEvent.type = "session_started";
        const model = (synaxEvent as Record<string, unknown>).model as string;
        const prov = (synaxEvent as Record<string, unknown>).providerName as string;
        const task = (synaxEvent as Record<string, unknown>).task as string;
        bridgeEvent.modelId = model;
        bridgeModelId = model || bridgeModelId;
        bridgeEvent.providerName = prov;
        bridgeProviderName = prov || bridgeProviderName;
        bridgeEvent.text = `Session started: ${task || ""}`;
        bridgeEvent.phase = "idle";
        break;
      }

      case "assistant_message": {
        bridgeEvent.type = "model_note";
        bridgeEvent.text = (synaxEvent as Record<string, unknown>).content as string;
        bridgeEvent.phase = "thinking";
        break;
      }

      case "assistant_delta": {
        bridgeEvent.type = "assistant_delta";
        const content = (synaxEvent as Record<string, unknown>).content as string | undefined;
        const reasoning = (synaxEvent as Record<string, unknown>).reasoningContent as string | undefined;
        const text = [reasoning, content].filter(Boolean).join("");
        bridgeEvent.text = text || undefined;
        bridgeEvent.phase = "streaming";
        break;
      }

      case "model_step_started": {
        bridgeEvent.type = "model_note";
        bridgeEvent.text = "model step started";
        bridgeEvent.phase = "thinking";
        break;
      }

      case "tool_started": {
        bridgeEvent.type = "tool_call_started";
        const toolName = (synaxEvent as Record<string, unknown>).toolName as string ?? "unknown";
        const summary = (synaxEvent as Record<string, unknown>).summary as string;
        const detail = (synaxEvent as Record<string, unknown>).detail as string;
        const argsPreview = summary ?? detail ?? "";
        const args = ((synaxEvent as Record<string, unknown>).arguments as Record<string, unknown>) ?? {};
        const risk = scoreToolRisk(toolName, args);

        // Extract command for shell tools
        if (toolName === "bash" || toolName === "shell") {
          const cmd = (args.command ?? args.cmd ?? args.cmdline) as string;
          if (typeof cmd === "string") {
            bridgeEvent.command = cmd;
            const shellScore = scoreShellRisk(cmd);
            bridgeEvent.risk = shellScore.risk;
          }
        }

        // Extract file path
        const path = (args.path ?? args.filepath ?? args.file ?? args.target) as string;
        if (typeof path === "string") bridgeEvent.path = path;

        bridgeEvent.tool = {
          name: toolName,
          summary: argsPreview,
          status: "running",
          arguments: args,
          argsPreview,
        };
        bridgeEvent.phase = "tool_running";
        bridgeEvent.risk = risk;
        break;
      }

      case "tool_finished": {
        const toolName = (synaxEvent as Record<string, unknown>).toolName as string ?? "unknown";
        const summary = (synaxEvent as Record<string, unknown>).summary as string;
        const status = (synaxEvent as Record<string, unknown>).status as string;
        const detail = (synaxEvent as Record<string, unknown>).detail as string;
        const exitCode = (synaxEvent as Record<string, unknown>).exitCode as number | undefined;
        bridgeEvent.type = status === "ok" ? "tool_call_finished" : "tool_call_failed";
        bridgeEvent.tool = {
          name: toolName,
          summary: summary ?? detail ?? toolName,
          status: status === "ok" ? "completed" : "failed",
          arguments: {},
        };
        if (exitCode != null) bridgeEvent.exitCode = exitCode;
        bridgeEvent.phase = "thinking";
        break;
      }

      case "context_budget_updated": {
        bridgeEvent.type = "budget_update";
        bridgeEvent.contextUsedTokens = (synaxEvent as Record<string, unknown>).estimatedInputTokens as number;
        bridgeEvent.contextWindowTokens = (synaxEvent as Record<string, unknown>).contextWindowTokens as number;
        bridgeEvent.phase = "thinking";
        break;
      }

      case "task_finished": {
        bridgeEvent.type = "session_finished";
        const status = (synaxEvent as Record<string, unknown>).status as string;
        bridgeEvent.text = `Session finished: ${status}`;
        bridgeEvent.phase = status === "completed" ? "completed" : "error";
        break;
      }

      case "error": {
        bridgeEvent.type = "error";
        bridgeEvent.text = (synaxEvent as Record<string, unknown>).message as string;
        bridgeEvent.phase = "error";
        break;
      }

      default:
        break;
    }

    pushObserverEvent(bridgeEvent);
  };
}
