import type { ModelMorphologySpec } from "../eventTypes";
import { FAMILY_COLORS } from "../eventTypes";

// ─── Utility helpers ────────────────────────────────────────────────────

function layerGroupCount(actualLayers?: number | string): number {
  const n = typeof actualLayers === "number" ? actualLayers : undefined;
  if (!n) return 32;
  if (n <= 32) return n;
  if (n <= 96) return Math.ceil(n / 2);
  return 48;
}

function visualExpertCount(actual?: number | string): number {
  if (typeof actual === "number") return Math.min(actual, 512);
  return 256;
}

// ─── Model Registry ─────────────────────────────────────────────────────

export const MODEL_REGISTRY: Record<string, ModelMorphologySpec> = {

  // ── Opaque Frontier: GPT-5.5 / OpenAI API ──────────────────────────────
  "gpt-5.5": {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    provider: "openai",
    family: "openai",
    architectureConfidence: "opaque",
    architectureClass: "opaque-frontier-model",
    parameterScale: "unknown",
    activeParameterScale: "unknown",
    context: {
      maxTokens: "from-runtime-if-available",
      visual: "external-context-rails",
    },
    visual: {
      baseColor: FAMILY_COLORS.openai,
      accentColor: "#ffffff",
      shellOpacity: 0.18,
      bloomStrength: 0.75,
      scaleClass: "frontier",
      morphologyPreset: "opaque-frontier-core",
      labels: ["opaque architecture", "telemetry driven", "agent observable"],
    },
  },

  // ── Opaque Frontier: Claude Opus 4.7 ──────────────────────────────────
  "claude-opus-4.7": {
    id: "claude-opus-4.7",
    displayName: "Claude Opus 4.7",
    provider: "anthropic",
    family: "anthropic",
    architectureConfidence: "opaque",
    architectureClass: "opaque-frontier-model",
    parameterScale: "unknown",
    activeParameterScale: "unknown",
    context: {
      maxTokens: "from-runtime-if-available",
      visual: "external-context-rails",
    },
    visual: {
      baseColor: FAMILY_COLORS.anthropic,
      accentColor: "#fff1df",
      shellOpacity: 0.2,
      bloomStrength: 0.72,
      scaleClass: "frontier",
      morphologyPreset: "opaque-reasoning-core",
      labels: ["opaque architecture", "reasoning shell", "agent observable"],
    },
  },

  // ── Local Dense Transformer (generic) ─────────────────────────────────
  "local-dense-transformer": {
    id: "local-dense-transformer",
    displayName: "Local Dense Transformer",
    provider: "local",
    architectureConfidence: "partial",
    architectureClass: "dense-transformer",
    parameterScale: "unknown",
    transformer: {
      layers: "from-metadata-if-available",
      hiddenSize: "from-metadata-if-available",
      residualStyle: "central-spine",
    },
    attention: {
      heads: "from-metadata-if-available",
      kvHeads: "from-metadata-if-available",
      style: "unknown-or-gqa",
      visual: "side-rail-attention",
    },
    visual: {
      baseColor: FAMILY_COLORS.generic,
      accentColor: "#e8f7ff",
      shellOpacity: 0.16,
      bloomStrength: 0.85,
      scaleClass: "large",
      morphologyPreset: "dense-transformer-core",
      labels: ["dense stack", "local inference", "transformer backbone"],
    },
  },

  // ── Local MoE Transformer (generic) ───────────────────────────────────
  "local-moe-transformer": {
    id: "local-moe-transformer",
    displayName: "Local MoE Transformer",
    provider: "local",
    architectureConfidence: "partial",
    architectureClass: "moe-transformer",
    parameterScale: "unknown",
    activeParameterScale: "unknown",
    moe: {
      experts: "from-metadata-if-available",
      activeExperts: "from-metadata-if-available",
      visual: "radial-expert-banks",
    },
    visual: {
      baseColor: FAMILY_COLORS.generic,
      accentColor: "#e8f7ff",
      shellOpacity: 0.14,
      bloomStrength: 0.9,
      scaleClass: "giant",
      morphologyPreset: "moe-transformer-core",
      labels: ["sparse MoE", "expert banks", "router gates"],
    },
  },

  // ── DeepSeek ──────────────────────────────────────────────────────────
  "deepseek": {
    id: "deepseek",
    displayName: "DeepSeek",
    provider: "local",
    family: "deepseek",
    architectureConfidence: "partial",
    architectureClass: "moe-transformer",
    parameterScale: "unknown",
    moe: {
      experts: "from-metadata-if-available",
      activeExperts: "from-metadata-if-available",
      visual: "radial-expert-banks",
    },
    visual: {
      baseColor: FAMILY_COLORS.deepseek,
      accentColor: "#ff8a7a",
      shellOpacity: 0.15,
      bloomStrength: 0.92,
      scaleClass: "giant",
      morphologyPreset: "moe-transformer-core",
      labels: ["DeepSeek MoE", "expert banks", "deep stack"],
    },
  },

  // ── Qwen ──────────────────────────────────────────────────────────────
  "qwen": {
    id: "qwen",
    displayName: "Qwen",
    provider: "local",
    family: "qwen",
    architectureConfidence: "partial",
    architectureClass: "dense-transformer",
    parameterScale: "unknown",
    transformer: {
      layers: "from-metadata-if-available",
      residualStyle: "central-spine",
    },
    visual: {
      baseColor: FAMILY_COLORS.qwen,
      accentColor: "#80ddff",
      shellOpacity: 0.17,
      bloomStrength: 0.82,
      scaleClass: "large",
      morphologyPreset: "dense-transformer-core",
      labels: ["Qwen dense", "lattice stack"],
    },
  },

  // ── Llama ─────────────────────────────────────────────────────────────
  "llama": {
    id: "llama",
    displayName: "Llama",
    provider: "local",
    family: "llama",
    architectureConfidence: "partial",
    architectureClass: "dense-transformer",
    parameterScale: "unknown",
    visual: {
      baseColor: FAMILY_COLORS.llama,
      accentColor: "#9ad4ff",
      shellOpacity: 0.16,
      bloomStrength: 0.8,
      scaleClass: "large",
      morphologyPreset: "dense-transformer-core",
      labels: ["Llama dense", "transformer stack"],
    },
  },

  // ── Gemini ────────────────────────────────────────────────────────────
  "gemini": {
    id: "gemini",
    displayName: "Gemini",
    provider: "google",
    family: "google",
    architectureConfidence: "opaque",
    architectureClass: "opaque-frontier-model",
    parameterScale: "unknown",
    visual: {
      baseColor: FAMILY_COLORS.google,
      accentColor: "#c4e0ff",
      shellOpacity: 0.19,
      bloomStrength: 0.7,
      scaleClass: "frontier",
      morphologyPreset: "opaque-frontier-core",
      labels: ["opaque frontier", "Google API", "multimodal capable"],
    },
  },

  // ── Coding-optimized agent overlay ────────────────────────────────────
  "coding-agent": {
    id: "coding-agent",
    displayName: "Synax Coding Agent",
    provider: "local",
    architectureConfidence: "partial",
    architectureClass: "coding-optimized-transformer",
    visual: {
      baseColor: FAMILY_COLORS.generic,
      accentColor: "#e8f7ff",
      shellOpacity: 0.18,
      bloomStrength: 0.78,
      scaleClass: "large",
      morphologyPreset: "coder-transformer-core",
      labels: ["coding agent", "tool orbit active", "filesystem aware"],
    },
  },

  // ── Reasoning-optimized ───────────────────────────────────────────────
  "reasoning-model": {
    id: "reasoning-model",
    displayName: "Reasoning Model",
    provider: "local",
    architectureConfidence: "opaque",
    architectureClass: "reasoning-optimized-transformer",
    visual: {
      baseColor: FAMILY_COLORS.generic,
      accentColor: "#ffe8c0",
      shellOpacity: 0.2,
      bloomStrength: 0.7,
      scaleClass: "large",
      morphologyPreset: "reasoning-core",
      labels: ["reasoning shell", "deliberation loops", "nested cognition"],
    },
  },
};

