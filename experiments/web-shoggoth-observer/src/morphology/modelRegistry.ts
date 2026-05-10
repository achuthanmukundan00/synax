import type { ModelMorphologySpec } from "../eventTypes";
import { FAMILY_COLORS } from "../eventTypes";

// ─── Build a profile dynamically from provider + model hints ────────────

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

function normalizeProvider(raw: string | undefined): string {
  if (!raw) return "unknown";
  const p = raw.toLowerCase().trim();
  if (p.includes("openai")) return "openai";
  if (p.includes("anthropic") || p.includes("claude")) return "anthropic";
  if (p.includes("google") || p.includes("gemini")) return "google";
  if (p.includes("deepseek")) return "deepseek";
  if (p.includes("relay")) return "relay";
  if (p.includes("local")) return "local";
  return "unknown";
}

// ─── Build a profile dynamically from provider + model hints ────────────

interface ProfileInput {
  provider: string;
  modelId: string;
}

function buildProfile(input: ProfileInput): ModelMorphologySpec {
  const { provider, modelId } = input;
  const id = `${provider}-${modelId || "unknown"}`;
  const nameLower = modelId.toLowerCase();

  // ── DeepSeek ──────────────────────────────────────────────────────────
  if (provider === "deepseek" || nameLower.includes("deepseek")) {
    const isR1 = nameLower.includes("r1");
    return {
      id, displayName: "DeepSeek",
      provider: "deepseek",
      family: "deepseek",
      architectureConfidence: "partial",
      architectureClass: "moe-transformer",
      parameterScale: "unknown",
      activeParameterScale: "unknown",
      moe: { experts: "from-metadata-if-available", activeExperts: "from-metadata-if-available", visual: "radial-expert-banks" },
      context: { maxTokens: "from-runtime-if-available", visual: "external-context-rails" },
      visual: {
        baseColor: FAMILY_COLORS.deepseek,
        accentColor: "#ffd0c8",
        shellOpacity: 0.14,
        bloomStrength: 0.92,
        scaleClass: "frontier",
        morphologyPreset: "moe-expert-field",
        labels: ["MoE / Expert Field", isR1 ? "reasoning capable" : "deep stack", "provider-inferred + telemetry driven"],
      },
    };
  }

  // ── Anthropic ─────────────────────────────────────────────────────────
  if (provider === "anthropic" || nameLower.includes("claude")) {
    return {
      id, displayName: "Anthropic Frontier",
      provider: "anthropic",
      family: "anthropic",
      architectureConfidence: "opaque",
      architectureClass: "opaque-frontier-model",
      parameterScale: "unknown",
      activeParameterScale: "unknown",
      context: { maxTokens: "from-runtime-if-available", visual: "external-context-rails" },
      visual: {
        baseColor: FAMILY_COLORS.anthropic,
        accentColor: "#fff0d0",
        shellOpacity: 0.2,
        bloomStrength: 0.72,
        scaleClass: "frontier",
        morphologyPreset: "frontier-reasoning-core",
        labels: ["GENERALIZED REASONING CORE", "provider-inferred + simulated morphology", "opaque architecture"],
      },
    };
  }

  // ── OpenAI ────────────────────────────────────────────────────────────
  if (provider === "openai" || nameLower.includes("gpt")) {
    return {
      id, displayName: "OpenAI Frontier",
      provider: "openai",
      family: "openai",
      architectureConfidence: "opaque",
      architectureClass: "opaque-frontier-model",
      parameterScale: "unknown",
      activeParameterScale: "unknown",
      context: { maxTokens: "from-runtime-if-available", visual: "external-context-rails" },
      visual: {
        baseColor: FAMILY_COLORS.openai,
        accentColor: "#ffffff",
        shellOpacity: 0.18,
        bloomStrength: 0.75,
        scaleClass: "frontier",
        morphologyPreset: "frontier-reasoning-core",
        labels: ["GENERALIZED REASONING CORE", "provider-inferred + simulated morphology", "opaque architecture"],
      },
    };
  }

  // ── Google ────────────────────────────────────────────────────────────
  if (provider === "google" || nameLower.includes("gemini")) {
    return {
      id, displayName: "Google Frontier",
      provider: "google",
      family: "google",
      architectureConfidence: "opaque",
      architectureClass: "opaque-frontier-model",
      parameterScale: "unknown",
      activeParameterScale: "unknown",
      context: { maxTokens: "from-runtime-if-available", visual: "external-context-rails" },
      visual: {
        baseColor: FAMILY_COLORS.google,
        accentColor: "#c4e0ff",
        shellOpacity: 0.19,
        bloomStrength: 0.7,
        scaleClass: "frontier",
        morphologyPreset: "frontier-reasoning-core",
        labels: ["GENERALIZED FRONTIER CORE", "provider-inferred + simulated morphology", "opaque architecture"],
      },
    };
  }

  // ── Relay / Local — check model name for Qwen, Llama, coding ──────────
  if (provider === "relay" || provider === "local") {
    const isQwen = nameLower.includes("qwen");
    const isCoder = nameLower.includes("coder") || nameLower.includes("code");
    const isLlama = nameLower.includes("llama");
    const isMistral = nameLower.includes("mistral");
    const isMoE = nameLower.includes("moe") || nameLower.includes("mixtral");

    if (isQwen) {
      return {
        id, displayName: "Qwen / Local Coder",
        provider: "local",
        family: "qwen",
        architectureConfidence: "partial",
        architectureClass: isCoder ? "coding-optimized-transformer" : "dense-transformer",
        parameterScale: "unknown",
        transformer: { layers: "from-metadata-if-available", residualStyle: "central-spine" },
        visual: {
          baseColor: FAMILY_COLORS.qwen,
          accentColor: "#e8f7ff",
          shellOpacity: 0.17,
          bloomStrength: 0.82,
          scaleClass: "large",
          morphologyPreset: isCoder ? "coder-reactor" : "dense-core",
          labels: [
            isCoder ? "QWEN / LOCAL CODER" : "QWEN / DENSE",
            isCoder ? "CODING TRANSFORMER" : "DENSE TRANSFORMER",
            "provider-inferred + telemetry driven",
          ],
        },
      };
    }

    if (isLlama) {
      return {
        id, displayName: "Llama",
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
          morphologyPreset: "dense-core",
          labels: ["LLAMA / DENSE", "DENSE TRANSFORMER", "provider-inferred + telemetry driven"],
        },
      };
    }

    if (isMistral || isMoE) {
      return {
        id, displayName: "Mistral MoE",
        provider: "local",
        family: "mistral",
        architectureConfidence: "partial",
        architectureClass: "moe-transformer",
        moe: { experts: "from-metadata-if-available", activeExperts: "from-metadata-if-available", visual: "radial-expert-banks" },
        visual: {
          baseColor: FAMILY_COLORS.mistral,
          accentColor: "#ffc8a0",
          shellOpacity: 0.14,
          bloomStrength: 0.9,
          scaleClass: "giant",
          morphologyPreset: "moe-expert-field",
          labels: ["MISTRAL / MOE", "EXPERT FIELD", "provider-inferred + telemetry driven"],
        },
      };
    }

    // Generic Relay/local fallback
    return {
      id, displayName: "Relay Local Model",
      provider: "local",
      architectureConfidence: "partial",
      architectureClass: "dense-transformer",
      parameterScale: "unknown",
      context: { maxTokens: "from-runtime-if-available", visual: "external-context-rails" },
      visual: {
        baseColor: FAMILY_COLORS.generic,
        accentColor: "#e8f7ff",
        shellOpacity: 0.17,
        bloomStrength: 0.8,
        scaleClass: "large",
        morphologyPreset: "relay-local-core",
        labels: ["RELAY / LOCAL", "DENSE FALLBACK", "provider-inferred + telemetry driven"],
      },
    };
  }

  // ── Unknown / default ─────────────────────────────────────────────────
  return {
    id, displayName: "Unknown Model",
    provider: "unknown",
    architectureConfidence: "partial",
    architectureClass: "dense-transformer",
    parameterScale: "unknown",
    activeParameterScale: "unknown",
    transformer: { layers: "from-metadata-if-available", residualStyle: "central-spine" },
    context: { maxTokens: "from-runtime-if-available", visual: "external-context-rails" },
    visual: {
      baseColor: FAMILY_COLORS.generic,
      accentColor: "#e8f7ff",
      shellOpacity: 0.17,
      bloomStrength: 0.8,
      scaleClass: "large",
      morphologyPreset: "dense-core",
      labels: ["UNKNOWN MODEL", "DENSE FALLBACK", "limited metadata + telemetry driven"],
    },
  };
}

