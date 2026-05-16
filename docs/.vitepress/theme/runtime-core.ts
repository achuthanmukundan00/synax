export type CoreModelProfileId = 'default' | 'qwen' | 'deepseek' | 'openai' | 'claude' | 'gemini';

export type RuntimeState = 'unloaded' | 'idle' | 'working' | 'tool-running' | 'succeeded' | 'warning' | 'error';

export type MorphologyGeometry = 'contained' | 'lattice' | 'furnace' | 'lens' | 'aperture' | 'twin';

export type TerminalTone = 'default' | 'dim' | 'model' | 'working' | 'succeeded' | 'warning' | 'error' | 'action';

export interface CoreVisualProfile {
  id: CoreModelProfileId;
  label: string;
  match: RegExp[];
  geometry: MorphologyGeometry;
  accentRgb: string;
  motion: {
    breathRate: number;
    phaseStyle: 'smooth' | 'snap' | 'compressed' | 'elastic' | 'mirrored';
    scanStyle: 'soft' | 'precise' | 'beam' | 'split';
  };
}

export interface RuntimePalette {
  label: string;
  stateRgb: string;
  hotRgb: string;
  shellRgb: string;
  lowRgb: string;
}

export interface TerminalLine {
  kind: 'kv' | 'command';
  key?: string;
  value: string;
  tone?: TerminalTone;
}

export interface RuntimeSceneDef {
  id: string;
  modelId: string;
  coreName: string;
  provider: string;
  state: RuntimeState;
  headline: string;
  subheadline: string;
  context: string;
  terminal: TerminalLine[];
  intensity: number;
}

export interface RuntimeScene extends RuntimeSceneDef {
  profile: CoreVisualProfile;
  palette: RuntimePalette;
  contextPressure: boolean;
}

const PROFILES: Record<CoreModelProfileId, CoreVisualProfile> = {
  default: {
    id: 'default',
    label: 'Synax',
    match: [/default/i, /local/i, /synax/i, /unknown/i],
    geometry: 'contained',
    accentRgb: '90 118 150',
    motion: {
      breathRate: 4.4,
      phaseStyle: 'smooth',
      scanStyle: 'soft',
    },
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen',
    match: [/qwen/i],
    geometry: 'lattice',
    accentRgb: '86 141 208',
    motion: {
      breathRate: 3.4,
      phaseStyle: 'snap',
      scanStyle: 'precise',
    },
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    match: [/deepseek/i],
    geometry: 'furnace',
    accentRgb: '91 126 187',
    motion: {
      breathRate: 4.9,
      phaseStyle: 'compressed',
      scanStyle: 'beam',
    },
  },
  openai: {
    id: 'openai',
    label: 'OpenAI/GPT',
    match: [/gpt/i, /openai/i],
    geometry: 'lens',
    accentRgb: '118 156 184',
    motion: {
      breathRate: 4.1,
      phaseStyle: 'smooth',
      scanStyle: 'soft',
    },
  },
  claude: {
    id: 'claude',
    label: 'Claude',
    match: [/claude/i],
    geometry: 'aperture',
    accentRgb: '188 146 103',
    motion: {
      breathRate: 4.8,
      phaseStyle: 'elastic',
      scanStyle: 'soft',
    },
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    match: [/gemini/i],
    geometry: 'twin',
    accentRgb: '104 139 206',
    motion: {
      breathRate: 3.8,
      phaseStyle: 'mirrored',
      scanStyle: 'split',
    },
  },
};

