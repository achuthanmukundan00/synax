import { useEffect, useRef } from "react";
import { useRuntimeStore } from "./runtimeStore";
import { resolveModelSpec } from "./morphology/modelRegistry";
import type { ObserverEvent, ShellRisk, AgentPhase } from "./eventTypes";

export function useSSEConnection() {
  const pushEvent = useRuntimeStore((s) => s.pushEvent);
  const setModelSpec = useRuntimeStore((s) => s.setModelSpec);
  const setModelId = useRuntimeStore((s) => s.setModelId);

  const eventSourceRef = useRef<EventSource | null>(null);
  const lastModelId = useRef<string>("");

  useEffect(() => {
    const es = new EventSource("/events");
    eventSourceRef.current = es;

    es.onopen = () => {
      console.log("[shoggoth] SSE connection opened");
    };

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "connected") {
          console.log("[shoggoth] SSE connected, history:", data.count, "events");
          return;
        }
        if (data.type === "snapshot") {
          console.log("[shoggoth] snapshot:", data.modelId || "(no model)", "prov:", data.providerName || "(none)");
          // Process snapshot as if it were a session_started with model info
          if (data.modelId) processEvent({ ...data, type: "session_started", phase: "idle" });
          return;
        }
        // Use console.log so it always shows (not hidden by log levels)
        console.log(
          `[shoggoth] ← ${data.type}${data.phase ? " phase=" + data.phase : ""}${data.modelId ? " model=" + data.modelId : ""}${data.providerName ? " prov=" + data.providerName : ""}`
        );
        processEvent(data);
      } catch {
        // ignore malformed events
      }
    };

    es.onerror = () => {
      console.log("[shoggoth] SSE connection error (will auto-reconnect)");
    };

    function processEvent(raw: Record<string, unknown>): void {
      const rawType = raw.type as string | undefined;

      // ── Model detection ────────────────────────────────────────────────
      const modelId = (raw.modelId as string) ?? "";
      const providerName = (raw.providerName as string) ?? (raw.provider as string) ?? "";

      if (modelId && modelId !== lastModelId.current) {
        lastModelId.current = modelId;
        const spec = resolveModelSpec(modelId, providerName);
        console.log(
          `[shoggoth] model detected: id=${modelId} prov=${providerName} → ${spec.displayName} (${spec.architectureClass}, ${spec.visual.morphologyPreset})`
        );
        setModelId(modelId);
        setModelSpec(spec);
        pushEvent({
          type: "model_switch",
          modelId,
          displayName: spec.displayName,
          provider: providerName,
        });
      }

      // ── Phase handling: directly for every event with a phase field ────
      if (raw.phase) {
        const phase = mapPhase(raw.phase as string);
        pushEvent({ type: "phase", phase });
      }

      // ── Normalize to spec events ───────────────────────────────────────
      const specEvent = normalizeToSpecEvent(rawType ?? "", raw);
      if (specEvent) pushEvent(specEvent);

      // ── Legacy passthrough for unmatched types ─────────────────────────
      handleLegacy(rawType ?? "", raw);
    }

    return () => {
      es.close();
      console.log("[shoggoth] SSE connection closed");
    };
  }, [pushEvent, setModelSpec, setModelId]);
}

// ─── Normalize to spec ObserverEvent ────────────────────────────────────

function normalizeToSpecEvent(rawType: string, raw: Record<string, unknown>): ObserverEvent | null {
  switch (rawType) {
    case "assistant_delta": {
      const text = (raw.text as string) ?? (raw.content as string) ?? "";
      if (!text.trim()) return null;
      return {
        type: "token",
        text,
        index: (raw.index as number) ?? 0,
        tps: raw.tps as number | undefined,
        cumulativeTokens: raw.cumulativeTokens as number | undefined,
        truth: "telemetry",
      };
    }

    case "tool_call_started": {
      const tool = raw.tool as Record<string, unknown> | undefined;
      return {
        type: "tool_call",
        tool: ((tool?.name ?? raw.toolName ?? "unknown") as string),
        argsPreview: ((tool?.summary ?? tool?.argsPreview ?? raw.summary ?? "") as string),
        risk: mapRisk((tool?.severity ?? raw.severity ?? raw.risk) as string | undefined),
        timestamp: Date.now(),
      };
    }

    case "tool_call_finished":
    case "tool_call_failed": {
      const tool = raw.tool as Record<string, unknown> | undefined;
      return {
        type: "tool_result",
        tool: ((tool?.name ?? raw.toolName ?? "unknown") as string),
        success: rawType !== "tool_call_failed" && tool?.status !== "failed",
        summary: ((tool?.summary ?? raw.summary ?? "") as string),
      };
    }

    case "budget_update": {
      return {
        type: "context_pressure",
        pressure: computePressure(raw),
        promptTokens: raw.contextUsedTokens as number | undefined,
        maxContext: raw.contextWindowTokens as number | undefined,
      };
    }

    case "error": {
      const text = (raw.text as string) ?? (raw.message as string) ?? "";
      return { type: "error_event", message: text };
    }

    default:
      return null;
  }
}

function handleLegacy(rawType: string, raw: Record<string, unknown>): void {
  const store = useRuntimeStore.getState();

  switch (rawType) {
    case "model_note":
      if (raw.text) {
        store.pushEvent({ type: "token", text: raw.text as string, index: 0, truth: "telemetry" });
      }
      break;

    case "session_started":
      store.pushEvent({ type: "phase", phase: "perceive" });
      break;

    case "session_finished":
      store.pushEvent({ type: "phase", phase: "idle" });
      break;

    case "budget_update": {
      const pressure = computePressure(raw);
      store.pushEvent({
        type: "context_pressure",
        pressure,
        promptTokens: raw.contextUsedTokens as number | undefined,
        maxContext: raw.contextWindowTokens as number | undefined,
      });
      break;
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function mapPhase(raw: string): AgentPhase {
  const m: Record<string, AgentPhase> = {
    idle: "idle",
    thinking: "think",
    think: "think",
    streaming: "act",     // streaming = actively producing = act phase
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
  return m[raw] ?? "idle";
}

function mapRisk(s: string | undefined): ShellRisk {
  if (!s) return "low";
  const lower = s.toLowerCase();
  if (lower === "high" || lower === "suspicious") return "high";
  if (lower === "medium" || lower === "attention") return "medium";
  return "low";
}

function computePressure(raw: Record<string, unknown>): number {
  const used = (raw.contextUsedTokens ?? raw.promptTokens ?? 0) as number;
  const max = (raw.contextWindowTokens ?? raw.maxContext ?? 1) as number;
  return max > 0 ? Math.min(1, used / max) : 0;
}
