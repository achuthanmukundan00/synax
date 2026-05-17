/**
 * Model-family palette resolver.
 *
 * Centralized adapter: model name → color palette for splash accents,
 * activity indicator, model name display, status glyphs, and animations.
 *
 * Detects at least: qwen, deepseek, frontier, openai, gemini, and unknown/default.
 */

export type ModelFamily = 'qwen' | 'deepseek' | 'frontier' | 'openai' | 'gemini' | 'default';

export interface AnimationGlyphSet {
  thinking: string[];
  working: string[];
  verifying: string[];
  orchestrating: string[];
  error: string[];
}

export interface ModelPalette {
  family: ModelFamily;
  primary: string;
  secondary: string;
  accent: string;
  dim: string;
  success: string;
  warning: string;
  error: string;
  splashAccents: string[];
  motionGlyph: string;
  animationGlyphs: AnimationGlyphSet;
}

const PALETTES: Record<ModelFamily, ModelPalette> = {
  qwen: {
    family: 'qwen',
    primary: '#6088bc',
    secondary: '#4a6aae',
    accent: '#7aa4d8',
    dim: '#3a4a6e',
    success: '#5aac78',
    warning: '#c8984a',
    error: '#cc5544',
    splashAccents: ['#6088bc', '#5c94d4', '#7098c8', '#4880c0'],
    motionGlyph: '✦',
    animationGlyphs: {
      thinking: ['◐', '◓', '◑', '◒'],
      working: ['░', '▒', '▓', '█', '▓', '▒'],
      verifying: ['◇', '◈', '◆', '◈'],
      orchestrating: ['⟡', '⟢', '⟣', '⟡'],
      error: ['▌', '▌', '▌', '▌'],
    },
  },
  deepseek: {
    family: 'deepseek',
    primary: '#4b6fa6',
    secondary: '#3a5a8c',
    accent: '#5c8ad4',
    dim: '#2a3a5c',
    success: '#4a9c68',
    warning: '#b8883a',
    error: '#bc4534',
    splashAccents: ['#4b6fa6', '#3e6aaa', '#5580ba', '#406098'],
    motionGlyph: '⬢',
    animationGlyphs: {
      thinking: ['◐', '◓', '◑', '◒'],
      working: ['▁', '▂', '▄', '▆', '█', '▆', '▄', '▂'],
      verifying: ['◇', '◈', '◆', '◈'],
      orchestrating: ['⟡', '⟢', '⟣', '⟡'],
      error: ['▌', '▌', '▌', '▌'],
    },
  },
  frontier: {
    family: 'frontier',
    primary: '#ac7e58',
    secondary: '#8a6240',
    accent: '#c4986a',
    dim: '#5a3e28',
    success: '#6aac68',
    warning: '#c89838',
    error: '#cc5544',
    splashAccents: ['#ac7e58', '#b8906a', '#c0986e', '#a07050'],
    motionGlyph: '◇',
    animationGlyphs: {
      thinking: ['○', '◌', '●', '◌'],
      working: ['·', '•', '●', '•'],
      verifying: ['◇', '◈', '◆', '◈'],
      orchestrating: ['⟡', '⟢', '⟣', '⟡'],
      error: ['▌', '▌', '▌', '▌'],
    },
  },
  openai: {
    family: 'openai',
    primary: '#7097b2',
    secondary: '#5a7a94',
    accent: '#8ab8d0',
    dim: '#3a5a74',
    success: '#4a9c68',
    warning: '#b8904a',
    error: '#c05040',
    splashAccents: ['#7097b2', '#70a0c0', '#80a8c4', '#6890b0'],
    motionGlyph: '◈',
    animationGlyphs: {
      thinking: ['◐', '◓', '◑', '◒'],
      working: ['▁', '▃', '▅', '█', '▅', '▃'],
      verifying: ['◇', '◈', '◆', '◈'],
      orchestrating: ['⟡', '⟢', '⟣', '⟡'],
      error: ['▌', '▌', '▌', '▌'],
    },
  },
  gemini: {
    family: 'gemini',
    primary: '#5681b8',
    secondary: '#4a6eaa',
    accent: '#6a94c8',
    dim: '#3a4e7a',
    success: '#5aac68',
    warning: '#c09040',
    error: '#c85440',
    splashAccents: ['#5681b8', '#5c88c4', '#6a8ec0', '#4e78b0'],
    motionGlyph: '◉',
    animationGlyphs: {
      thinking: ['◐', '◓', '◑', '◒'],
      working: ['▌', '▍', '▎', '▏', '▎', '▍'],
      verifying: ['◇', '◈', '◆', '◈'],
      orchestrating: ['⟡', '⟢', '⟣', '⟡'],
      error: ['▌', '▌', '▌', '▌'],
    },
  },
  default: {
    family: 'default',
    primary: '#4f8cff',
    secondary: '#3a6ad8',
    accent: '#6a9eff',
    dim: '#2a3a5e',
    success: '#4aac68',
    warning: '#c89840',
    error: '#cc5040',
    splashAccents: ['#4f8cff', '#47d7ff', '#7c6cff', '#82f7ff'],
    motionGlyph: '✦',
    animationGlyphs: {
      thinking: ['◐', '◓', '◑', '◒'],
      working: ['░', '▒', '▓', '█', '▓', '▒'],
      verifying: ['◇', '◈', '◆', '◈'],
      orchestrating: ['⟡', '⟢', '⟣', '⟡'],
      error: ['▌', '▌', '▌', '▌'],
    },
  },
};

export function resolveModelFamily(modelId: string): ModelFamily {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return 'default';
  if (normalized.includes('qwen')) return 'qwen';
  if (normalized.includes('deepseek')) return 'deepseek';
  if (normalized.includes('frontier')) return 'frontier';
  if (normalized.includes('gpt') || normalized.includes('openai')) return 'openai';
  if (normalized.includes('gemini')) return 'gemini';
  return 'default';
}

export function getModelPalette(modelId: string): ModelPalette {
  return PALETTES[resolveModelFamily(modelId)];
}

export function getPaletteForFamily(family: ModelFamily): ModelPalette {
  return PALETTES[family];
}
