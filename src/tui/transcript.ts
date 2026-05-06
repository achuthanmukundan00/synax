import type { RunStateSnapshot } from '../agent/tui-state';

export interface TranscriptRenderState {
  run: RunStateSnapshot;
  lastModelOutput?: string;
}

export function renderTranscript(state: TranscriptRenderState, width: number): string[] {
  const blocks: string[][] = [];
  const history = state.run.debugHistory;
  let lastKind = '';

  for (let i = 0; i < history.length; i += 1) {
    const item = history[i];
    const blockKind = item.kind === 'user' ? 'user' : item.kind === 'model' ? 'model' : 'tool';

    // Insert a thin separator when switching between model and tool regions.
    if (lastKind && lastKind !== blockKind) {
      blocks.push([dim(separator(Math.min(width - 4, 40)))]);
    }
    lastKind = blockKind;

    if (item.kind === 'user') {
      blocks.push(renderUserPrompt(item.detail || item.summary, width));
      continue;
    }

    if (item.kind === 'model') {
      blocks.push(renderEventBlock('model', cleanModelOutput(item.detail || item.summary), width));
      continue;
    }

    if (item.kind === 'final_summary') {
      blocks.push(renderFrozenFinalSummary(item.detail || item.summary, width));
      continue;
    }

    if (item.kind === 'tool_call') {
      const parsed = parseToolCall(item.detail);
      const next = history[i + 1]?.kind === 'tool_result' ? history[i + 1] : undefined;
      blocks.push(renderToolEvent(parsed, next, width));
      if (next) i += 1;
      continue;
    }

    blocks.push(renderEventBlock('tool', summarizeOutput(item.detail || item.summary), width));
  }

  // Only scan the most recent entries for a model output; the full history
  // is already bounded by MAX_DEBUG_HISTORY in the state reducer.
  const hasModelOutput = history.some((item) => item.kind === 'model');
  if (!hasModelOutput) {
    const fallbackModel = cleanModelOutput(state.run.lastModelOutput || state.lastModelOutput || '');
    if (fallbackModel) {
      if (lastKind) blocks.push([dim(separator(Math.min(width - 4, 40)))]);
      blocks.push(renderEventBlock('model', fallbackModel, width));
    }
  }

  if (state.run.patchPreview) {
    blocks.push(['']);
    blocks.push(renderDiffPreview(state.run.patchPreview.path, state.run.patchPreview.diff, width));
  }

  if (state.run.verification.state !== 'planned' || state.run.verification.checksPlanned > 0) {
    blocks.push(['']);
    blocks.push(renderVerification(state.run, width));
  }

  if (shouldShowFinalSummary(state.run) && !hasFrozenFinalSummary(state.run)) {
    blocks.push(['']);
    blocks.push(renderFinalSummary(state.run, width));
  }

  if (blocks.length === 0) {
    return [dim('No runtime events yet.')];
  }

  return blocks.flat();
}

export function toolsUsed(run: RunStateSnapshot): string[] {
  const tools = new Set<string>();
  for (const item of run.debugHistory) {
    if (item.kind !== 'tool_call') continue;
    tools.add(parseToolCall(item.detail).name);
  }
  return Array.from(tools);
}

function renderEventBlock(label: string, body: string, width: number): string[] {
  const available = Math.max(12, width - label.length - 4);
  const wrapped = wrapText(body || 'no detail', available).slice(0, 3);
  return wrapped.map((line, index) =>
    index === 0
      ? `${eventLabel(label)}  ${clip(line, available)}`
      : `${' '.repeat(label.length)}  ${clip(line, available)}`,
  );
}

function renderUserPrompt(body: string, width: number): string[] {
  const inner = Math.max(12, width - 4);
  const wrapped = wrapText(body || 'no prompt', inner).slice(0, 4);
  return [
    subtleBand(`user  ${clip(wrapped[0] ?? '', inner)}`, width),
    ...wrapped.slice(1).map((line) => subtleBand(`      ${clip(line, inner - 6)}`, width)),
  ];
}

function renderToolEvent(
  call: ParsedToolCall,
  result: { summary: string; detail: string } | undefined,
  width: number,
): string[] {
  if (call.name === 'read') {
    const path = call.path || 'unknown';
    const range = call.startLine || call.endLine ? `:${call.startLine ?? '?'}-${call.endLine ?? '?'}` : '';
    const preview = result ? summarizeOutput(result.detail).split('\n')[0] : '';
    const block = [`${eventLabel('read')}  ${clip(`${path}${range}`, width - 8)}`];
    if (preview) block.push(`      ${dim(clip(preview, width - 8))}`);
    return block;
  }

  if (call.name === 'write' || call.name === 'edit' || call.name === 'replace_in_file') {
    const label = call.name === 'write' ? 'write' : 'edit';
    const path = call.path || 'unknown';
    const block = [`${eventLabel(label)}  ${clip(path, width - 9)}`];
    const summary = result ? summarizeOutput(result.detail || result.summary) : '';
    if (summary) block.push(`       ${dim(clip(summary, width - 9))}`);
    return block;
  }

  if (call.name === 'bash' || call.name === 'shell' || call.command) {
    return renderCommandEvent(call.command || call.summary || call.name, result, width);
  }

  return renderEventBlock('tool', `${call.name} ${call.summary}`.trim(), width);
}

