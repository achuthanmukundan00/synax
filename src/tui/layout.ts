import type { RunStateSnapshot } from '../agent/tui-state';
import type { CoreMode } from './ai-core';
import { CORE_HEIGHT, CORE_WIDTH, modeColor, modePromptColor, renderAiCore } from './ai-core';
import { resolveCoreVisualProfile } from './core-visual-profile';
import { resolveModelFamily } from './model-palette';
import { renderTranscript } from './transcript';
import { renderAnsiTokenStreamFrame } from './token-stream';
import { charWidthAt, stripAnsi, visibleLength, terminalWriteWidth } from './text-utils';

const INPUT_DOCK_MAX_BODY_LINES = 12;
const INPUT_DOCK_MIN_NONEMPTY_BODY_LINES = 2;
const INPUT_DOCK_MIN_TRANSCRIPT_ROWS = 6;
/** Number of spaces between the border and the input text on each side. */
const INPUT_DOCK_PADDING = 2;

export interface InteractiveViewState {
  run: RunStateSnapshot;
  objectiveInput: string;
  blockedMessage?: string;
  coreMode: CoreMode;
  nowMs: number;
  /** Last model response text for observability. */
  lastModelOutput?: string;
  /** Active model ID displayed as input-panel instrumentation label. */
  modelLabel?: string;
  /** Active endpoint for state display. */
  endpointLabel?: string;
  /** Working directory displayed in the input dock. */
  cwdLabel?: string;
  /** Current git branch displayed in the input dock when available. */
  gitBranch?: string;
  /** Number of wrapped history lines hidden below the viewport. */
  historyScrollOffset?: number;
  /** 0-indexed character offset into objectiveInput for cursor placement. */
  inputCursorOffset?: number;
  /** Steering message queued while the model is generating (displayed above prompt box). */
  steeringMessage?: string;
}

export function renderLayout(state: InteractiveViewState, cols: number, rows: number): string[] {
  const width = Math.max(40, cols);
  const renderWidth = terminalWriteWidth(width);
  const height = Math.max(14, rows);
  const steeringBarHeight = state.steeringMessage ? 1 : 0;
  const activityBarHeight = activityStripVisible(state) ? 1 : 0;
  const panel = renderInputDock(
    state.objectiveInput,
    renderWidth,
    state.coreMode,
    state.nowMs,
    locationLabel(state.cwdLabel, state.gitBranch),
    maxInputDockBodyLines(height - steeringBarHeight - activityBarHeight),
  );
  const bodyHeight = Math.max(1, height - panel.length - steeringBarHeight - activityBarHeight);
  const lines = Array.from({ length: bodyHeight }, () => '');
  const hasTranscript =
    state.run.timeline.length > 0 ||
    state.run.debugHistory.length > 0 ||
    state.run.phase !== 'idle' ||
    Boolean(state.run.patchPreview) ||
    Boolean(state.run.lastModelOutput.trim());

  if (!hasTranscript) {
    renderWelcome(lines, renderWidth, bodyHeight, state);
  } else {
    renderHistory(lines, renderWidth, bodyHeight, state);
  }

  if (state.blockedMessage) {
    put(
      lines,
      Math.max(2, bodyHeight - 2),
      2,
      `[33mBlocked · ${clip(state.blockedMessage, renderWidth - 12)}[0m`,
      renderWidth,
    );
  }

  const clipped = lines.slice(0, bodyHeight).map((line) => pad(clip(line, renderWidth), width));
  // Steering message bar (shown above prompt box while bot is generating)
  if (state.steeringMessage) {
    const steeringLabel = '  steering> ';
    const maxMsgWidth = width - steeringLabel.length - 4;
    const truncated =
      state.steeringMessage.length > maxMsgWidth
        ? state.steeringMessage.slice(0, maxMsgWidth - 3) + '...'
        : state.steeringMessage;
    const steelBlue = '[38;2;67;76;88m[3m';
    clipped.push(pad(`${steelBlue}${steeringLabel}${truncated}[0m`, width));
  }
  if (activityBarHeight > 0) {
    clipped.push(pad(renderActivityStrip(state, width), width));
  }
  clipped.push(...panel);
  return clipped.map((line) => pad(clip(line, width), width));
}

