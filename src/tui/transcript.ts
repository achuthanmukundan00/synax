import type { RunStateSnapshot } from '../agent/tui-state';

export interface TranscriptRenderState {
  run: RunStateSnapshot;
  lastModelOutput?: string;
  /** Whether activity/reasoning detail is expanded (Ctrl+O toggle). */
  activityExpanded?: boolean;
}

/** Breathing glyph sequence for the working indicator. */
const BREATHING_GLYPHS = ['◌', '◓', '◑', '◒'];

export function renderTranscript(state: TranscriptRenderState, width: number): string[] {
  const blocks: string[][] = [];
  const history = state.run.debugHistory;
  const completed = state.run.terminal === 'completed' || state.run.phase === 'completed';
  const isWorking = state.run.phase === 'thinking' && state.run.terminal === 'running';

  for (let i = 0; i < history.length; i += 1) {
    const item = history[i];

    if (item.kind === 'user') {
      blocks.push(renderUserPrompt(item.detail || item.summary, width));
      continue;
    }

    if (item.kind === 'model') {
      const prose = extractModelProse(item.detail || item.summary);
      const isLastModel = i === history.length - 1 || !history.slice(i + 1).some((h) => h.kind === 'model');
      if (completed && isLastModel) {
        blocks.push(renderReviewOutput(item.detail || item.summary, width));
      } else if (prose) {
        blocks.push(renderModelProse(prose, width));
      }
      // Model items with only tool-call content (no natural-language prose) are
      // not useful to render; the actual tool calls are rendered as separate entries.
      continue;
    }

    if (item.kind === 'command') {
      blocks.push(renderEventBlock('command', item.detail || item.summary, width, Number.POSITIVE_INFINITY));
      continue;
    }

    if (item.kind === 'local_command') {
      blocks.push(renderCommandEvent(item.summary, { summary: item.summary, detail: item.detail }, width, completed));
      continue;
    }

    if (item.kind === 'final_summary') {
      // Final summary is intentionally not rendered in the transcript.
      // Completion state is communicated via the header, status bar, and
      // runtime panel. Internal summary data is preserved for logs and telemetry.
      continue;
    }

    if (item.kind === 'tool_call') {
      // Collect consecutive successful tool calls for grouping.
      const group = collectToolGroup(history, i, completed, width);
      if (group) {
        blocks.push(group.block);
        i = group.nextIndex - 1;
        continue;
      }

      const parsed = parseToolCall(item.detail);
      const next = history[i + 1]?.kind === 'tool_result' ? history[i + 1] : undefined;
      blocks.push(renderToolEvent(parsed, next, width, completed));
      if (next) i += 1;
      continue;
    }

    blocks.push(renderEventBlock('tool', summarizeOutput(item.detail || item.summary), width));
  }

  // Collect the last model output for inclusion in final summary.
  const hasModelOutput = history.some((item) => item.kind === 'model');
  const fallbackModel = !hasModelOutput
    ? cleanModelOutput(state.run.lastModelOutput || state.lastModelOutput || '')
    : '';
  if (fallbackModel) {
    blocks.push(renderEventBlock('model', fallbackModel, width));
  }

  if (state.run.patchPreview) {
    blocks.push(['']);
    blocks.push(renderDiffPreview(state.run.patchPreview.path, state.run.patchPreview.diff, width));
  }

  const hasVerificationEvents = state.run.verification.seenCheckIds.size > 0;
  if (hasVerificationEvents) {
    blocks.push(['']);
    blocks.push(renderVerification(state.run, width));
  }

  // Working indicator and activity preview — placed at the bottom so it remains
  // visible when the transcript autoscrolls during long workloads.
  if (isWorking) {
    const frameIdx = Math.floor((state.run.nowMs / 1000) * 3) % BREATHING_GLYPHS.length;
    const glyph = `\u001b[34m${BREATHING_GLYPHS[frameIdx]}\u001b[0m`;
    const label = '\u001b[34mworking\u001b[0m';
    const preview = activityPreviewText(state.run);
    const previewLine = `${glyph} ${label}  ${dimI(truncate(preview, Math.max(1, width - 22)))}`;
    blocks.push([previewLine]);

    if (state.activityExpanded) {
      blocks.push(renderExpandedActivity(state.run, width));
      blocks.push(['']);
    }
  }

  if (blocks.length === 0) {
    return [dim('No runtime events yet.')];
  }

  return blocks.flatMap((block, index) => (index === 0 ? block : ['', ...block]));
}

