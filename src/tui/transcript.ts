import type { RunStateSnapshot } from '../agent/tui-state';

export interface TranscriptRenderState {
  run: RunStateSnapshot;
  lastModelOutput?: string;
}

export function renderTranscript(state: TranscriptRenderState, width: number): string[] {
  const blocks: string[][] = [];
  const history = state.run.debugHistory;
  const completed = state.run.terminal === 'completed' || state.run.phase === 'completed';

  for (let i = 0; i < history.length; i += 1) {
    const item = history[i];

    if (item.kind === 'user') {
      blocks.push(renderUserPrompt(item.detail || item.summary, width));
      continue;
    }

    if (item.kind === 'model') {
      blocks.push(renderEventBlock('model', cleanModelOutput(item.detail || item.summary), width));
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
      blocks.push(renderFrozenFinalSummary(item.detail || item.summary, width));
      continue;
    }

    if (item.kind === 'tool_call') {
      const parsed = parseToolCall(item.detail);
      const next = history[i + 1]?.kind === 'tool_result' ? history[i + 1] : undefined;
      blocks.push(renderToolEvent(parsed, next, width, completed));
      if (next) i += 1;
      continue;
    }

    blocks.push(renderEventBlock('tool', summarizeOutput(item.detail || item.summary), width));
  }

  // Collect the last model output for inclusion in final summary.
  // Don't render it as a separate event block when a final summary will render.
  const hasModelOutput = history.some((item) => item.kind === 'model');
  const fallbackModel = !hasModelOutput
    ? cleanModelOutput(state.run.lastModelOutput || state.lastModelOutput || '')
    : '';
  const willShowFinalSummary = shouldShowFinalSummary(state.run) && !hasFrozenFinalSummary(state.run);

  if (fallbackModel && !willShowFinalSummary) {
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

  if (willShowFinalSummary) {
    blocks.push(['']);
    blocks.push(renderFinalSummary(state.run, width, fallbackModel));
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
  return [eventHeader('user', ''), ...wrapped.map((line) => detailRow('prompt', line, width))];
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
    const headerState = exitPart ? exitPart : 'ok';
    const block = [eventHeader('bash', headerState, width)];
    block.push(detailRow('command', command, width));

    // For git diff --stat, extract changed-files summary.
    if (isGitDiffCommand(command)) {
      const changedSummary = extractChangedSummary(parsed.output);
      if (changedSummary) block.push(detailRow('changed', changedSummary, width));
    }
    return block;
  }

  // Expanded mode: full detail (active execution or failed commands).
  const state = parsed ? `exit ${exitCode ?? 1}` : 'requested';
  const block = [eventHeader('bash', state, width)];
  block.push(detailRow('command', command, width));
  if (!result) return block;

  if (!compressed || failed) {
    block.push(detailRow('exit', String(exitCode ?? 1), width));
  }

  const meta = [parsed?.duration, isGitCommand(command) ? 'git' : ''].filter(Boolean).join(' · ');
  if (meta && (!compressed || failed)) block.push(detailRow('meta', meta, width));

  const output = colorizeCommandOutput(command, summarizeCommandDisplay(command, parsed?.output ?? '')).trim();
  const showOutput = output.length > 0 && (failed || output.length < 420);
  if (showOutput) {
    const maxOutputLines = isGitDiffCommand(command) ? 6 : failed ? 4 : 2;
    const outputWidth = Math.max(20, width - 14);
    for (const line of wrapText(output, outputWidth).slice(0, maxOutputLines)) {
      const clipped = clip(line, outputWidth);
      block.push(`  ${dim('output'.padEnd(10, ' '))} ${hasAnsi(clipped) ? clipped : dim(clipped)}`);
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

function renderFinalSummary(run: RunStateSnapshot, width: number, modelMessage?: string): string[] {
  const commands = commandsRun(run).join(', ') || 'none';
  const fileCount =
    run.filesChangedThisRun.length > 0
      ? run.filesChangedThisRun.length
      : run.changes.items.filter((item) => item.op !== 'read').length + run.changes.overflowCount;
  const toolInvocationCount =
    run.toolInvocationCount || run.debugHistory.filter((item) => item.kind === 'tool_call').length;
  const blockers = run.terminalIssue || (run.verification.state === 'failed' ? run.verification.summary : 'none');
  const completed = run.terminal === 'completed' || run.phase === 'completed';
  const result = completed ? 'completed' : run.terminal;
  const followUp = completed && run.verification.state !== 'failed' ? 'none' : 'resolve blocker and rerun verification';
  const hasVerificationEvents = run.verification.seenCheckIds.size > 0;
  const rows: string[] = [
    ...(run.statusNote ? [completionActivity(run.statusNote, width)] : []),
    finalBanner(result, width, finalTone(result, run.verification.state)),
  ];
  if (modelMessage) {
    rows.push(detailRow('message', modelMessage, width));
  }
  rows.push(
    detailRow('objective', run.objective.label, width),
    detailRow('changed', plural(fileCount, 'file'), width),
    detailRow('tools', `${toolInvocationCount} calls`, width),
    detailRow('commands', commands, width),
  );
  // Only include verify in final summary when no dedicated verification block exists.
  if (!hasVerificationEvents) {
    rows.push(detailRow('verify', run.verification.state, width));
  }
  rows.push(detailRow('blocker', blockers, width), detailRow('follow-up', followUp, width));
  return rows;
}

function renderFrozenFinalSummary(detail: string, width: number): string[] {
  const fields = parseFrozenFinalSummary(detail);
  const rows: string[] = [
    ...(fields.completed ? [completionActivity(fields.completed, width)] : []),
    finalBanner(fields.result || 'blocked', width, finalTone(fields.result || 'blocked', fields.verify)),
  ];
  if (fields.message) {
    rows.push(detailRow('message', fields.message, width));
  }
  rows.push(
    detailRow('objective', fields.objective || '—', width),
    detailRow('changed', fields.changed || '0 files', width),
    detailRow('tools', fields.tools || '0 calls', width),
    detailRow('commands', fields.commands || 'none', width),
  );
  if (fields.verify && fields.verify !== '—') {
    rows.push(detailRow('verify', fields.verify, width));
  }
  rows.push(
    detailRow('blocker', fields.blocker || 'none', width),
    detailRow('follow-up', fields.followUp || 'none', width),
  );
  return rows;
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

function commandsRun(run: RunStateSnapshot): string[] {
  const commands: string[] = [];
  for (const item of run.debugHistory) {
    if (item.kind !== 'tool_call') continue;
    const call = parseToolCall(item.detail);
    if (call.command) commands.push(call.command);
  }
  return commands;
}

function shouldShowFinalSummary(run: RunStateSnapshot): boolean {
  return run.terminal !== 'running' || run.phase === 'completed' || run.verification.state === 'failed';
}

function hasFrozenFinalSummary(run: RunStateSnapshot): boolean {
  return run.debugHistory.some((item) => item.kind === 'final_summary');
}

function isGitCommand(command: string): boolean {
  return /^git(?:\s|$)/.test(command.trim());
}

function isGitDiffCommand(command: string): boolean {
  return /^git\s+diff\b/.test(command.trim());
}

function completionActivity(statusNote: string, width: number): string {
  const trimmed = statusNote.replace(/^completed:\s*/i, '');
  return `${dim('  status    ')}${clip(trimmed, Math.max(1, width - 13))}`;
}

interface FrozenFinalFields {
  completed?: string;
  message?: string;
  objective?: string;
  result?: string;
  changed?: string;
  tree?: string;
  tools?: string;
  used?: string;
  commands?: string;
  verify?: string;
  blocker?: string;
  followUp?: string;
}

function parseFrozenFinalSummary(detail: string): FrozenFinalFields {
  const fields: FrozenFinalFields = {};
  for (const rawLine of detail.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('Completed · ')) fields.completed = line.replace(/^Completed ·\s*/, '');
    else if (line.startsWith('objective:')) fields.objective = line.replace(/^objective:\s*/, '');
    else if (line.startsWith('result:')) fields.result = line.replace(/^result:\s*/, '');
    else if (line.startsWith('Changed this run:')) fields.changed = line.replace(/^Changed this run:\s*/, '');
    else if (line.startsWith('Working tree:'))
      fields.tree = line.replace(/^Working tree:\s*/, '').replace(/^unknown$/, '—');
    else if (line.startsWith('tool invocations:')) fields.tools = `${line.replace(/^tool invocations:\s*/, '')} calls`;
    else if (line.startsWith('tools used:')) fields.used = line.replace(/^tools used:\s*/, '');
    else if (line.startsWith('commands run:')) fields.commands = line.replace(/^commands run:\s*/, '');
    else if (line.startsWith('verification:')) fields.verify = line.replace(/^verification:\s*/, '');
    else if (line.startsWith('blockers:')) fields.blocker = line.replace(/^blockers:\s*/, '');
    else if (line.startsWith('follow-up:')) fields.followUp = line.replace(/^follow-up:\s*/, '');
  }
  return fields;
}

function cleanModelOutput(output: string): string {
  return stripTerminalControl(output)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
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

function pad(text: string, width: number): string {
  const visible = visibleLength(text);
  if (visible >= width) return text;
  return `${text}${' '.repeat(width - visible)}`;
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}

function stripTerminalControl(input: string): string {
  return input
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[()][0-2AB]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
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
  return `${glyph} ${bold(label.padEnd(10, ' '))} ${clip(state, available)}`;
}

type FinalTone = 'success' | 'caution' | 'failure';

function finalTone(result: string, verification?: string): FinalTone {
  const normalized = result.toLowerCase();
  if (verification === 'failed' || normalized === 'failed' || normalized === 'error') return 'failure';
  if (normalized === 'blocked' || normalized === 'budget_exhausted' || normalized === 'user_input_required') {
    return 'caution';
  }
  return 'success';
}

function finalBanner(result: string, width: number, tone: FinalTone): string {
  const bg = tone === 'success' ? '\u001b[48;5;22m' : tone === 'caution' ? '\u001b[48;5;58m' : '\u001b[48;5;52m';
  const text = `◆ ${'final'.padEnd(10, ' ')} ${result}`;
  const clipped = clip(text, Math.max(1, width));
  return `${bg}\u001b[1;37m${pad(clipped, width)}\u001b[0m`;
}

function detailRow(label: string, value: string, width: number): string {
  return `  ${dim(label.padEnd(10, ' '))} ${dim(clip(value || '—', Math.max(1, width - 14)))}`;
}

function eventGlyph(label: string): string {
  if (label === 'final') return '\u001b[32m◆\u001b[0m';
  if (label === 'verify') return '\u001b[36m◆\u001b[0m';
  if (label === 'bash' || label === 'read' || label === 'write' || label === 'edit') return '\u001b[36m›\u001b[0m';
  return dim('◇');
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

function dim(text: string): string {
  return `\u001b[90m${text}\u001b[0m`;
}

function plural(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}
