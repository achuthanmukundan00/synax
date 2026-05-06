export type CoreMode =
  | 'idle'
  | 'planning'
  | 'reasoning'
  | 'reading'
  | 'writing'
  | 'bash'
  | 'verifying'
  | 'blocked'
  | 'completed'
  | 'failure'
  | 'thinking'
  | 'tool_execution'
  | 'error';

export const CORE_WIDTH = 28;
export const CORE_HEIGHT = 11;

interface CoreProfile {
  density: number;
  flow: number;
  pressure: number;
  compression: number;
  sync: number;
  strain: boolean;
  stable: boolean;
}

interface FieldState {
  mode: NormalizedCoreMode;
  frame: number;
  profile: CoreProfile;
  palette: [MaterialColor, MaterialColor, MaterialColor];
  unicode: boolean;
}

interface MaterialColor {
  r: number;
  g: number;
  b: number;
}

type NormalizedCoreMode = 'idle' | 'thinking' | 'tool_execution' | 'verifying' | 'blocked' | 'completed' | 'failure';

const RESET = '\u001b[0m';

export function modeColor(mode: CoreMode): string {
  if (mode === 'blocked') return '\u001b[33m';
  if (mode === 'failure' || mode === 'error') return '\u001b[31m';
  if (mode === 'completed') return '\u001b[32m';
  if (mode === 'verifying') return '\u001b[32m';
  if (
    mode === 'idle' ||
    mode === 'planning' ||
    mode === 'reasoning' ||
    mode === 'reading' ||
    mode === 'writing' ||
    mode === 'bash' ||
    mode === 'thinking' ||
    mode === 'tool_execution'
  ) {
    return '\u001b[34m';
  }
  return '\u001b[90m';
}

export function renderAiCore(mode: CoreMode, t: number): string[] {
  return renderDottedCore({
    mode,
    frame: Math.floor(t * 8),
    width: CORE_WIDTH,
    height: CORE_HEIGHT,
    unicode: true,
  });
}

export function renderDottedCore(opts: {
  mode: CoreMode;
  frame: number;
  width: number;
  height: number;
  unicode?: boolean;
}): string[] {
  const normalized = normalizeMode(opts.mode);
  const state: FieldState = {
    mode: normalized,
    frame: opts.frame,
    profile: profileForMode(normalized),
    palette: paletteForMode(normalized, opts.frame),
    unicode: opts.unicode !== false,
  };
  const width = clamp(Math.floor(opts.width), 1, 80);
  const height = clamp(Math.floor(opts.height), 1, 40);

  return Array.from({ length: height }, (_, y) => renderFieldRow(state, y, width, height));
}

function renderFieldRow(state: FieldState, y: number, width: number, height: number): string {
  let row = '';
  for (let x = 0; x < width; x += 1) {
    row += renderFieldCell(state, x, y, width, height);
  }
  return row;
}

function renderFieldCell(state: FieldState, x: number, y: number, width: number, height: number): string {
  const nx = ((x + 0.5) / width - 0.5) * 2.1;
  const ny = ((y + 0.5) / height - 0.5) * 2.45;
  const radius = Math.sqrt(nx * nx + ny * ny);
  if (radius > 1.13) return ' ';

  const frame = state.frame;
  const p = state.profile;
  const angle = Math.atan2(ny, nx);
  const containment = Math.abs(radius - (0.78 - p.compression * 0.13));
  const central = Math.max(0, 1 - radius);
  const flow =
    Math.sin(angle * (2.1 + p.flow * 0.35) + frame * 0.16 * p.flow) +
    Math.sin(nx * 4.6 - ny * 1.7 + frame * 0.11 * p.flow) * 0.45;
  const harmonic = Math.sin((x + y * 1.8 + frame * p.sync) * 0.62);
  const lockedPulse = Math.abs(Math.sin(frame * 0.42 + y * 0.35));
  const stress = p.strain && positiveModulo(x * 7 + y * 11 + frame, 13) < 3;
  const grain = positiveModulo(x * 29 + y * 17 + frame * 5, 97) / 97;
  const density = p.density + central * 0.3 + (containment < 0.09 ? 0.32 : 0) + Math.max(0, flow) * 0.12;

  if (grain > density && containment > 0.045 && central < 0.62) return ' ';

  const glyphs = glyphSet(state.unicode);
  let ch = glyphs.small;
  let color: MaterialColor = state.palette[0];

  if (state.mode === 'tool_execution' && containment < 0.075 && positiveModulo(x + frame, 4) === 0) {
    ch = glyphs.compressed;
    color = state.palette[2];
  } else if (state.mode === 'verifying' && Math.abs(harmonic) > 0.88) {
    ch = glyphs.sync;
    color = state.palette[2];
  } else if ((state.mode === 'failure' || state.mode === 'blocked') && stress) {
    ch = glyphs.stress;
    color = state.palette[2];
  } else if (containment < 0.055) {
    ch = glyphs.line(angle);
    color = state.palette[1];
  } else if (central > 0.7 || lockedPulse > 0.94) {
    ch = p.stable ? glyphs.stable : glyphs.large;
    color = state.palette[2];
  } else if (flow > 0.55 || harmonic > 0.82) {
    ch = glyphs.mid;
    color = state.palette[1];
  }

  return colorize(ch, color);
}

