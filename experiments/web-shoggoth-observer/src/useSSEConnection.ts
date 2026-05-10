import { useEffect, useRef } from "react";
import { useRuntimeStore } from "./runtimeStore";
import { resolveModelSpec } from "./morphology/modelRegistry";
import type { ObserverEvent, ShellRisk } from "./eventTypes";

/**
 * SSE hook that connects to the observer server's /events stream
 * and pushes events into the Zustand runtime store.
 *
 * Normalizes legacy event formats into the spec's ObserverEvent types.
 */
export function useSSEConnection() {
  const pushEvent = useRuntimeStore((s) => s.pushEvent);
  const setModelSpec = useRuntimeStore((s) => s.setModelSpec);
  const setModelId = useRuntimeStore((s) => s.setModelId);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/events");
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "connected") return;
        processEvent(data);
      } catch {
        // ignore malformed events
      }
    };

    // Custom event handlers for named SSE events
    es.addEventListener("token", (e: any) => {
      try { processEvent(JSON.parse(e.data)); } catch {}
    });
    es.addEventListener("phase", (e: any) => {
      try { processEvent(JSON.parse(e.data)); } catch {}
    });
    es.addEventListener("tool_call", (e: any) => {
      try { processEvent(JSON.parse(e.data)); } catch {}
    });

    function processEvent(raw: any): void {
      // Detect model from event
      if (raw.modelId && raw.modelId !== "default") {
        setModelId(raw.modelId);
        const spec = resolveModelSpec(raw.modelId, raw.providerName);
        setModelSpec(spec);
      }

      // Try to map to spec event types
      const event = normalizeToSpecEvent(raw);
      if (event) {
        pushEvent(event);
      }

      // Also push legacy events as best-effort
      pushLegacyEvent(raw);
    }

    es.onerror = () => {
      // Connection lost — will auto-reconnect
    };

    return () => {
      es.close();
    };
  }, [pushEvent, setModelSpec, setModelId]);
}

/**
 * Normalize raw server events into spec-compliant ObserverEvent types.
 */
function normalizeToSpecEvent(raw: any): ObserverEvent | null {
  const rawType = raw.type as string;

  switch (rawType) {
    case "token":
    case "assistant_delta": {
      const text = raw.text ?? raw.content ?? "";
      return {
        type: "token",
        text,
        index: raw.index ?? 0,
        tps: raw.tps ?? raw.tokensPerSecond,
        cumulativeTokens: raw.cumulativeTokens ?? raw.completionTokens,
        truth: "telemetry",
      };
    }

    case "phase": {
      return {
        type: "phase",
        phase: mapPhase(raw.phase),
      };
    }

    case "tool_call":
    case "tool_call_started": {
      const tool = raw.tool?.name ?? raw.toolName ?? "unknown";
      return {
        type: "tool_call",
        tool,
        argsPreview: raw.tool?.summary ?? raw.summary ?? raw.argsPreview ?? "",
        risk: mapRisk(raw.tool?.severity ?? raw.severity ?? raw.risk),
        timestamp: Date.now(),
      };
    }

    case "tool_result":
    case "tool_call_finished":
    case "tool_call_failed": {
      const tool = raw.tool?.name ?? raw.toolName ?? "unknown";
      return {
        type: "tool_result",
        tool,
        success: rawType !== "tool_call_failed" && raw.tool?.status !== "failed",
        summary: raw.tool?.summary ?? raw.summary ?? "",
      };
    }

    case "memory_search": {
      return {
        type: "memory_search",
        query: raw.query ?? "",
        hitCount: raw.hitCount,
      };
    }

    case "file_read": {
      return { type: "file_read", path: raw.path ?? "" };
    }

    case "file_write": {
      return { type: "file_write", path: raw.path ?? "" };
    }

    case "shell_command": {
      return {
        type: "shell_command",
        command: raw.command ?? raw.text ?? "",
        risk: mapRisk(raw.risk),
        exitCode: raw.exitCode,
      };
    }

    case "verification": {
      return {
        type: "verification",
        status: mapVerificationStatus(raw.status),
        command: raw.command,
      };
    }

    case "context_pressure":
    case "budget_update": {
      return {
        type: "context_pressure",
        pressure: raw.pressure ?? computePressure(raw),
        promptTokens: raw.contextUsedTokens ?? raw.promptTokens,
        maxContext: raw.contextWindowTokens ?? raw.maxContext,
      };
    }

    case "error":
    case "error_event": {
      const text = raw.text ?? raw.message ?? raw.error ?? "";
      // Filter out the error if it's just a phase transition label
      if (text === "Agent phase: ERROR") return null;
      return {
        type: "error_event",
        message: text,
      };
    }

    case "subroutine": {
      return {
        type: "subroutine",
        action: raw.action ?? "spawn",
        id: raw.id ?? "",
      };
    }

    case "model_switch": {
      return {
        type: "model_switch",
        modelId: raw.modelId ?? "",
        displayName: raw.displayName,
        provider: raw.providerName ?? raw.provider,
      };
    }

    default:
      return null;
  }
}

