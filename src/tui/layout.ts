import type { RunStateSnapshot } from '../agent/tui-state';
import type { CoreMode } from './ai-core';
import { CORE_HEIGHT, CORE_WIDTH, modeColor, renderAiCore } from './ai-core';

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
  /** Number of wrapped history lines hidden below the viewport. */
  historyScrollOffset?: number;
}

export function renderLayout(state: InteractiveViewState, cols: number, rows: number): string[] {
  const width = Math.max(40, cols);
  const height = Math.max(14, rows);
  const panel = renderDirectivePanel(state.objectiveInput, width, state.modelLabel);
  const bodyHeight = Math.max(1, height - panel.length);
  const lines = Array.from({ length: bodyHeight }, () => '');
  const core = renderAiCore(state.coreMode, state.nowMs / 1000);
  const compact = width < 70 || bodyHeight < CORE_HEIGHT + 6;
  const coreX = compact
    ? Math.max(0, Math.floor((width - CORE_WIDTH) / 2))
    : Math.max(0, Math.floor(width * 0.45 - CORE_WIDTH / 2));
  const coreY = compact ? 2 : Math.max(2, Math.floor((bodyHeight - CORE_HEIGHT) / 2) - 2);
  const telemetryWidth = compact ? width - 4 : Math.min(34, Math.max(24, width - (coreX + CORE_WIDTH + 4)));
  const telemetryX = compact ? 2 : Math.min(width - telemetryWidth, coreX + CORE_WIDTH + 3);
  const telemetryY = compact ? Math.min(bodyHeight - 1, coreY + CORE_HEIGHT + 1) : coreY + 1;

  put(
    lines,
    0,
    2,
    `\u001b[1;37mSynax\u001b[0m ${modeColor(state.coreMode)}${phaseLabel(state.run.phase)}\u001b[0m ${elapsed(state.run.startedAtMs, state.nowMs)}`,
    width,
  );
  put(lines, 1, 2, dim('contained local intelligence runtime'), width);
  if (state.run.phase === 'completed' && state.run.statusNote) {
    put(lines, 3, 2, activitySummary(state.run), width);
  }
  putBlock(lines, coreY, coreX, core, width);
  putTelemetry(lines, telemetryY, telemetryX, telemetryWidth, state);

  if (state.run.patchPreview && bodyHeight > coreY + CORE_HEIGHT + 5) {
    putPatchPreview(lines, Math.min(bodyHeight - 6, coreY + CORE_HEIGHT + 2), 2, Math.min(width - 4, 78), state.run);
  }
  if (state.blockedMessage) {
    put(
      lines,
      Math.max(2, bodyHeight - 2),
      2,
      `\u001b[33mBlocked · ${clip(state.blockedMessage, width - 12)}\u001b[0m`,
      width,
    );
  }

  const clipped = lines.slice(0, bodyHeight).map((line) => pad(clip(line, width), width));
  clipped.push(...panel);
  return clipped.map((line) => pad(clip(line, width), width));
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
  if (run.phase === 'completed' && run.statusNote) return completionActivity(run.statusNote);
  if (latest) return latest;
  if (run.statusNote) return compactStatus(run.statusNote);
  if (run.phase === 'idle') return 'Idle · awaiting objective';
  return `${phaseLabel(run.phase)} · ${run.objective.nextCheckpoint}`;
}

function renderDirectivePanel(objectiveInput: string, width: number, modelLabel?: string): string[] {
  const inner = Math.max(8, width - 4);
  const wrapped = wrapText(objectiveInput.trim() || 'Awaiting objective', inner - 2);
  const body = wrapped.slice(0, 2);
  while (body.length < 2) body.push('');

  const label = modelLabel ? truncateModelLabel(modelLabel, Math.max(4, inner - 6)) : 'Directive';
  const topFill = Math.max(0, inner - label.length - 3);
  const helpText = 'Enter submit | Ctrl+C exit | Ctrl+L redraw | /help';
  const bottomFill = Math.max(0, inner - helpText.length - 1);

  return [
    ` ${dim('▁'.repeat(topFill))} ${label} `,
    ` ${clip(body[0], inner - 2).padEnd(inner - 2, ' ')} `,
    ` ${clip(body[1], inner - 2).padEnd(inner - 2, ' ')} `,
    ` ${dim(helpText)}${dim('▔'.repeat(bottomFill))}`,
  ];
}

function putTelemetry(lines: string[], y: number, x: number, width: number, state: InteractiveViewState): void {
  const run = state.run;
  const items = [
    `${dim('Field')} ${modeColor(state.coreMode)}${phaseLabel(run.phase)}\u001b[0m`,
    activitySummary(run),
    `Objective · ${run.objective.label || 'Awaiting objective'}`,
    `Next · ${run.objective.nextCheckpoint}`,
    verificationLine(run),
    changeLine(run),
  ];

  for (let i = 0; i < items.length; i += 1) {
    put(lines, y + i, x, clip(items[i], width), x + width);
  }
}

function putPatchPreview(lines: string[], y: number, x: number, width: number, run: RunStateSnapshot): void {
  if (!run.patchPreview) return;
  const diffLines = run.patchPreview.diff.split('\n').slice(0, 4);
  put(lines, y, x, dim(`Diff preview: ${clip(run.patchPreview.path, width - 14)}`), x + width);
  for (let i = 0; i < diffLines.length; i += 1) {
    put(lines, y + i + 1, x + 2, clip(diffLines[i], width - 4), x + width);
  }
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
  const rightStart = Math.min(width, x + stripAnsi(text).length);
  const right = sliceVisible(base, rightStart, width);
  lines[y] = `${left}${text}${right}`;
}

function phaseLabel(phase: string): string {
  if (phase === 'tool_execution') return 'Tool';
  if (phase === 'budget_exhausted') return 'Budget exhausted';
  return `${phase.slice(0, 1).toUpperCase()}${phase.slice(1)}`;
}

function verificationLine(run: RunStateSnapshot): string {
  if (run.verification.state === 'passed') return 'Verification · passed';
  if (run.verification.state === 'running') return `Verification · ${run.verification.currentCheckLabel || 'running'}`;
  if (run.verification.state === 'failed') return `Verification · failed`;
  if (run.verification.state === 'skipped') return `Verification · skipped`;
  return `Verification · ${run.verification.summary || 'planned'}`;
}

function changeLine(run: RunStateSnapshot): string {
  const count = run.changes.items.length + run.changes.overflowCount;
  if (count === 0) return 'Changes · none';
  const latest = run.changes.items[run.changes.items.length - 1];
  if (!latest) return `Changes · ${count}`;
  return `Changes · ${count} · ${latest.op} ${latest.path}`;
}

function completionActivity(statusNote: string): string {
  const trimmed = statusNote.replace(/^completed:\s*/i, '');
  return `Completed · ${trimmed}`;
}

function compactStatus(statusNote: string): string {
  if (statusNote.startsWith('tool: ')) return `Tool · ${statusNote.slice(6)}`;
  if (statusNote.startsWith('passed: ')) return `Verification · passed`;
  if (statusNote.startsWith('failed: ')) return `Verification · failed`;
  return statusNote;
}

function dim(text: string): string {
  return `\u001b[90m${text}\u001b[0m`;
}
