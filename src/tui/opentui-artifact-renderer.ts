import type { TuiPalette } from './theme';
import { getPalette } from './theme';
import type { ArtifactPayload, RiskLevel, SemanticEvent, SemanticEventClass } from './semantic-events';
import { tuiStats } from './telemetry';
import pkg from '../../package.json';

const VERSION = pkg.version;
import { visibleLength, wordWrapLines } from './text-utils';
import type { ModelPalette } from './model-palette';
import { getModelPalette } from './model-palette';
import { stripToolCallMarkup } from './markup-sanitizer';
import {
  PERSISTENT_STATUS_CARD_ID,
  ACTIVITY_LINE_ID,
  ACTIVITY_GLYPH_ID,
  ACTIVITY_TEXT_ID,
  AUTOCOMPLETE_MAX_ROWS,
} from './tui-constants';
import { tokenStreamFrameText } from './token-stream';

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

/**
 * Build a shaded card body: an accent-bar + a background-shaded column with an
 * optional plain-text crown header. Uses no box-drawing glyphs so terminal copy
 * yields clean text (better cross-platform compatibility, lower token bloat).
 */
function shadedCard(
  core: OpenTuiCore,
  id: string,
  color: string,
  pal: TuiPalette,
  crown: string | null,
  children: OpenTuiNode[],
  marginBottom = 1,
): OpenTuiNode {
  const header = crown ? [core.Text({ ...FULL_WIDTH_TEXT, content: crown, fg: color })] : [];
  return core.Box(
    {
      id,
      width: '100%',
      flexDirection: 'row',
      marginBottom,
    },
    core.Box({ width: 1, backgroundColor: color, marginRight: 1 }),
    core.Box(
      {
        ...CARD_BODY_LAYOUT,
        flexDirection: 'column',
        backgroundColor: pal.surface,
        paddingX: 1,
        paddingY: 0,
      },
      ...header,
      ...children,
    ),
  );
}

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
  /** Context usage bar shown below the prompt input. */
  contextInfo?: string;
}

export interface AutocompleteState {
  visible: boolean;
  items: string[];
  selectedIndex: number;
  maxVisibleItems?: number;
}

export interface SplashOptions {
  frame: number;
  color?: boolean;
}

