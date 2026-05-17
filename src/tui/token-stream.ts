import type { ModelFamily } from './model-palette';

export type TokenGlyphRole = 'rear' | 'dim' | 'field' | 'active' | 'hot' | 'cool';

export interface TokenStreamGlyph {
  char: string;
  role: TokenGlyphRole;
}

export type TokenStreamFrame = TokenStreamGlyph[];

const DEFAULT_FRAMES: TokenStreamFrame[] = framesFromStrings([
  '˙·.:●:.·˙',
  '·.:●:.·˙·',
  '.:●:.·˙·.',
  ':●:.·˙·.:',
  '●:.·˙·.:●',
  ':●:.·˙·.:',
  '.:●:.·˙·.',
  '·.:●:.·˙·',
]);

const QWEN_FRAMES: TokenStreamFrame[] = [
  roles('╱·:●:·╲', ['cool', 'dim', 'active', 'hot', 'cool', 'dim', 'cool']),
  roles('╲·:●:·╱', ['cool', 'dim', 'active', 'hot', 'cool', 'dim', 'cool']),
  roles('╱·:◉:·╲', ['cool', 'dim', 'active', 'hot', 'cool', 'dim', 'cool']),
  roles('╲·:●:·╱', ['cool', 'dim', 'active', 'hot', 'cool', 'dim', 'cool']),
];

const FRONTIER_FRAMES: TokenStreamFrame[] = [
  roles('.·:●:·.', ['field', 'dim', 'active', 'hot', 'cool', 'dim', 'field']),
  roles('·.:●:.·', ['dim', 'field', 'active', 'hot', 'cool', 'field', 'dim']),
  roles('.::◉::.', ['field', 'active', 'active', 'hot', 'cool', 'cool', 'field']),
  roles('·.:●:.·', ['dim', 'field', 'active', 'hot', 'cool', 'field', 'dim']),
];

const DEEPSEEK_FRAMES: TokenStreamFrame[] = [
  roles('──:●:──', ['rear', 'dim', 'active', 'hot', 'cool', 'dim', 'rear']),
  roles('═─:●:─═', ['dim', 'rear', 'active', 'hot', 'cool', 'rear', 'dim']),
  roles('━━:◉:━━', ['field', 'dim', 'active', 'hot', 'cool', 'dim', 'field']),
  roles('═─:●:─═', ['dim', 'rear', 'active', 'hot', 'cool', 'rear', 'dim']),
];

const GEMINI_FRAMES: TokenStreamFrame[] = [
  roles('●·:   :·●', ['hot', 'dim', 'active', 'rear', 'rear', 'rear', 'cool', 'dim', 'hot']),
  roles('·●:   :●·', ['dim', 'hot', 'active', 'rear', 'rear', 'rear', 'cool', 'hot', 'dim']),
  roles('·:● · ●:·', ['dim', 'active', 'hot', 'rear', 'field', 'rear', 'hot', 'cool', 'dim']),
  roles('·●:   :●·', ['dim', 'hot', 'active', 'rear', 'rear', 'rear', 'cool', 'hot', 'dim']),
];

const FRAME_SETS: Partial<Record<ModelFamily, TokenStreamFrame[]>> = {
  qwen: QWEN_FRAMES,
  frontier: FRONTIER_FRAMES,
  deepseek: DEEPSEEK_FRAMES,
  gemini: GEMINI_FRAMES,
};

const ANSI_BY_ROLE: Record<TokenGlyphRole, string> = {
  rear: '\x1b[38;5;240m',
  dim: '\x1b[38;5;61m',
  field: '\x1b[38;5;99m',
  active: '\x1b[38;5;207m',
  hot: '\x1b[38;5;230m',
  cool: '\x1b[38;5;51m',
};

const HEX_BY_ROLE: Record<ModelFamily, Record<TokenGlyphRole, string>> = {
  default: {
    rear: '#5f6772',
    dim: '#5f5f87',
    field: '#875fd7',
    active: '#ff5fd7',
    hot: '#ffffd7',
    cool: '#5fffff',
  },
  openai: {
    rear: '#536474',
    dim: '#5a7a94',
    field: '#7097b2',
    active: '#8ab8d0',
    hot: '#f0f7ff',
    cool: '#70d7ff',
  },
  qwen: {
    rear: '#3a4a6e',
    dim: '#4a6aae',
    field: '#6088bc',
    active: '#7aa4d8',
    hot: '#eef7ff',
    cool: '#8be9fd',
  },
  frontier: {
    rear: '#5a3e28',
    dim: '#8a6240',
    field: '#ac7e58',
    active: '#d68a9b',
    hot: '#fff4df',
    cool: '#c4986a',
  },
  deepseek: {
    rear: '#263238',
    dim: '#35534f',
    field: '#4a786a',
    active: '#58d6a2',
    hot: '#f2fff0',
    cool: '#72d8cf',
  },
  gemini: {
    rear: '#3a4e7a',
    dim: '#5c5fa8',
    field: '#7a68c8',
    active: '#b477ff',
    hot: '#f4f0ff',
    cool: '#64d8ff',
  },
};

export function tokenStreamFrame(family: ModelFamily, frame: number): TokenStreamFrame {
  const frames = FRAME_SETS[family] ?? DEFAULT_FRAMES;
  return frames[frame % frames.length] ?? DEFAULT_FRAMES[0] ?? [];
}

export function tokenStreamFrameText(family: ModelFamily, frame: number): string {
  return tokenStreamFrame(family, frame)
    .map((glyph) => glyph.char)
    .join('');
}

export function tokenStreamRoleColor(family: ModelFamily, role: TokenGlyphRole): string {
  return (HEX_BY_ROLE[family] ?? HEX_BY_ROLE.default)[role];
}

export function renderAnsiTokenStreamFrame(family: ModelFamily, frame: number): string {
  return `${tokenStreamFrame(family, frame)
    .map((glyph) => `${ANSI_BY_ROLE[glyph.role]}${glyph.char}`)
    .join('')}\x1b[0m`;
}

function framesFromStrings(frames: string[]): TokenStreamFrame[] {
  return frames.map((frame) =>
    Array.from(frame).map((char) => ({
      char,
      role: defaultRoleForChar(char),
    })),
  );
}

function defaultRoleForChar(char: string): TokenGlyphRole {
  if (char === '●' || char === '◉') return 'hot';
  if (char === ':') return 'active';
  if (char === '.') return 'field';
  if (char === '·') return 'dim';
  return 'rear';
}

function roles(chars: string, glyphRoles: TokenGlyphRole[]): TokenStreamFrame {
  return Array.from(chars).map((char, index) => ({
    char,
    role: glyphRoles[index] ?? defaultRoleForChar(char),
  }));
}
