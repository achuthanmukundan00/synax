/**
 * Model Visual Profiles — Transformer Architecture Morphologies.
 *
 * Each model family gets distinct layer count, attention heads, color role,
 * and animation timing. Profiles matched case-insensitively by modelId from
 * telemetry events.
 */

export const PROFILES = [
  {
    id: 'default',
    label: 'Synax Default',
    match: [/default/i, /local/i, /unknown/i],
    colorRole: 'neutral',
    layerCount: 32,
    attentionHeads: 8,
    mlpWidth: 1.0,
    pulseCount: 25,
    breathRate: 0.45,
    cascadeSpeed: 1.0,
  },
  {
    id: 'qwen',
    label: 'Qwen · Dense Lattice',
    match: [/qwen/i],
    colorRole: 'violet',
    layerCount: 40,
    attentionHeads: 12,
    mlpWidth: 1.15,
    pulseCount: 32,
    breathRate: 0.55,
    cascadeSpeed: 1.3,
  },
  {
    id: 'openai',
    label: 'OpenAI · Clean Stack',
    match: [/gpt/i, /openai/i],
    colorRole: 'green',
    layerCount: 24,
    attentionHeads: 8,
    mlpWidth: 0.9,
    pulseCount: 20,
    breathRate: 0.5,
    cascadeSpeed: 0.9,
  },
  {
    id: 'claude',
    label: 'Claude · Organic Stack',
    match: [/claude/i],
    colorRole: 'gold',
    layerCount: 32,
    attentionHeads: 8,
    mlpWidth: 1.0,
    pulseCount: 22,
    breathRate: 0.4,
    cascadeSpeed: 0.85,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek · Deep Stack',
    match: [/deepseek/i],
    colorRole: 'red',
    layerCount: 48,
    attentionHeads: 16,
    mlpWidth: 1.3,
    pulseCount: 35,
    breathRate: 0.38,
    cascadeSpeed: 1.6,
  },
  {
    id: 'gemini',
    label: 'Gemini · Twin Engine',
    match: [/gemini/i],
    colorRole: 'blue',
    layerCount: 32,
    attentionHeads: 12,
    mlpWidth: 1.05,
    pulseCount: 28,
    breathRate: 0.52,
    cascadeSpeed: 1.1,
  },
];

/**
 * Resolve the best-matching profile for a model ID string.
 */
export function resolveProfile(modelId) {
  if (!modelId) return PROFILES[0];
  for (const p of PROFILES) {
    if (p.id === 'default') continue;
    for (const re of p.match) {
      if (re.test(modelId)) return p;
    }
  }
  return PROFILES[0];
}

// ─── Color palettes by color role ────────────────────────────────────────

const ROLE_PALETTES = {
  neutral: { spine: '#5080a8', ring: '#2a4a68', fiber: '#1e3850', mlp: '#182838', kv: '#101828', pulse: '#80c0e0', glow: '#284860' },
  green:    { spine: '#489860', ring: '#285838', fiber: '#1c4028', mlp: '#142818', kv: '#0c1810', pulse: '#70c880', glow: '#285838' },
  blue:     { spine: '#5090b8', ring: '#2a4e68', fiber: '#1e3a50', mlp: '#182a38', kv: '#101c28', pulse: '#80c8e8', glow: '#284a60' },
  violet:   { spine: '#6058a0', ring: '#383060', fiber: '#282048', mlp: '#1c1830', kv: '#101020', pulse: '#9088d0', glow: '#383050' },
  red:      { spine: '#984840', ring: '#583028', fiber: '#402018', mlp: '#281810', kv: '#180808', pulse: '#c06050', glow: '#483028' },
  gold:     { spine: '#887040', ring: '#504428', fiber: '#383018', mlp: '#241c10', kv: '#141008', pulse: '#b09858', glow: '#484020' },
};

// ─── Phase color modifiers per phase (multiplied onto role palette) ──────

const PHASE_MODIFIERS = {
  idle:         { brightness: 1.0,  saturation: 1.0, hueShift: 0.0 },
  thinking:     { brightness: 1.25, saturation: 1.1, hueShift: 0.0 },
  streaming:    { brightness: 1.15, saturation: 1.0, hueShift: -0.03 },
  tool_pending: { brightness: 1.1,  saturation: 0.85, hueShift: 0.05 },
  tool_running: { brightness: 1.05, saturation: 0.8,  hueShift: 0.08 },
  error:        { brightness: 1.0,  saturation: 0.7,  hueShift: 0.12 },
  completed:    { brightness: 1.1,  saturation: 0.95, hueShift: -0.02 },
  blocked:      { brightness: 0.9,  saturation: 0.75, hueShift: 0.04 },
};

// ─── Severity / error override colors ────────────────────────────────────

export const ERROR_SPINE  = '#601818';
export const ERROR_RING   = '#402020';
export const ERROR_FIBER  = '#281010';
export const ERROR_MLP    = '#200808';
export const ERROR_KV     = '#100808';
export const ERROR_PULSE  = '#802020';

/**
 * Get the effective color map for a given phase + profile.
 * During error/high severity, error colors override.
 */
export function getPhaseColors(phase, profile) {
  const role = ROLE_PALETTES[profile.colorRole] || ROLE_PALETTES.neutral;
  return { ...role }; // for now, phase modifiers are applied in animation
}

export { ROLE_PALETTES, PHASE_MODIFIERS };