export function footerLayoutHeight(footer: FooterState, infoLineCount = 0): number {
  const inputHeight = footer.inputHeight ?? promptInputHeight(footer.prompt);
  const inputFrameHeight = inputHeight + 2;
  // Slash-info panel renders inside the footer above the input: its lines
  // (capped at 14) plus a bottom border row.
  const infoPanelHeight = infoLineCount > 0 ? Math.min(infoLineCount, 14) + 1 : 0;
  // Context bar node always exists (may be empty); accounts for 1 row.
  return inputFrameHeight + 2 + infoPanelHeight + 1;
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
  const inputHeightEarly = footer.inputHeight ?? promptInputHeight(footer.prompt);
  // Pre-wrap slash-info lines so the physical row count matches footer layout
  // height exactly (previously the height counted logical lines while
  // Text wrapMode produced more visual rows, causing overlap and garbled text).
  const wrapWidth = typeof terminalWidth === 'number' ? Math.max(1, terminalWidth - 2) : undefined;
  const wrappedInfoLines: string[] = [];
  if (infoLines) {
    for (const line of infoLines.slice(0, 14)) {
      const parts = wrapWidth ? wordWrapLines(line, wrapWidth) : [line];
      wrappedInfoLines.push(...parts);
    }
  }
  const infoRowCount = Math.min(wrappedInfoLines.length, 14);
  const footerHeightEarly = footerLayoutHeight(footer, infoRowCount);

  // Always use the full flexible layout so splash→transcript transitions
  // are handled incrementally by the feed model, avoiding a full tree
  // destroy+rebuild that causes visible flicker.

  // Keep the session start info as the first transcript card so you can
  // scroll up and see what model, workspace, and Synax version you started
  // with — even after the splash screen disappears.
  const sessionHeaderCard = events.length > 0 ? [renderSessionHeaderCard(core, rail, modelId, modelPal, pal)] : [];

  const mainChildren =
    events.length > 0
      ? [...sessionHeaderCard, ...events.map((event) => renderArtifactCard(core, event, pal))]
      : [renderEmptyState(core, rail, terminalWidth, terminalHeight, footer, pal, splash, modelPal, modelId)];
  const inputHeight = inputHeightEarly;
  const inputFrameHeight = inputHeight + 2;
  const footerHeight = footerHeightEarly;
  const rootHeight = terminalHeight ?? '100%';
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
    cursorStyle: { style: 'block', blinking: false },
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
    },
    core.Box(
      { flexGrow: 1, flexDirection: 'row', minHeight: 1, overflow: 'hidden' },
      core.ScrollBox(
        {
          id: 'synax-artifacts',
          flexGrow: 1,
          overflow: 'hidden',
          viewportCulling: true,
          stickyScroll: true,
          stickyStart: 'bottom',
          padding: 1,
          // Hide the vertical scrollbar — with stickyScroll locked to
          // the bottom, a scrollbar is just visual noise. At worst it
          // paints block-char columns over the right edge of result cards.
          verticalScrollbarOptions: { visible: false } as Record<string, unknown>,
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
      },
      core.Text({ id: ACTIVITY_GLYPH_ID, content: '', width: 11 }),
      core.Text({ id: ACTIVITY_TEXT_ID, content: 'Ready.', fg: pal.textAccent }),
    ),
    ...(settingsLines && settingsLines.length > 0
      ? [renderSettingsOverlay(core, settingsLines, pal, settingsActiveLabel, terminalHeight, terminalWidth)]
      : []),
    renderAutocompleteOverlay(core, autocomplete, pal, footerHeight),
    core.Box(
      {
        id: 'synax-footer',
        width: '100%',
        height: footerHeightEarly,
        flexDirection: 'column',
        border: ['top'],
        borderColor: pal.border,
        overflow: 'hidden',
        zIndex: 20,
        paddingX: 1,
      },
      ...(wrappedInfoLines.length > 0 ? [renderSlashInfoPanel(core, wrappedInfoLines, pal)] : []),
      core.Box(
        {
          id: 'synax-input-frame',
          width: '100%',
          height: inputFrameHeight,
          flexDirection: 'row',
          overflow: 'hidden',
          backgroundColor: pal.surface,
          paddingX: 1,
          paddingY: 1,
        },
        core.Text({ content: '> ', fg: pal.textMuted, width: 2 }),
        core.Box({ flexGrow: 1 }, input),
      ),
      core.Text({ id: 'synax-hints', content: footer.hints, fg: pal.textAccent }),
      core.Text({ id: 'synax-context-bar', content: footer.contextInfo ?? '', fg: pal.textMuted }),
    ),
  );
}

function renderSettingsOverlay(
  core: OpenTuiCore,
  lines: string[],
  palette: TuiPalette,
  activeLabel?: string,
  terminalHeight?: number,
  terminalWidth?: number,
): OpenTuiNode {
  const overlayHeight = terminalHeight ?? '100%';
  const backingLineCount = typeof terminalHeight === 'number' ? Math.max(0, terminalHeight - lines.length) : 0;
  // The full-screen backing uses the app background (not the surface color)
  // so the settings screen matches the rest of the TUI instead of painting
  // the whole terminal a solid grey block.
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
    },
    ...lines.map((line, index) =>
      core.Box(
        {
          id: `synax-settings-row-${index}`,
          width: '100%',
          height: 1,
        },
        core.Text({
          id: `synax-settings-line-${index}`,
          content: settingsOverlayLineContent(core, line, index, activeLabel, palette, terminalWidth),
          fg: palette.text,
        }),
      ),
    ),
    ...Array.from({ length: backingLineCount }, (_, index) =>
      core.Box(
        {
          id: `synax-settings-backdrop-${index}`,
          width: '100%',
          height: 1,
        },
        // Solid app-background fill so the transcript behind the overlay
        // does not bleed through below the modal frame.
        core.Text({
          content: solidBgLine(core, ' '.repeat(Math.max(0, terminalWidth ?? 0)), palette),
          fg: palette.text,
        }),
      ),
    ),
  );
}

