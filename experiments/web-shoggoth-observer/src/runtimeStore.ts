import { create } from "zustand";
import type {
  MorphologyRuntimeState,
  ObserverEvent,
  AgentPhase,
  ShellRisk,
  VerificationState,
  ModelMorphologySpec,
} from "./eventTypes";
import { LIMITS } from "./eventTypes";

// ─── Default state ──────────────────────────────────────────────────────
const initialState = {
  modelId: "default",
  phase: "idle" as AgentPhase,
  isStreaming: false,

  tokens: {
    prompt: undefined as number | undefined,
    completion: undefined as number | undefined,
    total: undefined as number | undefined,
    maxContext: undefined as number | undefined,
    tokensPerSecond: undefined as number | undefined,
  },

  contextPressure: 0,
  activeTool: null as MorphologyRuntimeState["activeTool"],
  recentEvents: [] as ObserverEvent[],

  memory: {
    activeSearch: false,
    lastQuery: undefined as string | undefined,
    hitCount: undefined as number | undefined,
  },

  files: {
    activeReads: [] as string[],
    activeWrites: [] as string[],
    lastEdited: undefined as string | undefined,
  },

  shell: {
    activeCommand: undefined as string | undefined,
    lastExitCode: undefined as number | undefined,
    risk: undefined as ShellRisk | undefined,
  },

  verification: {
    active: false,
    status: undefined as VerificationState | undefined,
  },

  instability: 0,
  modelSpec: null as ModelMorphologySpec | null,
};

// ─── Derived instability helpers ────────────────────────────────────────
let errorTimestamps: number[] = [];
const INSTABILITY_WINDOW_MS = 15000;
const MAX_ERRORS_FOR_INSTABILITY = 4;

function computeInstability(
  recentEvents: ObserverEvent[],
  currentPhase: AgentPhase,
  contextPressure: number
): number {
  const now = Date.now();

  // Count recent errors
  errorTimestamps = errorTimestamps.filter((t) => now - t < INSTABILITY_WINDOW_MS);
  const errorRate = errorTimestamps.length / MAX_ERRORS_FOR_INSTABILITY;

  // Count repeated tool calls (loop detection)
  const recentToolCalls = recentEvents
    .filter((e) => e.type === "tool_call")
    .slice(-10) as import("./eventTypes").ToolCallEvent[];
  let toolLoopScore = 0;
  if (recentToolCalls.length >= 3) {
    const toolNames = recentToolCalls.map((t) => t.tool);
    const uniqueTools = new Set(toolNames).size;
    if (uniqueTools <= 2 && recentToolCalls.length >= 4) {
      toolLoopScore = 0.4;
    }
  }

  // Phase-based
  const phaseScore = currentPhase === "error" ? 0.5 : 0;

  // Context pressure
  const pressureScore = contextPressure > 0.85 ? 0.3 : contextPressure > 0.65 ? 0.15 : 0;

  return Math.min(1, errorRate * 0.6 + toolLoopScore + phaseScore + pressureScore);
}

// ─── Store ──────────────────────────────────────────────────────────────
export const useRuntimeStore = create<MorphologyRuntimeState>((set, get) => ({
  ...initialState,

  pushEvent: (event: ObserverEvent) => {
    const state = get();
    const updates: Partial<MorphologyRuntimeState> = {};
    const recentEvents = [...state.recentEvents, event].slice(-LIMITS.maxRecentEvents);
    updates.recentEvents = recentEvents;

    switch (event.type) {
      case "phase": {
        updates.phase = event.phase;
        updates.isStreaming = event.phase === "think" || event.phase === "act";
        break;
      }

      case "token": {
        updates.isStreaming = true;
        if (event.tps != null) {
          updates.tokens = {
            ...state.tokens,
            tokensPerSecond: event.tps,
            completion: event.cumulativeTokens,
          };
        }
        if (event.cumulativeTokens != null) {
          updates.tokens = {
            ...state.tokens,
            total: (state.tokens.prompt ?? 0) + event.cumulativeTokens,
            completion: event.cumulativeTokens,
          };
        }
        break;
      }

      case "tool_call": {
        updates.activeTool = {
          name: event.tool,
          risk: event.risk,
          startedAt: event.timestamp,
        };
        if (event.tool === "read" || event.tool === "edit" || event.tool === "write") {
          const path = event.argsPreview || "";
          if (event.tool === "read") {
            updates.files = {
              ...state.files,
              activeReads: [...state.files.activeReads, path].slice(-20),
              lastEdited: state.files.lastEdited,
            };
          } else {
            updates.files = {
              ...state.files,
              activeWrites: [...state.files.activeWrites, path].slice(-20),
              lastEdited: path,
            };
          }
        }
        if (event.tool === "search_memory") {
          updates.memory = {
            ...state.memory,
            activeSearch: true,
            lastQuery: event.argsPreview,
          };
        }
        break;
      }

      case "tool_result": {
        updates.activeTool = null;
        if (event.tool === "search_memory") {
          updates.memory = { ...state.memory, activeSearch: false };
        }
        break;
      }

      case "memory_search": {
        updates.memory = {
          activeSearch: true,
          lastQuery: event.query,
          hitCount: event.hitCount,
        };
        break;
      }

      case "file_read": {
        updates.files = {
          ...state.files,
          activeReads: [...state.files.activeReads, event.path].slice(-20),
        };
        break;
      }

      case "file_write": {
        updates.files = {
          ...state.files,
          activeWrites: [...state.files.activeWrites, event.path].slice(-20),
          lastEdited: event.path,
        };
        break;
      }

      case "shell_command": {
        updates.shell = {
          activeCommand: event.command,
          risk: event.risk,
          lastExitCode: event.exitCode,
        };
        break;
      }

      case "verification": {
        updates.verification = {
          active: event.status === "running",
          status: event.status,
        };
        break;
      }

      case "error_event": {
        errorTimestamps.push(Date.now());
        break;
      }

      case "context_pressure": {
        updates.contextPressure = event.pressure;
        if (event.promptTokens != null || event.maxContext != null) {
          updates.tokens = {
            ...state.tokens,
            prompt: event.promptTokens,
            maxContext: event.maxContext,
          };
        }
        break;
      }

      case "model_switch": {
        updates.modelId = event.modelId;
        break;
      }
    }

    // Recompute instability
    const instability = computeInstability(
      recentEvents,
      (updates.phase ?? state.phase) as AgentPhase,
      updates.contextPressure ?? state.contextPressure
    );
    updates.instability = instability;

    set(updates);
  },

  setModelSpec: (spec: ModelMorphologySpec) => {
    set({ modelSpec: spec });
  },

  setModelId: (id: string) => {
    set({ modelId: id });
  },

  reset: () => {
    errorTimestamps = [];
    set({ ...initialState });
  },
}));