// ─── Exported resolver ──────────────────────────────────────────────────

export function resolveModelSpec(modelId: string, providerName?: string): ModelMorphologySpec {
  const prov = normalizeProvider(providerName);

  // Use model name hints first if provider is Relay/local
  if (prov === "relay" || prov === "local") {
    const nameLower = (modelId || "").toLowerCase().replace(/^.*[\\/]/, "").replace(/^models--/, "");
    return buildProfile({ provider: prov, modelId: nameLower });
  }

  // For known cloud providers, use provider as primary signal
  if (prov !== "unknown") {
    return buildProfile({ provider: prov, modelId: modelId || "" });
  }

  // Fallback: try to infer provider from model name
  const nameLower = (modelId || "").toLowerCase();
  if (nameLower.includes("deepseek")) return buildProfile({ provider: "deepseek", modelId: nameLower });
  if (nameLower.includes("claude")) return buildProfile({ provider: "anthropic", modelId: nameLower });
  if (nameLower.includes("gpt") || nameLower.includes("openai")) return buildProfile({ provider: "openai", modelId: nameLower });
  if (nameLower.includes("gemini")) return buildProfile({ provider: "google", modelId: nameLower });
  if (nameLower.includes("qwen")) return buildProfile({ provider: "relay", modelId: nameLower });
  if (nameLower.includes("llama")) return buildProfile({ provider: "relay", modelId: nameLower });

  // True fallback
  return buildProfile({ provider: "unknown", modelId: nameLower });
}

// ─── Default spec ───────────────────────────────────────────────────────
export const DEFAULT_SPEC: ModelMorphologySpec = buildProfile({ provider: "unknown", modelId: "default" });

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