/**
 * Styled content for one settings/resume overlay line. Pads the line to the
 * full terminal width so the solid background fill covers the whole row —
 * otherwise the transcript behind the overlay bleeds through to the right
 * of the modal frame. Exported so the live render path can update overlay
 * lines in place (no full tree rebuild, no flicker) during navigation.
 */
export function settingsOverlayLineContent(
  core: OpenTuiCore,
  line: string,
  index: number,
  activeLabel: string | undefined,
  palette: TuiPalette,
  terminalWidth?: number,
): string | InstanceType<(typeof import('@opentui/core'))['StyledText']> {
  const padded =
    typeof terminalWidth === 'number' && terminalWidth > line.length
      ? line + ' '.repeat(terminalWidth - line.length)
      : line;
  return index === 1 && activeLabel
    ? styledActiveSettingsLine(core, padded, activeLabel, palette)
    : solidBgLine(core, padded, palette);
}

/** Render slash-command info as a panel inside the footer, above the input. */
function renderSlashInfoPanel(core: OpenTuiCore, lines: string[], palette: TuiPalette): OpenTuiNode {
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
    ...lines.map((line) => {
      // Solid surface-fill background behind every character cell so the
      // ScrollBox content doesn't bleed through transparent space cells.
      const styled = line
        ? new core.StyledText([core.bg(palette.surface)(core.fg(palette.textAccent)(line))] as any)
        : ' ';
      return core.Text({ content: styled as any, fg: palette.textAccent });
    }),
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
    core.bg(palette.background)(core.fg(palette.text)(before)),
    core.bg(palette.text)(core.fg(palette.background)(active)),
    core.bg(palette.background)(core.fg(palette.text)(after)),
  ] as any);
}

