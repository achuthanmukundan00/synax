import type { TuiPalette } from './theme';
import { getPalette } from './theme';
import type { ArtifactPayload, RiskLevel, SemanticEvent, SemanticEventClass } from './semantic-events';
import { tuiStats } from './telemetry';
import { renderAiCore } from './ai-core';
import {
  HUNK_PREVIEW_LINES,
  HUNK_SCROLLBOX_THRESHOLD,
  STDOUT_PREVIEW_LINES,
  STDOUT_FULL_LINES,
  STDERR_PREVIEW_LINES,
  STDERR_FULL_LINES,
  TOOL_RESULT_OUTPUT_LINES,
  TEXT_PREVIEW_LINES,
  OUTPUT_SHOW_ALL_THRESHOLD,
  PLAN_MAX_STEPS,
  CONTEXT_CHIPS_MAX,
  RIGHT_RAIL_MIN_WIDTH,
  RIGHT_RAIL_WIDTH,
  RAIL_MAX_FILES,
  RAIL_MAX_CHECKPOINTS,
  CLIP_SINGLE_LINE_WIDTH,
  PERSISTENT_STATUS_CARD_ID,
} from './tui-constants';

type OpenTuiCore = typeof import('@opentui/core');
type OpenTuiNode =
  | ReturnType<OpenTuiCore['Box']>
  | ReturnType<OpenTuiCore['Text']>
  | ReturnType<OpenTuiCore['ScrollBox']>;

export interface CheckpointRailEntry {
  title: string;
  hash?: string;
}

export interface ArtifactRailState {
  model?: string;
  branch?: string;
  cwd?: string;
  filesTouched: string[];
  costLabel?: string;
  contextLabel?: string;
  uptimeLabel: string;
  provider?: string;
  endpoint?: string;
  recentCheckpoints?: CheckpointRailEntry[];
  pendingApprovals?: number;
}

export interface FooterState {
  status: string;
  prompt: string;
  placeholder: string;
  hints: string;
  location?: string;
  inputHeight?: number;
}

export interface AutocompleteState {
  visible: boolean;
  items: string[];
  selectedIndex: number;
}

export type ExpandedState = Record<string, boolean>;

export interface SplashOptions {
  frame: number;
  color?: boolean;
}

const COLORS: Record<SemanticEventClass, string> = {
  plan: '#bd93f9',
  edit: '#00ff87',
  diff: '#bd93f9',
  command: '#8be9fd',
  tool_result: '#00ff87',
  review: '#ffb86c',
  commit: '#bd93f9',
  checkpoint: '#00ff87',
  approval: '#ffb86c',
  status: '#6272a4',
  error: '#ff5555',
  note: '#6272a4',
  assistant_text: '#6272a4',
};

const GLYPHS: Record<SemanticEventClass, string> = {
  plan: '…',
  edit: '✓',
  diff: '≠',
  command: '⌘',
  tool_result: '✓',
  review: '⚠',
  commit: '⎇',
  checkpoint: '✓',
  approval: '!',
  status: '…',
  error: '✗',
  note: '→',
  assistant_text: '→',
};

