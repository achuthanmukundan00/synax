// ─── Signal truth levels ───────────────────────────────────────────────
export type SignalTruthLevel =
  | "architecture"  // known from model card, config, GGUF metadata
  | "telemetry"     // directly observed from agent/runtime/event stream
  | "derived"       // computed from telemetry (context pressure, instability)
  | "simulated";    // visual metaphor / approximate internal flow

// ─── Architecture classes ──────────────────────────────────────────────
export type ArchitectureClass =
  | "opaque-frontier-model"
  | "dense-transformer"
  | "moe-transformer"
  | "hybrid-moe-transformer"
  | "long-context-transformer"
  | "reasoning-optimized-transformer"
  | "coding-optimized-transformer"
  | "small-dense-transformer"
  | "unknown-transformer-family";

// ─── Model family colors ────────────────────────────────────────────────
export const FAMILY_COLORS: Record<string, string> = {
  frontier: "#d7e7ff",
  openai: "#d7e7ff",
  anthropic: "#ffb86b",
  google: "#8ab4ff",
  qwen: "#00aaff",
  deepseek: "#ff4a36",
  llama: "#3aa6ff",
  kimi: "#7cff45",
  gemma: "#f0b35a",
  mistral: "#ff7b3a",
  glm: "#57e3c2",
  nemotron: "#b8ff5c",
  minimax: "#ff6d8d",
  generic: "#9fb7d5",
};

// ─── Runtime visual colors ──────────────────────────────────────────────
export const RUNTIME_COLORS: Record<string, string> = {
  tokenFlow: "#e8f7ff",
  attention: "#38bdf8",
  kvCache: "#64748b",
  memory: "#22c55e",
  toolRead: "#60a5fa",
  toolWrite: "#f59e0b",
  shellCommand: "#ef4444",
  verification: "#a78bfa",
  error: "#ff2a2a",
  suspicious: "#ff003c",
  success: "#39ff88",
};

// ─── Agent phase ────────────────────────────────────────────────────────
export type AgentPhase =
  | "idle"
  | "perceive"
  | "think"
  | "decide"
  | "act"
  | "reflect"
  | "remember"
  | "verify"
  | "error";

export const PHASE_VISUALS: Record<AgentPhase, string> = {
  idle: "slow breathing core",
  perceive: "top intake scanner active",
  think: "attention/reasoning rings accelerate",
  decide: "router/decision gates sharpen",
  act: "tool orbit activates",
  reflect: "outer shell rotates backward",
  remember: "green memory crystal connects",
  verify: "violet verification clamp engages",
  error: "red fracture lines appear",
};

// ─── Zoom levels ────────────────────────────────────────────────────────
export type ZoomLevel = "macro" | "meso" | "micro" | "telemetry";

// ─── File node ──────────────────────────────────────────────────────────
export interface FileNode {
  path: string;
  kind: "source" | "test" | "spec" | "config" | "unknown";
  lastTouchedAt: number;
  activity: "read" | "write" | "edit" | "delete" | "none";
}

// ─── Verification state ─────────────────────────────────────────────────
export type VerificationState = "idle" | "running" | "pass" | "fail";

// ─── Shell risk levels ──────────────────────────────────────────────────
export type ShellRisk = "low" | "medium" | "high";

// ─── Observer events ────────────────────────────────────────────────────
export interface TokenEvent {
  type: "token";
  text: string;
  index: number;
  tps?: number;
  cumulativeTokens?: number;
  truth: "telemetry";
}

export interface AgentPhaseEvent {
  type: "phase";
  phase: AgentPhase;
}

export interface ToolCallEvent {
  type: "tool_call";
  tool: "read" | "write" | "edit" | "bash" | "search_memory" | "web" | "subroutine" | string;
  argsPreview: string;
  risk: ShellRisk;
  timestamp: number;
}

export interface ToolResultEvent {
  type: "tool_result";
  tool: string;
  success: boolean;
  summary: string;
}

export interface MemorySearchEvent {
  type: "memory_search";
  query: string;
  hitCount?: number;
  topScores?: number[];
}

export interface FileReadEvent {
  type: "file_read";
  path: string;
}

export interface FileWriteEvent {
  type: "file_write";
  path: string;
}

export interface ShellCommandEvent {
  type: "shell_command";
  command: string;
  risk: ShellRisk;
  exitCode?: number;
}

export interface VerificationEvent {
  type: "verification";
  status: VerificationState;
  command?: string;
}

export interface ErrorEvent {
  type: "error_event";
  message: string;
}

export interface ContextPressureEvent {
  type: "context_pressure";
  pressure: number; // 0..1
  promptTokens?: number;
  completionTokens?: number;
  maxContext?: number;
}

export interface SubroutineEvent {
  type: "subroutine";
  action: "spawn" | "complete" | "error";
  id: string;
}

export interface ModelSwitchEvent {
  type: "model_switch";
  modelId: string;
  displayName?: string;
  provider?: string;
}

export type ObserverEvent =
  | TokenEvent
  | AgentPhaseEvent
  | ToolCallEvent
  | ToolResultEvent
  | MemorySearchEvent
  | FileReadEvent
  | FileWriteEvent
  | ShellCommandEvent
  | VerificationEvent
  | ErrorEvent
  | ContextPressureEvent
  | SubroutineEvent
  | ModelSwitchEvent;