/** Wrap a plain-text line in a StyledText with a solid app-background fill. */
function solidBgLine(
  core: OpenTuiCore,
  line: string,
  palette: TuiPalette,
): string | InstanceType<(typeof import('@opentui/core'))['StyledText']> {
  try {
    return new core.StyledText([core.bg(palette.background)(core.fg(palette.text)(line))] as any);
  } catch {
    return line;
  }
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

export function renderArtifactCard(core: OpenTuiCore, event: SemanticEvent, palette?: TuiPalette): OpenTuiNode {
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
    return renderThinkingCard(core, event, palette);
  }

  // Checkpoint — full-width visible divider
  if (event.class === 'checkpoint') {
    return renderCheckpointDivider(core, event, palette);
  }

  const pal = palette ?? getPalette();
  // Prompts are the user's anchor when scrolling a long transcript — use
  // the bright brand color instead of the muted semantic grey so they
  // stand out from thinking/result cards.
  const color = event.class === 'prompt' ? pal.brand : eventColor(event.class, pal);
  const children = renderPayloadRows(core, event.artifact, event.class, event, pal);
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
      core.Box({ ...CARD_BODY_LAYOUT, paddingX: 1, paddingY: 0 }, ...children),
    );
  }

  return shadedCard(core, event.id, color, pal, formatEventCrown(event.class), children);
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

  return shadedCard(core, event.id, color, pal, null, [
    core.Text({ ...FULL_WIDTH_TEXT, content: label, fg: color }),
    ...(detail ? [core.Text({ ...FULL_WIDTH_TEXT, content: detail, fg: pal.textAccent })] : []),
  ]);
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
    const nodes = [renderCompactBand(core, payload, eventClass, pal)];
    // Shell commands carry stdout / stderr in the payload — surface it below the band.
    if (eventClass === 'command' && payload.type === 'command') {
      const output = [payload.stdout?.trimEnd(), payload.stderr?.trimEnd()].filter(Boolean).join('\n');
      if (output) {
        nodes.push(core.Text({ ...FULL_WIDTH_TEXT, content: output, fg: pal.text }));
      }
    }
    return nodes;
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
    const titleRows: OpenTuiNode[] =
      payload.title !== 'Result' ? [core.Text({ ...FULL_WIDTH_TEXT, content: payload.title, fg: color })] : [];
    const resultLines = renderResultMarkdown(core, payload.body, pal);
    return [...titleRows, ...resultLines, ...(event ? [renderResultStats(core, event, pal)] : [])];
  }
  if (eventClass === 'prompt' && payload.type === 'text') {
    return textPayloadRows(core, payload.body, eventClass, pal);
  }
  // (prompt body brightness is handled inside textPayloadRows)
  // Error card: full bordered.
  return [
    core.Text({ ...FULL_WIDTH_TEXT, content: payload.title, fg: color }),
    ...textPayloadRows(core, payload.body, eventClass, pal),
    ...(eventClass === 'error' ? [actionText(core, '[Retry] [Skip] [Show raw]', pal.textAccent)] : []),
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
  palette: TuiPalette,
): OpenTuiNode[] {
  const lines = body.split('\n');
  // Prompt bodies render at full text brightness so the user's own words
  // are the easiest thing to spot when scanning a giant transcript.
  const fg = eventClass === 'prompt' ? palette.text : palette.textMuted;
  return lines.map((line) => core.Text({ ...FULL_WIDTH_TEXT, content: line, fg }));
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
        ...FULL_WIDTH_TEXT,
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
      // Solid background: without this the absolutely-positioned dropdown is
      // transparent and the transcript bleeds through, making it unreadable.
      backgroundColor: palette.surface,
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

/**
 * Render a session-start card as the first transcript entry so you can
 * scroll up and see which model, workspace, and Synax version you started
 * with — even after the splash screen disappears.
 */
function renderSessionHeaderCard(
  core: OpenTuiCore,
  rail: ArtifactRailState,
  modelId?: string,
  modelPal?: ModelPalette,
  palette?: TuiPalette,
): OpenTuiNode {
  const pal = palette ?? getPalette();
  const mp = modelPal ?? getModelPalette(modelId ?? rail.model ?? '');
  const model = modelId ?? rail.model ?? 'local';
  const provider = rail.provider ?? '-';
  const cwd = rail.cwd ?? '~';
  const branch = rail.branch ?? '-';
  const versionLabel = `synax v${VERSION}`;
  // Bold-white title with the model family's accent palette shimmering
  // across the brand name (same palette as the splash screen).
  const accents = mp.splashAccents;
  const titleText = `${versionLabel}`;
  let titleContent: string | unknown = titleText;
  try {
    const StyledText = (core as any).StyledText as new (chunks: unknown[]) => unknown;
    const boldMod = (core as any).bold as () => (s: string) => unknown;
    const chunks: unknown[] = [];
    for (let i = 0; i < titleText.length; i++) {
      const color = accents[i % accents.length];
      const styled = (core as any).fg(color)(titleText[i]);
      chunks.push(boldMod ? boldMod()(styled) : styled);
    }
    titleContent = new StyledText(chunks);
  } catch {
    /* fallback: plain text */
  }
  const lines = [`${model}  ·  ${provider}`, `workspace  ${cwd}`, `branch     ${branch}`];
  return core.Box(
    {
      id: 'synax-session-header',
      width: '100%',
      flexDirection: 'column',
      marginBottom: 1,
      border: ['left'],
      borderColor: mp.primary,
      paddingX: 1,
    },
    core.Text({ content: titleContent as any, fg: pal.text }),
    ...lines.map((line) => core.Text({ content: line, fg: pal.textMuted })),
  );
}

function renderEmptyState(
  core: OpenTuiCore,
  rail: ArtifactRailState,
  terminalWidth: number,
  terminalHeight: number | undefined,
  _footer: FooterState,
  palette?: TuiPalette,
  splash?: SplashOptions,
  modelPal?: ModelPalette,
  modelId?: string,
): OpenTuiNode {
  const pal = palette ?? getPalette();
  const mp = modelPal ?? getModelPalette(modelId ?? rail.model ?? '');
  const frame = splash?.frame ?? 0;
  // Match the session message block width — discrete card, no fill.
  const width = Math.max(20, Math.min(64, terminalWidth - 2));
  const inner = Math.max(12, width - 2); // 2px paddingX
  const narrow = inner < 36;
  // Absolute centering on both axes so the splash card sits dead-center
  // on ultrawide displays instead of pinning top-left.  Cap the top
  // offset so the card doesn't drift into dead space on short terminals
  // (tmux splits, narrow viewports).
  const left = Math.max(0, Math.floor((terminalWidth - width) / 2));
  const cardRows = 10; // token-stream (3) + gaps (2) + model (1) + sep (1) + meta (1) + paddingY (2)
  const top =
    typeof terminalHeight === 'number' ? Math.min(3, Math.max(0, Math.floor((terminalHeight - cardRows) / 2))) : 1;

  const model = middleEllipsis(rail.model ?? 'local', inner);
  const provider = rail.provider ?? '-';
  const branch = rail.branch ?? '-';
  const context = rail.contextLabel ?? `${rail.filesTouched.length} files`;

  const family = mp.family;
  const rowWide = (f: number): string => {
    const spaced = [...tokenStreamFrameText(family, f)].join(' ');
    return spaced.length <= inner ? spaced : tokenStreamFrameText(family, f);
  };
  const rowDense = (f: number): string => tokenStreamFrameText(family, f);
  const sep = '─'.repeat(Math.max(4, Math.min(28, inner)));

  return core.Box(
    {
      id: 'synax-empty-state',
      position: 'absolute',
      top,
      left,
      width,
      flexDirection: 'column',
      backgroundColor: pal.surface,
      paddingX: 1,
      paddingY: 1,
    },
    // Token-stream rows — staggered spacing; collapse to one row when narrow
    ...(narrow
      ? [core.Text({ content: centerText(rowDense(frame + 1), inner), fg: mp.accent })]
      : [
          core.Text({ content: centerText(rowWide(frame), inner), fg: mp.primary }),
          core.Text({ content: centerText(rowDense(frame + 1), inner), fg: mp.accent }),
          core.Text({ content: centerText(rowWide(frame + 2), inner), fg: mp.secondary }),
        ]),
    // Gap — visually anchor the model name below the logo
    core.Text({ content: '' }),
    core.Text({ content: '' }),
    // Model name (middle-ellipsized for long GGUF filenames)
    core.Text({ content: centerText(model, inner), fg: pal.text }),
    // Thin separator
    core.Text({ content: centerText(sep, inner), fg: pal.border }),
    // Metadata row with green-colored branch; segments drop when narrow
    buildSplashMeta(core, pal, provider, branch, context, inner),
  );
}

function buildSplashMeta(
  core: OpenTuiCore,
  pal: TuiPalette,
  provider: string,
  branch: string,
  context: string,
  inner: number,
): OpenTuiNode {
  // Drop segments right-to-left until the row fits the card — keeps the
  // splash legible in narrow panes instead of overflowing the frame.
  let sep = '  ·  ';
  let segments: Array<{ text: string; kind: 'muted' | 'branch' }> = [
    { text: provider, kind: 'muted' },
    { text: branch, kind: 'branch' },
    { text: context, kind: 'muted' },
  ];
  const rowText = (): string => segments.map((s) => s.text).join(sep);
  if (rowText().length > inner) sep = ' · ';
  while (segments.length > 1 && rowText().length > inner) {
    segments = segments.slice(0, -1);
  }
  const baseStr = rowText();
  const padding = Math.max(0, Math.floor((inner - visibleLength(baseStr)) / 2));
  const spacer = ' '.repeat(padding);
  // Use StyledText for a mixed-color metadata row so the branch appears green
  try {
    const StyledTextCtor = (core as any).StyledText as (new (chunks: unknown[]) => unknown) | undefined;
    const fgFn = (core as any).fg as ((color: string) => (text: string) => unknown) | undefined;
    if (StyledTextCtor && fgFn) {
      const chunks: unknown[] = [fgFn(pal.textMuted)(spacer)];
      segments.forEach((segment, index) => {
        if (index > 0) chunks.push(fgFn(pal.textMuted)(sep));
        chunks.push(fgFn(segment.kind === 'branch' ? pal.success : pal.textMuted)(segment.text));
      });
      const styled = new StyledTextCtor(chunks);
      return core.Text({ content: styled as any, width: '100%' });
    }
  } catch {
    // fallback: single-color row
  }
  return core.Text({
    content: spacer + baseStr,
    fg: pal.textMuted,
    width: '100%',
  });
}

/** Clip long names (e.g. GGUF filenames) from the middle, preserving the
 *  distinctive start and the quant/extension suffix. */
function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${tail > 0 ? text.slice(-tail) : ''}`;
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
  return `${GLYPHS[eventClass]}  ${label}`;
}

export function promptInputHeight(prompt: string, terminalWidth = 80): number {
  const wrapColumns = Math.max(16, terminalWidth - 6);
  const text = stripAnsi(prompt);
  // Empty prompt still needs 1 line for the placeholder/cursor.
  if (text.length === 0) return 1;
  const explicitLines = text.split('\n');
  const visualLines = explicitLines.reduce((count, line) => {
    if (line.length === 0) return count + 1;
    // Simulate word-wrapping to match OpenTUI TextareaRenderable wrapMode: 'word'.
    // Breaks at word boundaries when the accumulated width exceeds wrapColumns.
    // Words that are themselves longer than wrapColumns are force-broken.
    const words = line.split(/ +/);
    let currentLen = 0;
    let lineCount = 0;
    for (const word of words) {
      if (word.length === 0) continue;
      const space = currentLen === 0 ? 0 : 1;
      if (currentLen + space + word.length <= wrapColumns) {
        // Word fits on current visual line.
        currentLen += space + word.length;
      } else {
        // Word does not fit; start a new visual line.
        lineCount++;
        if (word.length > wrapColumns) {
          // Word is longer than the wrap width — force-break it across
          // ceil(word.length / wrapColumns) visual lines.
          const extraLines = Math.floor(word.length / wrapColumns);
          lineCount += extraLines - 1; // -1 because we already counted 1 above
          currentLen = word.length % wrapColumns;
          if (currentLen === 0 && extraLines > 0) {
            // Exact multiple: last full line has no remainder.
            currentLen = 0;
          }
        } else {
          currentLen = word.length;
        }
      }
    }
    if (currentLen > 0) lineCount++;
    return count + Math.max(1, lineCount);
  }, 0);
  return Math.max(1, visualLines);
}

export function renderSplashLogo(frame: number, _options?: { color?: boolean }): string[] {
  return [
    [...tokenStreamFrameText('default', frame)].join(' '),
    tokenStreamFrameText('default', frame),
    [...tokenStreamFrameText('default', frame + 1)].join(' '),
    tokenStreamFrameText('default', frame + 1),
    [...tokenStreamFrameText('default', frame + 2)].join(' '),
  ];
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
      content: `${glyph} ${payload.file}   +${payload.linesAdded} ~${payload.linesModified} -${payload.linesRemoved}   ${payload.summary}`,
      fg: color,
    });
  }
  if (payload.type === 'diff') {
    return core.Text({
      ...FULL_WIDTH_TEXT,
      content: `${glyph} ${payload.file}`,
      fg: color,
    });
  }
  if (payload.type === 'command') {
    const status = payload.exitCode === undefined ? '' : payload.exitCode === 0 ? ' ok' : ` exit ${payload.exitCode}`;
    return core.Text({
      ...FULL_WIDTH_TEXT,
      content: `${glyph} ${payload.command || ''}${status}`,
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
      content: `${glyph} ${payload.message}`,
      fg: color,
    });
  }
  if (payload.type === 'checkpoint') {
    // Checkpoints are rendered as full-width dividers via renderCheckpointDivider
    return core.Text({ ...FULL_WIDTH_TEXT, content: '', fg: palette.textMuted });
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
  const summary = summaryLine;

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
    return shadedCard(core, event.id, color, pal, `×  ${name}`, [
      core.Text({ ...FULL_WIDTH_TEXT, content: body, fg: color }),
    ]);
  }

  // Completed: full bordered result card — use info/cyan for intermediate child results
  const color = pal.info;
  const toolCalls = event.metadata.toolCalls ?? 0;
  const filesCount = event.metadata.filesTouched?.length ?? 0;
  const statsParts: string[] = [];
  if (toolCalls > 0) statsParts.push(`Calls ${toolCalls}`);
  if (filesCount > 0) statsParts.push(`Files touched: ${filesCount}`);

  return shadedCard(core, event.id, color, pal, `✓  ${name}`, [
    core.Text({
      ...FULL_WIDTH_TEXT,
      content: statsParts.length > 0 ? statsParts.join(' · ') : '',
      fg: pal.textAccent,
    }),
    ...(body.trim()
      ? renderResultMarkdown(core, body, pal)
      : [core.Text({ ...FULL_WIDTH_TEXT, content: '(no output)', fg: pal.textMuted })]),
  ]);
}

function renderThinkingCard(core: OpenTuiCore, event: SemanticEvent, palette?: TuiPalette): OpenTuiNode {
  const { config } = core;
  if (config?.hideThinking) {
    return renderGlyph(core, 'thinking', palette);
  }
  // ... existing implementation ...
  const pal = palette ?? getPalette();
  const payload = event.artifact;
  const title = payload.type === 'text' ? payload.title : 'Thinking';
  const body = payload.type === 'text' ? payload.body : '';
  const active = /^thinking/i.test(title);
  // Finalized "Thought" cards drop to muted so they recede behind prompts
  // and results when scanning the transcript; only the live card is tinted.
  const color = active ? pal.semantic.thinking : pal.textMuted;
  const normalized = normalizeThinkingText(body);

  // Always show the full thinking text — no collapse, no expand toggle.
  // Long thinking blocks are naturally scrollable in the transcript.
  return shadedCard(core, event.id, color, pal, `◌  ${title}`, renderThinkingBody(core, normalized, pal));
}

/**
 * Render thinking/reasoning content with markdown structural formatting.
 * Uses thinking-block styling (muted colors, subdued appearance) to
 * preserve distinct identity from assistant messages while making
 * structured reasoning (headings, lists, code) scannable.
 */
function renderThinkingBody(core: OpenTuiCore, body: string, pal: TuiPalette): OpenTuiNode[] {
  const nodes: OpenTuiNode[] = [];
  const lines = body.split('\n');
  let inCodeBlock = false;
  const codeBlockLines: string[] = [];

  for (let idx = 0; idx < lines.length; idx += 1) {
    const rawLine = lines[idx] ?? '';
    const line = rawLine.trimEnd();

    // Code fences
    if (/^```/.test(line)) {
      if (inCodeBlock) {
        if (codeBlockLines.length > 0) {
          nodes.push(
            core.Box(
              { paddingLeft: 2, flexDirection: 'column' },
              ...codeBlockLines.map((cl) => core.Text({ ...FULL_WIDTH_TEXT, content: cl, fg: pal.info })),
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

    // ATX headings: ## text, ### text, etc.
    const hMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (hMatch && hMatch[1] && hMatch[2]) {
      const text = plainInlineMarkdown(hMatch[2]);
      // Wrap in bold markers so styledInlineMarkdown applies bold styling,
      // making headings visually distinct from body text in the thinking block.
      nodes.push(
        core.Text({
          ...FULL_WIDTH_TEXT,
          content: styledInlineMarkdown(core, `**${text}**`, pal, pal.textMuted),
          fg: pal.textMuted,
        }),
      );
      continue;
    }

    // Bold heading: **text** or __text__ on its own line
    const boldHeadingMatch = line.match(/^(\*\*|__)(.+?)\1$/);
    if (boldHeadingMatch) {
      const text = boldHeadingMatch[2].trim();
      nodes.push(
        core.Text({
          ...FULL_WIDTH_TEXT,
          content: styledInlineMarkdown(core, `**${text}**`, pal, pal.textMuted),
          fg: pal.textMuted,
        }),
      );
      continue;
    }

    // Bullet lists (unordered): - item, * item, + item
    const bMatch = line.match(/^(\s*)([-*+])\s+(.+)/);
    if (bMatch) {
      const indent = bMatch[1];
      const content = bMatch[3];
      nodes.push(
        core.Text({
          ...FULL_WIDTH_TEXT,
          content: styledInlineMarkdown(core, `${indent}• ${content}`, pal, pal.textMuted),
          fg: pal.textMuted,
        }),
      );
      continue;
    }

    // Numbered lists: 1. item
    const nMatch = line.match(/^(\s*)(\d+\.)\s+(.+)/);
    if (nMatch) {
      nodes.push(
        core.Text({
          ...FULL_WIDTH_TEXT,
          content: styledInlineMarkdown(core, `${nMatch[1]}${nMatch[2]} ${nMatch[3]}`, pal, pal.textMuted),
          fg: pal.textMuted,
        }),
      );
      continue;
    }

    // Empty lines — preserve paragraph breaks
    if (line.trim() === '') {
      nodes.push(core.Text({ ...FULL_WIDTH_TEXT, content: '', fg: pal.textMuted }));
      continue;
    }

    // Regular line with inline markdown styling
    nodes.push(
      core.Text({
        ...FULL_WIDTH_TEXT,
        content: styledInlineMarkdown(core, line, pal, pal.textMuted),
        fg: pal.textMuted,
      }),
    );
  }

  return nodes;
}

function normalizeThinkingText(text: string): string {
  return stripToolCallMarkup(text)
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .trim();
}

// ─── Checkpoint divider ────────────────────────────────────────────────────

/** Render a checkpoint as a full-width visible separator. */
function renderCheckpointDivider(core: OpenTuiCore, event: SemanticEvent, palette?: TuiPalette): OpenTuiNode {
  const pal = palette ?? getPalette();
  const color = eventColor('checkpoint', pal);
  const payload = event.artifact;
  const hash = payload.type === 'checkpoint' ? (payload.hash ?? '') : '';
  const validHash = hash && hash !== 'unknown';
  const shortHash = validHash ? hash.slice(0, 7) : '';
  const label = shortHash ? `Checkpoint ${shortHash}` : 'Checkpoint';
  const glyph = GLYPHS.checkpoint;
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
        flexDirection: 'row',
        paddingX: 0,
        paddingY: 0,
      },
      core.Text({
        content: `${glyph} ${label} `,
        fg: color,
      }),
      core.Text({
        content: '─'.repeat(60),
        fg: pal.textAccent,
      }),
    ),
  );
}
