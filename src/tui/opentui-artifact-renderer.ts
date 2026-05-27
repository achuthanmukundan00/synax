import type { TuiPalette } from './theme';
import { getPalette } from './theme';
import type { ArtifactPayload, RiskLevel, SemanticEvent, SemanticEventClass } from './semantic-events';
import { tuiStats } from './telemetry';
import { renderAiCore } from './ai-core';
import { resolveCoreVisualProfile } from './core-visual-profile';
import { visibleLength } from './text-utils';
import type { ModelPalette } from './model-palette';
import { getModelPalette } from './model-palette';
import { stripToolCallMarkup } from './markup-sanitizer';
import {
  HUNK_PREVIEW_LINES,
  TEXT_PREVIEW_LINES,
  PERSISTENT_STATUS_CARD_ID,
  ACTIVITY_LINE_ID,
  ACTIVITY_GLYPH_ID,
  ACTIVITY_TEXT_ID,
  AUTOCOMPLETE_MAX_ROWS,
} from './tui-constants';

type OpenTuiCore = typeof import('@opentui/core');
type OpenTuiNode =
  | ReturnType<OpenTuiCore['Box']>
  | ReturnType<OpenTuiCore['Text']>
  | ReturnType<OpenTuiCore['ScrollBox']>;

const CARD_BODY_LAYOUT = {
  flexGrow: 1,
  flexShrink: 1,
  flexBasis: 0,
  minWidth: 0,
} as const;

const FULL_WIDTH_TEXT = {
  width: '100%',
  wrapMode: 'word',
} as const;

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
  maxVisibleItems?: number;
}

export type ExpandedState = Record<string, boolean>;

export interface SplashOptions {
  frame: number;
  color?: boolean;
}

export function footerLayoutHeight(footer: FooterState): number {
  const inputHeight = footer.inputHeight ?? promptInputHeight(footer.prompt);
  const inputFrameHeight = inputHeight + 2;
  return inputFrameHeight + 2;
}

const COLORS: Record<SemanticEventClass, string> = {
  plan: '#bd93f9',
  edit: '#00ff87',
  diff: '#bd93f9',
  command: '#8be9fd',
  tool_result: '#00ff87',
  result_error: '#ff5555',
  review: '#ffb86c',
  commit: '#bd93f9',
  checkpoint: '#00ff87',
  approval: '#ffb86c',
  status: '#6272a4',
  error: '#ff5555',
  prompt: '#8a8f98',
  note: '#6272a4',
  assistant_text: '#6272a4',
  dispatch: '#8be9fd',
  agent_status: '#ff79c6',
  thinking: '#bd93f9',
};

const GLYPHS: Record<SemanticEventClass, string> = {
  plan: '…',
  edit: '✓',
  diff: '⎇',
  command: '⌘',
  tool_result: '◇',
  result_error: '✕',
  review: '⚠',
  commit: '⎇',
  checkpoint: '✓',
  approval: '!',
  status: '…',
  error: '✕',
  prompt: '◆',
  note: '→',
  assistant_text: '→',
  dispatch: '◇',
  agent_status: '◈',
  thinking: '◌',
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
  settingsLines?: string[],
  settingsActiveLabel?: string,
  onSubmit?: (value: string) => void,
  onPromptChange?: (value: string, input: unknown) => void,
  splash?: SplashOptions,
  modelId?: string,
  terminalHeight?: number,
  infoLines?: string[] | null,
): OpenTuiNode {
  const pal = palette ?? getPalette();
  const modelPal = modelId ? getModelPalette(modelId) : getModelPalette('');
  const compactStartup =
    events.length === 0 &&
    (!settingsLines || settingsLines.length === 0) &&
    footer.status === 'Ready.' &&
    footer.prompt.length === 0;
  const mainChildren =
    events.length > 0
      ? events.map((event) => renderArtifactCard(core, event, expanded?.[event.id] ?? false, onToggleExpand, pal))
      : [renderEmptyState(core, rail, terminalWidth, footer, pal, splash, modelPal, modelId)];
  const inputHeight = footer.inputHeight ?? promptInputHeight(footer.prompt);
  const inputFrameHeight = inputHeight + 2;
  const footerHeight = footerLayoutHeight(footer);
  const activityHeight = 1;
  const emptyStateHeight = compactEmptyStateHeight(rail);
  const rootHeight = compactStartup ? emptyStateHeight + activityHeight + footerHeight : (terminalHeight ?? '100%');
  const input = core.h(core.TextareaRenderable, {
    id: 'synax-input',
    initialValue: footer.prompt,
    placeholder: footer.placeholder,
    width: '100%',
    height: inputHeight,
    minHeight: 1,
    maxHeight: 12,
    wrapMode: 'word',
    backgroundColor: pal.surface,
    textColor: pal.text,
    focusedBackgroundColor: pal.surface,
    focusedTextColor: pal.text,
    placeholderColor: pal.textAccent,
    cursorStyle: { style: 'line', blinking: true },
    keyBindings: [
      { name: 'return', shift: true, action: 'newline' },
      { name: 'linefeed', shift: true, action: 'newline' },
    ],
    onContentChange: function () {
      onPromptChange?.(readPromptValue(this), this);
    },
    onSubmit: function () {
      onSubmit?.(readPromptValue(this));
    },
  });

  return core.Box(
    {
      id: 'synax-root',
      width: '100%',
      height: rootHeight,
      flexDirection: 'column',
      overflow: 'hidden',
      backgroundColor: pal.background,
    },
    core.Box(
      compactStartup
        ? { height: emptyStateHeight, flexDirection: 'row', minHeight: 1, overflow: 'hidden' }
        : { flexGrow: 1, flexDirection: 'row', minHeight: 1, overflow: 'hidden' },
      core.ScrollBox(
        {
          id: 'synax-artifacts',
          ...(compactStartup ? { height: emptyStateHeight } : { flexGrow: 1 }),
          overflow: 'hidden',
          viewportCulling: true,
          stickyScroll: true,
          stickyStart: 'bottom',
          padding: 1,
          scrollY: true,
        },
        ...mainChildren,
      ),
    ),
    // Live activity line — single row between feed and footer
    core.Box(
      {
        id: ACTIVITY_LINE_ID,
        width: '100%',
        height: 1,
        flexDirection: 'row',
        paddingX: 1,
        paddingY: 0,
        visible: true,
        backgroundColor: pal.background,
      },
      core.Text({ id: ACTIVITY_GLYPH_ID, content: '', width: 11 }),
      core.Text({ id: ACTIVITY_TEXT_ID, content: 'Ready.', fg: pal.textAccent }),
    ),
    ...(settingsLines && settingsLines.length > 0
      ? [renderSettingsOverlay(core, settingsLines, pal, settingsActiveLabel, terminalHeight)]
      : []),
    renderAutocompleteOverlay(core, autocomplete, pal, footerHeight),
    core.Box(
      {
        id: 'synax-footer',
        width: '100%',
        flexDirection: 'column',
        border: ['top'],
        borderColor: pal.border,
        backgroundColor: pal.background,
        zIndex: 20,
        paddingX: 1,
      },
      ...(infoLines && infoLines.length > 0 ? [renderSlashInfoPanel(core, infoLines, pal)] : []),
      core.Box(
        {
          id: 'synax-input-frame',
          width: '100%',
          height: inputFrameHeight,
          flexDirection: 'row',
          backgroundColor: pal.surface,
          paddingX: 1,
          paddingY: 1,
        },
        core.Text({ content: '> ', fg: pal.textMuted, width: 2 }),
        core.Box({ flexGrow: 1 }, input),
      ),
      core.Text({ id: 'synax-hints', content: footer.hints, fg: pal.textAccent }),
    ),
  );
}

