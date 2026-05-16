export type SemanticColorSlot =
  | 'plan'
  | 'edit'
  | 'diff'
  | 'command'
  | 'tool_result'
  | 'result_error'
  | 'review'
  | 'commit'
  | 'checkpoint'
  | 'approval'
  | 'status'
  | 'error'
  | 'prompt'
  | 'note'
  | 'assistant_text';

export type RgbaHex = string;

export interface TuiPalette {
  name: string;
  semantic: Record<SemanticColorSlot, RgbaHex>;
  background: RgbaHex;
  surface: RgbaHex;
  border: RgbaHex;
  text: RgbaHex;
  textMuted: RgbaHex;
  textAccent: RgbaHex;
  success: RgbaHex;
  error: RgbaHex;
  warning: RgbaHex;
  info: RgbaHex;
  brand: RgbaHex;
}

const DEFAULT_SEMANTIC: Record<SemanticColorSlot, RgbaHex> = {
  plan: '#bd93f9',
  edit: '#00ff87',
  diff: '#bd93f9',
  command: '#8be9fd',
  tool_result: '#00ff87',
  result_error: '#ff5555',
  review: '#ffb86c',
  commit: '#bd93f9',
  checkpoint: '#00ff87',
  approval: '#ffb86c',
  status: '#6272a4',
  error: '#ff5555',
  prompt: '#8a8f98',
  note: '#6272a4',
  assistant_text: '#6272a4',
};

const PALETTES: Record<string, TuiPalette> = {
  default: {
    name: 'default',
    semantic: { ...DEFAULT_SEMANTIC },
    background: '#050505',
    surface: '#111111',
    border: '#333333',
    text: '#ffffff',
    textMuted: '#cccccc',
    textAccent: '#6272a4',
    success: '#00ff87',
    error: '#ff5555',
    warning: '#ffb86c',
    info: '#8be9fd',
    brand: '#bd93f9',
  },
  dark: {
    name: 'dark',
    semantic: { ...DEFAULT_SEMANTIC },
    background: '#0a0a0a',
    surface: '#1a1a1a',
    border: '#444444',
    text: '#e0e0e0',
    textMuted: '#aaaaaa',
    textAccent: '#888888',
    success: '#00ff87',
    error: '#ff5555',
    warning: '#ffb86c',
    info: '#8be9fd',
    brand: '#bd93f9',
  },
  light: {
    name: 'light',
    semantic: {
      plan: '#8b5cf6',
      edit: '#16a34a',
      diff: '#8b5cf6',
      command: '#0891b2',
      tool_result: '#16a34a',
      result_error: '#dc2626',
      review: '#d97706',
      commit: '#8b5cf6',
      checkpoint: '#16a34a',
      approval: '#d97706',
      status: '#6b7280',
      error: '#dc2626',
      prompt: '#6b7280',
      note: '#6b7280',
      assistant_text: '#6b7280',
    },
    background: '#f8f8f8',
    surface: '#ffffff',
    border: '#e0e0e0',
    text: '#1a1a1a',
    textMuted: '#666666',
    textAccent: '#888888',
    success: '#16a34a',
    error: '#dc2626',
    warning: '#d97706',
    info: '#0891b2',
    brand: '#8b5cf6',
  },
  'high-contrast': {
    name: 'high-contrast',
    semantic: {
      plan: '#ff79ff',
      edit: '#50fa70',
      diff: '#ff79ff',
      command: '#66d9ef',
      tool_result: '#50fa70',
      result_error: '#ff3333',
      review: '#f1fa8c',
      commit: '#ff79ff',
      checkpoint: '#50fa70',
      approval: '#f1fa8c',
      status: '#bbbbbb',
      error: '#ff3333',
      prompt: '#bbbbbb',
      note: '#bbbbbb',
      assistant_text: '#bbbbbb',
    },
    background: '#000000',
    surface: '#000000',
    border: '#ffffff',
    text: '#ffffff',
    textMuted: '#cccccc',
    textAccent: '#ffffff',
    success: '#50fa70',
    error: '#ff3333',
    warning: '#f1fa8c',
    info: '#66d9ef',
    brand: '#ff79ff',
  },
};

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const defaultPalette: TuiPalette = PALETTES['default']!;

export function getPalette(name?: string): TuiPalette {
  let key = (name ?? 'default').toLowerCase();
  if (key === 'dracula') key = 'default';
  return PALETTES[key] ?? defaultPalette;
}

export function getPaletteNames(): string[] {
  return Object.keys(PALETTES);
}

export function applyConfigOverrides(
  palette: TuiPalette,
  overrides: Partial<Record<SemanticColorSlot, string>> | undefined,
): TuiPalette {
  if (!overrides) return palette;
  const semantic = { ...palette.semantic };
  for (const [slot, color] of Object.entries(overrides)) {
    if (color && slot in semantic) {
      semantic[slot as SemanticColorSlot] = color;
    }
  }
  return { ...palette, semantic };
}

export async function detectThemeMode(renderer?: {
  waitForThemeMode?: () => Promise<'dark' | 'light'>;
}): Promise<'dark' | 'light'> {
  if (renderer?.waitForThemeMode) {
    try {
      return await renderer.waitForThemeMode();
    } catch {
      // fall through
    }
  }
  const colorFgBgMode = detectColorFgBgTheme(process.env.COLORFGBG);
  if (colorFgBgMode) return colorFgBgMode;
  return 'dark';
}

export function detectColorFgBgTheme(value: string | undefined): 'dark' | 'light' | undefined {
  if (!value) return undefined;
  const parts = value.split(';');
  const rawBackground = parts.at(-1);
  if (!rawBackground) return undefined;
  const background = Number.parseInt(rawBackground, 10);
  if (!Number.isFinite(background)) return undefined;

  // Common COLORFGBG values use 0-7/8-15 ANSI indexes. Treat white/bright
  // backgrounds as light when OpenTUI cannot query terminal theme directly.
  if (background === 7 || background === 15) return 'light';
  if (background >= 0 && background <= 6) return 'dark';
  if (background >= 8 && background <= 14) return 'dark';
  return undefined;
}
