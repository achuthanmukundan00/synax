import type { RunStateSnapshot } from '../agent/tui-state';
import type { CoreMode } from './ai-core';
import { CORE_HEIGHT, CORE_WIDTH, modeColor, modePromptColor, renderAiCore, renderDottedCore } from './ai-core';
import {
  resolveCoreVisualProfile,
  type CoreVisualResolverOptions,
  type CoreVisualProfileId,
} from './core-visual-profile';
import { renderTranscript, toolsUsed } from './transcript';
import pkg from '../../package.json';

const RESET = '\u001b[0m';

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
  /** Override core visual profile: 'model' (auto-detect), 'default', 'qwen', 'openai', 'claude', 'deepseek', 'gemini'. */
  coreVisualProfile?: string;
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
  const panel = renderInputDock(
    state.objectiveInput,
    renderWidth,
    state.coreMode,
    state.nowMs,
    locationLabel(state.cwdLabel, state.gitBranch),
    maxInputDockBodyLines(height),
  );
  const bodyHeight = Math.max(1, height - panel.length - steeringBarHeight);
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
    renderHeader(lines, renderWidth, state);
    renderOperationalSurface(lines, renderWidth, bodyHeight, state);
  }

  if (state.blockedMessage) {
    put(
      lines,
      Math.max(2, bodyHeight - 2),
      2,
      `\u001b[33mBlocked · ${clip(state.blockedMessage, renderWidth - 12)}\u001b[0m`,
      renderWidth,
    );
  }

  const clipped = lines.slice(0, bodyHeight).map((line) => pad(clip(line, renderWidth), width));
  // ── Steering message bar (shown above prompt box while bot is generating) ──
  if (state.steeringMessage) {
    const steeringLabel = '  steering> ';
    const maxMsgWidth = width - steeringLabel.length - 4;
    const truncated =
      state.steeringMessage.length > maxMsgWidth
        ? state.steeringMessage.slice(0, maxMsgWidth - 3) + '...'
        : state.steeringMessage;
    // Steel blue (synax) + italic + dim
    const steelBlue = '\u001b[38;2;67;76;88;3m';
    clipped.push(pad(`${steelBlue}${steeringLabel}${truncated}\u001b[0m`, width));
  }
  clipped.push(...panel);
  return clipped.map((line) => pad(clip(line, width), width));
}

export function maxHistoryScrollOffset(state: InteractiveViewState, _cols: number, rows: number): number {
  const width = Math.max(40, _cols);
  const renderWidth = terminalWriteWidth(width);
  const height = Math.max(14, rows);
  const panelHeight = inputDockHeight(state.objectiveInput, renderWidth, maxInputDockBodyLines(height));
  const bodyHeight = Math.max(1, height - panelHeight - (state.steeringMessage ? 1 : 0));
  const visibleRows = Math.max(1, bodyHeight - 3);
  const sideWidth = operationalSideWidth(renderWidth, bodyHeight);
  const transcriptWidth = sideWidth > 0 ? renderWidth - sideWidth - 5 : renderWidth - 4;
  const transcriptLines = renderTranscript({ ...state, nowMs: state.nowMs }, Math.max(24, transcriptWidth));
  return Math.max(0, transcriptLines.length - visibleRows);
}

function renderWelcome(lines: string[], width: number, bodyHeight: number, state: InteractiveViewState): void {
  const core = renderAiCore(
    state.coreMode,
    state.nowMs / 1000,
    resolveCoreVisualProfile(coreModelId(state), coreVisualOptions(state.coreVisualProfile)),
  );
  const coreX = Math.max(0, Math.floor(width * 0.45 - CORE_WIDTH / 2));
  const coreY = Math.max(2, Math.floor((bodyHeight - CORE_HEIGHT) / 2) - 2);
  const telemetryWidth = Math.min(34, Math.max(24, width - (coreX + CORE_WIDTH + 4)));
  const telemetryX = Math.min(width - telemetryWidth, coreX + CORE_WIDTH + 3);

  renderHeader(lines, width, state);
  putBlock(lines, coreY, coreX, core, width);
  putBlock(lines, coreY + 1, telemetryX, renderTelemetry(state, telemetryWidth), width);
}