function renderSettingsOverlay(
  core: OpenTuiCore,
  lines: string[],
  palette: TuiPalette,
  activeLabel?: string,
  terminalHeight?: number,
): OpenTuiNode {
  const overlayHeight = terminalHeight ?? '100%';
  const backingLineCount = typeof terminalHeight === 'number' ? Math.max(0, terminalHeight - lines.length) : 0;
  return core.Box(
    {
      id: 'synax-settings',
      width: '100%',
      height: overlayHeight,
      position: 'absolute',
      top: 0,
      left: 0,
      zIndex: 100,
      flexDirection: 'column',
      backgroundColor: palette.background,
    },
    ...lines.map((line, index) =>
      core.Text({
        id: `synax-settings-line-${index}`,
        content: index === 1 && activeLabel ? styledActiveSettingsLine(core, line, activeLabel, palette) : line,
        ...(index === 1 && activeLabel ? {} : { fg: palette.text }),
      }),
    ),
    ...Array.from({ length: backingLineCount }, (_, index) =>
      core.Box({
        id: `synax-settings-backdrop-${index}`,
        width: '100%',
        height: 1,
        backgroundColor: palette.background,
      }),
    ),
  );
}

/** Render slash-command info as a panel inside the footer, above the input. */
function renderSlashInfoPanel(core: OpenTuiCore, lines: string[], palette: TuiPalette): OpenTuiNode {
  const maxLines = Math.min(lines.length, 14);
  const displayed = lines.slice(0, maxLines);
  return core.Box(
    {
      id: 'synax-slash-info',
      width: '100%',
      flexDirection: 'column',
      border: ['bottom'],
      borderColor: palette.border,
      paddingX: 0,
      paddingY: 0,
      marginBottom: 0,
    },
    ...displayed.map((line) =>
      core.Text({
        content: line || ' ',
        fg: palette.textAccent,
        wrapMode: 'word',
      }),
    ),
  );
}

function styledActiveSettingsLine(
  core: OpenTuiCore,
  line: string,
  activeLabel: string,
  palette: TuiPalette,
): string | InstanceType<(typeof import('@opentui/core'))['StyledText']> {
  const plain = stripAnsi(line);
  const activeSegment = ` ${activeLabel} `;
  const start = plain.indexOf(activeSegment);
  if (start < 0) return plain;
  const before = plain.slice(0, start);
  const active = plain.slice(start, start + activeSegment.length);
  const after = plain.slice(start + activeSegment.length);
  return new core.StyledText([
    { __isChunk: true, text: before },
    core.bg(palette.text)(core.fg(palette.background)(active)),
    { __isChunk: true, text: after },
  ] as any);
}

