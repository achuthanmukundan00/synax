import type { AgentEvent } from './events';
import { applyEventToRunState, advanceClock, createInitialRunStateSnapshot, type RunStateSnapshot } from './tui-state';

export interface AgentRenderer {
  onEvent(event: AgentEvent): void;
  finish?(): void;
}

interface Cell {
  ch: string;
  style: string;
}

const ESC = '\u001b[';
const RESET = '\u001b[0m';
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const ALT_SCREEN = '\u001b[?1049h';
const MAIN_SCREEN = '\u001b[?1049l';
const CLEAR = '\u001b[2J';

const FPS = 6;
const FRAME_MS = Math.floor(1000 / FPS);

type CoreState = 'idle' | 'thinking' | 'tool_execution' | 'verifying' | 'blocked';

export class TuiRenderer implements AgentRenderer {
  private state: RunStateSnapshot = createInitialRunStateSnapshot(Date.now());
  private prevBuffer: Cell[][] = [];
  private cols = process.stdout.columns || 120;
  private rows = process.stdout.rows || 36;
  private timer: NodeJS.Timeout | null = null;
  private dirtyAll = true;
  private finished = false;
  private core = { phase: 0, angularVelocity: 0.03, amplitude: 0.4, targetAmplitude: 0.4, damping: 0.14 };
  private readonly onResize = (): void => {
    this.cols = process.stdout.columns || this.cols;
    this.rows = process.stdout.rows || this.rows;
    this.dirtyAll = true;
    this.paint();
  };

  constructor() {
    if (!process.stdout.isTTY) return;
    process.stdout.write(`${ALT_SCREEN}${HIDE_CURSOR}${CLEAR}${ESC}H`);
    process.stdout.on('resize', this.onResize);
    this.timer = setInterval(() => this.paint(), FRAME_MS);
  }

  onEvent(event: AgentEvent): void {
    this.state = applyEventToRunState(this.state, event, Date.now());
    this.dirtyAll = true;
    if (event.type === 'task_finished' || event.type === 'error') {
      this.finished = true;
    }
    this.paint();
  }

  setModelOutput(text: string): void {
    this.state = { ...this.state, lastModelOutput: text };
    this.dirtyAll = true;
    this.paint();
  }

  finish(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    process.stdout.off('resize', this.onResize);
    if (process.stdout.isTTY) {
      process.stdout.write(`${SHOW_CURSOR}${RESET}${MAIN_SCREEN}`);
    }
  }

