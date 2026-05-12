import type { RunStateSnapshot } from '../agent/tui-state';

export interface TranscriptRenderState {
  run: RunStateSnapshot;
  nowMs?: number;
  lastModelOutput?: string;
  /** Whether activity/reasoning detail is expanded (Ctrl+O toggle). */
  activityExpanded?: boolean;
}

/** Breathing glyph sequence for the working indicator. */
const BREATHING_GLYPHS = ['◌', '◓', '◑', '◒'];

// ─── Tool-summary detection ───────────────────────────────

/** Strip LaTeX math commands that terminals can't render.
 *  Converts common escapes to Unicode and removes remaining \commands.
 *  Preserves newlines so markdown structure (headings, lists, code blocks)
 *  survives into renderReviewOutput. */
function stripLatexCommands(text: string): string {
  return text
    .replace(/\\pmod\{([^}]*)\}/gi, ' (mod $1)')
    .replace(/\\bmod\b/gi, ' mod ')
    .replace(/\\equiv\b/gi, '≡')
    .replace(/\\cdot\b/gi, '·')
    .replace(/\\times\b/gi, '×')
    .replace(/\\ldots\b/gi, '…')
    .replace(/\\cdots\b/gi, '⋯')
    .replace(/\\text\{([^}]*)\}/gi, '$1')
    .replace(/\\[a-zA-Z]+(\{[^}]*\})*/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Detect notes that are only tool-call summaries with no useful prose.
 *  These should not appear in the user transcript or as working preview text. */
function isToolSummaryNote(text: string): boolean {
  const stripped = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return /^[-–—>→]*\s*\d+\s+tool call\(s\):\s*[A-Za-z0-9_,\s.-]+$/i.test(stripped);
}