export function toolsUsed(run: RunStateSnapshot): string[] {
  const tools = new Set<string>();
  for (const item of run.debugHistory) {
    if (item.kind !== 'tool_call') continue;
    tools.add(parseToolCall(item.detail).name);
  }
  return Array.from(tools);
}

function renderEventBlock(label: string, body: string, width: number, maxLines = 3): string[] {
  const available = Math.max(12, width - 13);
  const wrapped = wrapText(body || 'no detail', available).slice(0, maxLines);
  return [eventHeader(label, ''), ...wrapped.map((line) => detailRow('detail', line, width))];
}

function renderUserPrompt(body: string, width: number): string[] {
  const wrapped = wrapText(body || 'no prompt', Math.max(12, width - 13)).slice(0, 4);
  return [eventHeader('user', ''), ...alignedField('prompt', wrapped, width, true)];
}

function renderToolEvent(
  call: ParsedToolCall,
  result: { summary: string; detail: string } | undefined,
  width: number,
  compressed = false,
): string[] {
  if (call.name === 'read') {
    const path = call.path || '—';
    const preview = result ? summarizeOutput(result.detail).split('\n')[0] : '';
    const block = [eventHeader('read', path, width)];
    if (call.startLine || call.endLine)
      block.push(detailRow('lines', `${call.startLine ?? '?'}–${call.endLine ?? '?'}`, width));
    if (preview) block.push(detailRow('output', preview, width));
    return block;
  }

  if (call.name === 'write' || call.name === 'edit' || call.name === 'replace_in_file') {
    const label = call.name === 'write' ? 'write' : 'edit';
    const path = call.path || '—';
    const block = [eventHeader(label, path, width)];
    const diff = result ? extractToolResultDiff(result.detail || result.summary) : undefined;
    if (diff) {
      block.push(detailRow('preview', `Diff: ${path}`, width));
      block.push(...renderDiffRows(diff, width, 8));
      return block;
    }
    const summary = result ? summarizeOutput(result.detail || result.summary) : '';
    if (summary) block.push(detailRow('result', summary, width));
    return block;
  }

  if (call.name === 'bash' || call.name === 'shell' || call.command) {
    return renderCommandEvent(call.command || call.summary || call.name, result, width, compressed);
  }

  return renderEventBlock('tool', `${call.name} ${call.summary}`.trim(), width);
}

function renderCommandEvent(
  command: string,
  result: { summary: string; detail: string } | undefined,
  width: number,
  compressed = false,
): string[] {
  const parsed = result ? parseCommandResult(result.detail || result.summary) : undefined;
  const exitCode = parsed?.exitCode;
  const failed = exitCode !== undefined && exitCode !== 0;

  // Compressed mode (after completion): show command + exit code on header line.
  if (compressed && !failed && parsed) {
    const exitPart = exitCode !== undefined ? `exit ${exitCode}` : '';
    const block = [commandRow(command, exitPart || 'ok', width)];

    // For git diff --stat, extract changed-files summary.
    if (isGitDiffCommand(command)) {
      const changedSummary = extractChangedSummary(parsed.output);
      if (changedSummary) block.push(detailRow('changed', changedSummary, width));
    }
    return block;
  }

  // Expanded mode: full detail (active execution or failed commands).
  const state = parsed ? `exit ${exitCode ?? 1}` : 'requested';
  const block = [commandRow(command, state, width)];
  if (!result) return block;

  if (failed) {
    block.push(detailRow('exit', String(exitCode ?? 1), width));
    if (parsed?.duration) block.push(detailRow('meta', parsed.duration, width));
  }

  const output = colorizeCommandOutput(command, summarizeCommandDisplay(command, parsed?.output ?? '')).trim();

  // Drop output lines that exactly duplicate the command.
  const filteredOutput = dropCommandEcho(command, output);

  const showOutput = filteredOutput.length > 0 && (failed || filteredOutput.length < 420);
  if (showOutput) {
    const maxOutputLines = isGitDiffCommand(command) ? 6 : failed ? 4 : 2;
    const outputWidth = Math.max(20, width - 14);
    const outputLines = wrapText(filteredOutput, outputWidth).slice(0, maxOutputLines);
    if (outputLines.length > 0) {
      block.push(...alignedField('output', outputLines, width, true));
    }
  }

  return block;
}

