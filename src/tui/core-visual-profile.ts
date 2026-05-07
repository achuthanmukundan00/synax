export type CoreVisualProfileId = 'default' | 'qwen' | 'openai' | 'claude' | 'deepseek' | 'gemini';

export type CoreVisualMode = 'model' | 'default' | 'off';

export interface CoreVisualProfile {
  id: CoreVisualProfileId;
  morphology: 'contained' | 'lattice' | 'lens' | 'aperture' | 'furnace' | 'twin';
  densityBias: number;
  flowBias: number;
  compressionBias: number;
  syncBias: number;
  breathingRate: number;
  accent: { r: number; g: number; b: number };
  nucleusLayout: 'single' | 'soft' | 'dense' | 'twin';
  toolScan: 'ring' | 'horizontal' | 'split';
  hoverResponse: 'balanced' | 'optical' | 'elastic' | 'compressed' | 'mirrored';
}

export interface CoreVisualResolverOptions {
  mode?: CoreVisualMode;
  overrides?: Record<string, CoreVisualProfileId>;
}

const PROFILES: Record<CoreVisualProfileId, CoreVisualProfile> = {
  default: {
    id: 'default',
    morphology: 'contained',
    densityBias: 0,
    flowBias: 0,
    compressionBias: 0,
    syncBias: 0,
    breathingRate: 1,
    accent: { r: 58, g: 109, b: 176 },
    nucleusLayout: 'single',
    toolScan: 'ring',
    hoverResponse: 'balanced',
  },
  qwen: {
    id: 'qwen',
    morphology: 'lattice',
    densityBias: 0.07,
    flowBias: 0.12,
    compressionBias: 0.02,
    syncBias: 0.22,
    breathingRate: 1.05,
    accent: { r: 96, g: 136, b: 188 },
    nucleusLayout: 'single',
    toolScan: 'ring',
    hoverResponse: 'balanced',
  },
  openai: {
    id: 'openai',
    morphology: 'lens',
    densityBias: -0.02,
    flowBias: -0.08,
    compressionBias: -0.03,
    syncBias: 0.05,
    breathingRate: 0.9,
    accent: { r: 112, g: 151, b: 178 },
    nucleusLayout: 'single',
    toolScan: 'ring',
    hoverResponse: 'optical',
  },
  claude: {
    id: 'claude',
    morphology: 'aperture',
    densityBias: 0.02,
    flowBias: -0.03,
    compressionBias: -0.04,
    syncBias: -0.08,
    breathingRate: 1.16,
    accent: { r: 172, g: 126, b: 88 },
    nucleusLayout: 'soft',
    toolScan: 'ring',
    hoverResponse: 'elastic',
  },
  deepseek: {
    id: 'deepseek',
    morphology: 'furnace',
    densityBias: 0.11,
    flowBias: -0.12,
    compressionBias: 0.16,
    syncBias: -0.03,
    breathingRate: 0.72,
    accent: { r: 75, g: 111, b: 166 },
    nucleusLayout: 'dense',
    toolScan: 'horizontal',
    hoverResponse: 'compressed',
  },
  gemini: {
    id: 'gemini',
    morphology: 'twin',
    densityBias: 0.04,
    flowBias: 0.08,
    compressionBias: 0,
    syncBias: 0.14,
    breathingRate: 1,
    accent: { r: 86, g: 129, b: 184 },
    nucleusLayout: 'twin',
    toolScan: 'split',
    hoverResponse: 'mirrored',
  },
};

export function resolveCoreVisualProfile(modelId: string, options: CoreVisualResolverOptions = {}): CoreVisualProfile {
  if (options.mode === 'off' || options.mode === 'default') return PROFILES.default;

  const normalized = modelId.trim().toLowerCase();
  const override = resolveOverride(normalized, options.overrides);
  if (override) return PROFILES[override];

  if (normalized.includes('qwen')) return PROFILES.qwen;
  if (normalized.includes('gpt') || normalized.includes('openai')) return PROFILES.openai;
  if (normalized.includes('claude')) return PROFILES.claude;
  if (normalized.includes('deepseek')) return PROFILES.deepseek;
  if (normalized.includes('gemini')) return PROFILES.gemini;
  return PROFILES.default;
}

function resolveOverride(
  normalizedModelId: string,
  overrides: Record<string, CoreVisualProfileId> | undefined,
): CoreVisualProfileId | undefined {
  if (!overrides) return undefined;
  for (const [modelId, profileId] of Object.entries(overrides)) {
    if (modelId.trim().toLowerCase() === normalizedModelId) return profileId;
  }
  return undefined;
}