function renderHeader(lines: string[], width: number, state: InteractiveViewState): void {
  const run = state.run;
  const header = [
    `\u001b[1;37mSynax v${pkg.version}\u001b[0m`,
    `${modeColor(state.coreMode)}${phaseLabel(run.phase)}\u001b[0m`,
    dim(elapsed(run.startedAtMs, elapsedEndMs(state))),
  ].join('  ');
  put(lines, 0, 2, clip(header, width - 4), width);
}

function elapsedEndMs(state: InteractiveViewState): number {
  return state.run.terminal === 'running' ? state.nowMs : state.run.nowMs;
}

function renderOperationalSurface(
  lines: string[],
  width: number,
  bodyHeight: number,
  state: InteractiveViewState,
): void {
  const showSideCore = width >= 110 && bodyHeight >= 18;
  const showHeaderCore = !showSideCore && width >= 70 && bodyHeight >= 18;
  const sideWidth = operationalSideWidth(width, bodyHeight);
  const transcriptWidth = operationalTranscriptWidth(width, bodyHeight);
  const transcriptLines = renderTranscript({ ...state, nowMs: state.nowMs }, Math.max(24, transcriptWidth));
  const visibleRows = Math.max(1, bodyHeight - 3);
  const maxScrollOffset = Math.max(0, transcriptLines.length - visibleRows);
  const scrollOffset = Math.min(maxScrollOffset, Math.max(0, state.historyScrollOffset ?? 0));
  const visibleTranscript = transcriptLines.slice(
    Math.max(0, transcriptLines.length - visibleRows - scrollOffset),
    Math.max(0, transcriptLines.length - scrollOffset),
  );

  const lineOffset = 2;
  for (let i = 0; i < visibleTranscript.length && lineOffset + i < bodyHeight; i += 1) {
    put(lines, lineOffset + i, 2, clip(visibleTranscript[i], transcriptWidth), width);
  }

  if (showSideCore) {
    putBlock(lines, 2, width - sideWidth, renderCoreModule(state, sideWidth - 2, bodyHeight - 2), width);
  } else if (showHeaderCore) {
    putBlock(lines, 1, Math.max(2, width - 34), renderCompactCoreModule(state), width);
  }
}

function operationalSideWidth(width: number, bodyHeight: number): number {
  return width >= 110 && bodyHeight >= 18 ? 38 : 0;
}

function operationalTranscriptWidth(width: number, bodyHeight: number): number {
  const sideWidth = operationalSideWidth(width, bodyHeight);
  return sideWidth > 0 ? width - sideWidth - 5 : width - 4;
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

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\u001b') {
      // eslint-disable-next-line no-control-regex
      const match = /\u001b\[[0-9;]*m/.exec(text.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length - 1;
        continue;
      }
    }

    if (visibleCount >= target) break;
    out += text[i];
    visibleCount += 1;
  }

  return `${out}…`;
}

function pad(line: string, width: number): string {
  const visible = visibleLength(line);
  if (visible >= width) return line;
  return `${line}${' '.repeat(width - visible)}`;
}

function sliceVisible(line: string, start: number, end: number): string {
  const targetStart = Math.max(0, start);
  const targetEnd = Math.max(targetStart, end);
  let visibleIndex = 0;
  let out = '';
  let writing = false;

  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\u001b') {
      // eslint-disable-next-line no-control-regex
      const match = /\u001b\[[0-9;]*m/.exec(line.slice(i));
      if (match) {
        // Include ANSI codes that start at or after the slice targetStart, not only
        // after writing has begun.  Without this, leading ANSI codes and codes at
        // slice boundaries are dropped, causing color bleed and visual displacement
        // when put() overlays the AI core next to the transcript.
        if (writing || visibleIndex >= targetStart) out += match[0];
        i += match[0].length - 1;
        continue;
      }
    }
    if (visibleIndex >= targetEnd) break;
    if (visibleIndex >= targetStart) {
      writing = true;
      out += line[i];
    }
    visibleIndex += 1;
  }

  return out;
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}