// ─── Default fallback ───────────────────────────────────────────────────
export const DEFAULT_SPEC: ModelMorphologySpec = {
  id: "default",
  displayName: "Synax Agent",
  provider: "local",
  architectureConfidence: "opaque",
  architectureClass: "opaque-frontier-model",
  parameterScale: "unknown",
  activeParameterScale: "unknown",
  context: {
    maxTokens: "from-runtime-if-available",
    visual: "external-context-rails",
  },
  visual: {
    baseColor: FAMILY_COLORS.generic,
    accentColor: "#e8f7ff",
    shellOpacity: 0.17,
    bloomStrength: 0.8,
    scaleClass: "large",
    morphologyPreset: "opaque-frontier-core",
    labels: ["observing agent", "telemetry driven"],
  },
};

// ─── Resolve model spec from ID or event data ───────────────────────────
export function resolveModelSpec(modelId: string, provider?: string): ModelMorphologySpec {
  const key = modelId.toLowerCase().trim();

  // Direct match
  if (MODEL_REGISTRY[key]) return MODEL_REGISTRY[key];

  // Substring match
  for (const [id, spec] of Object.entries(MODEL_REGISTRY)) {
    if (key.includes(id) || id.includes(key)) return spec;
  }

  // Provider-based fallback
  if (provider === "openai") return MODEL_REGISTRY["gpt-5.5"]!;
  if (provider === "anthropic") return MODEL_REGISTRY["claude-opus-4.7"]!;
  if (provider === "google") return MODEL_REGISTRY["gemini"]!;

  // Family-based detection
  for (const [family, _color] of Object.entries(FAMILY_COLORS)) {
    if (key.includes(family)) {
      const match = Object.values(MODEL_REGISTRY).find((s) => s.family === family);
      if (match) return match;
    }
  }

  // Detect coding/reasoning from model ID hints
  if (key.includes("coder") || key.includes("code")) return MODEL_REGISTRY["coding-agent"]!;
  if (key.includes("reason") || key.includes("think") || key.includes("deep")) {
    return MODEL_REGISTRY["reasoning-model"]!;
  }

  return DEFAULT_SPEC;
}

