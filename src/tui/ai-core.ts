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

export const CORE_WIDTH = 14;
export const CORE_HEIGHT = 6;

export function modeColor(mode: CoreMode): string {
  if (mode === 'blocked') return '\u001b[33m';
  if (mode === 'failure' || mode === 'error') return '\u001b[31m';
  if (mode === 'completed') return '\u001b[37m';
  if (mode === 'verifying') return '\u001b[32m';
  if (mode === 'bash' || mode === 'reading') return '\u001b[36m';
  if (mode === 'writing' || mode === 'planning') return '\u001b[94m';
  if (mode === 'reasoning' || mode === 'thinking' || mode === 'tool_execution') return '\u001b[96m';
  return '\u001b[90m';
}

export function renderAiCore(mode: CoreMode, t: number): string[] {
  const normalized = normalizeMode(mode);
  const phase = Math.floor(t * 8) % 6;
  const leftPulse = normalized === 'idle' ? 1 : phase;
  const rightPulse = normalized === 'bash' ? (phase + 2) % 6 : phase;
  const center = normalized === 'blocked' || normalized === 'failure' ? '⟡' : '⟐';
  const rows = [
    renderRow('······', topBand(normalized), leftPulse, rightPulse),
    renderRow('······', midBand(normalized), leftPulse + 1, rightPulse + 1),
    renderRow('······', renderCoreBand(normalized, center), leftPulse + 2, rightPulse + 2),
    renderRow('······', lowBand(normalized), leftPulse + 3, rightPulse + 3),
  ];

  return [
    '╭' + '─'.repeat(CORE_WIDTH - 2) + '╮',
    ...rows.map((row) => `│${row}│`),
    '╰' + '─'.repeat(CORE_WIDTH - 2) + '╯',
  ];
}

function renderRow(leftSeed: string, rightSeed: string, leftPhase: number, rightPhase: number): string {
  const left = pulseLeft(leftSeed, leftPhase).padEnd(6, ' ').slice(0, 6);
  const right = pulseRight(rightSeed, rightPhase);
  return `${left}${right}`;
}

function pulseLeft(seed: string, phase: number): string {
  const chars = seed.split('');
  const lit = Math.max(0, Math.min(chars.length - 1, phase % chars.length));
  return chars.map((ch, index) => (index === lit ? '•' : ch)).join('');
}

function pulseRight(seed: string, phase: number): string {
  const chars = seed.padEnd(6, ' ').slice(0, 6).split('');
  const lit = Math.max(0, Math.min(chars.length - 1, phase % chars.length));
  return chars.map((ch, index) => (index === lit && isPulseGlyph(ch) ? '━' : ch)).join('');
}

function isPulseGlyph(ch: string): boolean {
  return '═─┄┈┬┴┼╪╤╧╞╡'.includes(ch);
}

function topBand(mode: Exclude<CoreMode, 'thinking' | 'tool_execution' | 'error'>): string {
  if (mode === 'planning') return '═┄┄═  ';
  if (mode === 'reading') return '═┈┈═  ';
  if (mode === 'bash') return '╤═╤═  ';
  if (mode === 'verifying') return '═┬┬═  ';
  if (mode === 'completed') return '════  ';
  if (mode === 'blocked' || mode === 'failure') return '═  ═  ';
  return '═══   ';
}

function midBand(mode: Exclude<CoreMode, 'thinking' | 'tool_execution' | 'error'>): string {
  if (mode === 'planning') return ' ┌┬┐  ';
  if (mode === 'reading') return ' ─┼─  ';
  if (mode === 'writing') return ' ═╪═  ';
  if (mode === 'bash') return '╞═╪╡  ';
  if (mode === 'verifying') return '═┼┼═  ';
  if (mode === 'completed') return ' ═╬═  ';
  if (mode === 'blocked' || mode === 'failure') return ' ═ ═  ';
  return ' ══   ';
}

function lowBand(mode: Exclude<CoreMode, 'thinking' | 'tool_execution' | 'error'>): string {
  if (mode === 'planning') return '═┴┴═  ';
  if (mode === 'reading') return '═┄┄═  ';
  if (mode === 'writing') return '╞══╡  ';
  if (mode === 'bash') return '╧═╧═  ';
  if (mode === 'verifying') return '═┴┴═  ';
  if (mode === 'completed') return '════  ';
  if (mode === 'blocked') return '══ ═  ';
  if (mode === 'failure') return '═╳═   ';
  if (mode === 'reasoning') return '═┈═   ';
  return '═══   ';
}

function renderCoreBand(mode: Exclude<CoreMode, 'thinking' | 'tool_execution' | 'error'>, center: string): string {
  if (mode === 'verifying') return `═┼${center}┼═ `;
  if (mode === 'writing') return `╞═${center}═╡ `;
  if (mode === 'bash') return `╞╪${center}╪╡ `;
  if (mode === 'reading') return `─┼${center}┼─ `;
  if (mode === 'planning') return `┌┼${center}┼┐ `;
  if (mode === 'completed') return ` ═${center}═· `;
  if (mode === 'blocked' || mode === 'failure') return ` ═${center}═  `;
  return ` ═${center}═· `;
}

function normalizeMode(mode: CoreMode): Exclude<CoreMode, 'thinking' | 'tool_execution' | 'error'> {
  if (mode === 'thinking') return 'reasoning';
  if (mode === 'tool_execution') return 'reasoning';
  if (mode === 'error') return 'failure';
  return mode;
}