export function renderArtifactRoot(
  core: OpenTuiCore,
  events: SemanticEvent[],
  rail: ArtifactRailState,
  footer: FooterState,
  terminalWidth: number,
  expanded?: ExpandedState,
  onToggleExpand?: (id: string) => void,
  palette?: TuiPalette,
  autocomplete?: AutocompleteState,
  onSubmit?: (value: string) => void,
  onPromptChange?: (value: string) => void,
  splash?: SplashOptions,
): OpenTuiNode {
  const pal = palette ?? getPalette();
  const rightRailWidth = railWidthFor(terminalWidth);
  const mainChildren =
    events.length > 0
      ? events.map((event) => renderArtifactCard(core, event, expanded?.[event.id] ?? false, onToggleExpand, pal))
      : [renderEmptyState(core, pal, splash)];
  const inputHeight = footer.inputHeight ?? promptInputHeight(footer.prompt);
  const input = core.h(core.TextareaRenderable, {
    id: 'synax-input',
    initialValue: footer.prompt,
    placeholder: footer.placeholder,
    width: '100%',
    height: inputHeight,
    minHeight: 1,
    maxHeight: 12,
    wrapMode: 'word',
    backgroundColor: pal.background,
    textColor: pal.text,
    focusedBackgroundColor: pal.surface,
    focusedTextColor: pal.text,
    placeholderColor: pal.textAccent,
    keyBindings: [
      { name: 'return', action: 'submit' },
      { name: 'linefeed', action: 'submit' },
      { name: 'return', shift: true, action: 'newline' },
      { name: 'linefeed', shift: true, action: 'newline' },
    ],
    onContentChange: function () {
      onPromptChange?.(readPromptValue(this));
    },
    onSubmit: function () {
      onSubmit?.(readPromptValue(this));
    },
  });

  return core.Box(
    {
      id: 'synax-root',
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      backgroundColor: pal.background,
    },
    core.Box(
      { flexGrow: 1, flexDirection: 'row', minHeight: 1 },
      core.ScrollBox(
        {
          id: 'synax-artifacts',
          flexGrow: 1,
          viewportCulling: true,
          stickyScroll: true,
          stickyStart: 'bottom',
          padding: 1,
          scrollY: true,
        },
        ...mainChildren,
      ),
      ...(rightRailWidth > 0 ? [renderRightRail(core, rail, rightRailWidth, pal)] : []),
    ),
    renderAutocompleteOverlay(core, autocomplete, pal),
    core.Box(
      {
        id: 'synax-footer',
        height: 3 + (footer.location ? 1 : 0) + inputHeight,
        width: '100%',
        flexDirection: 'column',
        border: ['top'],
        borderColor: pal.border,
        paddingX: 1,
      },
      core.Text({ id: 'synax-status', content: footer.status, fg: footerColor(footer.status) }),
      input,
      ...(footer.location ? [core.Text({ id: 'synax-location', content: footer.location, fg: pal.textMuted })] : []),
      core.Text({ id: 'synax-hints', content: footer.hints, fg: pal.textAccent }),
    ),
  );
}

export function renderArtifactCard(
  core: OpenTuiCore,
  event: SemanticEvent,
  expanded = false,
  onToggleExpand?: (id: string) => void,
  palette?: TuiPalette,
): OpenTuiNode {
  // Route the persistent status card to a special compact renderer
  if (event.id === PERSISTENT_STATUS_CARD_ID) {
    return renderPersistentStatusCard(core, event, palette);
  }
  const pal = palette ?? getPalette();
  const color = eventColor(event.class, pal);
  const children = renderPayloadRows(
    core,
    event.artifact,
    event.class,
    expanded,
    onToggleExpand ? () => onToggleExpand(event.id) : undefined,
    event,
    pal,
  );
  tuiStats.recordCardRendered(children.length);
  return core.Box(
    {
      id: event.id,
      width: '100%',
      flexDirection: 'row',
      marginBottom: 1,
    },
    core.Box({ width: 2, backgroundColor: color, marginRight: 1 }),
    core.Box(
      {
        flexGrow: 1,
        flexDirection: 'column',
        border: true,
        borderStyle: 'single',
        borderColor: color,
        title: formatEventCrown(event.class),
        paddingX: 1,
        paddingY: 0,
      },
      ...children,
    ),
  );
}

function eventColor(eventClass: SemanticEventClass, palette: TuiPalette): string {
  return palette.semantic[eventClass] ?? COLORS[eventClass] ?? '#cccccc';
}

/** Compact persistent status card shown at the bottom of the transcript during execution. */
function renderPersistentStatusCard(core: OpenTuiCore, event: SemanticEvent, palette?: TuiPalette): OpenTuiNode {
  const pal = palette ?? getPalette();
  const payload = event.artifact;
  const label = payload.type === 'status' ? payload.label : '';
  const detail = payload.type === 'status' ? (payload.detail ?? '') : '';

  const color = statusCardColor(label, pal);

  return core.Box(
    {
      id: event.id,
      width: '100%',
      flexDirection: 'row',
      marginBottom: 1,
    },
    core.Box({ width: 2, backgroundColor: color, marginRight: 1 }),
    core.Box(
      {
        flexGrow: 1,
        flexDirection: 'column',
        border: true,
        borderStyle: 'single',
        borderColor: color,
        paddingX: 1,
        paddingY: 0,
      },
      core.Text({ content: label, fg: color }),
      ...(detail ? [core.Text({ content: detail, fg: pal.textAccent })] : []),
    ),
  );
}