function visibleLength(input: string): number {
  return stripAnsi(input).length;
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
    if (current.length >= width) {
      const lastSpace = current.lastIndexOf(' ');
      if (lastSpace > width / 2 && lastSpace < current.length - 1) {
        lines.push(current.slice(0, lastSpace));
        current = current.slice(lastSpace + 1);
      } else {
        lines.push(current.slice(0, width));
        current = current.slice(width);
      }
    }
  }

  if (current.length > 0 || lines.length === 0) lines.push(current);
  return lines;
}

function renderInputDock(
  objectiveInput: string,
  width: number,
  coreMode: CoreMode = 'idle',
  nowMs: number = 0,
  metadataLabel?: string,
  maxBodyLines?: number,
): string[] {
  return ['', '', ...renderDirectivePanel(objectiveInput, width, coreMode, nowMs, metadataLabel, maxBodyLines)];
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
  const effectiveMaxBodyLines = maxBodyLines ?? maxInputDockBodyLines(height);
  const panelHeight = renderInputDock(objectiveInput, renderWidth, undefined, effectiveMaxBodyLines).length;
  const bodyHeight = Math.max(1, height - panelHeight);
  const inner = Math.max(8, renderWidth - 2);
  const wrapWidth = inner - INPUT_DOCK_PADDING * 2;
  const hasInput = objectiveInput.length > 0;
  const wrapped = hasInput ? wrapInputText(objectiveInput, wrapWidth) : [''];
  const renderedBodyLineCount = hasInput
    ? Math.max(INPUT_DOCK_MIN_NONEMPTY_BODY_LINES, Math.min(effectiveMaxBodyLines, wrapped.length))
    : 1;
  const visibleInputLineCount = hasInput ? Math.min(renderedBodyLineCount, wrapped.length) : 1;

  // Steering-aware dock offset (extra line for steering message bar)
  const steeringOffset = hasSteering ? 1 : 0;

  // If no explicit cursor offset, place at end of last line.
  if (cursorOffset === undefined) {
    const lastBodyLine = wrapped[wrapped.length - 1] ?? '';
    const dockStartRow = bodyHeight + steeringOffset;
    const row = dockStartRow + 2 + visibleInputLineCount;
    const col = 1 + INPUT_DOCK_PADDING + lastBodyLine.length;
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
  const row = dockStartRow + 2 + visibleLine + 1;
  const col = 1 + INPUT_DOCK_PADDING + cursorCol;
  return { row, col };
}

function renderDirectivePanel(
  objectiveInput: string,
  width: number,
  coreMode: CoreMode,
  nowMs: number,
  metadataLabel?: string,
  maxBodyLines = INPUT_DOCK_MAX_BODY_LINES,
): string[] {
  const inner = Math.max(8, width - 2);
  const hasInput = objectiveInput.length > 0;
  const wrapWidth = inner - INPUT_DOCK_PADDING * 2;
  const wrapped = hasInput ? wrapInputText(objectiveInput, wrapWidth) : [];
  const bodyLineCount = hasInput
    ? Math.max(INPUT_DOCK_MIN_NONEMPTY_BODY_LINES, Math.min(maxBodyLines, wrapped.length))
    : 1;
  // Keep the tail visible so active typing stays in view at larger input sizes.
  const body = hasInput
    ? wrapped
        .slice(-bodyLineCount)
        .concat(Array.from({ length: Math.max(0, bodyLineCount - wrapped.length) }, () => ''))
    : [''];

  const promptColor = modePromptColor(coreMode, nowMs);
  const label = metadataLabel ? ` ${truncateMiddle(metadataLabel, Math.max(4, inner - 6))} ` : '';
  const topFill = Math.max(0, inner - label.length);
  const helpText = 'Enter submit · Esc interrupt · Shift+↵ · Ctrl+D exit · Ctrl+C clear · /help · !cmd';
  const bottomFill = Math.max(0, inner - helpText.length - 2);

  const placeholder = hasInput ? '' : dimI('Ask Synax to inspect, edit, test, or commit…');
  const displayBody = hasInput ? body : [placeholder || ''];

  return [
    `${promptColor}┌${'─'.repeat(topFill)}${label ? dim(label) : ''}${promptColor}┐${RESET}`,
    ...displayBody.map(
      (line) =>
        `${promptColor}│${RESET}${' '.repeat(INPUT_DOCK_PADDING)}${pad(clip(line, inner - INPUT_DOCK_PADDING * 2), inner - INPUT_DOCK_PADDING * 2)}${' '.repeat(INPUT_DOCK_PADDING)}${promptColor}│${RESET}`,
    ),
    `${promptColor}└${RESET} ${dim(helpText)} ${promptColor}${'─'.repeat(bottomFill)}┘${RESET}`,
  ];
}

function terminalWriteWidth(width: number): number {
  return width > 1 ? width - 1 : width;
}

function maxInputDockBodyLines(rows: number): number {
  const viewportLimit = Math.max(
    INPUT_DOCK_MIN_NONEMPTY_BODY_LINES,
    rows - INPUT_DOCK_MIN_TRANSCRIPT_ROWS - 3, // spacer + top border + bottom border
  );
  return Math.min(INPUT_DOCK_MAX_BODY_LINES, viewportLimit);
}

function inputDockHeight(objectiveInput: string, width: number, maxBodyLines: number): number {
  return renderInputDock(objectiveInput, width, undefined, maxBodyLines).length;
}

function renderCoreModule(state: InteractiveViewState, width: number, maxHeight: number): string[] {
  const inner = Math.max(20, width - 2);
  const coreWidth = Math.min(20, inner);
  const core = renderDottedCore({
    mode: state.coreMode,
    frame: state.coreMode === 'unloaded' ? 0 : Math.floor((state.nowMs / 1000) * 8),
    width: coreWidth,
    height: 7,
    unicode: true,
    profile: resolveCoreVisualProfile(coreModelId(state), coreVisualOptions(state.coreVisualProfile)),
  }).map((line) => centerVisible(line, inner));
  const body = [
    ...core,
    '',
    sectionLabel('Runtime'),
    ...runtimeTelemetryRows(state, inner),
    contextUsageBar(state.run, inner),
    '',
    sectionLabel('Session'),
    ...sessionTelemetryRows(state.run, inner),
  ];

  if (width < 24 || body.length + 2 > maxHeight) return body.map((line) => clip(line, width));

  return [
    panelTop('Synax Core', inner),
    ...body.map((line) => `${dim('│')}${pad(clip(line, inner), inner)}${dim('│')}`),
    dim(`└${'─'.repeat(inner)}┘`),
  ];
}

function renderCompactCoreModule(state: InteractiveViewState): string[] {
  return renderDottedCore({
    mode: state.coreMode,
    frame: state.coreMode === 'unloaded' ? 0 : Math.floor((state.nowMs / 1000) * 8),
    width: 24,
    height: 1,
    unicode: true,
    profile: resolveCoreVisualProfile(coreModelId(state), coreVisualOptions(state.coreVisualProfile)),
  });
}

function renderTelemetry(state: InteractiveViewState, width: number): string[] {
  const inner = Math.max(20, width);
  return [
    sectionLabel('Runtime'),
    ...runtimeTelemetryRows(state, inner),
    contextUsageBar(state.run, inner),
    '',
    sectionLabel('Session'),
    ...sessionTelemetryRows(state.run, inner),
  ].map((line) => clip(line, width));
}

function runtimeTelemetryRows(state: InteractiveViewState, width: number): string[] {
  const run = state.run;
  const model = state.modelLabel || run.modelId || modelFromProvider(run.providerLabel);
  const friendlyModel = model ? friendlyModelDisplayName(model) : '';
  const route = routeDisplayLine(state.endpointLabel, state.modelLabel, run);
  const provider = providerLabel(state.endpointLabel, run);
  const context = contextLine(run);
  const valueWidth = Math.max(4, width - 12);

  const rows = [
    instrumentRow('Core', coreStatusLabel(state), width, { color: modeColor(state.coreMode) }),
    instrumentRow('Model', friendlyModel ? truncateMiddle(friendlyModel, valueWidth) : '—', width, {
      dimValue: !model,
    }),
  ];
  if (route && route !== model) {
    rows.push(instrumentRow('Route', truncateMiddle(route, valueWidth), width, { dimValue: true }));
  }
  rows.push(
    instrumentRow('Provider', provider === 'unknown' ? '—' : provider, width, { dimValue: provider === 'unknown' }),
    instrumentRow('Context', context, width, { dimValue: context === '—' }),
  );
  return rows;
}

function sessionTelemetryRows(run: RunStateSnapshot, width: number): string[] {
  const tools = toolsUsed(run);
  const skills = run.activeSkills ?? [];

  const rows: string[] = [];
  if (skills.length > 0) {
    rows.push(instrumentRow('Skills', skills.join(', '), width, { color: '\u001b[36m' }));
  }
  rows.push(
    instrumentRow('Thinking', run.thinkingEnabled === undefined ? '—' : run.thinkingEnabled ? 'on' : 'off', width, {
      dimValue: run.thinkingEnabled === undefined,
    }),
    instrumentRow('Spend', run.sessionSpendLabel ?? '—', width, {
      dimValue: run.sessionSpendLabel === undefined,
    }),
    instrumentRow('Tools', tools.length > 0 ? tools.join(', ') : 'none', width, { dimValue: tools.length === 0 }),
    instrumentRow('Steps', modelSteps(run.statusNote), width, { dimValue: modelSteps(run.statusNote) === '—' }),
  );
  return rows;
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

function modelFromProvider(provider: string): string {
  const [model] = provider.split(' @ ');
  return model === 'n/a' ? '' : model;
}

function providerLabel(endpointLabel: string | undefined, run: RunStateSnapshot): string {
  if (run.providerName && run.providerName !== 'unknown') return run.providerName;
  const endpoint = endpointLabel || run.providerLabel.split(' @ ')[1] || '';
  if (/(?:^|\/\/)(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(endpoint)) return 'Relay';
  if (/api\.openai\.com/i.test(endpoint)) return 'OpenAI';
  if (/anthropic/i.test(endpoint)) return 'Anthropic';
  if (/openrouter/i.test(endpoint)) return 'OpenRouter';
  return endpoint ? 'OpenAI-compatible' : 'unknown';
}

function coreStatusLabel(state: InteractiveViewState): string {
  if (state.run.terminal === 'completed' || state.run.phase === 'completed') return 'Complete';
  if (state.run.coreLoaded) return 'Loaded';
  const model = state.modelLabel || state.run.modelId || modelFromProvider(state.run.providerLabel);
  return model ? 'Loaded' : 'Unloaded';
}

function coreModelId(state: InteractiveViewState): string {
  return state.modelLabel || state.run.modelId || modelFromProvider(state.run.providerLabel);
}

function coreVisualOptions(profile?: string): CoreVisualResolverOptions {
  if (!profile || profile === 'model') return {};
  const valid: CoreVisualProfileId[] = ['default', 'qwen', 'openai', 'claude', 'deepseek', 'gemini'];
  if (valid.includes(profile as CoreVisualProfileId)) {
    return { profile: profile as CoreVisualProfileId };
  }
  return {};
}

function contextLine(run: RunStateSnapshot): string {
  if (run.contextUsedTokens === undefined && run.contextWindowTokens === undefined) return '—';
  const used = run.contextUsedTokens ?? 0;
  const total = run.contextWindowTokens ?? 0;
  const ratio = total > 0 ? ` (${Math.round((used / total) * 100)}%)` : '';
  return `${formatTokens(used)} / ${formatTokens(total)}${ratio}`;
}

function contextUsageBar(run: RunStateSnapshot, width: number): string {
  const total = run.contextWindowTokens;
  const used = run.contextUsedTokens ?? 0;
  const prefix = 'ctx ';
  const barWidth = Math.max(1, width - prefix.length);
  if (!total || total <= 0) return dim(`${prefix}${'░'.repeat(barWidth)}`);
  const ratio = Math.max(0, Math.min(1, used / total));
  // Hide the bar when usage is negligible (< 10 %) to reduce visual noise.
  if (ratio < 0.1) return dim(`${prefix}${'░'.repeat(barWidth)}`);
  const filled = Math.round(ratio * barWidth);
  return `${dim(prefix)}${modeColorForRatio(ratio)}${'█'.repeat(filled)}\u001b[0m${dim('░'.repeat(barWidth - filled))}`;
}

function instrumentRow(
  label: string,
  value: string,
  width: number,
  options: { color?: string; dimValue?: boolean } = {},
): string {
  const labelWidth = 11;
  const valueWidth = Math.max(1, width - labelWidth - 1);
  const renderedValue = options.dimValue ? dim(truncateMiddle(value, valueWidth)) : truncateMiddle(value, valueWidth);
  const prefix = `${dim(label.padEnd(labelWidth, ' '))} `;
  if (!options.color) return `${prefix}${renderedValue}`;
  return `${prefix}${options.color}${truncateMiddle(value, valueWidth)}\u001b[0m`;
}

function modelSteps(statusNote: string): string {
  const ratio = /(\d+)\s*\/\s*(\d+)\s+model steps?/i.exec(statusNote);
  if (ratio) return `${ratio[1]}/${ratio[2]}`;
  const match = /(\d+)\s+model steps?/i.exec(statusNote);
  return match ? match[1] : '—';
}

function panelTop(title: string, width: number): string {
  const label = ` ${title} `;
  const fill = Math.max(0, width - label.length);
  return dim(`┌${label}${'─'.repeat(fill)}┐`);
}

function sectionLabel(label: string): string {
  return dim(label);
}

function modeColorForRatio(ratio: number): string {
  if (ratio > 0.85) return '\u001b[33m';
  return '\u001b[34m';
}

function centerVisible(line: string, width: number): string {
  const visible = visibleLength(line);
  if (visible >= width) return clip(line, width);
  const left = Math.floor((width - visible) / 2);
  return `${' '.repeat(left)}${line}${' '.repeat(width - visible - left)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens >= 10_000 ? 1 : 1)}k`;
  return String(tokens);
}

function truncateMiddle(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  if (maxLen <= 4) return value.slice(0, maxLen);
  const keep = maxLen - 1;
  const head = Math.ceil(keep * 0.62);
  const tail = Math.max(1, keep - head);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

function locationLabel(cwdLabel?: string, gitBranch?: string): string | undefined {
  if (!cwdLabel && !gitBranch) return undefined;
  if (!gitBranch) return cwdLabel;
  if (!cwdLabel) return gitBranch;
  return `${cwdLabel}  ${gitBranch}`;
}

/** Derive a friendly human-readable model name from a raw model ID.
 *  e.g. "baidu/cobuddy:free" → "Cobuddy: Free" */
function friendlyModelDisplayName(modelId: string): string {
  if (!modelId) return '';
  let name = modelId;
  // Strip provider namespace prefix
  const lastSlash = name.lastIndexOf('/');
  if (lastSlash >= 0 && lastSlash < name.length - 1) {
    name = name.slice(lastSlash + 1);
  }
  // Make separators readable
  name = name.replace(/-/g, ' ');
  name = name.replace(/_/g, ' ');
  name = name.replace(/:/g, ': ');
  // Capitalize first letter of each word
  name = name.replace(/\b\w/g, (c) => c.toUpperCase());
  // Collapse multiple spaces
  name = name.replace(/\s+/g, ' ').trim();
  return name;
}

/** Build a route display line showing provider and raw model ID. */
function routeDisplayLine(
  _endpointLabel: string | undefined,
  modelLabel: string | undefined,
  run: RunStateSnapshot,
): string {
  const providerName = run.providerName && run.providerName !== 'unknown' ? run.providerName : '';
  const model = modelLabel || run.modelId || '';
  if (!model) return '';
  if (providerName) return `${providerName} · ${model}`;
  return model;
}

function dim(text: string): string {
  return `\u001b[90m${text}\u001b[0m`;
}

function dimI(text: string): string {
  return `\u001b[3;90m${text}\u001b[0m`;
}
