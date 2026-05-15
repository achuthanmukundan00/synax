/**
 * Minimal theme system for the Synax presentation layer.
 *
 * Two built-in themes:
 * - morphology: expressive default with Unicode glyphs and ANSI color
 * - ascii: plain fallback with no Unicode or color dependency
 *
 * Options support color on/off, unicode on/off, density, and a motion
 * intensity placeholder for future animation support.
 */

export type Density = 'compact' | 'normal' | 'spacious';

export interface ThemeGlyphs {
  user: string;
  tool: string;
  subagent: string;
  memory: string;
  synthesis: string;
  result: string;
  handoff: string;
  warning: string;
  error: string;
  question: string;
}

export interface ThemeColors {
  header: string;
  dim: string;
  accent: string;
  label: string;
  key: string;
  value: string;
  rule: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  user: string;
  tool: string;
  subagent: string;
  memory: string;
  synthesis: string;
  result: string;
  handoff: string;
  muted: string;
}

export interface Theme {
  name: string;
  glyphs: ThemeGlyphs;
  colors: ThemeColors;
  density: Density;
  /** ANSI escape prefix (empty string if color disabled). */
  ansi(seq: string): string;
  /** Reset ANSI styling. */
  reset: string;
  /** Padding between major blocks in lines. */
  blockPadding: number;
  /** Character for horizontal rules. */
  ruleChar: string;
  /** Width of horizontal rules (0 = full terminal width). */
  ruleWidth: number;
  /** Indent for block content (spaces). */
  contentIndent: number;
  /** Indent for key-value lines inside blocks (spaces). */
  kvIndent: number;
}

// ─── ANSI helpers ────────────────────────────────────────────────────────────────

const SGR = (code: string): string => `\u001b[${code}m`;
const RESET = SGR('0');

function ansiFactory(useColor: boolean): (seq: string) => string {
  if (!useColor) return () => '';
  return (seq: string) => SGR(seq);
}

// ─── Morphology theme ────────────────────────────────────────────────────────────

function morphologyColors(useColor: boolean): ThemeColors {
  const base = {
    header: '1;36', // bold cyan
    dim: '2;37', // dim white
    accent: '1;35', // bold magenta
    label: '1;37', // bold white
    key: '36', // cyan
    value: '37', // white
    rule: '36', // cyan
    success: '32', // green
    warning: '33', // yellow
    error: '1;31', // bold red
    info: '34', // blue
    user: '1;33', // bold yellow
    tool: '36', // cyan
    subagent: '1;35', // bold magenta
    memory: '1;34', // bold blue
    synthesis: '1;36', // bold cyan
    result: '1;32', // bold green
    handoff: '1;33', // bold yellow
    muted: '90', // bright black
  };
  if (!useColor) {
    // In no-color mode, all colors become empty
    const empty: ThemeColors = {} as ThemeColors;
    for (const k of Object.keys(base) as Array<keyof ThemeColors>) {
      empty[k] = '';
    }
    return empty;
  }
  return base;
}

export function createMorphologyTheme(options?: { color?: boolean; unicode?: boolean; density?: Density }): Theme {
  const color = options?.color ?? true;
  const unicode = options?.unicode ?? true;
  const density = options?.density ?? 'normal';
  const ansi = ansiFactory(color);

  const blockPadding = density === 'compact' ? 0 : density === 'spacious' ? 2 : 1;
  const contentIndent = 2;
  const kvIndent = contentIndent + 4;

  const glyphs: ThemeGlyphs = unicode
    ? {
        user: '›',
        tool: '$',
        subagent: '✦',
        memory: '◇',
        synthesis: '✶',
        result: '◆',
        handoff: '↳',
        warning: '!',
        error: '×',
        question: '?',
      }
    : {
        user: '>',
        tool: '$',
        subagent: '*',
        memory: '#',
        synthesis: '~',
        result: '#',
        handoff: '->',
        warning: '!',
        error: 'X',
        question: '?',
      };

  return {
    name: 'morphology',
    glyphs,
    colors: morphologyColors(color),
    density,
    ansi,
    reset: color ? RESET : '',
    blockPadding,
    ruleChar: '─',
    ruleWidth: 0, // full width
    contentIndent,
    kvIndent,
  };
}

export function createAsciiTheme(options?: { density?: Density }): Theme {
  return createMorphologyTheme({ color: false, unicode: false, density: options?.density });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────

/** Format a key-value line with theme styling. */
export function kvLine(theme: Theme, key: string, value: string, indent: number = theme.kvIndent): string {
  const pad = ' '.repeat(indent);
  return `${pad}${theme.ansi(theme.colors.key)}${key}${theme.reset}${' '.repeat(
    Math.max(2, 16 - key.length),
  )}${theme.ansi(theme.colors.value)}${value}${theme.reset}`;
}

/** Render a horizontal rule. */
export function hrLine(theme: Theme, terminalWidth?: number): string {
  const width = theme.ruleWidth > 0 ? theme.ruleWidth : (terminalWidth ?? 80);
  const char = theme.ruleChar;
  return theme.ansi(theme.colors.rule) + char.repeat(Math.max(1, width)) + theme.reset;
}

/** Render a glyph + bold label header. */
export function glyphLabel(theme: Theme, glyph: string, label: string, colorKey: keyof ThemeColors): string {
  const color = theme.colors[colorKey] || theme.colors.accent;
  return `${theme.ansi(color)}${glyph}${theme.reset} ${theme.ansi(theme.colors.label)}${label}${theme.reset}`;
}

/** Render a compact status badge. */
export function badge(theme: Theme, text: string, kind: 'ok' | 'error' | 'warn' | 'info'): string {
  const color =
    kind === 'ok'
      ? theme.colors.success
      : kind === 'error'
        ? theme.colors.error
        : kind === 'warn'
          ? theme.colors.warning
          : theme.colors.info;
  return `${theme.ansi(color)}${text}${theme.reset}`;
}