function statusCardColor(label: string, palette: TuiPalette): string {
  if (label.startsWith('✗') || label.startsWith('x')) return palette.error;
  if (label.startsWith('✓')) return palette.success;
  if (label.startsWith('!')) return palette.warning;
  if (label.startsWith('$') || label.startsWith('○') || label.startsWith('...')) return palette.info;
  if (label.startsWith('◉')) return palette.brand;
  return palette.info;
}

function renderContextChips(core: OpenTuiCore, event: SemanticEvent): OpenTuiNode | null {
  const files = event.metadata.filesTouched;
  if (!files || files.length === 0) return null;
  const chips: OpenTuiNode[] = [];
  const maxChips = CONTEXT_CHIPS_MAX;
  for (let i = 0; i < Math.min(files.length, maxChips); i++) {
    const file = files[i]!;
    const isDir = file.endsWith('/');
    const chipLabel = isDir ? `@${file}` : `→ ${file.split('/').pop() ?? file}`;
    chips.push(core.Text({ content: ` ${chipLabel}`, fg: '#6272a4' }));
    if (i < Math.min(files.length, maxChips) - 1) {
      chips.push(core.Text({ content: ' ', fg: '#333333' }));
    }
  }
  if (files.length > maxChips) {
    chips.push(core.Text({ content: ` +${files.length - maxChips} more`, fg: '#6272a4' }));
  }
  return core.Box({ flexDirection: 'row', paddingTop: 0, paddingBottom: 0 }, ...chips);
}