function glyphSet(unicode: boolean): {
  small: string;
  mid: string;
  large: string;
  stable: string;
  compressed: string;
  sync: string;
  stress: string;
  line: (angle: number) => string;
} {
  if (!unicode) {
    return {
      small: '.',
      mid: 'o',
      large: 'O',
      stable: 'O',
      compressed: '#',
      sync: '+',
      stress: 'x',
      line: (angle) => (Math.abs(Math.sin(angle)) > Math.abs(Math.cos(angle)) ? '|' : '-'),
    };
  }
  return {
    small: '.',
    mid: '·',
    large: '•',
    stable: '◎',
    compressed: '◆',
    sync: '━',
    stress: '×',
    line: (angle) => {
      if (Math.abs(Math.sin(angle)) < 0.32) return '─';
      if (Math.abs(Math.cos(angle)) < 0.32) return '│';
      return Math.sin(angle) * Math.cos(angle) > 0 ? '╲' : '╱';
    },
  };
}

function profileForMode(mode: NormalizedCoreMode): CoreProfile {
  if (mode === 'idle') {
    return { density: 0.21, flow: 0.55, pressure: 0.25, compression: 0.08, sync: 0.24, strain: false, stable: false };
  }
  if (mode === 'thinking') {
    return { density: 0.43, flow: 1.45, pressure: 0.82, compression: 0.12, sync: 0.56, strain: false, stable: false };
  }
  if (mode === 'tool_execution') {
    return { density: 0.47, flow: 1.0, pressure: 1.0, compression: 0.44, sync: 0.45, strain: false, stable: false };
  }
  if (mode === 'verifying') {
    return { density: 0.35, flow: 0.72, pressure: 0.62, compression: 0.18, sync: 0.9, strain: false, stable: true };
  }
  if (mode === 'completed') {
    return { density: 0.26, flow: 0.36, pressure: 0.34, compression: 0.1, sync: 0.25, strain: false, stable: true };
  }
  if (mode === 'blocked') {
    return { density: 0.34, flow: 0.52, pressure: 0.78, compression: 0.32, sync: 0.42, strain: true, stable: false };
  }
  return { density: 0.43, flow: 0.64, pressure: 1.0, compression: 0.4, sync: 0.62, strain: true, stable: false };
}

function paletteForMode(mode: NormalizedCoreMode, frame: number): [MaterialColor, MaterialColor, MaterialColor] {
  const wave = (Math.sin(frame * 0.19) + 1) / 2;
  const steel: MaterialColor = { r: 67, g: 76, b: 88 };
  const blue: MaterialColor = { r: 58, g: 109, b: 176 };
  const deepBlue: MaterialColor = { r: 32, g: 62, b: 112 };
  const green: MaterialColor = { r: 83, g: 156, b: 108 };
  const paleGreen: MaterialColor = { r: 174, g: 204, b: 180 };
  const coolBlue: MaterialColor = { r: 86, g: 141, b: 178 };
  const amber: MaterialColor = { r: 190, g: 133, b: 54 };
  const red: MaterialColor = { r: 183, g: 65, b: 52 };

  if (mode === 'tool_execution')
    return [mix(steel, deepBlue, 0.32), mix(deepBlue, blue, 0.5), mix(blue, coolBlue, 0.35 + wave * 0.2)];
  if (mode === 'verifying')
    return [mix(steel, green, 0.18), mix(blue, green, 0.45), mix(green, paleGreen, 0.35 + wave * 0.12)];
  if (mode === 'completed') return [mix(steel, green, 0.22), mix(blue, green, 0.35), green];
  if (mode === 'blocked') return [mix(steel, amber, 0.28), amber, mix(amber, red, 0.38 + wave * 0.14)];
  if (mode === 'failure') return [mix(steel, red, 0.26), mix(amber, red, 0.62), red];
  if (mode === 'idle') return [mix(steel, deepBlue, 0.44), mix(deepBlue, blue, 0.36), mix(blue, steel, 0.2)];
  return [mix(steel, deepBlue, 0.38), blue, mix(blue, { r: 93, g: 140, b: 190 }, 0.35 + wave * 0.14)];
}

function normalizeMode(mode: CoreMode): NormalizedCoreMode {
  if (mode === 'tool_execution' || mode === 'reading' || mode === 'writing' || mode === 'bash') return 'tool_execution';
  if (mode === 'verifying') return 'verifying';
  if (mode === 'completed') return 'completed';
  if (mode === 'blocked') return 'blocked';
  if (mode === 'failure' || mode === 'error') return 'failure';
  if (mode === 'idle') return 'idle';
  return 'thinking';
}

function colorize(ch: string, color: MaterialColor): string {
  return `\u001b[38;2;${color.r};${color.g};${color.b}m${ch}${RESET}`;
}

function mix(a: MaterialColor, b: MaterialColor, amount: number): MaterialColor {
  const n = clamp(amount, 0, 1);
  return {
    r: Math.round(a.r + (b.r - a.r) * n),
    g: Math.round(a.g + (b.g - a.g) * n),
    b: Math.round(a.b + (b.b - a.b) * n),
  };
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
