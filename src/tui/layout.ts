import type { RunStateSnapshot } from '../agent/tui-state';
import type { CoreMode } from './ai-core';
import { CORE_WIDTH, modeColor, renderAiCore } from './ai-core';

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
}

export function renderLayout(state: InteractiveViewState, cols: number, rows: number): string[] {
  const width = Math.max(40, cols);
  const height = Math.max(14, rows);
  const lines: string[] = [];
  const core = renderAiCore(state.coreMode, state.nowMs / 1000);
  const coreWidth = CORE_WIDTH;
  const contentWidth = Math.max(20, width - coreWidth - 2);
  const panel = renderDirectivePanel(state.objectiveInput, contentWidth, state.modelLabel);
  const bodyHeight = Math.max(1, height - panel.length);

  lines.push(
    clip(
      `\u001b[1;37mSynax\u001b[0m  ${state.run.phase}  ${elapsed(state.run.startedAtMs, state.nowMs)}`,
      contentWidth,
    ),
  );
  lines.push('');
  lines.push(`Activity: ${clip(activitySummary(state.run), contentWidth - 10)}`);
  lines.push(`Working on: ${clip(state.run.objective.label || 'Awaiting objective', contentWidth - 12)}`);
  lines.push(
    `Phase: ${clip(state.run.phase, contentWidth - 7)} | Next: ${clip(state.run.objective.nextCheckpoint, contentWidth - 16)}`,
  );
  lines.push('');
  lines.push('Progress:');
  const timeline = state.run.timeline.slice(-4);
  if (timeline.length === 0) {
    lines.push('  - waiting');
  } else {
    for (const item of timeline) lines.push(`  ${glyph(item.phase)} ${clip(item.summary, contentWidth - 4)}`);
  }
  lines.push('');
  lines.push('Files touched:');
  const files = state.run.changes.items.slice(-4);
  if (files.length === 0) lines.push('  - none yet');
  else for (const file of files) lines.push(`  ${file.op.padEnd(6)} ${clip(file.path, contentWidth - 10)}`);
  lines.push('');
  lines.push(`Verification: ${state.run.verification.state} (${state.run.verification.summary || 'not run yet'})`);
  if (state.blockedMessage) lines.push(`\u001b[33mBlocked: ${clip(state.blockedMessage, contentWidth - 9)}\u001b[0m`);
  lines.push('');

  const clipped = lines.slice(0, bodyHeight);
  while (clipped.length < bodyHeight) clipped.push('');
  clipped.push(...panel);

  const coreX = Math.max(0, width - coreWidth);
  const coreY = 0;
  for (let i = 0; i < core.length && coreY + i < clipped.length; i += 1) {
    const base = pad(clipped[coreY + i], width);
    const left = sliceVisible(base, 0, coreX);
    clipped[coreY + i] = `${left}${modeColor(state.coreMode)}${core[i]}\u001b[0m`;
  }

  return clipped.map((line) => pad(line, width));
}

function glyph(phase: string): string {
  if (phase === 'completed') return '✓';
  if (phase === 'error' || phase === 'blocked' || phase === 'budget_exhausted') return '!';
  if (phase === 'tool_execution') return '◌';
  return '·';
}

function elapsed(startedAtMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function clip(text: string, width: number): string {
  const visible = stripAnsi(text);
  if (visible.length <= width) return text;
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
  const visible = stripAnsi(line);
  if (visible.length >= width) return line;
  return `${line}${' '.repeat(width - visible.length)}`;
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
        if (writing) out += match[0];
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

function wrapText(text: string, maxWidth: number): string[] {
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/\u001b\[[0-9;]*m/g, '');
  const lines: string[] = [];
  let current = '';

  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (ch === '\n') {
      lines.push(current.trimEnd());
      current = '';
      continue;
    }
    current += ch;
    if (current.length >= maxWidth) {
      // try to break on last space
      const lastSpace = current.lastIndexOf(' ');
      if (lastSpace > maxWidth / 2) {
        lines.push(current.slice(0, lastSpace).trimEnd());
        current = current.slice(lastSpace + 1);
      } else {
        lines.push(current.slice(0, maxWidth));
        current = current.slice(maxWidth);
      }
    }
  }
  if (current.trim().length > 0) lines.push(current.trimEnd());
  return lines.length > 0 ? lines : [''];
}

/** Truncate a model ID for display in the input panel border label. */
function truncateModelLabel(model: string, maxLen: number): string {
  if (model.length <= maxLen) return model;
  // Keep as much of the identifier as we can, strip from the end.
  return `${model.slice(0, maxLen - 1)}…`;
}

function activitySummary(run: RunStateSnapshot): string {
  const latest = run.timeline[run.timeline.length - 1]?.summary;
  if (latest) return latest;
  if (run.statusNote) return run.statusNote;
  if (run.phase === 'idle') return 'waiting for run start';
  return run.objective.nextCheckpoint;
}

function renderDirectivePanel(objectiveInput: string, width: number, modelLabel?: string): string[] {
  const inner = Math.max(8, width - 2);
  const wrapped = wrapText(objectiveInput.trim() || 'Awaiting objective', inner - 2);
  const body = wrapped.slice(0, 2);
  while (body.length < 2) body.push('');

  // Model label as instrumentation tag — low-contrast, right-aligned in top border.
  const label = modelLabel ? truncateModelLabel(modelLabel, Math.max(4, inner - 6)) : 'Directive';
  const labelLen = label.length + 2; // space + label + space
  const topDash = Math.max(0, inner - labelLen);

  // Bottom border: help text, dynamically sized.
  const helpText = ' Enter submit | Ctrl+C exit | Ctrl+L redraw | /help';
  const helpLen = helpText.length;
  const bottomDash = Math.max(0, inner - helpLen);

  return [
    `┌${'─'.repeat(topDash)} ${label} ─┐`,
    `│ ${clip(body[0], inner - 2).padEnd(inner - 2, ' ')} │`,
    `│ ${clip(body[1], inner - 2).padEnd(inner - 2, ' ')} │`,
    `└${helpText}${'─'.repeat(bottomDash)}┘`,
  ];
}
