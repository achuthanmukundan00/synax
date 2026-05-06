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

export const CORE_WIDTH = 22;
export const CORE_HEIGHT = 9;

type DottedMode = Exclude<CoreMode, 'thinking' | 'tool_execution' | 'error'>;

interface DottedProfile {
  density: number;
  flow: number;
  pressure: number;
  strain: boolean;
  calm: boolean;
}

interface DottedState {
  mode: DottedMode;
  frame: number;
  profile: DottedProfile;
  palette: [ThermalColor, ThermalColor, ThermalColor];
  unicode: boolean;
}

interface ThermalColor {
  r: number;
  g: number;
  b: number;
}

const RESET = '\u001b[0m';

export function modeColor(mode: CoreMode): string {
  if (mode === 'blocked') return '\u001b[33m';
  if (mode === 'failure' || mode === 'error') return '\u001b[31m';
  if (mode === 'completed' || mode === 'verifying') return '\u001b[32m';
  if (mode === 'bash' || mode === 'reading') return '\u001b[36m';
  if (mode === 'idle') return '\u001b[94m';
  if (mode === 'writing' || mode === 'planning') return '\u001b[94m';
  if (mode === 'reasoning' || mode === 'thinking' || mode === 'tool_execution') return '\u001b[96m';
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
  const width = clamp(Math.floor(opts.width), 1, 80);
  const height = clamp(Math.floor(opts.height), 1, 40);
  const state: DottedState = {
    mode: normalized,
    frame: opts.frame,
    profile: profileForMode(normalized),
    palette: statePalette(normalized, opts.frame),
    unicode: opts.unicode !== false,
  };

  return Array.from({ length: height }, (_, y) => renderDottedRow(state, y, width, height));
}

function renderDottedRow(state: DottedState, y: number, width: number, height: number): string {
  let line = '';
  for (let x = 0; x < width; x += 1) {
    line += renderDottedCell(state, x, y, width, height);
  }
  return line;
}

function renderDottedCell(state: DottedState, x: number, y: number, width: number, height: number): string {
  const nx = ((x + 0.5) / width - 0.5) / 0.48;
  const ny = ((y + 0.5) / height - 0.5) / 0.55;
  const radius = Math.sqrt(nx * nx + ny * ny);
  if (radius > 1.03) return ' ';

  const rowPhase = y * 3 + Math.floor((height - y) * state.profile.flow);
  const stream = positiveModulo(x + rowPhase + state.frame, 9);
  const diagonal = positiveModulo(x - y * 2 + state.frame, 11);
  const grain = positiveModulo(x * 7 + y * 13 + state.frame * 2, 17);
  const edge = Math.abs(radius - 0.82);
  const density = state.profile.density + (1 - radius) * 0.42 + (edge < 0.12 ? 0.18 : 0);

  if (grain / 17 > density && stream > 2) return ' ';

  const chars = glyphSet(state.unicode);
  const bandActive = stream <= 2 || diagonal === 0;
  const accent = state.profile.strain && positiveModulo(x + y + state.frame, 7) === 0;
  const corePulse = radius < 0.28 && positiveModulo(state.frame + y, state.profile.calm ? 6 : 4) === 0;
  const large = radius < 0.68 && (bandActive || corePulse || grain < 5);

  let ch = chars.small;
  let colorIndex: 0 | 1 | 2 = 0;
  if (accent) {
    ch = chars.cross;
    colorIndex = 2;
  } else if (large) {
    ch = chars.large;
    colorIndex = radius < 0.42 ? 2 : 1;
  } else if (stream === 3 || diagonal === 1) {
    ch = chars.mid;
    colorIndex = 1;
  }

  return colorize(ch, state.palette[colorIndex]);
}

function glyphSet(unicode: boolean): { small: string; mid: string; large: string; cross: string } {
  if (!unicode) return { small: '.', mid: 'o', large: 'o', cross: 'x' };
  return { small: '.', mid: '·', large: '•', cross: '×' };
}

function profileForMode(mode: DottedMode): DottedProfile {
  if (mode === 'idle') return { density: 0.42, flow: 0.7, pressure: 0.35, strain: false, calm: true };
  if (mode === 'planning') return { density: 0.55, flow: 1.0, pressure: 0.55, strain: false, calm: true };
  if (mode === 'reasoning') return { density: 0.72, flow: 1.35, pressure: 0.8, strain: false, calm: false };
  if (mode === 'reading') return { density: 0.62, flow: 1.7, pressure: 0.65, strain: false, calm: false };
  if (mode === 'writing') return { density: 0.76, flow: 1.45, pressure: 0.9, strain: false, calm: false };
  if (mode === 'bash') return { density: 0.78, flow: 1.2, pressure: 0.95, strain: false, calm: false };
  if (mode === 'verifying') return { density: 0.68, flow: 0.85, pressure: 0.7, strain: false, calm: true };
  if (mode === 'completed') return { density: 0.56, flow: 0.55, pressure: 0.45, strain: false, calm: true };
  if (mode === 'blocked') return { density: 0.58, flow: 0.65, pressure: 0.75, strain: true, calm: true };
  return { density: 0.8, flow: 0.9, pressure: 1.0, strain: true, calm: false };
}

function statePalette(mode: DottedMode, frame: number): [ThermalColor, ThermalColor, ThermalColor] {
  const wave = (Math.sin(frame * 0.24) + 1) / 2;
  const blue: ThermalColor = { r: 64, g: 142, b: 230 };
  const cyan: ThermalColor = { r: 65, g: 210, b: 220 };
  const green: ThermalColor = { r: 94, g: 226, b: 142 };
  const amber: ThermalColor = { r: 226, g: 157, b: 62 };
  const red: ThermalColor = { r: 224, g: 78, b: 64 };
  const dim: ThermalColor = { r: 56, g: 78, b: 132 };

  if (mode === 'failure') return [mix(amber, red, 0.4), red, mix(red, amber, wave * 0.18)];
  if (mode === 'blocked') return [mix(dim, amber, 0.45), amber, mix(amber, red, 0.22 + wave * 0.12)];
  if (mode === 'completed' || mode === 'verifying') return [mix(dim, green, 0.35), mix(cyan, green, 0.55), green];
  if (mode === 'idle') return [mix(dim, blue, 0.4), blue, mix(blue, cyan, 0.3 + wave * 0.18)];

  const heat = profileForMode(mode).pressure;
  return [mix(blue, cyan, 0.25 + wave * 0.15), mix(cyan, green, Math.min(0.65, heat * 0.45)), green];
}

function normalizeMode(mode: CoreMode): DottedMode {
  if (mode === 'thinking') return 'reasoning';
  if (mode === 'tool_execution') return 'reasoning';
  if (mode === 'error') return 'failure';
  return mode;
}

function colorize(ch: string, color: ThermalColor): string {
  return `\u001b[38;2;${color.r};${color.g};${color.b}m${ch}${RESET}`;
}

function mix(a: ThermalColor, b: ThermalColor, amount: number): ThermalColor {
  const n = Math.max(0, Math.min(1, amount));
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