/**
 * Push legacy-format events into the store (best-effort compatibility).
 */
function pushLegacyEvent(raw: any): void {
  const rawType = raw.type as string;
  const phase = mapPhase(raw.phase);

  // Always push phase if present
  if (raw.phase) {
    useRuntimeStore.getState().pushEvent({ type: "phase", phase });
  }

  // Tool events from legacy format
  if (rawType === "tool_call_started" || rawType === "tool_call_finished" || rawType === "tool_call_failed") {
    // Handled by normalizeToSpecEvent above
  }

  // Model notes as output
  if (rawType === "model_note" && raw.text) {
    useRuntimeStore.getState().pushEvent({
      type: "token",
      text: raw.text,
      index: 0,
      truth: "telemetry",
    });
  }

  // Session lifecycle as phases
  if (rawType === "session_started") {
    useRuntimeStore.getState().pushEvent({ type: "phase", phase: "perceive" });
  }
  if (rawType === "session_finished") {
    useRuntimeStore.getState().pushEvent({ type: "phase", phase: "idle" });
  }

  // Budget updates
  if (rawType === "budget_update") {
    const pressure = computePressure(raw);
    useRuntimeStore.getState().pushEvent({
      type: "context_pressure",
      pressure,
      promptTokens: raw.contextUsedTokens,
      maxContext: raw.contextWindowTokens,
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function mapPhase(phase: string): import("./eventTypes").AgentPhase {
  const mapping: Record<string, import("./eventTypes").AgentPhase> = {
    idle: "idle",
    thinking: "think",
    think: "think",
    streaming: "think",
    tool_running: "act",
    tool_pending: "decide",
    act: "act",
    decide: "decide",
    perceive: "perceive",
    reflect: "reflect",
    remember: "remember",
    verify: "verify",
    completed: "idle",
    error: "error",
    blocked: "error",
  };
  return mapping[phase] ?? "idle";
}

function mapRisk(severity: string | undefined): ShellRisk {
  if (!severity) return "low";
  const s = severity.toLowerCase();
  if (s === "high" || s === "suspicious") return "high";
  if (s === "medium" || s === "attention") return "medium";
  return "low";
}

function mapVerificationStatus(status: string): import("./eventTypes").VerificationState {
  const mapping: Record<string, import("./eventTypes").VerificationState> = {
    running: "running",
    pass: "pass",
    passed: "pass",
    fail: "fail",
    failed: "fail",
    idle: "idle",
  };
  return mapping[status] ?? "idle";
}

function computePressure(raw: any): number {
  const used = raw.contextUsedTokens ?? raw.promptTokens ?? 0;
  const max = raw.contextWindowTokens ?? raw.maxContext ?? 1;
  return max > 0 ? Math.min(1, used / max) : 0;
}