function renderCommandEvent(
  command: string,
  result: { summary: string; detail: string } | undefined,
  width: number,
): string[] {
  const block = [`${eventLabel('$')} ${clip(command, width - 4)}`];
  if (!result) return block;

  const parsed = parseCommandResult(result.detail || result.summary);
  const exitLabel = dim(`exit ${parsed.exitCode ?? 1}`);
  const tags = [exitLabel];
  if (parsed.duration) tags.push(dim(parsed.duration));
  if (isGitCommand(command)) tags.push(dim('git'));
  block.push(`  ${tags.join(' · ')}`);

  const output = colorizeCommandOutput(command, summarizeCommandDisplay(command, parsed.output)).trim();
  const showOutput = output.length > 0 && (parsed.exitCode !== 0 || output.length < 420);
  if (showOutput) {
    const maxOutputLines = isGitDiffCommand(command) ? 6 : parsed.exitCode === 0 ? 2 : 4;
    for (const line of wrapText(output, Math.max(20, width - 4)).slice(0, maxOutputLines)) {
      const clipped = clip(line, width - 4);
      block.push(`  ${hasAnsi(clipped) ? clipped : dim(clipped)}`);
    }
  }

  return block;
}

function renderDiffPreview(path: string, diff: string, width: number): string[] {
  const block = [
    `${eventLabel('edit')}  ${clip(path, width - 8)}`,
    `      ${dim(`Diff preview: ${clip(path, width - 22)}`)}`,
  ];
  for (const line of diff.split('\n').slice(0, 8)) {
    const color =
      line.startsWith('+') && !line.startsWith('+++') ? '\u001b[32m' : line.startsWith('-') ? '\u001b[31m' : '';
    block.push(`      ${color}${clip(line, width - 8)}${color ? '\u001b[0m' : ''}`);
  }
  return block;
}

function renderVerification(run: RunStateSnapshot, width: number): string[] {
  const stateIcon =
    run.verification.state === 'passed'
      ? '\u001b[32m✓\u001b[0m'
      : run.verification.state === 'failed'
        ? '\u001b[31m✗\u001b[0m'
        : run.verification.state === 'running'
          ? '\u001b[33m◌\u001b[0m'
          : '·';
  const label = run.verification.state === 'failed' ? red('failed') : run.verification.state;
  const block = [
    `${stateIcon} ${eventLabel('verify')}  ${label}  ${clip(run.verification.currentCheckLabel || 'verification', width - 22)}`,
  ];
  if (run.verification.summary) block.push(`         ${dim(clip(run.verification.summary, width - 10))}`);
  if (run.verification.state === 'failed')
    block.push(`         ${dim(`next: ${clip(run.verification.summary, width - 16)}`)}`);
  return block;
}

function renderFinalSummary(run: RunStateSnapshot, width: number): string[] {
  const commands = commandsRun(run).join(', ') || 'none';
  const tools = toolsUsed(run).join(', ') || 'none';
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
  return [
    ...(run.statusNote ? [completionActivity(run.statusNote)] : []),
    bold('Final summary'),
    `  objective: ${clip(run.objective.label, width - 15)}`,
    `  result: ${clip(result, width - 10)}`,
    `  Changed this run: ${plural(fileCount, 'file')}`,
    `  Working tree: ${run.workingTreeClean === undefined ? 'unknown' : run.workingTreeClean ? 'clean' : 'dirty'}`,
    `  tool invocations: ${toolInvocationCount}`,
    `  tools used: ${clip(tools, width - 14)}`,
    `  commands run: ${clip(commands, width - 16)}`,
    `  verification: ${clip(run.verification.state, width - 18)}`,
    `  blockers: ${clip(blockers, width - 13)}`,
    `  follow-up: ${followUp}`,
  ];
}

function renderFrozenFinalSummary(detail: string, width: number): string[] {
  return detail.split('\n').map((line) => {
    if (line === 'Final summary') return bold(line);
    return clip(line, width);
  });
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

function numberValue(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const item = value?.[key];
  return typeof item === 'number' ? item : undefined;
}

function summarizeOutput(output: string): string {
  return output
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

function completionActivity(statusNote: string): string {
  const trimmed = statusNote.replace(/^completed:\s*/i, '');
  return `Completed · ${trimmed}`;
}

function cleanModelOutput(output: string): string {
  return output
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

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\u001b\[[0-9;]*m/g, '');
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

function eventLabel(label: string): string {
  return dim(label);
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

function subtleBand(text: string, width: number): string {
  return `\u001b[48;5;236m\u001b[1;37m ${clip(text, Math.max(1, width - 2)).padEnd(Math.max(1, width - 2), ' ')} \u001b[0m`;
}

function separator(width: number): string {
  return '─'.repeat(Math.max(1, width));
}

function plural(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}