  private paint(): void {
    if (!process.stdout.isTTY) return;
    this.state = advanceClock(this.state, Date.now());
    this.tickCore();
    const nextBuffer = createBuffer(this.rows, this.cols);
    renderFrame(nextBuffer, this.state);
    renderCoreOverlay(nextBuffer, this.state, this.core);
    const out = this.diffBuffer(this.prevBuffer, nextBuffer, this.dirtyAll);
    if (out) {
      process.stdout.write(out);
    }
    this.prevBuffer = nextBuffer;
    this.dirtyAll = false;
    if (this.finished && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tickCore(): void {
    const state = coreStateFromPhase(this.state.phase);
    if (state === 'idle') {
      this.core.angularVelocity = 0.02;
      this.core.targetAmplitude = 0.3;
    } else if (state === 'thinking') {
      this.core.angularVelocity = 0.045;
      this.core.targetAmplitude = 0.65;
    } else if (state === 'tool_execution') {
      this.core.angularVelocity = 0.06;
      this.core.targetAmplitude = 0.85;
    } else if (state === 'verifying') {
      this.core.angularVelocity = 0.03;
      this.core.targetAmplitude = 0.45;
    } else {
      this.core.angularVelocity = 0.025;
      this.core.targetAmplitude = 0.55;
    }
    this.core.amplitude += (this.core.targetAmplitude - this.core.amplitude) * this.core.damping;
    this.core.phase += this.core.angularVelocity;
  }

  private diffBuffer(prev: Cell[][], next: Cell[][], force: boolean): string {
    const chunks: string[] = [];
    if (force) {
      chunks.push(`${ESC}H${CLEAR}`);
    }
    const rowCount = Math.min(prev.length, next.length);
    for (let y = 0; y < next.length; y += 1) {
      const prevRow = y < rowCount ? prev[y] : [];
      const nextRow = next[y];
      let start = -1;
      for (let x = 0; x < nextRow.length; x += 1) {
        const changed = force || !sameCell(prevRow[x], nextRow[x]);
        if (changed && start < 0) start = x;
        if (!changed && start >= 0) {
          chunks.push(emitRun(y, start, x - 1, nextRow));
          start = -1;
        }
      }
      if (start >= 0) {
        chunks.push(emitRun(y, start, nextRow.length - 1, nextRow));
      }
    }
    chunks.push(`${ESC}${this.rows};1H${RESET}`);
    return chunks.join('');
  }
}

function createBuffer(rows: number, cols: number): Cell[][] {
  const result: Cell[][] = [];
  for (let y = 0; y < rows; y += 1) {
    const row: Cell[] = [];
    for (let x = 0; x < cols; x += 1) {
      row.push({ ch: ' ', style: '' });
    }
    result.push(row);
  }
  return result;
}

function renderFrame(buffer: Cell[][], state: RunStateSnapshot): void {
  const cols = buffer[0]?.length ?? 0;
  const rows = buffer.length;
  if (cols < 40 || rows < 18) {
    writeLine(buffer, 0, 0, withStyle('terminal too small for synax tui', '\u001b[33m'));
    return;
  }

  const objectiveWidth = Math.max(24, cols - 16);
  writeLine(buffer, 0, 0, withStyle(`Run ${state.runId} | ${state.mode} | ${elapsedLabel(state)}`, '\u001b[36m'));
  writeLine(buffer, 1, 0, clipStyled(`Objective: ${state.objective.label}`, objectiveWidth));
  writeLine(buffer, 2, 0, clipStyled(`Phase: ${state.phase}`, objectiveWidth));
  writeLine(buffer, 3, 0, clipStyled(`Next: ${state.objective.nextCheckpoint}`, objectiveWidth));
  writeLine(buffer, 5, 0, withStyle('Progress', '\u001b[1;37m'));
  for (let i = 0; i < 8; i += 1) {
    const item = state.timeline[state.timeline.length - 8 + i];
    if (!item) continue;
    writeLine(buffer, 6 + i, 0, clipStyled(`${phaseGlyph(item.phase)} ${item.summary}`, cols - 14));
  }

  const changeStart = 15;
  writeLine(buffer, changeStart, 0, withStyle('Changes', '\u001b[1;37m'));
  for (let i = 0; i < 6; i += 1) {
    const item = state.changes.items[state.changes.items.length - 6 + i];
    if (!item) continue;
    writeLine(
      buffer,
      changeStart + 1 + i,
      0,
      clipStyled(`${item.op.padEnd(6)} ${clipPath(item.path, cols - 10)}`, cols - 14),
    );
  }
  if (state.changes.overflowCount > 0) {
    writeLine(buffer, changeStart + 7, 0, clipStyled(`+${state.changes.overflowCount} prior changes`, cols - 14));
  }

  const verifyStart = 23;
  if (verifyStart + 5 < rows) {
    writeLine(buffer, verifyStart, 0, withStyle('Verification', '\u001b[1;37m'));
    writeLine(
      buffer,
      verifyStart + 1,
      0,
      clipStyled(
        `state=${state.verification.state} planned=${state.verification.checksPlanned} running=${state.verification.checksRunning} passed=${state.verification.checksPassed} failed=${state.verification.checksFailed} skipped=${state.verification.checksSkipped}`,
        cols - 14,
      ),
    );
    if (state.verification.currentCheckLabel) {
      writeLine(buffer, verifyStart + 2, 0, clipStyled(`current: ${state.verification.currentCheckLabel}`, cols - 14));
    }
    if (state.verification.summary) {
      writeLine(buffer, verifyStart + 3, 0, clipStyled(state.verification.summary, cols - 14));
    }
    if (state.statusNote) {
      writeLine(buffer, verifyStart + 4, 0, clipStyled(`note: ${state.statusNote}`, cols - 14));
    }
  }

  // Model observability: show last model output so users can see what the model is thinking.
  const modelOutputStart = Math.max(verifyStart + 6, 28);
  if (modelOutputStart + 2 < rows && state.lastModelOutput.trim().length > 0) {
    writeLine(buffer, modelOutputStart, 0, withStyle('Model output', '\u001b[1;37m'));
    // eslint-disable-next-line no-control-regex
    const cleaned = state.lastModelOutput.replace(/\u001b\[[0-9;]*m/g, '');
    // Show up to 4 lines of model output, each wrapped to fit.
    const rawLines = cleaned.split('\n');
    let shown = 0;
    for (const rawLine of rawLines) {
      if (modelOutputStart + 1 + shown >= rows - 3) break;
      if (shown >= 4) break;
      writeLine(buffer, modelOutputStart + 1 + shown, 0, clipStyled(rawLine.trim().slice(0, cols - 14), cols - 14));
      shown += 1;
    }
  }

  const historyStart = state.lastModelOutput.trim().length > 0 ? modelOutputStart + 6 : modelOutputStart;
  if (historyStart + 2 < rows && state.debugHistory.length > 0) {
    writeLine(buffer, historyStart, 0, withStyle('History', '\u001b[1;37m'));
    const historyLines = formatHistoryLines(state, cols - 14);
    for (let i = 0; i < historyLines.length && historyStart + 1 + i < rows - 3; i += 1) {
      writeLine(buffer, historyStart + 1 + i, 0, clipStyled(historyLines[i], cols - 14));
    }
  }

  writeLine(
    buffer,
    rows - 2,
    0,
    withStyle(`risk=${state.severity} ${state.riskLine} | q quit`, severityColor(state.severity)),
  );
}

function renderCoreOverlay(
  buffer: Cell[][],
  state: RunStateSnapshot,
  core: { phase: number; amplitude: number },
): void {
  const size = 9;
  const cols = buffer[0]?.length ?? 0;
  const rows = buffer.length;
  const x0 = Math.max(0, cols - size - 2);
  const y0 = 1;
  if (x0 + size > cols || y0 + size > rows) return;
  if (cols < size + 4 || rows < size + 4) return;
  drawBox(buffer, x0, y0, size, size, '\u001b[90m');
  const cx = x0 + 4;
  const cy = y0 + 4;
  setCell(buffer, cx, cy, 'o', '\u001b[1;36m');
  const radius = 2 + core.amplitude * 1.2;
  const px = clamp(Math.round(cx + Math.cos(core.phase) * radius), 0, cols - 1);
  const py = clamp(Math.round(cy + Math.sin(core.phase) * radius), 0, rows - 1);
  const glyph = state.phase === 'blocked' || state.phase === 'error' ? '*' : '.';
  const tone = state.phase === 'blocked' || state.phase === 'error' ? '\u001b[33m' : '\u001b[36m';
  setCell(buffer, px, py, glyph, tone);
}

function drawBox(buffer: Cell[][], x0: number, y0: number, w: number, h: number, style: string): void {
  for (let x = x0; x < x0 + w; x += 1) {
    setCell(buffer, x, y0, x === x0 ? '+' : x === x0 + w - 1 ? '+' : '-', style);
    setCell(buffer, x, y0 + h - 1, x === x0 ? '+' : x === x0 + w - 1 ? '+' : '-', style);
  }
  for (let y = y0 + 1; y < y0 + h - 1; y += 1) {
    setCell(buffer, x0, y, '|', style);
    setCell(buffer, x0 + w - 1, y, '|', style);
  }
}

function sameCell(a: Cell | undefined, b: Cell | undefined): boolean {
  if (!a || !b) return false;
  return a.ch === b.ch && a.style === b.style;
}

function emitRun(y: number, xStart: number, xEnd: number, row: Cell[]): string {
  let currentStyle = '';
  let text = `${ESC}${y + 1};${xStart + 1}H`;
  for (let x = xStart; x <= xEnd; x += 1) {
    const cell = row[x];
    if (cell.style !== currentStyle) {
      currentStyle = cell.style;
      text += currentStyle || RESET;
    }
    text += cell.ch;
  }
  return text + RESET;
}

function writeLine(buffer: Cell[][], y: number, x: number, value: string): void {
  if (y < 0 || y >= buffer.length) return;
  let style = '';
  let col = x;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '\u001b') {
      const end = value.indexOf('m', i);
      if (end < 0) break;
      style = value.slice(i, end + 1);
      i = end;
      continue;
    }
    if (col >= buffer[y].length) break;
    buffer[y][col] = { ch, style };
    col += 1;
  }
}

function setCell(buffer: Cell[][], x: number, y: number, ch: string, style: string): void {
  if (y < 0 || y >= buffer.length) return;
  if (x < 0 || x >= buffer[y].length) return;
  buffer[y][x] = { ch, style };
}

function withStyle(value: string, style: string): string {
  return `${style}${value}${RESET}`;
}

function clipStyled(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 4) return value.slice(0, Math.max(0, width));
  return `${value.slice(0, width - 3)}...`;
}