function renderDiffPreview(path: string, diff: string, width: number): string[] {
  const block = [eventHeader('edit', path, width), detailRow('preview', `Diff preview: ${path}`, width)];
  block.push(...renderDiffRows(diff, width, 8));
  return block;
}

function renderDiffRows(diff: string, width: number, maxLines: number): string[] {
  return diff
    .split('\n')
    .slice(0, maxLines)
    .map((line) => {
      const colored = colorizeGitDiffLine(line);
      return `  ${' '.repeat(11)}${clip(colored, width - 14)}`;
    });
}

function renderVerification(run: RunStateSnapshot, width: number): string[] {
  const label = run.verification.state === 'failed' ? red('failed') : run.verification.state;
  const block = [eventHeader('verify', label, width)];
  block.push(detailRow('check', run.verification.currentCheckLabel || 'verification', width));
  if (run.verification.summary) block.push(detailRow('summary', run.verification.summary, width));
  if (run.verification.state === 'failed') block.push(detailRow('next', run.verification.summary, width));
  return block;
}

interface ParsedToolCall {
  name: string;
  summary: string;
  path?: string;
  command?: string;
  startLine?: number;
  endLine?: number;
}

function parseToolCall(detail: string): ParsedToolCall {
  const [rawName = 'tool', ...rest] = detail.split('\n');
  const name = rawName.trim();
  const summary = rest.join('\n').trim();
  const parsed = parseFirstJson(summary);
  return {
    name,
    summary,
    path: stringValue(parsed, 'path') ?? stringValue(parsed, 'file') ?? stringValue(parsed, 'target_file'),
    command: stringValue(parsed, 'command') ?? stringValue(parsed, 'cmd'),
    startLine: numberValue(parsed, 'startLine') ?? numberValue(parsed, 'start_line'),
    endLine: numberValue(parsed, 'endLine') ?? numberValue(parsed, 'end_line'),
  };
}

function parseFirstJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function stringValue(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const item = value?.[key];
  return typeof item === 'string' ? item : undefined;
}

function objectValue(value: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const item = value?.[key];
  return item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : undefined;
}

function extractToolResultDiff(detail: string): string | undefined {
  const parsed = parseFirstJson(detail);
  return stringValue(objectValue(parsed, 'output'), 'diff') ?? stringValue(parsed, 'diff');
}

function numberValue(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const item = value?.[key];
  return typeof item === 'number' ? item : undefined;
}

function summarizeOutput(output: string): string {
  return stripTerminalControl(output)
    .replace(/^command:\s*/im, '')
    .replace(/^stdout:\s*/im, '')
    .replace(/^stderr:\s*/im, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, 8)
    .join('\n');
}

function parseCommandResult(detail: string): { exitCode?: number; duration?: string; output: string } {
  const exitMatch = /exit(?:\s+code|Code)?:\s*(-?\d+)/i.exec(detail);
  const durationMatch = /duration:\s*([^\n]+)/i.exec(detail);
  const output = detail
    .split('\n')
    .filter((line) => !/^exit(?:\s+code|Code)?:/i.test(line.trim()) && !/^duration:/i.test(line.trim()))
    .join('\n');
  return {
    exitCode: exitMatch ? Number(exitMatch[1]) : undefined,
    duration: durationMatch?.[1]?.trim(),
    output: summarizeOutput(output),
  };
}

function summarizeCommandDisplay(command: string, output: string): string {
  if (!/^git\s+diff\b.*--stat\b/.test(command.trim())) return output;
  const rows = output
    .split('\n')
    .map(parseDiffStatLine)
    .filter((line): line is string => Boolean(line));
  return rows.length > 0 ? rows.join('\n') : output;
}