function styledInlineMarkdown(
  core: OpenTuiCore,
  text: string,
  palette: TuiPalette,
  baseColor = palette.text,
): string | InstanceType<(typeof import('@opentui/core'))['StyledText']> {
  const coreWithStyles = core as unknown as {
    StyledText?: new (chunks: unknown[]) => unknown;
    fg?: (color: string) => (text: string) => unknown;
    bold?: (chunk: unknown) => unknown;
    italic?: (chunk: unknown) => unknown;
    underline?: (chunk: unknown) => unknown;
  };
  if (typeof coreWithStyles.StyledText !== 'function' || typeof coreWithStyles.fg !== 'function') {
    return plainInlineMarkdown(text);
  }

  const chunks: unknown[] = [];
  const tokenPattern = /(`[^`]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^)]+\))/g;
  let cursor = 0;

  const pushPlain = (value: string): void => {
    if (!value) return;
    chunks.push(coreWithStyles.fg!(baseColor)(value));
  };

  for (const match of text.matchAll(tokenPattern)) {
    const raw = match[0];
    const index = match.index ?? 0;
    pushPlain(text.slice(cursor, index));
    cursor = index + raw.length;

    if (raw.startsWith('`') && raw.endsWith('`')) {
      chunks.push(coreWithStyles.fg!(palette.info)(raw.slice(1, -1)));
    } else if ((raw.startsWith('**') && raw.endsWith('**')) || (raw.startsWith('__') && raw.endsWith('__'))) {
      const inner = raw.slice(2, -2);
      const colored = coreWithStyles.fg!(baseColor)(inner);
      chunks.push(typeof coreWithStyles.bold === 'function' ? coreWithStyles.bold(colored) : colored);
    } else if (raw.startsWith('[')) {
      const linkText = raw.match(/^\[([^\]\n]+)\]\([^)]+\)$/)?.[1] ?? plainInlineMarkdown(raw);
      const colored = coreWithStyles.fg!(palette.info)(linkText);
      chunks.push(typeof coreWithStyles.underline === 'function' ? coreWithStyles.underline(colored) : colored);
    } else {
      const inner = raw.slice(1, -1);
      const colored = coreWithStyles.fg!(baseColor)(inner);
      chunks.push(typeof coreWithStyles.italic === 'function' ? coreWithStyles.italic(colored) : colored);
    }
  }

  pushPlain(text.slice(cursor));
  return new coreWithStyles.StyledText(chunks) as InstanceType<(typeof import('@opentui/core'))['StyledText']>;
}

function plainInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1');
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

  // Dispatch — compact orchestration header
  if (event.class === 'dispatch') {
    return renderDispatchCard(core, event, palette);
  }

  // Agent status — compact when running, full card when returned/failed
  if (event.class === 'agent_status') {
    return renderAgentStatusCard(core, event, palette);
  }

  if (event.class === 'thinking') {
    return renderThinkingCard(core, event, expanded, onToggleExpand, palette);
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

  // Determine if this should be a full bordered card or a compact row.
  const { artifact } = event;
  const isFullCard =
    ((event.class === 'tool_result' || event.class === 'result_error') && artifact.type === 'text') ||
    (event.class === 'prompt' && artifact.type === 'text') ||
    (event.class === 'error' && artifact.type === 'text') ||
    artifact.type === 'approval';

  if (!isFullCard) {
    // Compact row: just the color bar + content row, no border.
    return core.Box(
      {
        id: event.id,
        width: '100%',
        flexDirection: 'row',
        marginBottom: 1,
      },
      core.Box({ width: 1, minWidth: 1, marginRight: 1 }, core.Text({ content: ' ', fg: color })),
      core.Box({ ...CARD_BODY_LAYOUT, paddingY: 0 }, ...children),
    );
  }

  return core.Box(
    {
      id: event.id,
      width: '100%',
      flexDirection: 'row',
      marginBottom: 1,
    },
    core.Box({ width: 1, backgroundColor: color, marginRight: 1 }),
    core.Box(
      {
        ...CARD_BODY_LAYOUT,
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
    core.Box({ width: 1, backgroundColor: color, marginRight: 1 }),
    core.Box(
      {
        ...CARD_BODY_LAYOUT,
        flexDirection: 'column',
        border: true,
        borderStyle: 'single',
        borderColor: color,
        paddingX: 1,
        paddingY: 0,
      },
      core.Text({ ...FULL_WIDTH_TEXT, content: label, fg: color }),
      ...(detail ? [core.Text({ ...FULL_WIDTH_TEXT, content: detail, fg: pal.textAccent })] : []),
    ),
  );
}

function statusCardColor(label: string, palette: TuiPalette): string {
  if (label.startsWith('✗') || label.startsWith('x')) return palette.error;
  if (label.startsWith('✓')) return palette.success;
  if (label.startsWith('!')) return palette.warning;
  // Animated spinner (◐ ◓ ◑ ◒) / pulse (○ ◌ ●) glyphs for active states
  if (
    label.startsWith('$') ||
    label.startsWith('○') ||
    label.startsWith('◌') ||
    label.startsWith('●') ||
    label.startsWith('◐') ||
    label.startsWith('◓') ||
    label.startsWith('◑') ||
    label.startsWith('◒')
  ) {
    return palette.info;
  }
  if (label.startsWith('◉')) return palette.brand;
  return palette.info;
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
  const color = eventColor(eventClass, pal);

  // Full bordered cards only for: final results, prompts, errors, approvals.
  const isFullCard = (eventClass === 'tool_result' || eventClass === 'result_error') && payload.type === 'text';
  const isPromptCard = eventClass === 'prompt' && payload.type === 'text';
  const isErrorCard = eventClass === 'error' && payload.type === 'text';
  const isApprovalCard = payload.type === 'approval';
  const useFullCard = isFullCard || isPromptCard || isErrorCard || isApprovalCard;

  // Render compact band for everything else.
  if (!useFullCard) {
    return [renderCompactBand(core, payload, eventClass, pal, onToggle, expanded)];
  }

  if (payload.type === 'approval') {
    return [
      core.Text({ ...FULL_WIDTH_TEXT, content: payload.action, fg: pal.text }),
      core.Text({
        ...FULL_WIDTH_TEXT,
        content: `Risk: ${payload.details}   [${payload.riskLevel.toUpperCase()}]`,
        fg: riskColor(payload.riskLevel),
      }),
      core.Text({ ...FULL_WIDTH_TEXT, content: payload.choices.join('   '), fg: pal.textAccent }),
    ];
  }

  // Full-card text rendering.
  if ((eventClass === 'tool_result' || eventClass === 'result_error') && payload.type === 'text') {
    if (isDiagnosticTitle(payload.title)) {
      return renderDiagnosticCard(core, payload, eventClass, pal);
    }
    // Skip inner title when it duplicates the card crown (crown already shows "Result")
    const titleRows: OpenTuiNode[] =
      payload.title !== 'Result' ? [core.Text({ ...FULL_WIDTH_TEXT, content: payload.title, fg: color })] : [];
    return [
      ...titleRows,
      ...renderResultMarkdown(core, payload.body, pal),
      ...(event ? [renderResultStats(core, event, pal)] : []),
    ];
  }
  if (eventClass === 'prompt' && payload.type === 'text') {
    return textPayloadRows(core, payload.body, eventClass, expanded, pal);
  }
  // Error card: full bordered.
  return [
    core.Text({ ...FULL_WIDTH_TEXT, content: payload.title, fg: color }),
    ...textPayloadRows(core, payload.body, eventClass, expanded, pal),
    ...(eventClass === 'error'
      ? [actionText(core, '[Retry] [Skip] [Show raw]', pal.textAccent)]
      : [
          ...(isExpandableText(payload.body, eventClass, expanded)
            ? [actionText(core, '[Show full text]', pal.textAccent, onToggle)]
            : []),
          ...(expanded && isCollapsibleText(payload.body, eventClass)
            ? [actionText(core, '[Collapse text]', pal.textAccent, onToggle)]
            : []),
        ]),
  ];
}

/**
 * Render markdown content as styled OpenTUI Text nodes.
 * Handles headings, inline code, bold, lists, and blockquotes.
 */
function renderResultMarkdown(core: OpenTuiCore, body: string, palette: TuiPalette): OpenTuiNode[] {
  const nodes: OpenTuiNode[] = [];
  const lines = body.split('\n');
  let inCodeBlock = false;
  const codeBlockLines: string[] = [];

  for (let idx = 0; idx < lines.length; idx += 1) {
    const rawLine = lines[idx] ?? '';
    const line = rawLine.trimEnd();

    if (/^```/.test(line)) {
      if (inCodeBlock) {
        // Flush accumulated code block as a single box with padding
        if (codeBlockLines.length > 0) {
          nodes.push(
            core.Box(
              { paddingLeft: 2, flexDirection: 'column' },
              ...codeBlockLines.map((cl) => core.Text({ ...FULL_WIDTH_TEXT, content: cl, fg: palette.info })),
            ),
          );
          codeBlockLines.length = 0;
        }
        inCodeBlock = false;
        continue;
      }
      inCodeBlock = true;
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    if (isMarkdownTableRow(line) && isMarkdownTableSeparator(lines[idx + 1] ?? '')) {
      const tableRows: string[] = [line];
      idx += 2;
      while (idx < lines.length && isMarkdownTableRow(lines[idx] ?? '')) {
        tableRows.push((lines[idx] ?? '').trimEnd());
        idx += 1;
      }
      idx -= 1;
      nodes.push(...renderResultTable(core, tableRows, palette));
      continue;
    }

    // Headings
    const hMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (hMatch && hMatch[1] && hMatch[2]) {
      const level = hMatch[1].length;
      const text = plainInlineMarkdown(hMatch[2]);
      const hColor = level <= 2 ? palette.brand : palette.warning;
      nodes.push(core.Text({ ...FULL_WIDTH_TEXT, content: text, fg: hColor }));
      continue;
    }

    // Bullet lists
    const bMatch = line.match(/^\s*[-*+]\s+(.+)/);
    if (bMatch) {
      nodes.push(
        core.Text({
          ...FULL_WIDTH_TEXT,
          content: styledInlineMarkdown(core, `• ${bMatch[1]}`, palette),
          fg: palette.text,
        }),
      );
      continue;
    }

    // Numbered lists
    const nMatch = line.match(/^(\s*)(\d+\.)\s+(.+)/);
    if (nMatch) {
      nodes.push(
        core.Text({
          ...FULL_WIDTH_TEXT,
          content: styledInlineMarkdown(core, `${nMatch[1]}${nMatch[2]} ${nMatch[3]}`, palette),
          fg: palette.text,
        }),
      );
      continue;
    }

    // Blockquotes
    const qMatch = line.match(/^>\s?(.+)/);
    if (qMatch && qMatch[1]) {
      nodes.push(
        core.Text({
          ...FULL_WIDTH_TEXT,
          content: styledInlineMarkdown(core, qMatch[1], palette, palette.textMuted),
          fg: palette.textMuted,
        }),
      );
      continue;
    }

    // Empty lines
    if (!line.trim()) {
      nodes.push(core.Text({ ...FULL_WIDTH_TEXT, content: '', fg: palette.text }));
      continue;
    }

    nodes.push(core.Text({ ...FULL_WIDTH_TEXT, content: styledInlineMarkdown(core, line, palette), fg: palette.text }));
  }

  return nodes;
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.split('|').length >= 4;
}

function isMarkdownTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!isMarkdownTableRow(trimmed)) return false;
  return trimmed
    .slice(1, -1)
    .split('|')
    .every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

function renderResultTable(core: OpenTuiCore, rows: string[], palette: TuiPalette): OpenTuiNode[] {
  const parsed = rows.map((row) => tableCells(row).map(plainInlineMarkdown));
  const columnCount = Math.max(0, ...parsed.map((row) => row.length));
  if (columnCount === 0) return [];
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.min(28, Math.max(6, ...parsed.map((row) => visibleLength(row[column] ?? '')))),
  );
  return parsed.map((row, rowIndex) => {
    const content = widths
      .map((width, column) => {
        const value = row[column] ?? '';
        return visibleLength(value) > width ? value.slice(0, Math.max(0, width)) : value.padEnd(width, ' ');
      })
      .join('  ')
      .trimEnd();
    return core.Text({ ...FULL_WIDTH_TEXT, content, fg: rowIndex === 0 ? palette.brand : palette.text });
  });
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
  return visibleLines.map((line) => core.Text({ ...FULL_WIDTH_TEXT, content: line, fg }));
}

function isExpandableText(body: string, eventClass: SemanticEventClass, expanded: boolean): boolean {
  return !expanded && eventClass !== 'tool_result' && body.split('\n').length > TEXT_PREVIEW_LINES;
}

function isCollapsibleText(body: string, eventClass: SemanticEventClass): boolean {
  return eventClass !== 'tool_result' && body.split('\n').length > TEXT_PREVIEW_LINES;
}

function renderAutocompleteOverlay(
  core: OpenTuiCore,
  autocomplete: AutocompleteState | undefined,
  palette: TuiPalette,
  footerHeight: number,
): OpenTuiNode {
  const visible = autocomplete?.visible === true && autocomplete.items.length > 0;
  const allItems = autocomplete?.items ?? [];
  const selectedIndex = autocomplete?.selectedIndex ?? 0;
  const maxVisibleItems = Math.max(1, autocomplete?.maxVisibleItems ?? allItems.length);
  const windowSize = Math.min(allItems.length, maxVisibleItems);
  const windowStart = autocompleteWindowStart(selectedIndex, allItems.length, windowSize);
  const items = allItems.slice(windowStart, windowStart + windowSize);
  const rows: OpenTuiNode[] = [];
  for (let i = 0; i < AUTOCOMPLETE_MAX_ROWS; i++) {
    const item = items[i] ?? '';
    const absoluteIndex = windowStart + i;
    const isSelected = absoluteIndex === selectedIndex;
    rows.push(
      core.Text({
        id: `synax-ac-row-${i}`,
        content: item ? (isSelected ? `→ ${item}` : `  ${item}`) : '',
        fg: isSelected ? palette.brand : palette.textAccent,
        visible: i < items.length,
      }),
    );
  }
  return core.Box(
    {
      id: 'synax-autocomplete',
      visible,
      width: '100%',
      position: 'absolute',
      bottom: footerHeight,
      left: 0,
      zIndex: 50,
      flexDirection: 'column',
      border: ['top'],
      borderColor: palette.brand,
      backgroundColor: palette.background,
      paddingX: 2,
      paddingY: 0,
    },
    ...rows,
  );
}

function autocompleteWindowStart(selectedIndex: number, itemCount: number, windowSize: number): number {
  if (itemCount <= windowSize) return 0;
  const clampedSelected = Math.max(0, Math.min(selectedIndex, itemCount - 1));
  const halfWindow = Math.floor(windowSize / 2);
  return Math.max(0, Math.min(clampedSelected - halfWindow, itemCount - windowSize));
}

function renderEmptyState(
  core: OpenTuiCore,
  rail: ArtifactRailState,
  terminalWidth: number,
  footer: FooterState,
  palette?: TuiPalette,
  splash?: SplashOptions,
  modelPal?: ModelPalette,
  modelId?: string,
): OpenTuiNode {
  const pal = palette ?? getPalette();
  const width = Math.min(64, Math.max(42, terminalWidth - 8));
  const activeModel = modelId ?? rail.model ?? '';
  const visualProfile = resolveCoreVisualProfile(activeModel);
  const inner = width - 2;
  const railPrefix = ' │ ';
  const railInner = inner - 3;
  const model = rail.model ? clip(rail.model, Math.max(8, railInner - 12)) : 'local';
  const workspace = rail.cwd ? clip(rail.cwd, Math.max(8, railInner - 12)) : '~';
  const branch = rail.branch ? clip(rail.branch, railInner - 12) : '-';
  const context = rail.contextLabel
    ? clip(rail.contextLabel, railInner - 12)
    : `${rail.filesTouched.length} files loaded`;
  const stateLine = clip(footer.status.replace(/\.$/, '').toLowerCase() || 'ready', railInner - 12);
  const coreLines = renderAiCore('idle', (splash?.frame ?? 0) / 8, visualProfile).map(stripAnsi);
  const hr = '─'.repeat(Math.max(20, inner - 6));
  const tableLabelWidth = 10;

  return core.Box(
    {
      id: 'synax-empty-state',
      width,
      flexDirection: 'column',
      paddingX: 1,
      paddingY: 0,
    },
    // Title with horizontal rule
    core.Text({ content: centerText(`── synax ──${hr}`, inner), fg: pal.brand }),
    // Core morphology
    ...coreLines.map((line) =>
      core.Text({ content: centerText(line, inner), fg: modelPal?.primary ?? pal.textAccent }),
    ),
    core.Text({ content: '' }),
    // Metadata table with left rail
    core.Text({
      content: `${railPrefix}${'model'.padEnd(tableLabelWidth)}${model}`,
      fg: pal.textMuted,
    }),
    core.Text({
      content: `${railPrefix}${'workspace'.padEnd(tableLabelWidth)}${workspace}`,
      fg: pal.textMuted,
    }),
    core.Text({
      content: `${railPrefix}${'branch'.padEnd(tableLabelWidth)}${branch}`,
      fg: pal.textMuted,
    }),
    core.Text({
      content: `${railPrefix}${'context'.padEnd(tableLabelWidth)}${context}`,
      fg: pal.textMuted,
    }),
    core.Text({
      content: `${railPrefix}${'state'.padEnd(tableLabelWidth)}${stateLine}`,
      fg: pal.textAccent,
    }),
  );
}

function compactEmptyStateHeight(rail: ArtifactRailState): number {
  void rail;
  return 22;
}

function centerText(text: string, width: number): string {
  const visible = visibleLength(text);
  if (visible >= width) return text;
  return `${' '.repeat(Math.floor((width - visible) / 2))}${text}`;
}

function labelFor(eventClass: SemanticEventClass): string {
  if (eventClass === 'assistant_text') return 'Note';
  if (eventClass === 'tool_result' || eventClass === 'result_error') return 'Result';
  return eventClass.replace(/_/g, ' ').replace(/^\w/, (char) => char.toUpperCase());
}

export function formatEventCrown(eventClass: SemanticEventClass): string {
  const label = labelFor(eventClass);
  // Bold the label portion for visual prominence
  return `  ${GLYPHS[eventClass]}  \u001b[1m${label}\u001b[0m  `;
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

const ANSI_PATTERN = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function actionText(core: OpenTuiCore, content: string, fg: string, onToggle?: () => void): OpenTuiNode {
  return core.Text({
    ...FULL_WIDTH_TEXT,
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

function riskColor(risk: RiskLevel): string {
  if (risk === 'high') return '#ff5555';
  if (risk === 'medium') return '#ffb86c';
  return '#00ff87';
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, Math.max(0, width));
}

// ─── Diagnostic slash-command compact card rendering ────────────────────────

/** Titles that should render as compact diagnostic bands instead of full cards. */
const DIAGNOSTIC_TITLES = new Set([
  'Provider Ready',
  'Provider Check Failed',
  'Provider Degraded',
  'Provider Check',
  'Command',
]);

function isDiagnosticTitle(title: string): boolean {
  return DIAGNOSTIC_TITLES.has(title);
}

/** Render a single-line compact band for non-essential artifacts. */
function renderCompactBand(
  core: OpenTuiCore,
  payload: ArtifactPayload,
  eventClass: SemanticEventClass,
  palette: TuiPalette,
  _onToggle?: () => void,
  expanded?: boolean,
): OpenTuiNode {
  const glyph = GLYPHS[eventClass] ?? '·';
  const color = eventColor(eventClass, palette);

  if (payload.type === 'plan') {
    return core.Text({
      ...FULL_WIDTH_TEXT,
      content: `${glyph} ${payload.title}`,
      fg: color,
    });
  }
  if (payload.type === 'edit') {
    return core.Text({
      ...FULL_WIDTH_TEXT,
      content: `${glyph} ${payload.file}   +${payload.linesAdded} ~${payload.linesModified} -${payload.linesRemoved}   ${payload.summary.slice(0, 50)}`,
      fg: color,
    });
  }
  if (payload.type === 'diff') {
    const countLabel =
      payload.hunks.length > HUNK_PREVIEW_LINES && !expanded
        ? ` [${payload.hunks.length - HUNK_PREVIEW_LINES} more]`
        : '';
    return core.Text({
      ...FULL_WIDTH_TEXT,
      content: `${glyph} ${payload.file}${countLabel}`,
      fg: color,
    });
  }
  if (payload.type === 'command') {
    const status = payload.exitCode === undefined ? '' : payload.exitCode === 0 ? ' ok' : ` exit ${payload.exitCode}`;
    return core.Text({
      ...FULL_WIDTH_TEXT,
      content: `${glyph} ${(payload.command || 'command').slice(0, 60)}${status}`,
      fg: payload.exitCode && payload.exitCode !== 0 ? palette.error : color,
    });
  }
  if (payload.type === 'tool_result') {
    return core.Text({
      ...FULL_WIDTH_TEXT,
      content: `${glyph} ${payload.summary || payload.title}`,
      fg: payload.status === 'error' ? palette.error : palette.text,
    });
  }
  if (payload.type === 'commit') {
    return core.Text({
      ...FULL_WIDTH_TEXT,
      content: `${glyph} ${payload.message.slice(0, 70)}`,
      fg: color,
    });
  }
  if (payload.type === 'checkpoint') {
    return core.Text({
      ...FULL_WIDTH_TEXT,
      content: `${glyph} ${payload.title}   ${payload.hash ?? ''}`,
      fg: color,
    });
  }
  if (payload.type === 'status') {
    return core.Text({
      ...FULL_WIDTH_TEXT,
      content: payload.label,
      fg: color,
    });
  }
  // Default compact band for any other payload.
  return core.Text({
    ...FULL_WIDTH_TEXT,
    content: `${glyph} ${payload.type}`,
    fg: palette.textMuted,
  });
}

/** Render a compact stats line for result cards (Duration / Files / Commands). */
function renderResultStats(core: OpenTuiCore, event: SemanticEvent, palette: TuiPalette): OpenTuiNode {
  const parts: string[] = [];
  if (event.metadata.duration !== undefined) {
    const s =
      event.metadata.duration >= 1000
        ? `${(event.metadata.duration / 1000).toFixed(0)}s`
        : `${event.metadata.duration}ms`;
    parts.push(`Duration ${s}`);
  }
  const fileCount = event.metadata.filesTouched?.length;
  if (fileCount && fileCount > 0) parts.push(`Touched files: ${fileCount}`);
  // Commands count is not tracked directly — approximate from file count.
  if (parts.length > 0) {
    return core.Text({ ...FULL_WIDTH_TEXT, content: parts.join('   '), fg: palette.textAccent });
  }
  return core.Text({ ...FULL_WIDTH_TEXT, content: '', fg: palette.textAccent });
}

/** Render a compact horizontal diagnostic band for slash command output.
 *  Uses a single status-line approach: colored title + first meaningful line. */
function renderDiagnosticCard(
  core: OpenTuiCore,
  payload: { type: 'text'; title: string; body: string },
  eventClass: SemanticEventClass,
  palette: TuiPalette,
): OpenTuiNode[] {
  const color =
    eventClass === 'tool_result' ? palette.success : eventClass === 'result_error' ? palette.error : palette.info;

  // Extract a compact summary: first non-empty non-header line.
  const lines = payload.body.split('\n').filter((l) => l.trim().length > 0);
  const summaryLine =
    lines.find(
      (l) =>
        !l.startsWith('Status:') &&
        !l.startsWith('Profile:') &&
        !l.startsWith('-') &&
        !l.startsWith('=') &&
        !l.startsWith('Provider') &&
        !l.startsWith('Checks'),
    ) ??
    lines[1] ??
    payload.title;
  const summary = summaryLine.length > 80 ? `${summaryLine.slice(0, 77)}...` : summaryLine;

  return [
    core.Text({ ...FULL_WIDTH_TEXT, content: `${payload.title}  —  ${summary}`, fg: color }),
    ...(lines.length > 2
      ? [core.Text({ ...FULL_WIDTH_TEXT, content: `[${lines.length - 1} lines of detail]`, fg: palette.textAccent })]
      : []),
  ];
}

// ─── Orchestration dispatch card ────────────────────────────────────────────

/** Compact dispatch header for orchestration start. */
function renderDispatchCard(core: OpenTuiCore, event: SemanticEvent, palette?: TuiPalette): OpenTuiNode {
  const pal = palette ?? getPalette();
  const color = eventColor('dispatch', pal);
  const payload = event.artifact;
  const title = payload.type === 'text' ? payload.title : '';
  const bodyLines = payload.type === 'text' ? payload.body.split('\n').filter(Boolean) : [];

  return core.Box(
    {
      id: event.id,
      width: '100%',
      flexDirection: 'row',
      marginBottom: 0,
    },
    core.Box({ width: 1, minWidth: 1, marginRight: 1 }, core.Text({ content: ' ', fg: color })),
    core.Box(
      { ...CARD_BODY_LAYOUT, flexDirection: 'column', paddingY: 0 },
      core.Text({ ...FULL_WIDTH_TEXT, content: `◇ ${title}`, fg: color }),
      ...bodyLines.map((line) => core.Text({ ...FULL_WIDTH_TEXT, content: `  ${line}`, fg: pal.textAccent })),
    ),
  );
}

// ─── Agent status card ──────────────────────────────────────────────────────

/** Agent status: compact band while running, full bordered card on return/failure. */
function renderAgentStatusCard(core: OpenTuiCore, event: SemanticEvent, palette?: TuiPalette): OpenTuiNode {
  const pal = palette ?? getPalette();
  const payload = event.artifact;
  const name = payload.type === 'text' ? payload.title : 'agent';
  const body = payload.type === 'text' ? payload.body : '';

  // Running: compact band
  if (body === 'running') {
    const color = pal.info;
    return core.Box(
      {
        id: event.id,
        width: '100%',
        flexDirection: 'row',
        marginBottom: 0,
      },
      core.Box({ width: 1, minWidth: 1, marginRight: 1 }, core.Text({ content: ' ', fg: color })),
      core.Box(
        { ...CARD_BODY_LAYOUT, paddingY: 0 },
        core.Text({ ...FULL_WIDTH_TEXT, content: `◈ ${name} · running`, fg: color }),
      ),
    );
  }

  // Failed: full error card
  if (body.startsWith('Failed:')) {
    const color = pal.error;
    return core.Box(
      {
        id: event.id,
        width: '100%',
        flexDirection: 'row',
        marginBottom: 1,
      },
      core.Box({ width: 1, backgroundColor: color, marginRight: 1 }),
      core.Box(
        {
          ...CARD_BODY_LAYOUT,
          flexDirection: 'column',
          border: true,
          borderStyle: 'single',
          borderColor: color,
          title: `  ×  ${name}  `,
          paddingX: 1,
          paddingY: 0,
        },
        core.Text({ ...FULL_WIDTH_TEXT, content: body, fg: color }),
      ),
    );
  }

  // Completed: full bordered result card — use info/cyan for intermediate child results
  const color = pal.info;
  const toolCalls = event.metadata.toolCalls ?? 0;
  const filesCount = event.metadata.filesTouched?.length ?? 0;
  const statsParts: string[] = [];
  if (toolCalls > 0) statsParts.push(`Calls ${toolCalls}`);
  if (filesCount > 0) statsParts.push(`Files touched: ${filesCount}`);

  return core.Box(
    {
      id: event.id,
      width: '100%',
      flexDirection: 'row',
      marginBottom: 1,
    },
    core.Box({ width: 1, backgroundColor: color, marginRight: 1 }),
    core.Box(
      {
        ...CARD_BODY_LAYOUT,
        flexDirection: 'column',
        border: true,
        borderStyle: 'single',
        borderColor: color,
        title: `  ✓  ${name}  `,
        paddingX: 1,
        paddingY: 0,
      },
      core.Text({
        ...FULL_WIDTH_TEXT,
        content: statsParts.length > 0 ? statsParts.join(' · ') : '',
        fg: pal.textAccent,
      }),
      ...(body.trim()
        ? renderResultMarkdown(core, body, pal)
        : [core.Text({ ...FULL_WIDTH_TEXT, content: '(no output)', fg: pal.textMuted })]),
    ),
  );
}

function renderThinkingCard(
  core: OpenTuiCore,
  event: SemanticEvent,
  expanded = false,
  onToggleExpand?: (id: string) => void,
  palette?: TuiPalette,
): OpenTuiNode {
  const pal = palette ?? getPalette();
  const payload = event.artifact;
  const title = payload.type === 'text' ? payload.title : 'Thinking';
  const body = payload.type === 'text' ? payload.body : '';
  const active = /^thinking/i.test(title);
  const color = active ? pal.semantic.thinking : pal.textAccent;
  const normalized = normalizeThinkingText(body);
  const bodyLines = normalized.split('\n').filter((line) => line.trim().length > 0);
  const preview = thinkingPreview(normalized);
  const shown = expanded ? bodyLines : [preview];
  const eventId = event.id;

  return core.Box(
    {
      id: event.id,
      width: '100%',
      flexDirection: 'row',
      marginBottom: 1,
    },
    core.Box({ width: 1, backgroundColor: color, marginRight: 1 }),
    core.Box(
      {
        ...CARD_BODY_LAYOUT,
        flexDirection: 'column',
        border: true,
        borderStyle: 'single',
        borderColor: color,
        title: `  ◌  ${title}  `,
        paddingX: 1,
        paddingY: 0,
      },
      core.Text({
        ...FULL_WIDTH_TEXT,
        content: active && !expanded ? shimmerThinkingLine(preview) : (shown[0] ?? preview),
        fg: pal.textMuted,
        onMouseDown: (mouseEvent: { stopPropagation?: () => void; preventDefault?: () => void }) => {
          mouseEvent.stopPropagation?.();
          mouseEvent.preventDefault?.();
          onToggleExpand?.(eventId);
        },
      }),
      ...(expanded
        ? shown.slice(1).map((line) =>
            core.Text({
              ...FULL_WIDTH_TEXT,
              content: line,
              fg: pal.textMuted,
            }),
          )
        : [core.Text({ ...FULL_WIDTH_TEXT, content: '[Ctrl+O expand]', fg: pal.textAccent })]),
    ),
  );
}

function shimmerThinkingLine(text: string): string {
  return `◇ ${text}`;
}

function normalizeThinkingText(text: string): string {
  return stripToolCallMarkup(text)
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .trim();
}

function thinkingPreview(text: string): string {
  if (!text) return 'waiting for reasoning tokens';
  const maxLength = 120;
  return text.length > maxLength ? text.slice(0, maxLength).trimEnd() : text;
}
