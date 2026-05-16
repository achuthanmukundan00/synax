import { resolveCoreVisualProfile, type CoreVisualProfile } from './core-visual-profile';

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
  | 'unloaded'
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
  visualProfile: CoreVisualProfile;
  palette: [MaterialColor, MaterialColor, MaterialColor];
  unicode: boolean;
}

interface MaterialColor {
  r: number;
  g: number;
  b: number;
}

type NormalizedCoreMode =
  | 'idle'
  | 'thinking'
  | 'tool_execution'
  | 'verifying'
  | 'blocked'
  | 'completed'
  | 'failure'
  | 'unloaded';

const RESET = '\u001b[0m';

export function modePromptColor(mode: CoreMode, nowMs: number): string {
  const t = nowMs / 1000;
  const shimmer = Math.sin(t * 2.5) * 0.07 + 0.93; // gentle 0.86–1.0 pulse
  const base = modeBaseRgb(mode);
  const r = clampByte(Math.round(base.r * shimmer));
  const g = clampByte(Math.round(base.g * shimmer));
  const b = clampByte(Math.round(base.b * shimmer));
  return `\u001b[38;2;${r};${g};${b}m`;
}

function modeBaseRgb(mode: CoreMode): { r: number; g: number; b: number } {
  if (mode === 'blocked') return { r: 190, g: 133, b: 54 };
  if (mode === 'failure' || mode === 'error') return { r: 183, g: 65, b: 52 };
  if (mode === 'completed') return { r: 83, g: 156, b: 108 };
  if (mode === 'verifying') return { r: 86, g: 141, b: 178 };
  if (mode === 'unloaded') return { r: 100, g: 100, b: 100 };
  return { r: 58, g: 109, b: 176 };
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, v));
}