export function renderTranscript(state: TranscriptRenderState, width: number): string[] {
  const blocks: string[][] = [];
  const history = state.run.debugHistory;
  const completed = state.run.terminal === 'completed' || state.run.phase === 'completed';
  const isWorking = state.run.phase === 'thinking' && state.run.terminal === 'running';
  let lastRenderedProse = '';
  let wasPreviousNote = false;

  for (let i = 0; i < history.length; i += 1) {
    const item = history[i];

    if (item.kind === 'user') {
      blocks.push(renderUserPrompt(item.detail || item.summary, width));
      lastRenderedProse = '';
      wasPreviousNote = false;
      continue;
    }

    if (item.kind === 'model') {
      const prose = extractModelProse(item.detail || item.summary);
      // Deduplicate adjacent model entries with identical prose.
      // Streaming delta → final assistant_message can produce near-duplicates;
      // this catch-all prevents double rendering.
      const isLastModel = i === history.length - 1 || !history.slice(i + 1).some((h) => h.kind === 'model');
      // A model entry is a "final answer" (shown as a result, not a dim note)
      // when it's the last model entry before the next user prompt or end of
      // history (and the run is completed).  This preserves result formatting
      // for historical answers even after a new prompt starts a fresh run.
      const nextUserIdx = history.slice(i + 1).findIndex((h) => h.kind === 'user');
      const isLastModelBeforeUser =
        nextUserIdx >= 0 && !history.slice(i + 1, i + 1 + nextUserIdx).some((h) => h.kind === 'model');
      const isFinalAnswer = isLastModelBeforeUser || (completed && isLastModel);
      if (prose && prose === lastRenderedProse && !isLastModel) {
        continue;
      }
      if (isFinalAnswer) {
        blocks.push(renderReviewOutput(prose || item.detail || item.summary, width));
        lastRenderedProse = prose;
      } else if (prose) {
        blocks.push(renderModelProse(prose, width, !wasPreviousNote));
        lastRenderedProse = prose;
        wasPreviousNote = true;
      }
      // Model items with only tool-call content (no natural-language prose) are
      // not useful to render; the actual tool calls are rendered as separate entries.
      continue;
    }

    if (item.kind === 'command') {
      blocks.push(renderEventBlock('command', item.detail || item.summary, width, Number.POSITIVE_INFINITY));
      wasPreviousNote = false;
      continue;
    }

    if (item.kind === 'local_command') {
      blocks.push(renderCommandEvent(item.summary, { summary: item.summary, detail: item.detail }, width, completed));
      wasPreviousNote = false;
      continue;
    }

    if (item.kind === 'final_summary') {
      // Final summary is intentionally not rendered in the transcript.
      // Completion state is communicated via the header, status bar, and
      // runtime panel. Internal summary data is preserved for logs and telemetry.
      wasPreviousNote = false;
      continue;
    }

    if (item.kind === 'tool_call') {
      wasPreviousNote = false;
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

    wasPreviousNote = false;
    blocks.push(renderEventBlock('tool', summarizeOutput(item.detail || item.summary), width));
  }

  // Collect the last model output for inclusion in final summary.
  const hasModelOutput = history.some((item) => item.kind === 'model');
  const fallbackModel = !hasModelOutput
    ? cleanModelOutput(state.run.lastModelOutput || state.lastModelOutput || '')
    : '';
  if (fallbackModel) {
    blocks.push(renderEventBlock('model', fallbackModel, width, Number.POSITIVE_INFINITY));
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

  if (state.run.terminal !== 'completed' && state.run.terminalIssue) {
    blocks.push(['']);
    blocks.push(renderTerminalIssue(state.run.terminalIssue, width));
  }

  // Working indicator — placed at the bottom so it remains
  // visible when the transcript autoscrolls during long workloads.
  if (isWorking) {
    const frameIdx = Math.floor((state.run.nowMs / 1000) * 3) % BREATHING_GLYPHS.length;
    const glyph = `\u001b[1;34m${BREATHING_GLYPHS[frameIdx]}\u001b[0m`;
    const label = renderWorkingShimmer(state.run.nowMs);
    blocks.push(['', `${glyph} ${label}`]);

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
  const innerWidth = Math.max(14, width - 4);
  const contentWidth = Math.max(1, innerWidth - 4);
  const wrapped = wrapText(body || 'no prompt', contentWidth);
  const lines: string[] = [];

  // Top border with bold label
  const labelText = ' user prompt ';
  const labelLen = labelText.length;
  const topFill = Math.max(0, innerWidth - labelLen);
  lines.push(` ${dim('╭─')}${boldDim(labelText)}${dim('─'.repeat(topFill))}${dim('╮')}`);

  // Content lines (italic, dim)
  if (wrapped.length === 0) {
    lines.push(` ${dim('│')}${' '.repeat(innerWidth)}${dim('│')}`);
  } else {
    for (const line of wrapped) {
      const visibleLen = visibleLength(line);
      const padding = ' '.repeat(Math.max(0, contentWidth - visibleLen));
      lines.push(` ${dim('│')}  ${dimI(line)}${padding}  ${dim('│')}`);
    }
  }

  // Bottom border
  lines.push(` ${dim('╰─')}${dim('─'.repeat(innerWidth))}${dim('╯')}`);

  return lines;
}

function renderToolEvent(
  call: ParsedToolCall,
  result: { summary: string; detail: string } | undefined,
  width: number,
  compressed = false,
): string[] {
  if (call.name === 'read') {
    const path = call.path || '—';
    const block = [eventHeader('read', path, width)];
    if (call.startLine || call.endLine)
      block.push(detailRow('lines', `${call.startLine ?? '?'}–${call.endLine ?? '?'}`, width));
    if (result) {
      const readOut = extractReadOutput(result.detail, width);
      if (readOut.length > 0) block.push(...readOut);
    }
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

  // Compressed mode (after completion): show command header, suppress exit 0.
  if (compressed && !failed && parsed) {
    const exitPart = exitCode !== undefined && exitCode !== 0 ? `failed exit ${exitCode}` : '';
    const block = [commandRow(command, exitPart || 'ok', width)];

    // For git diff --stat, extract changed-files summary.
    if (isGitDiffCommand(command)) {
      const changedSummary = extractChangedSummary(parsed.output);
      if (changedSummary) block.push(detailRow('changed', changedSummary, width));
    }
    return block;
  }

  // Expanded mode: full detail (active execution or failed commands).
  // Suppress exit 0 for successful commands; show only failure/nonzero exit.
  const state = ((): string => {
    if (!parsed) return 'running';
    if (exitCode === 0) return '';
    if (exitCode !== undefined) return `failed exit ${exitCode}`;
    return '';
  })();
  const block = [commandRow(command, state, width)];
  if (!result) return block;

  if (failed) {
    block.push(detailRow('exit', String(exitCode ?? 1), width));
    if (parsed?.duration) block.push(detailRow('meta', parsed.duration, width));
  }

  // For commit commands, extract and show the commit message on a separate line.
  if (/^git\s+commit\b/.test(command.trim())) {
    const commitMsg = extractCommitMessage(command);
    if (commitMsg) {
      block.push(detailRow('message', commitMsg, width));
    }
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

  // Detect and separate truncation marker appended by clipPatchPreview so it is
  // always visible even under display-line caps.
  const TRUNCATION_MARKER = '\n\n[Edit preview truncated:';
  const truncIdx = diff.indexOf(TRUNCATION_MARKER);
  const displayDiff = truncIdx >= 0 ? diff.slice(0, truncIdx) : diff;
  const truncNote = truncIdx >= 0 ? diff.slice(truncIdx + 2).trim() : null;

  block.push(...renderDiffRows(displayDiff, width, truncNote ? 6 : 8));
  if (truncNote) {
    block.push(`  ${' '.repeat(11)}${dimI(truncNote)}`);
  }
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

export function extractReadOutput(detail: string, width: number, maxDisplayLines = 15): string[] {
  const parsed = parseFirstJson(detail);
  const output = objectValue(parsed, 'output');
  const lines = output?.['lines'] as Array<{ lineNumber: number; text: string }> | undefined;
  if (!lines || lines.length === 0) return [];

  const displayLines = lines.slice(0, maxDisplayLines);
  const result: string[] = [];

  for (const line of displayLines) {
    const lineNo = String(line.lineNumber).padStart(4, ' ');
    const content = line.text.trimEnd();
    const maxContentWidth = Math.max(10, width - 21);
    const clipped = content.length > maxContentWidth ? content.slice(0, maxContentWidth - 1) + '…' : content;
    result.push(detailRow(`${lineNo}`, dim(clipped), width));
  }

  if (lines.length > maxDisplayLines) {
    const remaining = lines.length - maxDisplayLines;
    const firstLine = lines[0]?.lineNumber ?? 1;
    const lastLine = lines[lines.length - 1]?.lineNumber ?? '?';
    result.push(
      detailRow('', dimI(`… ${remaining} more line${remaining === 1 ? '' : 's'} (${firstLine}–${lastLine})`), width),
    );
  }

  return result;
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
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGitDiffCommand(command: string): boolean {
  return /^git\s+diff\b/.test(command.trim());
}

/** Extract the commit message from a git commit command line.
 *  Handles: git commit -m "message"  and  git commit --message "message" */
function extractCommitMessage(command: string): string | null {
  const trimmed = command.trim();
  const match = /git\s+commit\b.*(?:-m|--message)\s+"([^"]+)"/.exec(trimmed);
  if (match) return match[1];
  // Try single-quoted variant
  const sqMatch = /git\s+commit\b.*(?:-m|--message)\s+'([^']+)'/.exec(trimmed);
  if (sqMatch) return sqMatch[1];
  return null;
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
      // Orphaned CSI remnants — e.g. "[1;37m" left over when \u001b was
      // stripped upstream or by the control-character pass below.
      // Only strip orphaned SGR (Select Graphic Rendition) codes which are the
      // visually noisy ones; other CSI orphans (e.g. cursor moves) are rare.
      // eslint-disable-next-line no-control-regex
      .replace(/\[[0-9;:<=>?]*m/g, '')
  );
}

function hasAnsi(input: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /\u001b\[[0-9;]*m/.test(input);
}

/**
 * Calculate the visual length of a string in a terminal.
 * Correctly accounts for multi-width characters (e.g. emojis).
 */
function visibleLength(input: string): number {
  const stripped = stripAnsi(input);
  let len = 0;
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.charCodeAt(i);
    // Rough approximation for multi-column characters.
    // In a real application, consider 'string-width' library.
    if (code > 0x1f000) {
      len += 2;
      // Handle surrogate pairs
      if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        i + 1 < stripped.length &&
        stripped.charCodeAt(i + 1) >= 0xdc00 &&
        stripped.charCodeAt(i + 1) <= 0xdfff
      ) {
        i++;
      }
    } else {
      len++;
    }
  }
  return len;
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
  // Track the last non-reset ANSI sequence seen before the slice start.
  // When the slice starts mid-string (e.g. wrapped continuation lines),
  // we re-emit it so colors carry forward correctly.
  let pendingAnsi = '';

  for (let i = 0; i < input.length; i += 1) {
    if (input[i] === '\u001b') {
      // eslint-disable-next-line no-control-regex
      const match = /\u001b\[[0-9;]*m/.exec(input.slice(i));
      if (match) {
        if (writing || visibleIndex >= targetStart) {
          out += match[0];
        } else if (visibleIndex < targetStart) {
          // Remember the last non-reset ANSI code seen before the slice.
          pendingAnsi = match[0] === '\u001b[0m' ? '' : match[0];
        }
        i += match[0].length - 1;
        continue;
      }
    }

    if (visibleIndex >= targetEnd) break;
    if (visibleIndex >= targetStart) {
      writing = true;
      if (pendingAnsi) {
        out += pendingAnsi;
        pendingAnsi = '';
      }
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
  return `${yellow('$')} ${clip(command || 'bash', available)}${stateText}`;
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
  if (label === 'model') return pink('✽');
  if (label === 'result') return dim('•');
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

function pink(text: string): string {
  return `\u001b[35m${text}\u001b[0m`;
}

function boldDim(text: string): string {
  return `\u001b[1;90m${text}\u001b[0m`;
}

function dim(text: string): string {
  return `\u001b[90m${text}\u001b[0m`;
}

function plural(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
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

// ─── Model prose rendering ─────────────────────────────────

/** Extract meaningful natural-language prose from model output,
 *  stripping think blocks, tool_call XML, and excess whitespace.
 *  Returns empty string when content is only tool-call summaries. */
function extractModelProse(detail: string): string {
  const clean = stripLatexCommands(
    detail
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
      .replace(/\s*[-–—>→]*\s*\d+\s+tool call\(s\):\s*[A-Za-z0-9_,\s.-]+$/gi, '')
      .replace(/<\/?(?:think|thinking)>/gi, '')
      .replace(/[ \t]+/g, ' ')
      .trim(),
  );
  // If the remaining text is itself only a tool-summary line, return empty.
  if (isToolSummaryNote(clean)) return '';
  // Filter process-chatter that narrates intended future actions.
  if (isProcessChatter(clean)) return '';
  return clean;
}

/** Detect agent self-narration / process-chatter that doesn't add factual content.
 *  These phrases imply future actions that should be visible as tool commands
 *  or results — not rendered as standalone notes. */
function isProcessChatter(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  // Short stand-alone chatter fragments.
  if (
    /^(let me|i'll|i will|i am going to|i need to|i should|let's|we'll|we will)\b/i.test(normalized) &&
    normalized.length < 180
  ) {
    // Check if it reads like a self-narration of intended next actions.
    const chatterPatterns = [
      /(?:^|[.!?;]\s+)let me\b.*\b(diff|show|display|print|output|list|check|inspect|run|execute|fetch|get|pull|read|write|edit|commit|push|format|render|view|see|look|verify|confirm)/i,
      /(?:^|[.!?;]\s+)i'll\b.*\b(show|display|print|output|list|check|inspect|run|execute|fetch|get|pull|read|write|edit|commit|push|format|render|view|see|look|verify|confirm)/i,
      /(?:^|[.!?;]\s+)i (?:am going to|need to|should)\b.*\b(show|display|print|output|list|check|inspect|run|execute|fetch|get|pull|read|write|edit|commit|push|format|render|view|see|look|verify|confirm)/i,
      /\bfor completeness\b/i,
    ];
    if (chatterPatterns.some((p) => p.test(normalized))) return true;
  }
  return false;
}

/** Render model prose as a note with pink star glyph and dim italic body.
 *  When showHeading is false, the note heading is suppressed so
 *  consecutive notes group cleanly under a single heading. */
function renderModelProse(prose: string, width: number, showHeading: boolean): string[] {
  const glyph = '✽';
  const label = 'note';

  const plainPrefix = `${glyph} ${label} `;
  const prefixVisibleWidth = visibleLength(plainPrefix);
  const bodyWidth = Math.max(20, width - prefixVisibleWidth);
  const continuationIndent = ' '.repeat(prefixVisibleWidth);

  const wrapped = wrapText(prose, bodyWidth);
  if (wrapped.length === 0) return [];

  if (showHeading) {
    return [
      `${pink(glyph)} ${boldDim(label)} ${dimI(wrapped[0])}`,
      ...wrapped.slice(1).map((line) => `${continuationIndent}${dimI(line)}`),
    ];
  }
  return wrapped.map((line) => `${continuationIndent}${dimI(line)}`);
}

function renderWorkingShimmer(nowMs: number): string {
  const text = 'working';
  const highlight = Math.floor((nowMs / 120) % (text.length + 3)) - 1;
  let rendered = '';
  for (let i = 0; i < text.length; i += 1) {
    const style =
      i === highlight ? '\u001b[1;97m' : i === highlight - 1 || i === highlight + 1 ? '\u001b[1;36m' : '\u001b[1;34m';
    rendered += `${style}${text[i]}\u001b[0m`;
  }
  return rendered;
}

function renderTerminalIssue(issue: string, width: number): string[] {
  const lines = wrapText(stripTerminalControl(issue).trim() || 'unknown failure', Math.max(20, width - 14));
  return [
    eventHeader('error', 'terminal issue', width),
    detailRow('next', classifyTerminalIssue(issue), width),
    ...alignedField('message', lines, width, true),
  ];
}

function classifyTerminalIssue(issue: string): string {
  const lower = issue.toLowerCase();
  if (
    lower.includes('provider error') ||
    lower.includes('connection failed') ||
    lower.includes('network error') ||
    lower.includes('timed out') ||
    lower.includes('api key') ||
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('429') ||
    lower.includes('deepseek')
  ) {
    return 'check provider/server/config, then rerun';
  }
  if (lower.includes('context budget') || lower.includes('max tool calls')) {
    return 'narrow the prompt or raise the configured budget/limits';
  }
  if (
    lower.includes('malformed tool call') ||
    lower.includes('ambiguous mixed output') ||
    lower.includes('recoverable tool errors')
  ) {
    return 're-prompt Synax with a smaller, more explicit task';
  }
  if (lower.includes('verification failed')) {
    return 'inspect verification output and rerun after fixing';
  }
  return 'inspect the message below, then rerun';
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
export function renderMarkdownBlock(md: string, width: number): string[] {
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
export function renderReviewOutput(body: string, width: number): string[] {
  let clean = stripLatexCommands(
    body
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
      .trim(),
  );
  // Filter process-chatter lines from the final result.
  clean = clean
    .split('\n')
    .filter((line) => !isProcessChatter(line.trim()))
    .join('\n')
    .trim();
  if (!clean) return [`${green('•')} ${boldDim('result')}`];

  const hasMd = /^#{1,3}\s|^[*\-+]\s|^```|^\d+\.\s|^>\s|^---+$/m.test(clean);
  // Accent header: dashed rule with bold result label in green
  const accentWidth = Math.max(0, width - 6 - ' result '.length);
  const lines: string[] = [`  ${dim('╌')} ${boldDim('result')} ${green('╌'.repeat(Math.max(0, accentWidth)))}`];

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