export function maxHistoryScrollOffset(state: InteractiveViewState, _cols: number, rows: number): number {
  const width = Math.max(40, _cols);
  const renderWidth = terminalWriteWidth(width);
  const height = Math.max(14, rows);
  const steeringBarHeight = state.steeringMessage ? 1 : 0;
  const activityBarHeight = activityStripVisible(state) ? 1 : 0;
  const panelHeight = inputDockHeight(
    state.objectiveInput,
    renderWidth,
    maxInputDockBodyLines(height - steeringBarHeight - activityBarHeight),
  );
  const bodyHeight = Math.max(1, height - panelHeight - steeringBarHeight - activityBarHeight);
  const visibleRows = Math.max(1, bodyHeight - 3);
  const transcriptWidth = Math.max(24, renderWidth - 4);
  const transcriptLines = renderTranscript({ ...state, nowMs: state.nowMs }, transcriptWidth);
  return Math.max(0, transcriptLines.length - visibleRows);
}

function renderWelcome(lines: string[], width: number, bodyHeight: number, state: InteractiveViewState): void {
  // Info bar at the top
  put(lines, 0, 0, dim(infoBar(state)), width);
  put(lines, 1, 0, dim('─'.repeat(Math.max(1, width))), width);

  // Animated AI core logo (centered) — only if we have room
  if (bodyHeight >= 16) {
    const core = renderAiCore(
      state.coreMode,
      state.nowMs / 1000,
      resolveCoreVisualProfile(state.modelLabel || state.run.modelId),
    );
    const coreX = Math.max(0, Math.floor((width - CORE_WIDTH) / 2));
    const coreY = Math.max(3, Math.floor((bodyHeight - CORE_HEIGHT) / 2) - 3);
    putBlock(lines, coreY, coreX, core, width);

    // Welcome text below the logo
    const welcomeText = bold('Welcome');
    const welcomeX = Math.max(0, Math.floor(width / 2) - Math.floor(welcomeText.length / 2));
    put(lines, coreY + CORE_HEIGHT + 1, welcomeX, welcomeText, width);

    // Tips section
    const tipsY = coreY + CORE_HEIGHT + 3;
    if (tipsY + 9 < bodyHeight) {
      put(lines, tipsY, 4, boldDim('Tips'), width);
      put(lines, tipsY + 1, 4, dim('─'.repeat(Math.min(40, width - 8))), width);
      put(lines, tipsY + 2, 4, dim('Run /help to see available commands'), width);
      put(lines, tipsY + 3, 4, dim('Type !<command> to run shell commands'), width);
      put(lines, tipsY + 4, 4, dim('Use /settings to configure Synax'), width);
    }
  }
}

function renderHistory(lines: string[], width: number, bodyHeight: number, state: InteractiveViewState): void {
  // Info bar with phase
  put(lines, 0, 0, dim(infoBar(state, true)), width);
  put(lines, 1, 0, dim('─'.repeat(Math.max(1, width))), width);

  // Full-width transcript (no sidebar)
  const transcriptWidth = Math.max(24, width - 4);
  const transcriptLines = renderTranscript({ ...state, nowMs: state.nowMs }, transcriptWidth);
  const visibleRows = Math.max(1, bodyHeight - 3);
  const maxScrollOffset = Math.max(0, transcriptLines.length - visibleRows);
  const scrollOffset = Math.min(maxScrollOffset, Math.max(0, state.historyScrollOffset ?? 0));
  const visibleTranscript = transcriptLines.slice(
    Math.max(0, transcriptLines.length - visibleRows - scrollOffset),
    Math.max(0, transcriptLines.length - scrollOffset),
  );

  for (let i = 0; i < visibleTranscript.length && i + 2 < bodyHeight; i += 1) {
    put(lines, i + 2, 2, clip(visibleTranscript[i], transcriptWidth), width);
  }
}

/** Single-line info bar showing model, cwd, and optionally phase+elapsed. */
function infoBar(state: InteractiveViewState, includePhase = false): string {
  const parts: string[] = [];
  const model = state.modelLabel || state.run.modelId;
  if (model) parts.push(model);
  if (state.cwdLabel) parts.push(state.cwdLabel);
  if (includePhase) {
    const phase = phaseLabel(state.run.phase);
    const endMs = state.run.terminal === 'running' ? state.nowMs : state.run.nowMs;
    const time = elapsed(state.run.startedAtMs, endMs);
    parts.push(`${modeColor(state.coreMode)}${phase}  ${time}[0m`);
  }
  return parts.join('  │  ');
}