export function modeColor(mode: CoreMode): string {
  if (mode === 'blocked') return '\u001b[33m';
  if (mode === 'failure' || mode === 'error') return '\u001b[31m';
  if (mode === 'completed') return '\u001b[32m';
  if (mode === 'verifying') return '\u001b[34m';
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

export function renderAiCore(
  mode: CoreMode,
  t: number,
  profile: CoreVisualProfile = resolveCoreVisualProfile(''),
): string[] {
  return renderDottedCore({
    mode,
    frame: Math.floor(t * 8),
    width: CORE_WIDTH,
    height: CORE_HEIGHT,
    unicode: true,
    profile,
  });
}

export function renderDottedCore(opts: {
  mode: CoreMode;
  frame: number;
  width: number;
  height: number;
  unicode?: boolean;
  profile?: CoreVisualProfile;
}): string[] {
  const normalized = normalizeMode(opts.mode);
  if (normalized === 'unloaded') {
    return renderUnloadedCore(clamp(Math.floor(opts.width), 1, 80), clamp(Math.floor(opts.height), 1, 40));
  }
  const visualProfile = opts.profile ?? resolveCoreVisualProfile('');
  const state: FieldState = {
    mode: normalized,
    frame: Math.floor(opts.frame * visualProfile.motion.breathRate),
    profile: applyVisualProfile(profileForMode(normalized), visualProfile),
    visualProfile,
    palette: paletteForVisualProfile(paletteForMode(normalized, opts.frame), normalized, visualProfile),
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
    Math.sin(angle * (2.1 + p.flow * 0.35 + morphologyPhase(state.visualProfile)) + frame * 0.16 * p.flow) +
    Math.sin(nx * 4.6 - ny * 1.7 + frame * 0.11 * p.flow + morphologyShear(state.visualProfile, nx, ny)) * 0.45;
  const harmonic = Math.sin((x + y * 1.8 + frame * p.sync) * 0.62);
  const lockedPulse = Math.abs(Math.sin(frame * 0.42 + y * 0.35));
  const stress = p.strain && positiveModulo(x * 7 + y * 11 + frame, 13) < 3;
  const sx = Math.min(x, width - 1 - x);
  const sy = Math.min(y, height - 1 - y);
  const grainFrame = p.stable ? 0 : frame;
  const grain = positiveModulo(sx * 29 + sy * 17 + grainFrame * 5, 97) / 97;
  const density =
    p.density +
    central * centralDensity(state.visualProfile) +
    (containment < 0.09 ? containmentDensity(state.visualProfile) : 0) +
    Math.max(0, flow) * 0.12;
  const chamber = innerChamberGlyph(state, x, y, width, height);

  if (!chamber && grain > density && containment > 0.045 && central < 0.62) return ' ';

  const glyphs = glyphSet(state.unicode, state.visualProfile);
  let ch = glyphs.small;
  let color: MaterialColor = state.palette[0];

  const profileGlyph = innerMorphologyGlyph(state, x, y, nx, ny, central, radius, angle);
  if (profileGlyph) {
    ch = profileGlyph;
    color = central > 0.48 ? state.palette[2] : state.palette[1];
  }

  if (chamber) {
    ch = chamber;
    color = state.palette[1];
  } else if (state.mode === 'tool_execution' && isToolScanCell(state, x, y, frame, containment, ny)) {
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

function innerChamberGlyph(state: FieldState, x: number, y: number, width: number, height: number): string | undefined {
  if (!state.unicode) return undefined;
  const centerX = Math.floor(width / 2);
  const centerY = Math.floor(height / 2);
  const halfWidth = chamberHalfWidth(state.visualProfile, width);
  const halfHeight = chamberHalfHeight(state.visualProfile, height);
  const left = centerX - halfWidth;
  const right = centerX + halfWidth;
  const top = centerY - halfHeight;
  const bottom = centerY + halfHeight;

  if (x < left || x > right || y < top || y > bottom) return undefined;
  if (x === left && y === top) return '╭';
  if (x === right && y === top) return '╮';
  if (x === left && y === bottom) return '╰';
  if (x === right && y === bottom) return '╯';
  if (y === top || y === bottom) return '─';
  if (x === left || x === right) return '│';
  return undefined;
}

function chamberHalfWidth(visualProfile: CoreVisualProfile, width: number): number {
  const base = visualProfile.geometry === 'organic' ? 0.2 : visualProfile.geometry === 'furnace' ? 0.14 : 0.16;
  return clamp(Math.round(width * base), 3, Math.max(3, Math.floor(width / 2) - 2));
}

function chamberHalfHeight(visualProfile: CoreVisualProfile, height: number): number {
  const base = visualProfile.geometry === 'organic' ? 0.24 : 0.2;
  return clamp(Math.round(height * base), 1, Math.max(1, Math.floor(height / 2) - 1));
}

function glyphSet(
  unicode: boolean,
  visualProfile: CoreVisualProfile,
): {
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
  if (visualProfile.id === 'claude') {
    return {
      small: '.',
      mid: '·',
      large: '◎',
      stable: '◉',
      compressed: '═',
      sync: '━',
      stress: '×',
      line: (angle) => {
        if (Math.abs(Math.sin(angle)) < 0.24) return '─';
        if (Math.abs(Math.cos(angle)) < 0.24) return '│';
        return '·';
      },
    };
  }
  if (visualProfile.id === 'qwen') {
    return {
      small: '˙',
      mid: '·',
      large: '●',
      stable: '◎',
      compressed: '═',
      sync: '━',
      stress: '×',
      line: (angle) => {
        if (Math.abs(Math.sin(angle)) < 0.3) return '─';
        if (Math.abs(Math.cos(angle)) < 0.3) return '│';
        return Math.sin(angle) * Math.cos(angle) > 0 ? '╲' : '╱';
      },
    };
  }
  if (visualProfile.id === 'openai') {
    return {
      small: '.',
      mid: ':',
      large: '●',
      stable: '◎',
      compressed: '═',
      sync: '━',
      stress: '×',
      line: (angle) => {
        if (Math.abs(Math.sin(angle)) < 0.36) return '─';
        if (Math.abs(Math.cos(angle)) < 0.36) return '│';
        return '·';
      },
    };
  }
  if (visualProfile.id === 'deepseek') {
    return {
      small: '˙',
      mid: ':',
      large: '◉',
      stable: '◉',
      compressed: '═',
      sync: '━',
      stress: '×',
      line: (angle) => (Math.abs(Math.sin(angle)) < 0.44 ? '━' : '│'),
    };
  }
  if (visualProfile.id === 'gemini') {
    return {
      small: '.',
      mid: '·',
      large: '●',
      stable: '◉',
      compressed: '═',
      sync: '━',
      stress: '×',
      line: (angle) => {
        if (Math.abs(Math.sin(angle)) < 0.3) return '─';
        if (Math.abs(Math.cos(angle)) < 0.3) return '│';
        return '·';
      },
    };
  }
  return {
    small: '.',
    mid: '·',
    large: '●',
    stable: '◎',
    compressed: '═',
    sync: '━',
    stress: '×',
    line: (angle) => {
      if (Math.abs(Math.sin(angle)) < 0.32) return '─';
      if (Math.abs(Math.cos(angle)) < 0.32) return '│';
      return Math.sin(angle) * Math.cos(angle) > 0 ? '╲' : '╱';
    },
  };
}

function applyVisualProfile(profile: CoreProfile, visualProfile: CoreVisualProfile): CoreProfile {
  const bias = visualBiases(visualProfile);
  return {
    ...profile,
    density: clamp(profile.density + bias.density, 0.04, 0.82),
    flow: clamp(profile.flow + bias.flow, 0, 2),
    compression: clamp(profile.compression + bias.compression, 0, 0.7),
    sync: clamp(profile.sync + bias.sync, 0, 1.2),
    stable: profile.stable || visualProfile.id === 'openai',
  };
}

function visualBiases(visualProfile: CoreVisualProfile): {
  density: number;
  flow: number;
  compression: number;
  sync: number;
} {
  if (visualProfile.geometry === 'lattice') return { density: 0.07, flow: 0.12, compression: 0.02, sync: 0.22 };
  if (visualProfile.geometry === 'lens') return { density: -0.02, flow: -0.08, compression: -0.03, sync: 0.05 };
  if (visualProfile.geometry === 'organic') return { density: 0.02, flow: -0.03, compression: -0.04, sync: -0.08 };
  if (visualProfile.geometry === 'furnace') return { density: 0.11, flow: -0.12, compression: 0.16, sync: -0.03 };
  if (visualProfile.geometry === 'twin') return { density: 0.04, flow: 0.08, compression: 0, sync: 0.14 };
  return { density: 0, flow: 0, compression: 0, sync: 0 };
}

function paletteForVisualProfile(
  palette: [MaterialColor, MaterialColor, MaterialColor],
  mode: NormalizedCoreMode,
  visualProfile: CoreVisualProfile,
): [MaterialColor, MaterialColor, MaterialColor] {
  if (mode === 'blocked' || mode === 'failure' || mode === 'completed' || mode === 'verifying') return palette;
  const accent = accentForVisualProfile(visualProfile);
  return [mix(palette[0], accent, 0.08), mix(palette[1], accent, 0.16), mix(palette[2], accent, 0.2)];
}

function accentForVisualProfile(visualProfile: CoreVisualProfile): MaterialColor {
  if (visualProfile.colorRole === 'green') return { r: 83, g: 156, b: 108 };
  if (visualProfile.colorRole === 'blue') return { r: 96, g: 136, b: 188 };
  if (visualProfile.colorRole === 'violet') return { r: 118, g: 103, b: 184 };
  if (visualProfile.colorRole === 'red') return { r: 183, g: 65, b: 52 };
  if (visualProfile.colorRole === 'gold') return { r: 172, g: 126, b: 88 };
  return { r: 58, g: 109, b: 176 };
}

function morphologyPhase(visualProfile: CoreVisualProfile): number {
  if (visualProfile.geometry === 'lattice') return 0.42;
  if (visualProfile.geometry === 'organic') return -0.22;
  if (visualProfile.geometry === 'furnace') return -0.38;
  if (visualProfile.geometry === 'twin') return 0.28;
  return 0;
}

function morphologyShear(visualProfile: CoreVisualProfile, nx: number, ny: number): number {
  if (visualProfile.geometry === 'lattice') return Math.sin((nx + ny) * 5.5) * 0.25;
  if (visualProfile.geometry === 'organic') return Math.sin(nx * ny * 3.2) * 0.18;
  if (visualProfile.geometry === 'furnace') return -Math.abs(ny) * 0.35;
  if (visualProfile.geometry === 'twin') return Math.sin(nx * 4.8) * 0.28;
  return 0;
}

function centralDensity(visualProfile: CoreVisualProfile): number {
  const layout = nucleusLayout(visualProfile);
  if (layout === 'dense') return 0.46;
  if (layout === 'soft') return 0.24;
  if (layout === 'twin') return 0.2;
  return 0.3;
}

function containmentDensity(visualProfile: CoreVisualProfile): number {
  if (visualProfile.geometry === 'lattice') return 0.42;
  if (visualProfile.geometry === 'organic') return 0.24;
  if (visualProfile.geometry === 'furnace') return 0.36;
  return 0.32;
}

function nucleusLayout(visualProfile: CoreVisualProfile): 'single' | 'soft' | 'dense' | 'twin' {
  if (visualProfile.geometry === 'organic') return 'soft';
  if (visualProfile.geometry === 'furnace') return 'dense';
  if (visualProfile.geometry === 'twin') return 'twin';
  return 'single';
}

function innerMorphologyGlyph(
  state: FieldState,
  x: number,
  y: number,
  nx: number,
  ny: number,
  central: number,
  radius: number,
  angle: number,
): string | undefined {
  if (!state.unicode) return undefined;
  const profile = state.visualProfile;
  const layout = nucleusLayout(profile);
  const stableFrame = state.profile.stable ? 0 : state.frame;
  if (layout === 'twin') {
    const phase = Math.sin(stableFrame * 0.22) * 0.025;
    const left = Math.hypot(nx + 0.2 + phase, ny);
    const right = Math.hypot(nx - 0.2 - phase, ny);
    if (left < 0.13 || right < 0.13) return stableFrame % 2 === 0 ? '●' : '◉';
    if (Math.abs(left - right) < 0.035 && radius < 0.55 && positiveModulo(x + y + stableFrame, 4) === 0) return '·';
  }
  if (layout === 'soft' && central > 0.58) {
    return central > 0.78 ? '◉' : '◎';
  }
  if (layout === 'dense' && central > 0.46) {
    return central > 0.7 ? '◎' : '◉';
  }
  if (profile.geometry === 'lattice' && radius > 0.24 && radius < 0.74) {
    const diagonalA = Math.abs(Math.sin((nx + ny) * 7 + stableFrame * 0.08));
    const diagonalB = Math.abs(Math.sin((nx - ny) * 7 - stableFrame * 0.08));
    if (diagonalA < 0.12 || diagonalB < 0.12) return Math.sin(angle) * Math.cos(angle) > 0 ? '╲' : '╱';
  }
  if (profile.geometry === 'lens' && central > 0.68) return central > 0.82 ? '◎' : '●';
  if (profile.geometry === 'default' && central > 0.72 && positiveModulo(x + y, 2) === 0) return '●';
  if (
    profile.geometry === 'furnace' &&
    Math.abs(ny) < 0.18 &&
    radius < 0.68 &&
    positiveModulo(x + stableFrame, 2) === 0
  ) {
    return Math.abs(ny) < 0.08 ? '═' : '━';
  }
  if (profile.geometry === 'twin' && Math.abs(nx) < 0.05 && radius < 0.62 && positiveModulo(y + stableFrame, 3) === 0) {
    return '│';
  }
  return undefined;
}

function isToolScanCell(
  state: FieldState,
  x: number,
  y: number,
  frame: number,
  containment: number,
  ny: number,
): boolean {
  if (state.mode !== 'tool_execution') return false;
  if (state.visualProfile.motion.scanStyle === 'beam') {
    return Math.abs(ny) < 0.2 && positiveModulo(x + frame, 3) === 0;
  }
  if (state.visualProfile.motion.scanStyle === 'split') {
    return containment < 0.08 && positiveModulo(x - y + frame, 5) === 0;
  }
  return containment < 0.075 && positiveModulo(x + frame, 4) === 0;
}

function profileForMode(mode: NormalizedCoreMode): CoreProfile {
  if (mode === 'idle') {
    return { density: 0.12, flow: 0.02, pressure: 0.18, compression: 0.06, sync: 0.08, strain: false, stable: true };
  }
  if (mode === 'unloaded') {
    return { density: 0.14, flow: 0, pressure: 0, compression: 0, sync: 0, strain: false, stable: true };
  }
  if (mode === 'thinking') {
    return { density: 0.3, flow: 1.0, pressure: 0.82, compression: 0.12, sync: 0.42, strain: false, stable: false };
  }
  if (mode === 'tool_execution') {
    return { density: 0.32, flow: 0.82, pressure: 1.0, compression: 0.38, sync: 0.34, strain: false, stable: false };
  }
  if (mode === 'verifying') {
    return { density: 0.24, flow: 0.5, pressure: 0.62, compression: 0.18, sync: 0.72, strain: false, stable: true };
  }
  if (mode === 'completed') {
    return { density: 0.16, flow: 0.02, pressure: 0.28, compression: 0.08, sync: 0.08, strain: false, stable: true };
  }
  if (mode === 'blocked') {
    return { density: 0.28, flow: 0.38, pressure: 0.78, compression: 0.32, sync: 0.34, strain: true, stable: false };
  }
  if (mode === 'failure') {
    return { density: 0.3, flow: 0.42, pressure: 1.0, compression: 0.4, sync: 0.5, strain: true, stable: true };
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
  if (mode === 'unloaded') return [steel, steel, steel];
  if (mode === 'idle') return [mix(steel, deepBlue, 0.44), mix(deepBlue, blue, 0.36), mix(blue, steel, 0.2)];
  return [mix(steel, deepBlue, 0.38), blue, mix(blue, { r: 93, g: 140, b: 190 }, 0.35 + wave * 0.14)];
}

function normalizeMode(mode: CoreMode): NormalizedCoreMode {
  if (mode === 'unloaded') return 'unloaded';
  if (mode === 'tool_execution' || mode === 'reading' || mode === 'writing' || mode === 'bash') return 'tool_execution';
  if (mode === 'verifying') return 'verifying';
  if (mode === 'completed') return 'completed';
  if (mode === 'blocked') return 'blocked';
  if (mode === 'failure' || mode === 'error') return 'failure';
  if (mode === 'idle') return 'idle';
  return 'thinking';
}

function renderUnloadedCore(width: number, height: number): string[] {
  return Array.from({ length: height }, (_, y) => {
    let row = '';
    for (let x = 0; x < width; x += 1) {
      const nx = ((x + 0.5) / width - 0.5) * 2.1;
      const ny = ((y + 0.5) / height - 0.5) * 2.45;
      const radius = Math.sqrt(nx * nx + ny * ny);
      if (radius > 1.1) {
        row += ' ';
      } else if (Math.abs(radius - 0.72) < 0.05 && positiveModulo(x + y, 3) === 0) {
        row += '\u001b[90m.\u001b[0m';
      } else if (radius < 0.18) {
        row += '\u001b[90m·\u001b[0m';
      } else {
        row += ' ';
      }
    }
    return row;
  });
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