// ─── Model morphology spec ──────────────────────────────────────────────
export interface VisualMorphologyProfile {
  baseColor: string;
  accentColor: string;
  shellOpacity: number;
  bloomStrength: number;
  scaleClass: "small" | "medium" | "large" | "giant" | "frontier";
  morphologyPreset: string;
  labels: string[];
}

export interface TokenizerSpec { type?: string; vocabSize?: number }
export interface EmbeddingSpec { dim?: number }
export interface TransformerBackboneSpec {
  layers?: number | "from-metadata-if-available";
  hiddenSize?: number | "from-metadata-if-available";
  residualStyle?: string;
}
export interface AttentionSpec {
  heads?: number | "from-metadata-if-available";
  kvHeads?: number | "from-metadata-if-available";
  style?: string;
  visual?: string;
}
export interface MLPSpec { intermediateSize?: number; activation?: string }
export interface MoESpec {
  experts?: number | "from-metadata-if-available";
  activeExperts?: number | "from-metadata-if-available";
  visual?: string;
}
export interface KVCacheSpec { type?: string; maxTokens?: number }
export interface ContextSpec {
  maxTokens?: number | "from-runtime-if-available";
  visual?: string;
}
export interface OutputHeadSpec { type?: string }

export interface ModelMorphologySpec {
  id: string;
  displayName: string;
  provider?: "local" | "openai" | "anthropic" | "google" | "deepseek" | "relay" | "unknown" | "other";
  family?: string;
  architectureConfidence: "known" | "partial" | "opaque";
  architectureClass: ArchitectureClass;
  parameterScale?: number | "unknown";
  activeParameterScale?: number | "unknown";
  tokenizer?: TokenizerSpec;
  embedding?: EmbeddingSpec;
  transformer?: TransformerBackboneSpec;
  attention?: AttentionSpec;
  mlp?: MLPSpec;
  moe?: MoESpec;
  kvCache?: KVCacheSpec;
  context?: ContextSpec;
  outputHead?: OutputHeadSpec;
  visual: VisualMorphologyProfile;
}

// ─── Runtime state store shape ──────────────────────────────────────────
export interface MorphologyRuntimeState {
  modelId: string;
  phase: AgentPhase;
  isStreaming: boolean;

  tokens: {
    prompt?: number;
    completion?: number;
    total?: number;
    maxContext?: number;
    tokensPerSecond?: number;
  };

  contextPressure: number; // 0..1

  activeTool: {
    name: string;
    risk: ShellRisk;
    startedAt: number;
  } | null;

  recentEvents: ObserverEvent[];

  memory: {
    activeSearch: boolean;
    lastQuery?: string;
    hitCount?: number;
  };

  files: {
    activeReads: string[];
    activeWrites: string[];
    lastEdited?: string;
  };

  shell: {
    activeCommand?: string;
    lastExitCode?: number;
    risk?: ShellRisk;
  };

  verification: {
    active: boolean;
    status?: VerificationState;
  };

  instability: number; // 0..1 derived

  modelSpec: ModelMorphologySpec | null;

  // Actions
  pushEvent: (event: ObserverEvent) => void;
  setModelSpec: (spec: ModelMorphologySpec) => void;
  setModelId: (id: string) => void;
  reset: () => void;
}

// ─── Layer band visual ──────────────────────────────────────────────────
export interface LayerBandVisual {
  index: number;
  representedLayers: number;
  positionY: number;
  width: number;
  height: number;
  depth: number;
  opacity: number;
  edgeGlow: number;
  activation: number;
}

// ─── Attention ring ─────────────────────────────────────────────────────
export interface AttentionRing {
  layerGroupIndex: number;
  radiusX: number;
  radiusZ: number;
  rotationSpeed: number;
  intensity: number;
  truth: SignalTruthLevel;
}

// ─── Expert shard ───────────────────────────────────────────────────────
export interface ExpertShard {
  visualExpertIndex: number;
  bankIndex: number;
  position: [number, number, number];
  active: boolean;
  load: number;
  lastActivatedAt?: number;
  truth: SignalTruthLevel;
}

// ─── Transcript item ────────────────────────────────────────────────────
export type TranscriptItem =
  | { kind: "model_output"; text: string; time: number }
  | { kind: "model_note"; text: string; time: number }
  | { kind: "tool_call"; tool: string; preview: string; risk?: ShellRisk; time: number }
  | { kind: "tool_result"; summary: string; success: boolean; time: number }
  | { kind: "memory"; query: string; hitCount?: number; time: number }
  | { kind: "error"; text: string; time: number }
  | { kind: "verification"; status: string; time: number }
  | { kind: "shell_command"; command: string; risk: ShellRisk; exitCode?: number; time: number };

// ─── Performance limits ─────────────────────────────────────────────────
export const LIMITS = {
  maxVisibleTokenParticles: 512,
  maxVisibleExpertShards: 512,
  maxVisibleAttentionLines: 256,
  maxTranscriptItems: 200,
  maxRecentEvents: 500,
} as const;