function colorizeCommandOutput(command: string, output: string): string {
  const trimmedCommand = command.trim();
  if (!isGitDiffCommand(trimmedCommand) || /^git\s+diff\b.*--stat\b/.test(trimmedCommand) || hasAnsi(output)) {
    return output;
  }

  return output
    .split('\n')
    .map((line) => colorizeGitDiffLine(line))
    .join('\n');
}

function colorizeGitDiffLine(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return green(line);
  if (line.startsWith('-') && !line.startsWith('---')) return red(line);
  if (line.startsWith('@@')) return cyan(line);
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ')
  ) {
    return bold(line);
  }
  return line;
}

function parseDiffStatLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || /^\d+\s+files?\s+changed/.test(trimmed)) return undefined;
  const match = /^(.+?)\s+\|\s+(\d+)\s+([+-]+).*$/.exec(trimmed);
  if (!match) return undefined;
  const path = match[1]?.trim();
  const count = Number(match[2]);
  const marks = match[3] ?? '';
  if (!path || !Number.isFinite(count)) return undefined;
  const added = (marks.match(/\+/g) ?? []).length;
  const removed = (marks.match(/-/g) ?? []).length;
  const sign = added >= removed ? '+' : '-';
  return `changed  ${path}  ${sign}${count} ${count === 1 ? 'line' : 'lines'}`;
}

/** Extract a human-readable changed-files summary from git diff --stat output. */
function extractChangedSummary(output: string): string {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // Look for summary line like "4 files changed, 120 insertions(+), 40 deletions(-)"
  for (const line of lines) {
    const match = /^(\d+)\s+files?\s+changed/.exec(line);
    if (match) {
      const fileCount = Number(match[1]);
      const insertMatch = /(\d+)\s+insertions?\(\+\)/.exec(line);
      const deleteMatch = /(\d+)\s+deletions?\(-\)/.exec(line);
      const parts: string[] = [plural(fileCount, 'file')];
      if (insertMatch) parts.push(`${insertMatch[1]} +`);
      if (deleteMatch) parts.push(`${deleteMatch[1]} -`);
      return parts.join(', ');
    }
  }
  // Fallback: count changed files from stat lines
  const statLines = lines.filter((l) => /\|\s+\d+\s+[+-]+/.test(l));
  if (statLines.length > 0) {
    return plural(statLines.length, 'file');
  }
  return '';
}