function clipPath(path: string, width: number): string {
  if (path.length <= width) return path;
  const keep = Math.max(8, width - 3);
  return `...${path.slice(path.length - keep)}`;
}

function phaseGlyph(phase: string): string {
  if (phase === 'thinking') return '~';
  if (phase === 'tool_execution') return '>';
  if (phase === 'verifying') return '=';
  if (phase === 'completed') return '+';
  if (phase === 'budget_exhausted' || phase === 'error') return '!';
  if (phase === 'blocked') return '!';
  return '.';
}

function elapsedLabel(state: RunStateSnapshot): string {
  const elapsedMs = Math.max(0, state.nowMs - state.startedAtMs);
  const total = Math.floor(elapsedMs / 1000);
  const m = Math.floor(total / 60)
    .toString()
    .padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function coreStateFromPhase(phase: string): CoreState {
  if (phase === 'tool_execution') return 'tool_execution';
  if (phase === 'verifying') return 'verifying';
  if (phase === 'budget_exhausted' || phase === 'blocked' || phase === 'error') return 'blocked';
  if (phase === 'thinking') return 'thinking';
  return 'idle';
}

function severityColor(severity: string): string {
  if (severity === 'S3') return '\u001b[31m';
  if (severity === 'S2') return '\u001b[33m';
  return '\u001b[90m';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatHistoryLines(state: RunStateSnapshot, width: number): string[] {
  const lines: string[] = [];
  for (const item of state.debugHistory.slice(-4)) {
    const title = item.kind === 'tool_call' ? 'Tool call' : item.kind === 'tool_result' ? 'Tool result' : 'Model';
    const detail = item.detail.replace(/\s+/g, ' ').trim();
    lines.push(`${title}: ${detail.slice(0, Math.max(20, width - title.length - 2))}`);
  }
  return lines;
}