function renderPayloadRows(
  core: OpenTuiCore,
  payload: ArtifactPayload,
  eventClass: SemanticEventClass,
  expanded = false,
  onToggle?: () => void,
  event?: SemanticEvent,
  palette?: TuiPalette,
): OpenTuiNode[] {
  const pal = palette ?? getPalette();
  if (payload.type === 'plan') {
    return [
      core.Text({ content: payload.title, fg: pal.text }),
      ...(event ? ([renderContextChips(core, event)].filter(Boolean) as OpenTuiNode[]) : []),
      ...payload.steps.slice(0, PLAN_MAX_STEPS).map((step) => core.Text({ content: step, fg: pal.textMuted })),
      core.Text({ content: '[Execute plan] [Revise]', fg: pal.textAccent }),
    ];
  }
  if (payload.type === 'edit') {
    return [
      core.Text({
        content: `${payload.file}   +${payload.linesAdded} ~${payload.linesModified} -${payload.linesRemoved}`,
        fg: pal.textMuted,
      }),
      ...(event ? ([renderContextChips(core, event)].filter(Boolean) as OpenTuiNode[]) : []),
      core.Text({ content: payload.summary, fg: pal.text }),
      core.Text({ content: '[View diff] [Open file]', fg: pal.textAccent }),
    ];
  }
  if (payload.type === 'diff') {
    const showAll = expanded;
    const hunks = showAll ? payload.hunks : payload.hunks.slice(0, HUNK_PREVIEW_LINES);
    const hunkNodes = hunks.map((line) => core.Text({ content: line, fg: diffLineColor(line) }));
    const toggleLabel = showAll ? '[Collapse hunk]' : payload.hunks.length > HUNK_PREVIEW_LINES ? '[Expand hunk]' : '';
    const toggleText = toggleLabel ? `${toggleLabel} [Accept] [Discard]` : '[Accept] [Discard]';
    return [
      core.Text({ content: payload.file, fg: pal.textMuted }),
      ...(event ? ([renderContextChips(core, event)].filter(Boolean) as OpenTuiNode[]) : []),
      ...(showAll && hunkNodes.length > HUNK_SCROLLBOX_THRESHOLD
        ? [
            core.ScrollBox(
              { height: 20, viewportCulling: true, scrollY: true, border: true, borderColor: pal.border },
              ...hunkNodes,
            ),
          ]
        : hunkNodes),
      actionText(core, toggleText, pal.textAccent, onToggle),
    ];
  }
  if (payload.type === 'command') {
    const status =
      payload.exitCode === undefined
        ? 'Running or queued'
        : payload.exitCode === 0
          ? 'exit 0'
          : `failed exit ${payload.exitCode}`;
    const stdoutLines = payload.stdout?.split('\n').filter(Boolean) ?? [];
    const stderrLines = payload.stderr?.split('\n').filter(Boolean) ?? [];
    const totalOut = stdoutLines.length + stderrLines.length;
    const showFull = expanded;
    const displayStdout = showFull
      ? stdoutLines.slice(0, STDOUT_FULL_LINES)
      : stdoutLines.slice(0, STDOUT_PREVIEW_LINES);
    const displayStderr = showFull
      ? stderrLines.slice(0, STDERR_FULL_LINES)
      : stderrLines.slice(0, STDERR_PREVIEW_LINES);
    let actionLabel: string;
    if (!showFull && totalOut > OUTPUT_SHOW_ALL_THRESHOLD) {
      actionLabel = `[Show full output (${totalOut} lines)] [Retry]`;
    } else if (showFull && totalOut > 200) {
      actionLabel = `[Show 200 of ${totalOut} lines] [Open in pager]`;
    } else if (showFull) {
      actionLabel = '[Collapse output] [Retry]';
    } else {
      actionLabel = '[Show full output] [Retry]';
    }
    return [
      core.Text({ content: payload.command || 'command', fg: pal.text }),
      ...(event ? ([renderContextChips(core, event)].filter(Boolean) as OpenTuiNode[]) : []),
      core.Text({ content: status, fg: payload.exitCode && payload.exitCode !== 0 ? pal.error : pal.textAccent }),
      ...outputRows(core, displayStdout, displayStderr, pal),
      actionText(core, actionLabel, pal.textAccent, onToggle),
    ];
  }
  if (payload.type === 'tool_result') {
    const hasOutput = !!payload.output;
    return [
      core.Text({ content: payload.title, fg: payload.status === 'error' ? pal.error : pal.text }),
      core.Text({ content: payload.summary || 'completed', fg: pal.textMuted }),
      ...(hasOutput
        ? expanded
          ? [
              actionText(core, '[Hide output]', pal.textAccent, onToggle),
              ...payload
                .output!.split('\n')
                .filter(Boolean)
                .slice(0, TOOL_RESULT_OUTPUT_LINES)
                .map((line) => core.Text({ content: line, fg: pal.textAccent })),
            ]
          : [
              core.Text({ content: clipSingleLine(payload.output!), fg: pal.textAccent }),
              actionText(core, '[Show output]', pal.textAccent, onToggle),
            ]
        : []),
    ];
  }
  if (payload.type === 'approval') {
    return [
      core.Text({ content: payload.action, fg: pal.text }),
      core.Text({
        content: `Risk: ${payload.details}   [${payload.riskLevel.toUpperCase()}]`,
        fg: riskColor(payload.riskLevel),
      }),
      core.Text({ content: payload.choices.join('   '), fg: pal.textAccent }),
    ];
  }
  if (payload.type === 'commit') {
    return [
      core.Text({ content: payload.message, fg: pal.text }),
      core.Text({ content: `Files: ${payload.files.join(', ') || 'unknown'}`, fg: pal.textMuted }),
      core.Text({ content: '[Amend] [Create PR]', fg: pal.textAccent }),
    ];
  }
  if (payload.type === 'checkpoint') {
    return [
      core.Text({ content: payload.title, fg: pal.text }),
      core.Text({ content: `Files: ${payload.files.length}   Git hash: ${payload.hash ?? 'n/a'}`, fg: pal.textMuted }),
      core.Text({ content: '[Restore] [Diff against current]', fg: pal.textAccent }),
    ];
  }
  if (payload.type === 'status') {
    const color = eventColor(eventClass, pal);
    return [
      core.Text({ content: payload.label, fg: color }),
      core.Text({ content: payload.detail ?? '', fg: pal.textAccent }),
    ];
  }
  // For tool_result text events (e.g., final model output), render with markdown
  if (eventClass === 'tool_result' && payload.type === 'text') {
    return [
      core.Text({ content: payload.title, fg: eventColor(eventClass, pal) }),
      ...renderResultMarkdown(core, payload.body, pal),
    ];
  }
  return [
    core.Text({ content: payload.title, fg: eventColor(eventClass, pal) }),
    ...textPayloadRows(core, payload.body, eventClass, expanded, pal),
    ...(isExpandableText(payload.body, eventClass, expanded)
      ? [actionText(core, '[Show full text]', pal.textAccent, onToggle)]
      : []),
    ...(expanded && isCollapsibleText(payload.body, eventClass)
      ? [actionText(core, '[Collapse text]', pal.textAccent, onToggle)]
      : []),
  ];
}