function cleanModelOutput(output: string): string {
  return stripTerminalControl(output)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGitDiffCommand(command: string): boolean {
  return /^git\s+diff\b/.test(command.trim());
}

function wrapText(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  const width = Math.max(1, maxWidth);

  for (const rawLine of text.split('\n')) {
    let remaining = rawLine;
    if (visibleLength(remaining.trimEnd()) === 0) {
      lines.push('');
      continue;
    }

    while (visibleLength(remaining) > width) {
      const breakAt = findVisibleBreak(remaining, width);
      lines.push(closeAnsi(sliceAnsi(remaining, 0, breakAt).trimEnd()));
      remaining = sliceAnsi(remaining, breakAt, Number.POSITIVE_INFINITY).trimStart();
    }
    lines.push(remaining.trimEnd());
  }

  return lines.length > 0 ? lines : [''];
}

function clip(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  return closeAnsi(`${sliceAnsi(text, 0, Math.max(0, width - 1))}…`);
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}

function stripTerminalControl(input: string): string {
  return (
    input
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b[()][0-2AB]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b[@-Z\\-_]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
  );
}

function hasAnsi(input: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /\u001b\[[0-9;]*m/.test(input);
}

function visibleLength(input: string): number {
  return stripAnsi(input).length;
}

function closeAnsi(input: string): string {
  return hasAnsi(input) && !input.endsWith('\u001b[0m') ? `${input}\u001b[0m` : input;
}

function findVisibleBreak(input: string, maxWidth: number): number {
  const visible = stripAnsi(input);
  const prefix = visible.slice(0, maxWidth);
  const lastSpace = prefix.lastIndexOf(' ');
  return lastSpace > maxWidth / 2 ? lastSpace : maxWidth;
}

function sliceAnsi(input: string, start: number, end: number): string {
  const targetStart = Math.max(0, start);
  const targetEnd = Math.max(targetStart, end);
  let visibleIndex = 0;
  let out = '';
  let writing = false;

  for (let i = 0; i < input.length; i += 1) {
    if (input[i] === '\u001b') {
      // eslint-disable-next-line no-control-regex
      const match = /\u001b\[[0-9;]*m/.exec(input.slice(i));
      if (match) {
        if (writing || visibleIndex >= targetStart) out += match[0];
        i += match[0].length - 1;
        continue;
      }
    }

    if (visibleIndex >= targetEnd) break;
    if (visibleIndex >= targetStart) {
      writing = true;
      out += input[i];
    }
    visibleIndex += 1;
  }

  return out;
}

function eventHeader(label: string, state: string, width: number = 120): string {
  const available = Math.max(1, width - 14);
  const glyph = eventGlyph(label);
  return `${glyph} ${dim(label.padEnd(10, ' '))} ${clip(state, available)}`;
}

function commandRow(command: string, state: string, width: number): string {
  const stateText = state ? `  ${dim(state)}` : '';
  const available = Math.max(1, width - 4 - visibleLength(state));
  return `${yellow('$')} ${yellow(clip(command || 'bash', available))}${stateText}`;
}

function detailRow(label: string, value: string, width: number): string {
  return `  ${dim(label.padEnd(10, ' '))} ${dim(clip(value || '—', Math.max(1, width - 14)))}`;
}

/** Render aligned multi-line key/value rows:
 *  label     first line
 *            continuation line 1
 *            continuation line 2
 */
function alignedField(label: string, lines: string[], width: number, valueDimmed = false): string[] {
  const valueWidth = Math.max(1, width - 14);
  const formatValue = (v: string) => {
    const clipped = clip(v, valueWidth);
    return valueDimmed ? dim(clipped) : clipped;
  };
  if (lines.length === 0) return [detailRow(label, '', width)];
  return [
    `  ${dim(label.padEnd(10, ' '))} ${formatValue(lines[0])}`,
    ...lines.slice(1).map((line) => `  ${' '.repeat(10)} ${formatValue(line)}`),
  ];
}

/** Drop leading output lines that are verbatim echoes of the command. */
function dropCommandEcho(command: string, output: string): string {
  const trimmedCommand = command.trim();
  const lines = output.split('\n');
  const firstNonEmpty = lines.findIndex((l) => l.trim().length > 0);
  if (firstNonEmpty >= 0 && lines[firstNonEmpty].trim() === trimmedCommand) {
    lines.splice(firstNonEmpty, 1);
  }
  return lines.join('\n');
}

function eventGlyph(label: string): string {
  if (label === 'user') return dim('•');
  if (label === 'model') return dim('•');
  if (label === 'review') return dim('•');
  if (label === 'bash' || label === 'read' || label === 'write' || label === 'edit') return yellow('$');
  if (label === 'verify') return '\u001b[32m√\u001b[0m';
  return dim('?');
}

function bold(text: string): string {
  return `\u001b[1;37m${text}\u001b[0m`;
}

function red(text: string): string {
  return `\u001b[31m${text}\u001b[0m`;
}

function green(text: string): string {
  return `\u001b[32m${text}\u001b[0m`;
}

function cyan(text: string): string {
  return `\u001b[36m${text}\u001b[0m`;
}

function yellow(text: string): string {
  return `\u001b[33m${text}\u001b[0m`;
}

function dim(text: string): string {
  return `\u001b[90m${text}\u001b[0m`;
}

function plural(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

/** Extract a safe activity/reasoning preview from the run state. */
function activityPreviewText(run: RunStateSnapshot): string {
  // Prefer lifecycle-based activity labels derived from real runtime state.
  const latest = run.timeline[run.timeline.length - 1];
  if (latest) {
    const summary = latest.summary.toLowerCase();
    if (summary.includes('objective registered') || summary.includes('task started')) return 'inspecting context…';
    if (summary.includes('model step') || summary.includes('thinking')) return 'planning next action…';
    if (summary.includes('tool') && summary.includes('read')) return 'reading file…';
    if (summary.includes('tool') && (summary.includes('write') || summary.includes('edit'))) return 'editing file…';
    if (summary.includes('tool') && summary.includes('bash')) return 'running bash…';
    if (summary.includes('tool') && summary.includes('ok')) return 'checking tool result…';
    if (summary.includes('tool') && summary.includes('error')) return 'recovering from tool error…';
    if (summary.includes('passed')) return 'verification passed…';
    if (summary.includes('failed')) return 'verification failed…';
    if (summary.includes('verifying')) return 'checking verification result…';
    if (summary.includes('planned')) return 'planning verification…';
    return `synax: ${clipText(run.statusNote || latest.summary, 80)}`;
  }
  if (run.statusNote) return clipText(run.statusNote, 80);
  return 'waiting for model response…';
}

/** Render expanded activity detail: recent timeline items. */
function renderExpandedActivity(run: RunStateSnapshot, width: number): string[] {
  const items = run.timeline.slice(-12);
  if (items.length === 0) return [`  ${dimI('(no activity detail yet)')}`];
  return items.map((item, idx) => {
    const prefix = idx === items.length - 1 ? '\u001b[34m→\u001b[0m' : '  ';
    return `  ${prefix} ${dimI(truncate(item.summary, Math.max(1, width - 6)))}`;
  });
}

function dimI(text: string): string {
  return `\u001b[3;90m${text}\u001b[0m`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function clipText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

// ─── Model prose rendering ─────────────────────────────────

/** Extract meaningful natural-language prose from model output,
 *  stripping think blocks, tool_call XML, and excess whitespace. */
function extractModelProse(detail: string): string {
  const clean = detail
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/\s*[-–—>→]*\s*\d+\s+tool call\(s\):\s*[A-Za-z0-9_,\s.-]+$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean;
}

/** Render model prose prominently, with full text wrapping and no truncation. */
function renderModelProse(prose: string, width: number): string[] {
  const lines: string[] = [];
  const proseWidth = Math.max(20, width - 6);
  const wrapped = wrapText(prose, proseWidth);
  lines.push(`${dim('•')} ${wrapped[0]}`);
  for (let i = 1; i < wrapped.length; i += 1) {
    lines.push(`  ${wrapped[i]}`);
  }
  return lines;
}

// ─── Tool group rendering ───────────────────────────────────

interface ToolGroupResult {
  block: string[];
  nextIndex: number;
}

/** Collect consecutive successful tool calls into a compact group. */
function collectToolGroup(
  history: RunStateSnapshot['debugHistory'],
  startIndex: number,
  compressed: boolean,
  width: number,
): ToolGroupResult | null {
  if (!compressed) return null;
  const group: Array<{ call: ParsedToolCall; result: string }> = [];
  let i = startIndex;

  while (i < history.length) {
    const item = history[i];
    if (item.kind !== 'tool_call') break;
    const call = parseToolCall(item.detail);
    const resultItem = history[i + 1];
    if (resultItem?.kind !== 'tool_result') break;

    const parsed = parseCommandResult(resultItem.detail || resultItem.summary);
    const failed = parsed.exitCode !== undefined && parsed.exitCode !== 0;
    if (failed) break; // Don't group failures

    // Only group read / bash / no-output-success commands
    group.push({ call, result: resultItem.detail || resultItem.summary });
    i += 2;
    if (group.length >= 12) break;
  }

  if (group.length < 2) return null;

  return {
    block: renderToolGroup(group, width),
    nextIndex: i,
  };
}

function renderToolGroup(group: Array<{ call: ParsedToolCall; result: string }>, width: number): string[] {
  const lines: string[] = [];
  const toolCounts = new Map<string, number>();
  for (const g of group) toolCounts.set(g.call.name, (toolCounts.get(g.call.name) ?? 0) + 1);
  const summary = [...toolCounts.entries()].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(', ');
  lines.push(`${dim('•')} ${dim('tools'.padEnd(10, ' '))} ${dim(clip(summary, Math.max(1, width - 14)))}`);

  // Show up to 3 command previews
  const previews = group.slice(0, 3);
  for (const g of previews) {
    if (g.call.command) {
      lines.push(`  ${' '.repeat(10)} ${dim(clip(g.call.command, Math.max(1, width - 14)))}`);
    } else if (g.call.path) {
      lines.push(`  ${' '.repeat(10)} ${dim(clip(`${g.call.name} ${g.call.path}`, Math.max(1, width - 14)))}`);
    }
  }
  if (group.length > 3) {
    lines.push(`  ${' '.repeat(10)} ${dim(`+${group.length - 3} more`)}`);
  }
  return lines;
}

// ─── Markdown-to-terminal rendering ─────────────────────────

/** Render common Markdown constructs as styled terminal text. */
function renderMarkdownBlock(md: string, width: number): string[] {
  const rawLines = md.split('\n');
  const lines: string[] = [];
  let inCodeBlock = false;

  for (const raw of rawLines) {
    const line = raw.trimEnd();

    // Fenced code blocks
    if (/^```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      lines.push(inCodeBlock ? dim('│') : dim('└'));
      continue;
    }
    if (inCodeBlock) {
      lines.push(`  ${dim(line)}`);
      continue;
    }

    // Horizontal rules
    if (/^(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      lines.push(dim('─'.repeat(Math.min(width - 4, 40))));
      continue;
    }

    // Headings
    const heading = line.match(/^(#{1,3})\s+(.+)/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      if (level === 1) lines.push(`\u001b[1;4;37m${text}\u001b[0m`);
      else if (level === 2) lines.push(`\u001b[1;37m${text}\u001b[0m`);
      else lines.push(`\u001b[1;33m${text}\u001b[0m`);
      continue;
    }

    // Bullet lists (*, -, +)
    const bullet = line.match(/^(\s*)([-*+])\s+(.+)/);
    if (bullet) {
      const indent = Math.min(bullet[1].length, 6);
      lines.push(
        `${' '.repeat(indent)}  \u001b[37m•\u001b[0m ${renderInlineMd(bullet[3], Math.max(1, width - indent - 6))}`,
      );
      continue;
    }

    // Numbered lists
    const numbered = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (numbered) {
      const indent = Math.min(numbered[1].length, 6);
      lines.push(`${' '.repeat(indent)}  ${dim('•')} ${renderInlineMd(numbered[2], Math.max(1, width - indent - 6))}`);
      continue;
    }

    // Blockquotes
    const quote = line.match(/^>\s?(.+)/);
    if (quote) {
      lines.push(`${dim('│')} ${dimI(renderInlineMd(quote[1], Math.max(1, width - 6)))}`);
      continue;
    }

    // Regular text
    if (line.trim()) {
      lines.push(renderInlineMd(line, Math.max(1, width - 4)));
    } else {
      lines.push('');
    }
  }

  return lines;
}

/** Render inline Markdown: bold, inline code, and links. */
function renderInlineMd(text: string, _maxWidth: number): string {
  let result = text;
  // Bold
  result = result.replace(/[*]{2}(.+?)[*]{2}/g, `\u001b[1;37m$1\u001b[0m`);
  // Inline code
  result = result.replace(/`([^`]+)`/g, `\u001b[33m$1\u001b[0m`);
  // Links (keep text, drop URL)
  result = result.replace(new RegExp(String.raw`\[([^\]]+)\]\([^)]+\)`, 'g'), `\u001b[4;36m$1\u001b[0m`);
  return result;
}

/** Render the final model output — uses markdown formatting when applicable,
 *  otherwise renders as plain wrapped text. */
function renderReviewOutput(body: string, width: number): string[] {
  const clean = body
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .trim();
  if (!clean) return [eventHeader('model', '')];

  const hasMd = /^#{1,3}\s|^[*\-+]\s|^```|^\d+\.\s|^>\s|^---+$/m.test(clean);
  const lines: string[] = [eventHeader('review', '')];

  if (hasMd) {
    const mdBlocks = renderMarkdownBlock(clean, width);
    for (const line of mdBlocks) {
      for (const wrappedLine of wrapText(line, Math.max(1, width - 4))) {
        lines.push(`  ${wrappedLine}`);
      }
    }
  } else {
    const resultWidth = Math.max(20, width - 8);
    const wrapped = wrapText(clean, resultWidth);
    for (const line of wrapped) {
      lines.push(`  ${line}`);
    }
  }
  return lines;
}
