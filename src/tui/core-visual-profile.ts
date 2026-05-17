export type CoreVisualProfileId = 'default' | 'qwen' | 'openai' | 'frontier' | 'deepseek' | 'gemini';

export type CoreVisualMode = 'model' | 'default' | 'off';

export type CoreGeometry = 'lens' | 'lattice' | 'organic' | 'furnace' | 'twin' | 'default';
export type CorePhaseStyle = 'smooth' | 'snap' | 'elastic' | 'compressed' | 'mirrored';
export type CoreHoverBias = 'focus' | 'magnetic' | 'elastic' | 'minimal' | 'split';
export type CoreScanStyle = 'soft' | 'beam' | 'inward' | 'split' | 'precise';
export type CoreColorRole = 'neutral' | 'green' | 'blue' | 'violet' | 'red' | 'gold';

export interface CoreVisualProfile {
  id: CoreVisualProfileId;
  label: string;
  match: RegExp[];
  glyphs: {
    nucleus: string;
    secondary?: string;
    farParticle: string;
    rearParticle: string;
    glow: string;
    hotGlow: string;
  };
  geometry: CoreGeometry;
  motion: {
    breathRate: number;
    phaseStyle: CorePhaseStyle;
    hoverBias: CoreHoverBias;
    scanStyle: CoreScanStyle;
  };
  colorRole?: CoreColorRole;
}

export interface CoreVisualResolverOptions {
  mode?: CoreVisualMode;
  profile?: CoreVisualProfileId;
  overrides?: Record<string, CoreVisualProfileId>;
}

const PROFILES: Record<CoreVisualProfileId, CoreVisualProfile> = {
  default: {
    id: 'default',
    label: 'Synax',
    match: [],
    glyphs: {
      nucleus: '●',
      farParticle: '˙',
      rearParticle: '.',
      glow: '·',
      hotGlow: '◎',
    },
    geometry: 'default',
    motion: {
      breathRate: 0.82,
      phaseStyle: 'smooth',
      hoverBias: 'minimal',
      scanStyle: 'soft',
    },
    colorRole: 'neutral',
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen',
    match: [/qwen/i],
    glyphs: {
      nucleus: '●',
      secondary: '◎',
      farParticle: '˙',
      rearParticle: '.',
      glow: '·',
      hotGlow: '━',
    },
    geometry: 'lattice',
    motion: {
      breathRate: 1.05,
      phaseStyle: 'snap',
      hoverBias: 'magnetic',
      scanStyle: 'precise',
    },
    colorRole: 'blue',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    match: [/gpt|openai/i],
    glyphs: {
      nucleus: '●',
      secondary: '◎',
      farParticle: '.',
      rearParticle: '˙',
      glow: ':',
      hotGlow: '●',
    },
    geometry: 'lens',
    motion: {
      breathRate: 0.9,
      phaseStyle: 'smooth',
      hoverBias: 'focus',
      scanStyle: 'soft',
    },
    colorRole: 'green',
  },
  frontier: {
    id: 'frontier',
    label: 'Frontier',
    match: [/frontier/i],
    glyphs: {
      nucleus: '◉',
      secondary: '◎',
      farParticle: '.',
      rearParticle: '˙',
      glow: '·',
      hotGlow: '◉',
    },
    geometry: 'organic',
    motion: {
      breathRate: 1.16,
      phaseStyle: 'elastic',
      hoverBias: 'elastic',
      scanStyle: 'soft',
    },
    colorRole: 'gold',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    match: [/deepseek/i],
    glyphs: {
      nucleus: '◉',
      secondary: '◎',
      farParticle: '˙',
      rearParticle: '.',
      glow: ':',
      hotGlow: '━',
    },
    geometry: 'furnace',
    motion: {
      breathRate: 0.72,
      phaseStyle: 'compressed',
      hoverBias: 'focus',
      scanStyle: 'beam',
    },
    colorRole: 'green',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    match: [/gemini/i],
    glyphs: {
      nucleus: '●',
      secondary: '◉',
      farParticle: '.',
      rearParticle: '˙',
      glow: '·',
      hotGlow: '│',
    },
    geometry: 'twin',
    motion: {
      breathRate: 1,
      phaseStyle: 'mirrored',
      hoverBias: 'split',
      scanStyle: 'split',
    },
    colorRole: 'violet',
  },
};

export function resolveCoreVisualProfile(modelId: string, options: CoreVisualResolverOptions = {}): CoreVisualProfile {
  if (options.profile && PROFILES[options.profile]) return PROFILES[options.profile];
  if (options.mode === 'off' || options.mode === 'default') return PROFILES.default;

  const normalized = modelId.trim().toLowerCase();
  const override = resolveOverride(normalized, options.overrides);
  if (override) return PROFILES[override];

  for (const profile of [PROFILES.qwen, PROFILES.openai, PROFILES.frontier, PROFILES.deepseek, PROFILES.gemini]) {
    if (profile.match.some((pattern) => pattern.test(modelId))) return profile;
  }

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