export const runtimeScenes: RuntimeSceneDef[] = [
  {
    id: 'unloaded',
    modelId: 'synax-default',
    coreName: 'Synax',
    provider: 'none',
    state: 'unloaded',
    context: '0 / 32768',
    headline: 'No model loaded.',
    subheadline: 'The chamber stays dormant until a local or API model is attached.',
    intensity: 0.12,
    terminal: [
      { kind: 'kv', key: 'core', value: 'unloaded', tone: 'dim' },
      { kind: 'kv', key: 'provider', value: 'none', tone: 'dim' },
      { kind: 'kv', key: 'state', value: 'unloaded', tone: 'dim' },
      { kind: 'kv', key: 'ctx', value: '0 / 32768', tone: 'dim' },
    ],
  },
  {
    id: 'qwen-idle',
    modelId: 'qwen-coder',
    coreName: 'Qwen',
    provider: 'relay(local)',
    state: 'idle',
    context: '0 / 32768',
    headline: 'Sharp, lattice-like cognition.',
    subheadline: 'Qwen feels nimble and surgical inside the Synax containment runtime.',
    intensity: 0.38,
    terminal: [
      { kind: 'kv', key: 'core', value: 'qwen-coder', tone: 'model' },
      { kind: 'kv', key: 'provider', value: 'relay (local)' },
      { kind: 'kv', key: 'state', value: 'idle', tone: 'model' },
      { kind: 'kv', key: 'ctx', value: '0 / 32768' },
    ],
  },
  {
    id: 'qwen-working',
    modelId: 'qwen-coder',
    coreName: 'Qwen',
    provider: 'relay(local)',
    state: 'working',
    context: '18420 / 32768',
    headline: 'Local models, real work.',
    subheadline: 'Synax routes reads, edits, and commands through an observable runtime.',
    intensity: 0.72,
    terminal: [
      { kind: 'command', value: 'read src/config.ts', tone: 'working' },
      { kind: 'command', value: 'edit src/providers.ts', tone: 'working' },
      { kind: 'command', value: 'test npm test', tone: 'working' },
      { kind: 'kv', key: 'state', value: 'working', tone: 'working' },
      { kind: 'kv', key: 'ctx', value: '18420 / 32768' },
    ],
  },
  {
    id: 'deepseek-tools',
    modelId: 'deepseek-coder',
    coreName: 'DeepSeek',
    provider: 'relay(local)',
    state: 'tool-running',
    context: '22104 / 65536',
    headline: 'Every action is visible.',
    subheadline: 'Tool calls route through the chamber instead of vanishing into a transcript blob.',
    intensity: 0.82,
    terminal: [
      { kind: 'command', value: 'read src/llm/tool-calls.ts', tone: 'working' },
      { kind: 'command', value: 'edit src/llm/client.ts', tone: 'working' },
      { kind: 'command', value: 'test npm test -- tool-calls', tone: 'working' },
      { kind: 'kv', key: 'state', value: 'tool-running', tone: 'working' },
      { kind: 'kv', key: 'ctx', value: '22104 / 65536' },
    ],
  },
  {
    id: 'qwen-succeeded',
    modelId: 'qwen-coder',
    coreName: 'Qwen',
    provider: 'relay(local)',
    state: 'succeeded',
    context: '31200 / 32768',
    headline: 'Run complete. Resolved.',
    subheadline: 'The agent finished cleanly. Verification passed. The chamber returns to idle.',
    intensity: 0.64,
    terminal: [
      { kind: 'command', value: 'read src/config.ts', tone: 'succeeded' },
      { kind: 'command', value: 'edit src/providers.ts', tone: 'succeeded' },
      { kind: 'command', value: 'test npm test', tone: 'succeeded' },
      { kind: 'kv', key: 'result', value: 'verification passed', tone: 'succeeded' },
      { kind: 'kv', key: 'state', value: 'succeeded', tone: 'succeeded' },
      { kind: 'kv', key: 'ctx', value: '31200 / 32768', tone: 'warning' },
    ],
  },
  {
    id: 'claude-warning',
    modelId: 'claude-sonnet-compatible',
    coreName: 'Claude',
    provider: 'api-compatible',
    state: 'warning',
    context: '30812 / 32768',
    headline: 'Context pressure detected.',
    subheadline: 'Synax keeps the model working set observable before the run degrades.',
    intensity: 0.76,
    terminal: [
      { kind: 'kv', key: 'state', value: 'warning', tone: 'warning' },
      { kind: 'kv', key: 'reason', value: 'context pressure', tone: 'warning' },
      { kind: 'kv', key: 'ctx', value: '30812 / 32768', tone: 'warning' },
      { kind: 'kv', key: 'action', value: 'compaction recommended', tone: 'action' },
    ],
  },
  {
    id: 'gemini-error',
    modelId: 'gemini-compatible',
    coreName: 'Gemini',
    provider: 'api-compatible',
    state: 'error',
    context: '0 / 1048576',
    headline: 'Contained failure, not chaos.',
    subheadline: 'Provider errors, unloaded models, and blocked runs are surfaced clearly.',
    intensity: 0.66,
    terminal: [
      { kind: 'kv', key: 'state', value: 'error', tone: 'error' },
      { kind: 'kv', key: 'reason', value: 'model unavailable', tone: 'error' },
      { kind: 'kv', key: 'fix', value: 'start relay or select provider', tone: 'action' },
      { kind: 'kv', key: 'ctx', value: '0 / 1048576', tone: 'dim' },
    ],
  },
  {
    id: 'openai-idle',
    modelId: 'gpt-compatible',
    coreName: 'OpenAI/GPT',
    provider: 'openai-compatible',
    state: 'idle',
    context: '0 / 128000',
    headline: 'Clean centered optics.',
    subheadline: 'API-compatible fallback models still run inside the same Synax chamber.',
    intensity: 0.34,
    terminal: [
      { kind: 'kv', key: 'core', value: 'gpt-compatible', tone: 'model' },
      { kind: 'kv', key: 'provider', value: 'openai-compatible' },
      { kind: 'kv', key: 'state', value: 'idle', tone: 'model' },
      { kind: 'kv', key: 'ctx', value: '0 / 128000' },
    ],
  },
  {
    id: 'qwen-multi',
    modelId: 'qwen-coder',
    coreName: 'Qwen',
    provider: 'relay(local)',
    state: 'idle',
    context: '0 / 32768',
    headline: 'One runtime, every provider.',
    subheadline: 'Route local Relay, cloud APIs, or custom endpoints through the same agent loop.',
    intensity: 0.42,
    terminal: [
      { kind: 'kv', key: 'core', value: 'qwen-coder', tone: 'model' },
      { kind: 'kv', key: 'provider', value: 'relay (local)' },
      { kind: 'kv', key: 'routing', value: 'deepseek → anthropic → groq' },
      { kind: 'kv', key: 'state', value: 'idle', tone: 'model' },
      { kind: 'kv', key: 'ctx', value: '0 / 32768' },
    ],
  },
  {
    id: 'deepseek-parsers',
    modelId: 'deepseek-coder',
    coreName: 'DeepSeek',
    provider: 'relay(local)',
    state: 'tool-running',
    context: '18420 / 65536',
    headline: '26 native tool-call parsers.',
    subheadline: 'Qwen XML, Hermes JSON, Llama Pythonic, DeepSeek, Mistral — no vLLM normalization needed.',
    intensity: 0.78,
    terminal: [
      { kind: 'command', value: 'parse qwen3_xml → tool_call', tone: 'working' },
      { kind: 'command', value: 'parse hermes → tool_call', tone: 'working' },
      { kind: 'command', value: 'parse deepseek_v3 → tool_call', tone: 'working' },
      { kind: 'command', value: 'parse llama4_pythonic → tool_call', tone: 'working' },
      { kind: 'kv', key: 'state', value: 'tool-running', tone: 'working' },
      { kind: 'kv', key: 'ctx', value: '18420 / 65536' },
    ],
  },
];