// ─── Derive visual parameters for rendering ─────────────────────────────
export interface ResolvedVisualParams {
  layerCount: number;
  attentionHeads: number;
  expertBanks: number;
  visibleExperts: number;
  activeExpertsPerToken: number;
  scaleMultiplier: number;
  baseColor: string;
  accentColor: string;
  shellOpacity: number;
  bloomStrength: number;
  architectureClass: string;
  morphologyPreset: string;
}

export function resolveVisualParams(spec: ModelMorphologySpec): ResolvedVisualParams {
  const layers = layerGroupCount(spec.transformer?.layers);
  const heads = typeof spec.attention?.heads === "number" ? spec.attention.heads : 8;
  const experts = visualExpertCount(spec.moe?.experts);
  const activePerToken = typeof spec.moe?.activeExperts === "number" ? spec.moe.activeExperts : 8;
  const expertBanks = Math.min(Math.ceil(experts / 32), 16);

  const scaleMap: Record<string, number> = {
    small: 0.7, medium: 0.85, large: 1.0, giant: 1.2, frontier: 1.15,
  };
  const scaleMultiplier = scaleMap[spec.visual.scaleClass] ?? 1.0;

  return {
    layerCount: layers,
    attentionHeads: heads,
    expertBanks,
    visibleExperts: experts,
    activeExpertsPerToken: activePerToken,
    scaleMultiplier,
    baseColor: spec.visual.baseColor,
    accentColor: spec.visual.accentColor,
    shellOpacity: spec.visual.shellOpacity,
    bloomStrength: spec.visual.bloomStrength,
    architectureClass: spec.architectureClass,
    morphologyPreset: spec.visual.morphologyPreset,
  };
}