function elapsed(startedAtMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function clip(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  const target = Math.max(0, width - 1);
  let visibleCount = 0;
  let out = '';
  let activeAnsi = '';

  for (let i = 0; i < text.length; ) {
    if (text[i] === '') {
      // eslint-disable-next-line no-control-regex
      const match = /\[[0-9;]*m/.exec(text.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length;
        activeAnsi = match[0] === '[0m' ? '' : match[0];
        continue;
      }
    }
    const [w, advance] = charWidthAt(text, i);
    if (visibleCount + w > target) break;
    out += text.slice(i, i + advance);
    visibleCount += w;
    i += advance;
  }

  out += '…';
  if (activeAnsi && !out.endsWith('[0m')) {
    out += '[0m';
  }
  return out;
}

function pad(line: string, width: number): string {
  const visible = visibleLength(line);
  if (visible >= width) return line;
  return `${line}${' '.repeat(Math.max(0, width - visible))}`;
}

function sliceVisible(line: string, start: number, end: number): string {
  const targetStart = Math.max(0, start);
  const targetEnd = Math.max(targetStart, end);
  let visibleIndex = 0;
  let out = '';
  let writing = false;

  for (let i = 0; i < line.length; ) {
    if (line[i] === '') {
      // eslint-disable-next-line no-control-regex
      const match = /\[[0-9;]*m/.exec(line.slice(i));
      if (match) {
        if (writing || visibleIndex >= targetStart) out += match[0];
        i += match[0].length;
        continue;
      }
    }
    const [w, advance] = charWidthAt(line, i);
    if (visibleIndex + w > targetEnd) break;
    if (visibleIndex >= targetStart) {
      writing = true;
      out += line.slice(i, i + advance);
    }
    visibleIndex += w;
    i += advance;
  }

  return out;
}

function wrapInputText(text: string, maxWidth: number): string[] {
  const width = Math.max(1, maxWidth);
  const stripped = stripAnsi(text);
  const lines: string[] = [];
  let current = '';

  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (ch === '\n') {
      lines.push(current);
      current = '';
      continue;
    }

    current += ch;
    if (visibleLength(current) >= width) {
      const lastSpace = current.lastIndexOf(' ');
      if (lastSpace > width / 2 && lastSpace < current.length - 1) {
        lines.push(current.slice(0, lastSpace));
        current = current.slice(lastSpace + 1);
      } else {
        let truncLen = 0;
        let visLen = 0;
        for (let j = 0; j < current.length; j++) {
          const cw = current.charCodeAt(j) >= 0x4e00 && current.charCodeAt(j) <= 0x9fff ? 2 : 1;
          if (visLen + cw > width) break;
          visLen += cw;
          truncLen = j + 1;
        }
        lines.push(current.slice(0, truncLen));
        current = current.slice(truncLen);
      }
    }
  }

  if (current.length > 0 || lines.length === 0) lines.push(current);
  return lines;
}

/**
 * Shared helper: compute the wrapped input text and visible body-line count.
 * Used by both renderDirectivePanel (rendering) and inputCursorPosition (cursor
 * placement) so they derive from the same model and can't drift apart.
 */
interface InputBodyInfo {
  wrapped: string[];
  bodyLineCount: number;
}

function computeInputBodyInfo(objectiveInput: string, inner: number, maxBodyLines: number): InputBodyInfo {
  const wrapWidth = inner - INPUT_DOCK_PADDING * 2;
  const hasInput = objectiveInput.length > 0;
  const wrapped = hasInput ? wrapInputText(objectiveInput, wrapWidth) : [];
  const bodyLineCount = hasInput
    ? Math.max(INPUT_DOCK_MIN_NONEMPTY_BODY_LINES, Math.min(maxBodyLines, wrapped.length))
    : 1;
  return { wrapped, bodyLineCount };
}

function renderInputDock(
  objectiveInput: string,
  width: number,
  coreMode: CoreMode = 'idle',
  nowMs: number = 0,
  metadataLabel?: string,
  maxBodyLines?: number,
): string[] {
  return ['', ...renderDirectivePanel(objectiveInput, width, coreMode, nowMs, metadataLabel, maxBodyLines)];
}

export interface InputCursorPosition {
  /** 0-indexed row within the full rendered layout. */
  row: number;
  /** 0-indexed column within the input body line. */
  col: number;
}

/** Compute the cursor position for the input box within a rendered layout. */
export function inputCursorPosition(
  objectiveInput: string,
  cols: number,
  rows: number,
  maxBodyLines?: number,
  cursorOffset?: number,
  hasSteering?: boolean,
): InputCursorPosition {
  const width = Math.max(40, cols);
  const renderWidth = terminalWriteWidth(width);
  const height = Math.max(14, rows);
  const effectiveMaxBodyLines = maxBodyLines ?? maxInputDockBodyLines(height - (hasSteering ? 1 : 0));
  const panelHeight = renderInputDock(objectiveInput, renderWidth, undefined, effectiveMaxBodyLines).length;
  const bodyHeight = Math.max(1, height - panelHeight - (hasSteering ? 1 : 0));
  const inner = Math.max(8, renderWidth - 2);
  const hasInput = objectiveInput.length > 0;
  const { wrapped, bodyLineCount } = computeInputBodyInfo(objectiveInput, inner, effectiveMaxBodyLines);
  const visibleInputLineCount = hasInput ? Math.min(bodyLineCount, wrapped.length) : 1;

  // Steering-aware dock offset (extra line for steering message bar)
  const steeringOffset = hasSteering ? 1 : 0;

  // If no explicit cursor offset, place at end of last line.
  if (cursorOffset === undefined) {
    const lastBodyLine = wrapped[wrapped.length - 1] ?? '';
    // dockStartRow: where the input dock begins in the layout (after transcript + steering)
    const dockStartRow = bodyHeight + steeringOffset;
    const row = dockStartRow + 1 + visibleInputLineCount;
    // Flat dock: first body line has "> " prefix (2 chars), continuation has no prefix
    const isContinuation = wrapped.length > 1;
    const col = (isContinuation ? 0 : 2) + lastBodyLine.length;
    return { row, col };
  }

  // Map cursorOffset into the wrapped lines.
  let remaining = cursorOffset;
  let cursorLine = 0;
  let cursorCol = 0;
  for (let i = 0; i < wrapped.length; i += 1) {
    const lineLen = wrapped[i].length;
    if (remaining <= lineLen) {
      cursorLine = i;
      cursorCol = remaining;
      break;
    }
    remaining -= lineLen;
    // Account for the implicit newline separator between wrapped lines.
    remaining -= 1;
    if (remaining < 0) remaining = 0;
    if (i === wrapped.length - 1) {
      cursorLine = i;
      cursorCol = lineLen;
    }
  }

  // Clamp to visible region.
  const visibleStart = Math.max(0, wrapped.length - visibleInputLineCount);
  if (cursorLine < visibleStart) cursorLine = visibleStart;
  const visibleLine = cursorLine - visibleStart;
  const dockStartRow = bodyHeight + steeringOffset;
  const row = dockStartRow + 1 + visibleLine + 1;
  // Flat dock: first body line has "> " prefix (2 chars), continuation has no prefix (0)
  const col = (visibleLine === 0 ? 2 : 0) + cursorCol;
  return { row, col };
}

function renderDirectivePanel(
  objectiveInput: string,
  width: number,
  coreMode: CoreMode,
  nowMs: number,
  _metadataLabel?: string,
  maxBodyLines = INPUT_DOCK_MAX_BODY_LINES,
): string[] {
  const inner = Math.max(8, width - 2);
  const hasInput = objectiveInput.length > 0;
  const { wrapped, bodyLineCount } = computeInputBodyInfo(objectiveInput, inner, maxBodyLines);
  const body = hasInput
    ? wrapped
        .slice(-bodyLineCount)
        .concat(Array.from({ length: Math.max(0, bodyLineCount - wrapped.length) }, () => ''))
    : [''];

  const promptColor = modePromptColor(coreMode, nowMs);
  const placeholder = hasInput ? '' : dimI('Ask Synax to inspect, edit, test, or commit…');
  const displayBody = hasInput ? body : [placeholder || ''];

  // Flatten dock: simple prompt line with horizontal rule above
  if (width < 14) {
    return [`${promptColor}>[0m ${displayBody[0]}`];
  }

  const hrWidth = Math.min(width - 2, 50);
  return [dim(`─${'─'.repeat(hrWidth)}`), `${promptColor}>[0m ${displayBody[0]}`, ...displayBody.slice(1)];
}

function maxInputDockBodyLines(rows: number): number {
  const viewportLimit = Math.max(
    INPUT_DOCK_MIN_NONEMPTY_BODY_LINES,
    rows - INPUT_DOCK_MIN_TRANSCRIPT_ROWS - 2, // hr line + prompt line
  );
  return Math.min(INPUT_DOCK_MAX_BODY_LINES, viewportLimit);
}

function inputDockHeight(objectiveInput: string, width: number, maxBodyLines: number): number {
  return renderInputDock(objectiveInput, width, undefined, maxBodyLines).length;
}

function putBlock(lines: string[], y: number, x: number, block: string[], width: number): void {
  for (let i = 0; i < block.length; i += 1) {
    put(lines, y + i, x, block[i], width);
  }
}

function put(lines: string[], y: number, x: number, text: string, width: number): void {
  if (y < 0 || y >= lines.length || x >= width) return;
  const base = pad(lines[y], width);
  const left = sliceVisible(base, 0, Math.max(0, x));
  const rightStart = Math.min(width, x + visibleLength(text));
  const right = sliceVisible(base, rightStart, width);
  lines[y] = `${left}${text}${right}`;
}

function phaseLabel(phase: string): string {
  if (phase === 'thinking') return 'Working';
  if (phase === 'tool_execution') return 'Tool';
  if (phase === 'completed') return 'Ready';
  if (phase === 'budget_exhausted') return 'Budget exhausted';
  return `${phase.slice(0, 1).toUpperCase()}${phase.slice(1)}`;
}

function activityStripVisible(state: InteractiveViewState): boolean {
  return state.run.terminal === 'running' && state.run.phase !== 'idle' && state.run.phase !== 'completed';
}

function renderActivityStrip(state: InteractiveViewState, width: number): string {
  const intervalMs = state.run.phase === 'thinking' ? 333 : 120;
  const frame = Math.floor(state.nowMs / intervalMs);
  const glyph = renderAnsiTokenStreamFrame(resolveModelFamily(state.modelLabel || state.run.modelId), frame);
  const label = state.run.phase === 'thinking' ? 'thinking' : 'working';
  const text = `${glyph} ${label} · ${fallbackActivitySummary(state.run)}`;
  return ` ${modeColor(state.coreMode)}${clip(text, Math.max(1, width - 2))}[0m`;
}

function fallbackActivitySummary(run: RunStateSnapshot): string {
  if (run.phase === 'verifying') {
    return run.verification.currentCheckLabel || 'running checks';
  }
  const latest = run.timeline[run.timeline.length - 1]?.summary ?? '';
  const cleaned = cleanActivitySummary(latest);
  if (run.phase === 'tool_execution') {
    return cleaned || toolNameFromStatus(run.statusNote) || 'running tool';
  }
  if (run.phase === 'thinking') {
    if (/^Tool\s*·/i.test(latest)) return `reviewing ${cleaned || 'tool'} result`;
    if (cleaned && !/objective registered/i.test(cleaned) && !/^step\s+\d+/i.test(cleaned)) return cleaned;
    return run.objective.nextCheckpoint || 'awaiting model response';
  }
  return cleaned || run.objective.nextCheckpoint || 'working';
}

function cleanActivitySummary(summary: string): string {
  return summary
    .replace(/^Working\s*·\s*/i, '')
    .replace(/^Tool\s*·\s*/i, '')
    .replace(/\s+ok$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toolNameFromStatus(statusNote?: string): string {
  return (statusNote ?? '').replace(/^tool:\s*/i, '').trim();
}

function locationLabel(cwdLabel?: string, gitBranch?: string): string | undefined {
  if (!cwdLabel && !gitBranch) return undefined;
  if (!gitBranch) return cwdLabel;
  if (!cwdLabel) return gitBranch;
  return `${cwdLabel}  ${gitBranch}`;
}

function bold(text: string): string {
  return `[1;37m${text}[0m`;
}

function boldDim(text: string): string {
  return `[1;90m${text}[0m`;
}

function dim(text: string): string {
  return `[90m${text}[0m`;
}

function dimI(text: string): string {
  return `[3;90m${text}[0m`;
}