export function resolveCoreVisualProfile(modelId: string): CoreVisualProfile {
  const normalized = modelId.trim().toLowerCase();
  for (const profile of Object.values(PROFILES)) {
    if (profile.id !== 'default' && profile.match.some((matcher) => matcher.test(normalized))) {
      return profile;
    }
  }
  return PROFILES.default;
}

export function buildRuntimeScene(scene: RuntimeSceneDef): RuntimeScene {
  const profile = scene.state === 'unloaded' ? PROFILES.default : resolveCoreVisualProfile(scene.modelId);

  return {
    ...scene,
    profile,
    palette: resolveRuntimePalette(scene.state, profile),
    contextPressure: isContextPressure(scene.context),
  };
}

function resolveRuntimePalette(state: RuntimeState, profile: CoreVisualProfile): RuntimePalette {
  if (state === 'unloaded') {
    return {
      label: 'unloaded',
      stateRgb: '92 96 104',
      hotRgb: '145 150 160',
      shellRgb: '82 86 94',
      lowRgb: '38 41 48',
    };
  }

  if (state === 'succeeded') {
    return {
      label: 'succeeded',
      stateRgb: '74 222 128',
      hotRgb: '134 239 172',
      shellRgb: '34 197 94',
      lowRgb: '20 83 45',
    };
  }

  if (state === 'warning') {
    return {
      label: 'warning',
      stateRgb: '234 179 8',
      hotRgb: '253 224 71',
      shellRgb: '202 138 4',
      lowRgb: '113 63 18',
    };
  }

  if (state === 'error') {
    return {
      label: 'error',
      stateRgb: '248 113 113',
      hotRgb: '251 146 60',
      shellRgb: '239 68 68',
      lowRgb: '127 29 29',
    };
  }

  return {
    label: state,
    stateRgb: profile.accentRgb,
    hotRgb: lightenRgb(profile.accentRgb),
    shellRgb: profile.accentRgb,
    lowRgb: dimRgb(profile.accentRgb),
  };
}

function lightenRgb(rgb: string): string {
  return rgb
    .split(' ')
    .map((channel) => Math.min(255, Number(channel) + 38))
    .join(' ');
}

function dimRgb(rgb: string): string {
  return rgb
    .split(' ')
    .map((channel) => Math.max(0, Math.round(Number(channel) * 0.44)))
    .join(' ');
}

function isContextPressure(context: string): boolean {
  const match = context.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return false;

  const current = Number(match[1]);
  const max = Number(match[2]);
  if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return false;

  return current / max >= 0.9;
}