/**
 * Render markdown content as styled OpenTUI Text nodes.
 * Handles headings, inline code, bold, lists, and blockquotes.
 */
function renderResultMarkdown(core: OpenTuiCore, body: string, palette: TuiPalette): OpenTuiNode[] {
  const nodes: OpenTuiNode[] = [];
  const lines = body.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Fenced code blocks: skip fence markers, inline code as-is
    if (/^```/.test(line)) {
      continue;
    }

    // Headings
    const hMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (hMatch) {
      const level = hMatch[1].length;
      const text = hMatch[2]!;
      const hColor = level <= 2 ? palette.brand : palette.warning;
      nodes.push(core.Text({ content: text, fg: hColor }));
      continue;
    }

    // Bullet lists
    const bMatch = line.match(/^\s*[-*+]\s+(.+)/);
    if (bMatch) {
      nodes.push(core.Text({ content: `• ${bMatch[1]}`, fg: palette.text }));
      continue;
    }

    // Numbered lists
    const nMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (nMatch) {
      nodes.push(core.Text({ content: line, fg: palette.text }));
      continue;
    }

    // Blockquotes
    const qMatch = line.match(/^>\s?(.+)/);
    if (qMatch) {
      nodes.push(core.Text({ content: qMatch[1]!, fg: palette.textMuted }));
      continue;
    }

    // Empty lines
    if (!line.trim()) {
      nodes.push(core.Text({ content: '', fg: palette.text }));
      continue;
    }

    // Regular text with inline code support — split on backtick pairs.
    // Each odd-indexed segment after splitting by backticks is inline code.
    const segments = line.split(/(`[^`]+`)/);
    const lineNodes: OpenTuiNode[] = [];
    let accumulator = '';
    for (const seg of segments) {
      if (seg.startsWith('`') && seg.endsWith('`') && seg.length >= 2) {
        if (accumulator) {
          lineNodes.push(core.Text({ content: accumulator, fg: palette.text }));
          accumulator = '';
        }
        lineNodes.push(core.Text({ content: seg.slice(1, -1), fg: palette.info }));
      } else {
        accumulator += seg;
      }
    }
    if (accumulator) lineNodes.push(core.Text({ content: accumulator, fg: palette.text }));

    nodes.push(...lineNodes);
  }

  return nodes;
}

function textPayloadRows(
  core: OpenTuiCore,
  body: string,
  eventClass: SemanticEventClass,
  expanded: boolean,
  palette: TuiPalette,
): OpenTuiNode[] {
  const lines = body.split('\n');
  const visibleLines = eventClass === 'tool_result' || expanded ? lines : lines.slice(0, TEXT_PREVIEW_LINES);
  const fg = eventClass === 'tool_result' ? palette.text : palette.textMuted;
  return visibleLines.map((line) => core.Text({ content: line, fg }));
}

function isExpandableText(body: string, eventClass: SemanticEventClass, expanded: boolean): boolean {
  return !expanded && eventClass !== 'tool_result' && body.split('\n').length > TEXT_PREVIEW_LINES;
}

function isCollapsibleText(body: string, eventClass: SemanticEventClass): boolean {
  return eventClass !== 'tool_result' && body.split('\n').length > TEXT_PREVIEW_LINES;
}

