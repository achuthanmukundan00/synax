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
  | 'assistant_text'
  | 'dispatch'
  | 'agent_status'
  | 'thinking';

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
  plan: '#888888',
  edit: '#5f8fc7',
  diff: '#5f8fc7',
  command: '#5f8fc7',
  tool_result: '#7ec87e',
  result_error: '#cc6666',
  review: '#d4a050',
  commit: '#7ec87e',
  checkpoint: '#7ec87e',
  approval: '#d4a050',
  status: '#707070',
  error: '#cc6666',
  prompt: '#888888',
  note: '#888888',
  assistant_text: '#a0a0a0',
  dispatch: '#5f8fc7',
  agent_status: '#d4879c',
  thinking: '#b487d4',
};

const PALETTES: Record<string, TuiPalette> = {
  mono: {
    name: 'mono',
    semantic: { ...DEFAULT_SEMANTIC },
    background: '#0d0d0d',
    surface: '#161616',
    border: '#2a2a2a',
    text: '#e0e0e0',
    textMuted: '#707070',
    textAccent: '#a0a0a0',
    success: '#7ec87e',
    error: '#cc6666',
    warning: '#d4a050',
    info: '#888888',
    brand: '#a0a0a0',
  },
  gruvbox: {
    name: 'gruvbox',
    semantic: {
      plan: '#d3869b',
      edit: '#83a598',
      diff: '#83a598',
      command: '#83a598',
      tool_result: '#b8bb26',
      result_error: '#fb4934',
      review: '#fabd2f',
      commit: '#b8bb26',
      checkpoint: '#b8bb26',
      approval: '#fabd2f',
      status: '#7c6f64',
      error: '#fb4934',
      prompt: '#a89984',
      note: '#7c6f64',
      assistant_text: '#a89984',
      dispatch: '#83a598',
      agent_status: '#d3869b',
      thinking: '#d3869b',
    },
    background: '#1d2021',
    surface: '#282828',
    border: '#3c3836',
    text: '#ebdbb2',
    textMuted: '#7c6f64',
    textAccent: '#a89984',
    success: '#b8bb26',
    error: '#fb4934',
    warning: '#fabd2f',
    info: '#83a598',
    brand: '#a89984',
  },
  kanagawa: {
    name: 'kanagawa',
    semantic: {
      plan: '#957fb8',
      edit: '#7fb4ca',
      diff: '#7fb4ca',
      command: '#7fb4ca',
      tool_result: '#98bb6c',
      result_error: '#c3403a',
      review: '#e6c384',
      commit: '#98bb6c',
      checkpoint: '#98bb6c',
      approval: '#e6c384',
      status: '#5f607a',
      error: '#c3403a',
      prompt: '#8489a7',
      note: '#5f607a',
      assistant_text: '#8489a7',
      dispatch: '#7fb4ca',
      agent_status: '#d27e99',
      thinking: '#d27e99',
    },
    background: '#1f1f2e',
    surface: '#262637',
    border: '#36364b',
    text: '#dcd7ba',
    textMuted: '#5f607a',
    textAccent: '#8489a7',
    success: '#98bb6c',
    error: '#c3403a',
    warning: '#e6c384',
    info: '#7fb4ca',
    brand: '#8489a7',
  },
  catppuccin: {
    name: 'catppuccin',
    semantic: {
      plan: '#cba6f7',
      edit: '#89b4fa',
      diff: '#89b4fa',
      command: '#89b4fa',
      tool_result: '#a6e3a1',
      result_error: '#f38ba8',
      review: '#f9e2af',
      commit: '#a6e3a1',
      checkpoint: '#a6e3a1',
      approval: '#f9e2af',
      status: '#6c7086',
      error: '#f38ba8',
      prompt: '#a6adc8',
      note: '#6c7086',
      assistant_text: '#a6adc8',
      dispatch: '#89b4fa',
      agent_status: '#f5c2e7',
      thinking: '#f5c2e7',
    },
    background: '#1e1e2e',
    surface: '#252538',
    border: '#363a4f',
    text: '#cdd6f4',
    textMuted: '#6c7086',
    textAccent: '#a6adc8',
    success: '#a6e3a1',
    error: '#f38ba8',
    warning: '#f9e2af',
    info: '#89b4fa',
    brand: '#a6adc8',
  },
  nord: {
    name: 'nord',
    semantic: {
      plan: '#88c0d0',
      edit: '#81a1c1',
      diff: '#81a1c1',
      command: '#81a1c1',
      tool_result: '#a3be8c',
      result_error: '#bf616a',
      review: '#ebcb8b',
      commit: '#a3be8c',
      checkpoint: '#a3be8c',
      approval: '#ebcb8b',
      status: '#616e88',
      error: '#bf616a',
      prompt: '#81a1c1',
      note: '#616e88',
      assistant_text: '#81a1c1',
      dispatch: '#81a1c1',
      agent_status: '#b48ead',
      thinking: '#b48ead',
    },
    background: '#2e3440',
    surface: '#353b49',
    border: '#434c5e',
    text: '#d8dee9',
    textMuted: '#616e88',
    textAccent: '#81a1c1',
    success: '#a3be8c',
    error: '#bf616a',
    warning: '#ebcb8b',
    info: '#81a1c1',
    brand: '#81a1c1',
  },
  'rose-pine': {
    name: 'rose-pine',
    semantic: {
      plan: '#c4a7e7',
      edit: '#9ccfd8',
      diff: '#9ccfd8',
      command: '#9ccfd8',
      tool_result: '#ebbcba',
      result_error: '#eb6f92',
      review: '#f6c177',
      commit: '#ebbcba',
      checkpoint: '#ebbcba',
      approval: '#f6c177',
      status: '#6e6a86',
      error: '#eb6f92',
      prompt: '#908caa',
      note: '#6e6a86',
      assistant_text: '#908caa',
      dispatch: '#9ccfd8',
      agent_status: '#c4a7e7',
      thinking: '#c4a7e7',
    },
    background: '#191724',
    surface: '#211f2d',
    border: '#312f44',
    text: '#e0def4',
    textMuted: '#6e6a86',
    textAccent: '#908caa',
    success: '#ebbcba',
    error: '#eb6f92',
    warning: '#f6c177',
    info: '#9ccfd8',
    brand: '#908caa',
  },
  'tokyo-night': {
    name: 'tokyo-night',
    semantic: {
      plan: '#7aa2f7',
      edit: '#73daca',
      diff: '#73daca',
      command: '#73daca',
      tool_result: '#9ece6a',
      result_error: '#f7768e',
      review: '#ff9e64',
      commit: '#9ece6a',
      checkpoint: '#9ece6a',
      approval: '#ff9e64',
      status: '#5060a0',
      error: '#f7768e',
      prompt: '#8090c0',
      note: '#5060a0',
      assistant_text: '#8090c0',
      dispatch: '#73daca',
      agent_status: '#bb9af7',
      thinking: '#bb9af7',
    },
    background: '#0f1424',
    surface: '#161b30',
    border: '#1e2848',
    text: '#c0d0f0',
    textMuted: '#5060a0',
    textAccent: '#8090c0',
    success: '#9ece6a',
    error: '#f7768e',
    warning: '#ff9e64',
    info: '#73daca',
    brand: '#8090c0',
  },
  pink: {
    name: 'pink',
    semantic: {
      plan: '#e878b8',
      edit: '#d090c0',
      diff: '#d090c0',
      command: '#d090c0',
      tool_result: '#a0c878',
      result_error: '#d44a5a',
      review: '#d4a060',
      commit: '#a0c878',
      checkpoint: '#a0c878',
      approval: '#d4a060',
      status: '#804868',
      error: '#d44a5a',
      prompt: '#b07898',
      note: '#804868',
      assistant_text: '#b07898',
      dispatch: '#d090c0',
      agent_status: '#e878b8',
      thinking: '#e878b8',
    },
    background: '#120a10',
    surface: '#1c0f18',
    border: '#301828',
    text: '#e8c8d8',
    textMuted: '#804868',
    textAccent: '#b07898',
    success: '#a0c878',
    error: '#d44a5a',
    warning: '#d4a060',
    info: '#d090c0',
    brand: '#b07898',
  },
  dracula: {
    name: 'dracula',
    semantic: {
      plan: '#bd93f9',
      edit: '#8be9fd',
      diff: '#8be9fd',
      command: '#8be9fd',
      tool_result: '#50fa7b',
      result_error: '#ff5555',
      review: '#ffb86c',
      commit: '#50fa7b',
      checkpoint: '#50fa7b',
      approval: '#ffb86c',
      status: '#7060a0',
      error: '#ff5555',
      prompt: '#a090c8',
      note: '#7060a0',
      assistant_text: '#a090c8',
      dispatch: '#8be9fd',
      agent_status: '#ff79c6',
      thinking: '#ff79c6',
    },
    background: '#14111a',
    surface: '#1c1830',
    border: '#2a2540',
    text: '#e0d8f0',
    textMuted: '#7060a0',
    textAccent: '#a090c8',
    success: '#50fa7b',
    error: '#ff5555',
    warning: '#ffb86c',
    info: '#8be9fd',
    brand: '#a090c8',
  },
};

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const defaultPalette: TuiPalette = PALETTES['mono']!;

export function getPalette(name?: string): TuiPalette {
  let key = (name ?? 'default').toLowerCase();
  if (key === 'default') key = 'mono';
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
      // OpenTUI resolves null when the terminal does not answer the OSC
      // theme query (common under some terminals/multiplexers). Only trust
      // a definite answer; otherwise fall through to COLORFGBG.
      const mode = (await renderer.waitForThemeMode()) as 'dark' | 'light' | null | undefined;
      if (mode === 'dark' || mode === 'light') return mode;
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