function outputRows(core: OpenTuiCore, stdout: string[], stderr: string[], palette: TuiPalette): OpenTuiNode[] {
  const rows: OpenTuiNode[] = [];
  if (stdout.length > 0)
    rows.push(core.Text({ content: `stdout: ${stdout.join(' / ').slice(0, 300)}`, fg: palette.textAccent }));
  if (stderr.length > 0)
    rows.push(core.Text({ content: `stderr: ${stderr.join(' / ').slice(0, 300)}`, fg: palette.error }));
  return rows;
}

function renderRightRail(core: OpenTuiCore, rail: ArtifactRailState, width: number, palette?: TuiPalette): OpenTuiNode {
  const pal = palette ?? getPalette();
  const fileRows = rail.filesTouched
    .slice(-RAIL_MAX_FILES)
    .map((file) => core.Text({ content: `> ${compactPath(file, width - 2)}`, fg: pal.textAccent }));
  const checkpointRows = (rail.recentCheckpoints ?? []).slice(-RAIL_MAX_CHECKPOINTS).map((cp) =>
    core.Text({
      content: `# ${clip(cp.title, width - 4)}`,
      fg: pal.success,
    }),
  );
  return core.Box(
    {
      id: 'synax-right-rail',
      width,
      flexDirection: 'column',
      border: ['left'],
      borderColor: pal.border,
      paddingX: 1,
    },
    core.Text({ id: 'synax-rail-files', content: `Files (${rail.filesTouched.length})`, fg: pal.text }),
    ...(fileRows.length > 0 ? fileRows : [core.Text({ content: 'none', fg: pal.textAccent })]),
    core.Text({ content: '' }),
    ...(checkpointRows.length > 0
      ? ([
          core.Text({ content: `Checkpoints (${(rail.recentCheckpoints ?? []).length})`, fg: pal.text }),
          ...checkpointRows,
          core.Text({ content: '' }),
        ] as OpenTuiNode[])
      : []),
    ...(rail.pendingApprovals && rail.pendingApprovals > 0
      ? ([
          core.Text({ content: '' }),
          core.Text({ content: `Pending approvals (${rail.pendingApprovals})`, fg: pal.warning }),
        ] as OpenTuiNode[])
      : []),
    core.Text({ content: '' }),
    core.Text({ content: 'Session', fg: pal.text }),
    core.Text({ content: `Cost: ${rail.costLabel ?? 'local'}`, fg: pal.textAccent }),
    core.Text({ id: 'synax-rail-context', content: `Context: ${rail.contextLabel ?? 'n/a'}`, fg: pal.textAccent }),
    core.Text({ id: 'synax-rail-model', content: clip(rail.model ?? 'model n/a', width - 2), fg: pal.brand }),
    core.Text({ id: 'synax-rail-uptime', content: `Uptime: ${rail.uptimeLabel}`, fg: pal.textAccent }),
  );
}

function renderAutocompleteOverlay(
  core: OpenTuiCore,
  autocomplete: AutocompleteState | undefined,
  palette: TuiPalette,
): OpenTuiNode {
  const visible = autocomplete?.visible === true && autocomplete.items.length > 0;
  const items = autocomplete?.items.slice(0, 10) ?? [];
  const selectedIndex = autocomplete?.selectedIndex ?? 0;
  const rows: OpenTuiNode[] = [];
  for (let i = 0; i < 10; i++) {
    const isSelected = i === selectedIndex;
    const item = items[i] ?? '';
    rows.push(
      core.Text({
        id: `synax-autocomplete-row-${i}`,
        content: item ? (isSelected ? `> ${item}` : `  ${item}`) : '',
        fg: isSelected ? palette.brand : palette.textAccent,
      }),
    );
  }
  return core.Box(
    {
      id: 'synax-autocomplete',
      visible,
      width: '100%',
      flexDirection: 'column',
      border: true,
      borderStyle: 'single',
      borderColor: palette.brand,
      paddingX: 1,
      paddingY: 0,
    },
    core.Text({ content: 'Commands', fg: palette.textMuted }),
    ...rows,
  );
}

function renderEmptyState(core: OpenTuiCore, palette?: TuiPalette, splash?: SplashOptions): OpenTuiNode {
  const pal = palette ?? getPalette();
  const logo = renderSplashLogo(splash?.frame ?? 0, { color: splash?.color ?? shouldUseSplashColor() });
  return core.Box(
    {
      id: 'synax-empty-state',
      width: '100%',
      flexDirection: 'column',
      border: true,
      borderStyle: 'single',
      borderColor: pal.border,
      padding: 1,
    },
    ...logo.map((line, index) =>
      core.Text({
        content: line,
        fg: splashLineColor(index, splash?.frame ?? 0, pal),
      }),
    ),
    core.Text({ content: '' }),
    core.Text({ content: 'synax', fg: pal.brand }),
    core.Text({ content: 'local-first coding agent runtime', fg: pal.textMuted }),
  );
}

function railWidthFor(width: number): number {
  return width < RIGHT_RAIL_MIN_WIDTH ? 0 : RIGHT_RAIL_WIDTH;
}

function labelFor(eventClass: SemanticEventClass): string {
  if (eventClass === 'assistant_text') return 'Note';
  if (eventClass === 'tool_result') return 'Result';
  return eventClass.replace(/_/g, ' ').replace(/^\w/, (char) => char.toUpperCase());
}

export function formatEventCrown(eventClass: SemanticEventClass): string {
  return `  ${GLYPHS[eventClass]}  ${labelFor(eventClass)}  `;
}

export function promptInputHeight(prompt: string, terminalWidth = 80): number {
  const wrapColumns = Math.max(16, terminalWidth - 4);
  const explicitLines = stripAnsi(prompt).split('\n');
  const visualLines = explicitLines.reduce((count, line) => {
    const lineLength = Math.max(1, line.length);
    return count + Math.max(1, Math.ceil(lineLength / wrapColumns));
  }, 0);
  return Math.max(1, visualLines);
}

export function renderSplashLogo(frame: number, options?: { color?: boolean }): string[] {
  const useColor = options?.color !== false;
  return renderAiCore('idle', frame / 8)
    .slice(0, 9)
    .map((line) => (useColor ? stripAnsi(line) : stripAnsi(line).replace(/[╭╮╰╯─│○◎●•·]/g, '.')));
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function shouldUseSplashColor(): boolean {
  return !process.env.NO_COLOR && process.env.TERM !== 'dumb';
}

function splashLineColor(index: number, frame: number, palette: TuiPalette): string {
  if (!shouldUseSplashColor()) return palette.textMuted;
  const colors = ['#4f8cff', '#47d7ff', '#7c6cff', '#82f7ff'];
  return colors[(index + frame) % colors.length] ?? palette.brand;
}

function actionText(core: OpenTuiCore, content: string, fg: string, onToggle?: () => void): OpenTuiNode {
  return core.Text({
    content,
    fg,
    onMouseDown: (event: { stopPropagation?: () => void; preventDefault?: () => void }) => {
      event.stopPropagation?.();
      event.preventDefault?.();
      onToggle?.();
    },
  });
}

function readPromptValue(input: unknown): string {
  const promptInput = input as { plainText?: string; value?: string };
  try {
    return typeof promptInput.plainText === 'string' ? promptInput.plainText : (promptInput.value ?? '');
  } catch {
    return promptInput.value ?? '';
  }
}

function diffLineColor(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return '#00ff87';
  if (line.startsWith('-') && !line.startsWith('---')) return '#ff5555';
  if (line.startsWith('@@')) return '#8be9fd';
  return '#cccccc';
}

function riskColor(risk: RiskLevel): string {
  if (risk === 'high') return '#ff5555';
  if (risk === 'medium') return '#ffb86c';
  return '#00ff87';
}

function footerColor(status: string): string {
  if (status.startsWith('!')) return '#ffb86c';
  if (status.startsWith('x')) return '#ff5555';
  if (status.startsWith('✓')) return '#00ff87';
  if (status.startsWith('$')) return '#8be9fd';
  return '#cccccc';
}

const ANSI_PATTERN = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

function clipSingleLine(text: string): string {
  return clip(
    text
      .replace(ANSI_PATTERN, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(' / '),
    CLIP_SINGLE_LINE_WIDTH,
  );
}

function compactPath(path: string, width: number): string {
  if (path.length <= width) return path;
  const parts = path.split('/');
  return clip(parts[parts.length - 1] ?? path, width);
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}
