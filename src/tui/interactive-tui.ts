import {
  applyEventToRunState,
  advanceClock,
  createInitialRunStateSnapshot,
  type RunStateSnapshot,
} from '../agent/tui-state';
import { isSecretTrigger } from '../backrooms/trigger';
import type { ChatSession } from '../commands/chat';
import type { EffectiveSynaxConfig } from '../config/schema';
import { persistConfig } from '../config/load-config';
import { renderSettings } from '../settings/settings-renderer';
import {
  createSettingsState,
  settingsReducer,
  tabLabel,
  type SettingsAction,
  type SettingsTab,
} from '../settings/settings-state';
import { getCommand } from '../settings/slash-command-registry';
import type { Readable, Writable } from 'node:stream';
import { listSessionsSorted } from '../sessions/session-store';
import {
  createResumePickerState,
  resumePickerReducer,
  renderResumePicker,
  type ResumePickerState,
} from '../sessions/resume-renderer';
import {
  renderArtifactRoot,
  renderArtifactCard,
  promptInputHeight,
  footerLayoutHeight,
  type ArtifactRailState,
  type FooterState,
  type ExpandedState,
  type AutocompleteState,
  type CheckpointRailEntry,
} from './opentui-artifact-renderer';
import {
  classifyAgentEvent,
  semanticEventsFromDebugHistory,
  createCheckpointEvent,
  shouldEmitCheckpoint,
  type SemanticEvent,
} from './semantic-events';
import { getPalette, detectThemeMode, type TuiPalette } from './theme';
import { tuiStats } from './telemetry';
import { tokenStreamFrame, tokenStreamFrameText, tokenStreamRoleColor } from './token-stream';
import { stripToolCallMarkup } from './markup-sanitizer';
import {
  AdaptiveRenderScheduler,
  CMUX_ACTIVE_FPS,
  CMUX_LIVE_CARD_LIMIT,
  CMUX_TUI_COALESCE_MS,
  DEFAULT_ACTIVE_FPS,
  DEFAULT_LIVE_CARD_LIMIT,
  DEFAULT_TUI_COALESCE_MS,
  IncrementalFeedModel,
  type DirtyReason,
} from './opentui-render-scheduler';
import { gitCreateCheckpoint, gitListCheckpoints, gitRestoreCheckpoint, type CheckpointInfo } from './git-helpers';
import {
  AUTOCOMPLETE_MAX_ROWS,
  CTRL_C_QUIT_TIMEOUT_MS,
  MAX_TRANSCRIPT_EVENTS,
  TRANSIENT_EVENT_TYPES,
  SCROLL_STEP_ROWS,
  SCROLL_PAGE_FACTOR,
  ACTIVITY_LINE_ID,
  ACTIVITY_GLYPH_ID,
  ACTIVITY_TEXT_ID,
  TOOL_PREVIEW_LINES,
} from './tui-constants';
import { padAnsi, visibleLength } from './text-utils';
import { getModelPalette, type ModelPalette } from './model-palette';
import { createInputParser, parseInputChunk } from './input';

type OpenTuiCore = typeof import('@opentui/core');
type InputStreamLike = Readable & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
  resume: () => void;
  pause: () => void;
};
const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';

import {
  resolveCtrlCBehavior,
  latestExpandableEventId,
  slashAutocompleteItems,
  movePromptCursorVertically,
  scrollArtifactHistory,
  readPromptValue,
  setPromptValue,
  placePromptCursorAtEnd,
  splashFrame,
  clip,
  stripAnsi,
  truncateTitle,
  unique,
  tuiNote,
  slashOutputClass,
} from './key-handlers';
import { getCompletions } from './autocomplete';

export async function runInteractiveTui(
  session: ChatSession,
  options?: {
    stdin?: InputStreamLike;
    stdout?: Writable & { isTTY?: boolean; columns?: number; rows?: number };
    blockedMessage?: string;
    lastModelOutput?: () => string;
    resetLastModelOutput?: () => void;
    modelLabel?: string;
    thinkingEnabled?: boolean;
    endpointLabel?: string;
    providerName?: string;
    /** Display label for the working directory in the rail/footer. */
    cwdLabel?: string;
    /** Actual working directory path for path-completion; defaults to process.cwd(). */
    cwd?: string;
    /** Repository root path for @-mention completion. */
    repoRoot?: string;
    gitBranch?: string;
    contextWindowTokens?: number;
    activeSkills?: string[];
    coreLoaded?: boolean;
    inputPricePer1MTokens?: number;
    outputPricePer1MTokens?: number;
    settingsConfig?: EffectiveSynaxConfig;
    runLiminalLayer?: () => Promise<void>;
    onSettingsConfigChanged?: (settingsConfig: EffectiveSynaxConfig) => {
      modelLabel?: string;
      thinkingEnabled?: boolean;
      endpointLabel?: string;
      providerName?: string;
      contextWindowTokens?: number;
      coreLoaded?: boolean;
      providerWarning?: string;
      inputPricePer1MTokens?: number;
      outputPricePer1MTokens?: number;
    };
    enableMouse?: boolean;
    alternateScreen?: boolean;
    cmuxMode?: boolean;
  },
): Promise<void> {
  const stdout = options?.stdout ?? process.stdout;
  if (stdout.isTTY === false) return;

  const core = await loadOpenTuiCore();
  const highLoadMode = options?.cmuxMode === true;
  const activeFps = highLoadMode ? CMUX_ACTIVE_FPS : DEFAULT_ACTIVE_FPS;
  const coalesceMs = highLoadMode ? CMUX_TUI_COALESCE_MS : DEFAULT_TUI_COALESCE_MS;
  const liveCardLimit = highLoadMode ? CMUX_LIVE_CARD_LIMIT : DEFAULT_LIVE_CARD_LIMIT;
  const renderer = await core.createCliRenderer({
    stdin: (options?.stdin ?? process.stdin) as NodeJS.ReadStream,
    stdout: stdout as NodeJS.WriteStream,
    screenMode: options?.alternateScreen === false ? 'main-screen' : 'alternate-screen',
    exitOnCtrlC: false,
    targetFps: activeFps,
    maxFps: activeFps,
    useMouse: options?.enableMouse ?? false,
    backgroundColor: '#050505',
    consoleMode: 'disabled',
  });
  stdout.write(ENABLE_BRACKETED_PASTE);

  let state: RunStateSnapshot = createInitialRunStateSnapshot(Date.now());
  let events: SemanticEvent[] = [];
  let prompt = '';
  let busy = false;
  let exiting = false;
  let statusOverride = options?.blockedMessage ? `! Blocked: ${options.blockedMessage}` : '';
  /** Slash command info panel: displayed above the prompt bar until the user types. */
  let slashInfoLines: string[] | null = null;

  // --- Theme ---
  const themeMode: 'dark' | 'light' = (await detectThemeMode(renderer as any)) ?? 'dark';
  const currentPalette: TuiPalette = getPalette(options?.blockedMessage ? 'default' : themeMode);
  // Align the renderer clear color with the resolved palette. The renderer
  // was created before theme detection, so a hardcoded dark background would
  // otherwise clash with light terminal themes (e.g. Ghostty light mode).
  try {
    (renderer as unknown as { setBackgroundColor?: (color: string) => void }).setBackgroundColor?.(
      currentPalette.background,
    );
  } catch {
    // best-effort: keep the creation-time background
  }

  // --- Keyboard shortcut state ---
  let ctrlCPressedAt: number | null = null;
  let steeringBuffer = '';
  let autocompleteItems: string[] = [];
  let autocompleteIndex = 0;
  let autocompleteVisible = false;
  let autocompleteDraft: string | null = null;
  let autocompleteVisibleRows = 0;
  let autocompleteIsFile = false;
  let interrupted = false;
  let pasteBuffer = '';
  let pasteActive = false;
  let pasteBlockCount = 0;
  const pasteBlocks: { blockNumber: number; charCount: number }[] = [];
  const bracketedPasteParser = createInputParser();
  let rawPasteActive = false;
  let activeThinkingEventId: string | null = null;
  let thinkingRawBody = '';
  let expandCollapseVersion = 0;
  let promptDirty = false;
  let layoutDirty = false;
  let settingsState = options?.settingsConfig ? createSettingsState(options.settingsConfig) : undefined;
  let resumePickerState: ResumePickerState | null = null;
  let busyAnimationFrame = 0;
  let modelPalette: ModelPalette = getModelPalette(options?.modelLabel ?? '');

  /** Working directory for path completion. */
  const cwd = options?.cwd ?? process.cwd();
  /** Repository root for @-mention completion. */
  const repoRoot = options?.repoRoot ?? process.cwd();

  // --- Expanded state for cards ---
  const expandedState: ExpandedState = {};

  // --- Recent checkpoints ---
  let recentCheckpoints: CheckpointInfo[] = [];
  let lastCheckpointFileCount = 0;

  // --- Persistent status card state (removed — using activity line instead)
  const activeSubAgents: string[] = [];
  let orchestrationReturnedCount = 0;
  let orchestrationTotalSteps = 0;
  let orchestrationMode: 'parallel' | 'sequential' | null = null;
  let orchestrationPhase: 'dispatching' | 'synthesizing' | 'committing' | null = null;
  let hasAssistantResultThisTurn = false;

  /** Find a descendant OpenTUI node by ID. */
  const findNode = (id: string): unknown => renderer.root.findDescendantById(id);

  /** Set a property on a dynamic OpenTUI node. */
  const setNodeProp = <K extends string, V>(id: string, prop: K, value: V): void => {
    const node = findNode(id) as Record<string, unknown> | null;
    if (node) node[prop] = value;
  };

  const applyOptionsToState = (): void => {
    state = {
      ...state,
      modelId: options?.modelLabel ?? state.modelId,
      providerName:
        options?.providerName ?? providerNameFromEndpoint(options?.endpointLabel ?? '') ?? state.providerName,
      contextWindowTokens: options?.contextWindowTokens ?? state.contextWindowTokens,
      thinkingEnabled: options?.thinkingEnabled,
      activeSkills: options?.activeSkills ?? [],
      coreLoaded: options?.coreLoaded ?? true,
      inputPricePer1MTokens: options?.inputPricePer1MTokens,
      outputPricePer1MTokens: options?.outputPricePer1MTokens,
      sessionSpendLabel: isLocalEndpoint(options?.endpointLabel ?? '') ? 'local' : state.sessionSpendLabel,
    };
    modelPalette = getModelPalette(options?.modelLabel ?? state.modelId);
  };
  applyOptionsToState();
  let treeBuilt = false;
  let animationTimer: ReturnType<typeof setTimeout> | null = null;
  let eventsVersion = 0;
  let lastRenderedEventsVersion = -1;
  let lastRenderedSplashFrame = -1;
  let lastRenderedFooterSignature = '';
  let lastRenderedRootLayoutSignature = '';
  let lastSlashInfoLineCount = 0;
  const feedModel = new IncrementalFeedModel(liveCardLimit);

  const removeRenderedRoot = (): void => {
    const existingRoot = renderer.root.findDescendantById('synax-root');
    if (!existingRoot) return;
    feedModel.reset();
    if (typeof (existingRoot as any).destroyRecursively === 'function') {
      (existingRoot as any).destroyRecursively();
      return;
    }
    if (typeof (existingRoot as any).destroy === 'function') {
      (existingRoot as any).destroy();
      return;
    }
    if (typeof (renderer.root as any).remove === 'function') {
      (renderer.root as any).remove('synax-root');
    }
  };

  const handleInputSubmit = (value: string): void => {
    if (busy) return;
    const text = value.trim();
    if (!text) return;
    prompt = '';
    autocompleteDraft = null;
    autocompleteIsFile = false;
    promptDirty = true;
    void submit(text);
  };

  const doRender = (): void => {
    if (exiting || renderer.isDestroyed) return;
    state = advanceClock(state, Date.now());
    busyAnimationFrame++;

    // Sync persistent status card at the bottom of the transcript
    syncActivityLine();

    // Keep autocomplete in sync with every prompt edit, including backspace.
    const inputForAutocomplete = renderer.root.findDescendantById('synax-input');
    const widgetValue = inputForAutocomplete ? readPromptValue(inputForAutocomplete) : '';
    const rawCurrentValue = promptDirty || !inputForAutocomplete ? prompt : widgetValue;
    // Resolve stale autocompleteDraft: if the real input doesn't start with '/', clear the draft.
    // Otherwise autocorrect from history or backspacing past '/' can deadlock input submission.
    if (autocompleteDraft !== null && rawCurrentValue && !rawCurrentValue.startsWith('/')) {
      autocompleteDraft = null;
    }
    const currentInputValue = autocompleteDraft ?? rawCurrentValue;
    if (currentInputValue.startsWith('/') && !busy) {
      autocompleteIsFile = false;
      autocompleteDraft = currentInputValue;
      autocompleteItems = slashAutocompleteItems(currentInputValue);
      autocompleteIndex = Math.min(autocompleteIndex, Math.max(0, autocompleteItems.length - 1));
      autocompleteVisible = autocompleteItems.length > 0;
    } else if (!autocompleteIsFile) {
      autocompleteDraft = null;
      autocompleteItems = [];
      autocompleteIndex = 0;
      autocompleteVisible = false;
    } else {
      // File/path autocomplete is active — keep as-is
      autocompleteDraft = null;
    }
    const nextAutocompleteVisibleRows = autocompleteVisible
      ? Math.min(
          autocompleteItems.length,
          autocompleteMaxVisibleRows(renderer.height, promptInputHeight(prompt, renderer.width)),
        )
      : 0;

    const pendingApprovals = events.filter((e) => e.class === 'approval').length;
    const rail = railState(
      state,
      options,
      recentCheckpoints.map((c) => ({ title: c.title, hash: c.hash })),
      pendingApprovals,
    );
    const baseFooter = footerState({
      state,
      prompt,
      busy,
      statusOverride,
      steeringBuffer,
      terminalWidth: renderer.width,
      options,
      busyAnimationFrame,
    });
    const footer = {
      ...baseFooter,
      hints:
        pasteBlocks.length > 0
          ? pasteBlocks.map((pb) => `[Paste #${pb.blockNumber} · ${pb.charCount} chars]`).join('  ') +
            `  ${baseFooter.hints}`
          : baseFooter.hints,
    };
    const renderedEvents = visibleEvents(events, state);
    const footerSignature = stableFooterSignature(footer);
    const rootLayoutSignature = rootLayoutModeSignature({
      visibleEventCount: renderedEvents.length,
      footer,
      settingsActive: settingsState?.active === true,
      slashInfoActive: (slashInfoLines?.length ?? 0) > 0,
      terminalWidth: renderer.width,
      terminalHeight: renderer.height,
    });
    if (treeBuilt && footerSignature !== lastRenderedFooterSignature) {
      treeBuilt = false;
    }
    const currentSlashInfoCount = slashInfoLines?.length ?? 0;
    if (treeBuilt && currentSlashInfoCount !== lastSlashInfoLineCount) {
      treeBuilt = false;
      lastSlashInfoLineCount = currentSlashInfoCount;
    }
    if (treeBuilt && rootLayoutSignature !== lastRenderedRootLayoutSignature) {
      treeBuilt = false;
    }
    const acState: AutocompleteState | undefined = autocompleteVisible
      ? {
          visible: true,
          items: autocompleteItems,
          selectedIndex: autocompleteIndex,
          maxVisibleItems: nextAutocompleteVisibleRows,
        }
      : undefined;
    autocompleteVisibleRows = nextAutocompleteVisibleRows;
    const overlayLines = resumePickerState?.active
      ? renderResumePicker(resumePickerState, renderer.width, renderer.height)
      : settingsState?.active
        ? renderSettings(settingsState, renderer.width, renderer.height).map(stripAnsi)
        : undefined;
    const overlayActiveLabel = resumePickerState?.active
      ? 'Resume'
      : settingsState?.active
        ? tabLabel(settingsState.tab)
        : undefined;
    if (!treeBuilt) {
      removeRenderedRoot();
      renderer.root.add(
        renderArtifactRoot(
          core,
          renderedEvents,
          rail,
          footer,
          renderer.width,
          expandedState,
          (id) => {
            expandedState[id] = !expandedState[id];
            tuiStats.recordExpandToggle();
            expandCollapseVersion++;
            render('input', { immediate: true });
          },
          currentPalette,
          acState,
          overlayLines,
          overlayActiveLabel,
          handleInputSubmit,
          (value) => {
            // Clear slash-autocomplete state when user types non-slash content
            if (autocompleteDraft !== null && !value.startsWith('/')) {
              autocompleteDraft = null;
            }
            if (autocompleteDraft !== null) return;
            // Clear slash info panel when user starts typing
            if (slashInfoLines && value.trim()) {
              slashInfoLines = null;
              render('input', { immediate: true });
              return;
            }
            // Clear file/path autocomplete when the user types
            if (autocompleteIsFile) {
              autocompleteIsFile = false;
              autocompleteVisible = false;
              autocompleteItems = [];
              autocompleteIndex = 0;
            }
            const previousPrompt = prompt;
            prompt = value;
            const autocompleteChanged = previousPrompt.startsWith('/') || value.startsWith('/');
            const heightChanged =
              promptInputHeight(previousPrompt, renderer.width) !== promptInputHeight(value, renderer.width);
            if (autocompleteChanged || heightChanged) {
              render('input', { immediate: true });
            }
          },
          { frame: splashFrame(state.nowMs) },
          state.modelId,
          renderer.height,
          slashInfoLines || undefined,
        ),
      );
      treeBuilt = true;
      lastRenderedEventsVersion = eventsVersion;
      lastRenderedSplashFrame = splashFrame(state.nowMs);
      lastRenderedFooterSignature = footerSignature;
      lastRenderedRootLayoutSignature = rootLayoutSignature;
      lastSlashInfoLineCount = currentSlashInfoCount;
      expandCollapseVersion = 0;
      feedModel.reset();
      feedModel.plan(renderedEvents, expandedState);
      syncActivityLine(true);
      // Focus and position the input after rebuilds. OpenTUI applies initialValue
      // without guaranteeing the cursor is at the end of that value.
      queueMicrotask(() => {
        const input = renderer.root.findDescendantById('synax-input');
        input?.focus();
        placePromptCursorAtEnd(input, prompt);
      });
    } else {
      setNodeContent('synax-hints', footer.hints);
      if (footer.location) setNodeContent('synax-location', footer.location);
      setNodeContent('synax-context-bar', footer.contextInfo ?? '');
      const input = findNode('synax-input');
      if (input) {
        if (promptDirty) {
          setPromptValue(input, prompt);
          promptDirty = false;
        }
        (input as any).placeholder = footer.placeholder;
        const textareaHeight = promptInputHeight(prompt, renderer.width);
        if ((input as any).height !== textareaHeight) {
          (input as any).height = textareaHeight;
          layoutDirty = true;
        }
        const inputFrame = findNode('synax-input-frame');
        const inputFrameHeight = textareaHeight + 2;
        if (inputFrame && (inputFrame as any).height !== inputFrameHeight) {
          (inputFrame as any).height = inputFrameHeight;
          layoutDirty = true;
        }
      }
      const footerNode = findNode('synax-footer');
      if (footerNode && 'height' in (footerNode as any)) {
        const newFooterHeight = footerLayoutHeight(footer, slashInfoLines?.length ?? 0);
        const autocompleteNode = findNode('synax-autocomplete');
        if (autocompleteNode && 'bottom' in (autocompleteNode as any)) {
          (autocompleteNode as any).bottom = newFooterHeight;
        }
        if ((footerNode as any).height !== newFooterHeight) {
          (footerNode as any).height = newFooterHeight;
          layoutDirty = true;
        }
      }
      // Force yoga layout recalculation when input or footer height changed.
      // OpenTUI's native height setter doesn't always propagate through
      // the yoga layout tree on its own.
      if (layoutDirty) {
        renderer.root.calculateLayout();
        layoutDirty = false;
      }
      updateAutocompleteNode();
      rebuildEvents();
      lastRenderedFooterSignature = footerSignature;
      lastRenderedRootLayoutSignature = rootLayoutSignature;
    }
    tuiStats.recordRepaint();
    tuiStats.recordFrame(renderScheduler.getStats());
    renderer.requestRender();

    // Keep the spinner animation alive during active execution.
    // Re-render at ~3 fps when the run is active but no new events arrive.
    // Track the timer so repeated doRender calls don't stack timers and so
    // shutdown can cancel a pending animation tick.
    if (busy || (state.terminal === 'running' && state.phase !== 'idle' && state.phase !== 'completed')) {
      if (animationTimer) clearTimeout(animationTimer);
      animationTimer = setTimeout(() => {
        animationTimer = null;
        render('animation', { immediate: true });
      }, 333);
    }

    function removeNode(parent: unknown, id: string): void {
      const removable = parent as { remove?: (nodeId: string) => void };
      if (typeof removable.remove === 'function') {
        removable.remove(id);
        return;
      }
      const node = findNode(id);
      if (node && typeof (node as { destroyRecursively?: () => void }).destroyRecursively === 'function') {
        (node as { destroyRecursively: () => void }).destroyRecursively();
        return;
      }
      if (node && typeof (node as { destroy?: () => void }).destroy === 'function') {
        (node as { destroy: () => void }).destroy();
      }
    }
    function setNodeContent(id: string, content: string): void {
      const node = findNode(id);
      if (node && typeof node === 'object' && 'content' in node) {
        const previous = typeof (node as any).content === 'string' ? (node as any).content : '';
        const clearWidth = Math.max(visibleLength(previous), visibleLength(content));
        (node as any).content = padAnsi(content, clearWidth);
      }
    }
    function rebuildEvents(): void {
      const currentSplashFrame = splashFrame(state.nowMs);
      if (
        eventsVersion === lastRenderedEventsVersion &&
        expandCollapseVersion === 0 &&
        (events.length > 0 || currentSplashFrame === lastRenderedSplashFrame)
      )
        return;
      lastRenderedEventsVersion = eventsVersion;
      lastRenderedSplashFrame = currentSplashFrame;
      expandCollapseVersion = 0;
      const scrollBox = findNode('synax-artifacts');
      if (!scrollBox) return;
      const visible = visibleEvents(events, state);
      if (visible.length > 0) {
        removeNode(scrollBox, 'synax-empty-state');
      }
      const plan = feedModel.plan(visible, expandedState);
      if (plan.operations.length === 0) return;
      if (typeof (scrollBox as any).add !== 'function' || typeof (scrollBox as any).remove !== 'function') {
        treeBuilt = false;
        feedModel.reset();
        removeRenderedRoot();
        doRender();
        return;
      }
      for (const operation of plan.operations) {
        if (operation.type === 'remove') {
          removeNode(scrollBox, operation.id);
          continue;
        }
        if (!operation.event) continue;
        const card = renderArtifactCard(
          core,
          operation.event,
          expandedState[operation.event.id] ?? false,
          (id: string) => {
            expandedState[id] = !expandedState[id];
            tuiStats.recordExpandToggle();
            expandCollapseVersion++;
            render('input', { immediate: true });
          },
          currentPalette,
        );
        if (operation.type === 'update') {
          removeNode(scrollBox, operation.id);
          (scrollBox as any).add(card, operation.index);
        } else {
          (scrollBox as any).add(card);
        }
      }
    }
    function updateAutocompleteNode(): void {
      const acNode = findNode('synax-autocomplete');
      if (!acNode) return;
      (acNode as any).visible = autocompleteVisible && autocompleteItems.length > 0;
      const windowStart = autocompleteWindowStart(autocompleteIndex, autocompleteItems.length, autocompleteVisibleRows);
      for (let i = 0; i < AUTOCOMPLETE_MAX_ROWS; i++) {
        const row = findNode(`synax-ac-row-${i}`);
        if (!row) continue;
        const absoluteIndex = windowStart + i;
        const item = autocompleteItems[absoluteIndex] ?? '';
        const rowVisible = autocompleteVisible && i < autocompleteVisibleRows && item !== '';
        (row as any).visible = rowVisible;
        const isSelected = rowVisible && absoluteIndex === autocompleteIndex;
        (row as any).content = rowVisible ? (isSelected ? `→ ${item}` : `  ${item}`) : '';
        (row as any).fg = isSelected ? currentPalette.brand : currentPalette.textAccent;
      }
    }
  };

  // ─── Live activity line (replaces persistent status card) ──────

  let lastActivityGlyph = '';
  let lastActivityText = '';

  /** Pick the animation glyph for the current frame. */
  const frameGlyph = (glyphs: string[], frame: number): string => glyphs[frame % glyphs.length] ?? glyphs[0] ?? '·';
  const activityGlyph = (frame: number): string => tokenStreamFrameText(modelPalette.family, frame);
  const styledActivityGlyph = (
    frame: number,
  ): string | InstanceType<(typeof import('@opentui/core'))['StyledText']> => {
    const coreWithStyles = core as unknown as {
      StyledText?: new (chunks: unknown[]) => unknown;
      fg?: (color: string) => (text: string) => unknown;
    };
    if (typeof coreWithStyles.StyledText !== 'function' || typeof coreWithStyles.fg !== 'function') {
      return activityGlyph(frame);
    }
    return new coreWithStyles.StyledText(
      tokenStreamFrame(modelPalette.family, frame).map((glyph) =>
        coreWithStyles.fg!(tokenStreamRoleColor(modelPalette.family, glyph.role))(glyph.char),
      ),
    ) as InstanceType<(typeof import('@opentui/core'))['StyledText']>;
  };
  const syncActivityLine = (force = false): void => {
    const active = activityLineActive(state, busy, statusOverride);

    const line = findNode(ACTIVITY_LINE_ID);
    if (!line) return;

    if (!active) {
      setNodeProp(ACTIVITY_LINE_ID, 'visible', true);
      setNodeProp(ACTIVITY_GLYPH_ID, 'content', '');
      setNodeProp(ACTIVITY_TEXT_ID, 'content', '');
      lastActivityGlyph = '';
      lastActivityText = '';
      return;
    }

    let glyph: string;
    let text: string;

    if (statusOverride) {
      glyph = frameGlyph(modelPalette.animationGlyphs.error, busyAnimationFrame);
      text = statusOverride;
    } else if (orchestrationPhase === 'synthesizing') {
      glyph = activityGlyph(busyAnimationFrame);
      text = 'working · synthesizing result';
    } else if (orchestrationPhase === 'committing') {
      glyph = activityGlyph(busyAnimationFrame);
      text = 'working · committing changes';
    } else if (activeSubAgents.length > 0 && orchestrationMode) {
      glyph = activityGlyph(busyAnimationFrame);
      const activityText = computeOrchestrationStepText(
        orchestrationMode,
        activeSubAgents.length,
        orchestrationReturnedCount,
        orchestrationTotalSteps,
      );
      text = `working · ${activityText}`;
    } else if (activeSubAgents.length > 0) {
      glyph = activityGlyph(busyAnimationFrame);
      const total = activeSubAgents.length + orchestrationReturnedCount;
      text = `working · ${orchestrationReturnedCount}/${total} agents returned`;
    } else if (state.phase === 'thinking') {
      glyph = activityGlyph(busyAnimationFrame);
      text = 'thinking';
    } else if (state.phase === 'tool_execution') {
      glyph = activityGlyph(busyAnimationFrame);
      text = `working · ${activitySummary(state)}`;
    } else if (state.phase === 'verifying') {
      glyph = activityGlyph(busyAnimationFrame);
      text = state.verification.currentCheckLabel
        ? `working · ${state.verification.currentCheckLabel.slice(0, 58)}`
        : 'working';
    } else if (state.phase === 'error') {
      glyph = frameGlyph(modelPalette.animationGlyphs.error, busyAnimationFrame);
      text = state.terminalIssue ? `Error · ${state.terminalIssue.slice(0, 78)}` : 'Error';
    } else if (state.phase === 'blocked') {
      glyph = frameGlyph(modelPalette.animationGlyphs.error, busyAnimationFrame);
      text = state.objective.nextCheckpoint.slice(0, 78) || 'Blocked';
    } else if (state.phase === 'budget_exhausted') {
      glyph = frameGlyph(modelPalette.animationGlyphs.error, busyAnimationFrame);
      text = state.objective.nextCheckpoint.slice(0, 78) || 'Budget exhausted';
    } else if (busy) {
      glyph = activityGlyph(busyAnimationFrame);
      text = 'thinking · awaiting model response';
    } else {
      glyph = activityGlyph(busyAnimationFrame);
      text = 'working';
    }

    if (!force && glyph === lastActivityGlyph && text === lastActivityText) {
      return;
    }
    lastActivityGlyph = glyph;
    lastActivityText = text;

    setNodeProp(ACTIVITY_LINE_ID, 'visible', true);
    const glyphNode = findNode(ACTIVITY_GLYPH_ID);
    if (glyphNode) {
      setNodeProp(ACTIVITY_GLYPH_ID, 'content', styledActivityGlyph(busyAnimationFrame));
      setNodeProp(ACTIVITY_GLYPH_ID, 'fg', currentPalette.brand);
    }
    const textNode = findNode(ACTIVITY_TEXT_ID);
    if (textNode) {
      setNodeProp(ACTIVITY_TEXT_ID, 'content', text);
      setNodeProp(ACTIVITY_TEXT_ID, 'fg', currentPalette.textAccent);
    }
  };

  const renderScheduler = new AdaptiveRenderScheduler(
    () => {
      doRender();
    },
    { coalesceMs, maxFps: activeFps },
  );

  const render = (reason: DirtyReason = 'status', options?: { immediate?: boolean }): void => {
    if (exiting || renderer.isDestroyed) return;
    renderScheduler.markDirty(reason, options);
  };

  const openSettings = (commandName: string): void => {
    if (!options?.settingsConfig) {
      eventsVersion++;
      events.push(tuiNote('slash', 'Settings are unavailable in this session.'));
      render();
      return;
    }
    settingsState = settingsReducer(createSettingsState(options.settingsConfig), { type: 'open' });
    const tab = settingsTabForCommand(commandName);
    if (tab) {
      settingsState = settingsReducer(settingsState, { type: 'select_tab', tab });
    }
    treeBuilt = false;
    render('input', { immediate: true });
  };

  const applySettingsAction = (action: SettingsAction): void => {
    if (!settingsState) return;
    const previousConfig = settingsState.config;
    settingsState = settingsReducer(settingsState, action);
    if (settingsState.config !== previousConfig && options?.onSettingsConfigChanged) {
      const changed = options.onSettingsConfigChanged(settingsState.config);
      options.settingsConfig = settingsState.config;
      options.modelLabel = changed.modelLabel;
      options.thinkingEnabled = changed.thinkingEnabled;
      options.endpointLabel = changed.endpointLabel;
      options.providerName = changed.providerName;
      options.contextWindowTokens = changed.contextWindowTokens;
      options.coreLoaded = changed.coreLoaded;
      options.inputPricePer1MTokens = changed.inputPricePer1MTokens;
      options.outputPricePer1MTokens = changed.outputPricePer1MTokens;
      statusOverride = changed.providerWarning ? `! ${changed.providerWarning}` : '';
      applyOptionsToState();
    }
    treeBuilt = false;
    render('input', { immediate: true });
  };

  const closeSettings = (): void => {
    if (!settingsState) return;
    if (settingsState.dirty) {
      persistConfig(settingsState.config, repoRoot);
    }
    settingsState = settingsReducer(settingsState, { type: 'close' });
    treeBuilt = false;
    render('input', { immediate: true });
  };

  const handleSettingsKey = (key: {
    name?: string;
    sequence?: string;
    shift?: boolean;
    ctrl?: boolean;
    preventDefault?: () => void;
  }): boolean => {
    if (!settingsState?.active || key.ctrl) return false;
    const textInput = settingsState.textInput;
    if (key.name === 'escape') {
      if (textInput) {
        applySettingsAction({ type: 'text_cancel' });
      } else {
        closeSettings();
      }
      key.preventDefault?.();
      return true;
    }
    if (!textInput && key.name === 'q') {
      closeSettings();
      key.preventDefault?.();
      return true;
    }
    if (key.name === 'tab') {
      applySettingsAction({ type: key.shift ? 'prev_tab' : 'next_tab' });
      key.preventDefault?.();
      return true;
    }
    if (key.name === 'up' || (!textInput && key.name === 'k')) {
      applySettingsAction({ type: 'move_up' });
      key.preventDefault?.();
      return true;
    }
    if (key.name === 'down' || (!textInput && key.name === 'j')) {
      applySettingsAction({ type: 'move_down' });
      key.preventDefault?.();
      return true;
    }
    if (key.name === 'enter' || key.name === 'return') {
      applySettingsAction({ type: 'select_row' });
      key.preventDefault?.();
      return true;
    }
    if (key.name === 'space') {
      applySettingsAction(textInput ? { type: 'text_input', char: ' ' } : { type: 'toggle' });
      key.preventDefault?.();
      return true;
    }
    if (key.name === 'backspace') {
      applySettingsAction({ type: 'text_backspace' });
      key.preventDefault?.();
      return true;
    }
    if (textInput) {
      // Accept any printable character, including shifted/uppercase ones
      // (model names, URLs, and API keys need ':', '_', '-', uppercase, etc).
      const char = printableKeyValue(key as { name?: string; sequence?: string; shift?: boolean });
      if (char) {
        applySettingsAction({ type: 'text_input', char });
        key.preventDefault?.();
        return true;
      }
    }
    key.preventDefault?.();
    return true;
  };

  const submitSteering = async (text: string): Promise<void> => {
    if (!text.trim()) return;
    steeringBuffer = '';
    busy = true;
    statusOverride = '';
    render();
    try {
      await session.handleUserMessage(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      eventsVersion++;
      events.push(tuiNote('error', message));
      statusOverride = `x ${message}`;
    } finally {
      busy = false;
      render();
    }
  };

  const submit = async (rawValue: string): Promise<void> => {
    const value = rawValue.trim();
    if (!value || busy) return;
    if (isSecretTrigger(value)) {
      await options?.runLiminalLayer?.();
      prompt = '';
      autocompleteDraft = null;
      autocompleteIsFile = false;
      promptDirty = true;
      render();
      return;
    }
    prompt = '';
    autocompleteDraft = null;
    autocompleteIsFile = false;
    promptDirty = true;
    statusOverride = '';
    busy = true;
    render();
    try {
      if (value.startsWith('/')) {
        // Handle /checkpoint locally (still functional, not advertised)
        if (value === '/checkpoint') {
          const result = await gitCreateCheckpoint('manual checkpoint');
          if (result) {
            eventsVersion++;
            events.push(createCheckpointEvent('Manual checkpoint', state.filesChangedThisRun, result.hash));
            recentCheckpoints = await gitListCheckpoints();
          } else {
            eventsVersion++;
            events.push(tuiNote('error', 'Checkpoint failed: working tree clean or git error'));
          }
          busy = false;
          render();
          return;
        }
        if (value.startsWith('/restore')) {
          const indexOrHash = value.split(/\s+/)[1] ?? '';
          if (!indexOrHash) {
            eventsVersion++;
            events.push(tuiNote('slash', 'Usage: /restore <index-or-hash>'));
            busy = false;
            render();
            return;
          }
          const ok = await gitRestoreCheckpoint(indexOrHash);
          eventsVersion++;
          events.push(
            tuiNote(
              'slash',
              ok ? `Restored from checkpoint ${indexOrHash}` : `Restore failed: checkpoint ${indexOrHash} not found`,
            ),
          );
          busy = false;
          render();
          return;
        }
        if (value === '/checkpoints') {
          const list = await gitListCheckpoints();
          if (list.length === 0) {
            eventsVersion++;
            events.push(tuiNote('slash', 'No checkpoints found.'));
          } else {
            const lines = list.map((c, i) => `  ${i}. ${c.title} (${c.hash})`);
            eventsVersion++;
            events.push(tuiNote('slash', `Checkpoints (${list.length}):\n${lines.join('\n')}`));
            recentCheckpoints = list;
          }
          busy = false;
          render();
          return;
        }
        // Handle /doctor --tui locally
        if (value === '/doctor --tui' || value === '/doctor') {
          eventsVersion++;
          events.push(tuiNote('slash', tuiStats.formatReport()));
          busy = false;
          render();
          return;
        }

        const registryCommand = getCommand(value.slice(1).split(/\s+/, 1)[0] ?? '');
        if (registryCommand?.opensSettings) {
          openSettings(registryCommand.name);
          busy = false;
          render();
          return;
        }
        if (registryCommand?.opensResume) {
          const sessions = sessionsForCurrentWorkspace(listSessionsSorted('updated'), repoRoot);
          if (sessions.length === 0) {
            slashInfoLines = ['No saved sessions found.'];
          } else {
            resumePickerState = resumePickerReducer(createResumePickerState(sessions), { type: 'open' });
          }
          treeBuilt = false;
          busy = false;
          render('input', { immediate: true });
          return;
        }

        const report = await session.handleSlashCommand(value);
        if (report.exit) {
          exiting = true;
          renderer.destroy();
          return;
        }
        if (report.output.trim()) {
          // Show output as a persistent info panel above the prompt
          slashInfoLines = report.output.split('\n');
        }
        if (report.newSession) {
          events = [];
          eventsVersion = 0;
          state = createInitialRunStateSnapshot(Date.now());
          options?.resetLastModelOutput?.();
        }
      } else if (value.startsWith('!') && session.handleShellCommand) {
        const command = value.slice(1).trim();
        const report = await session.handleShellCommand(command);
        eventsVersion++;
        events.push({
          id: `shell-${Date.now()}`,
          class: 'command',
          timestamp: Date.now(),
          artifact: {
            type: 'command',
            command: report.command,
            cwd: process.cwd(),
            riskLevel: 'medium',
            stdout: report.stdout,
            stderr: report.stderr,
            exitCode: report.exitCode,
          },
          metadata: { duration: report.durationMs },
        });
      } else {
        await session.handleUserMessage(value);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      eventsVersion++;
      events.push(tuiNote('error', message));
      statusOverride = `x ${message}`;
    } finally {
      busy = false;
      render();
    }
  };

  const appendPromptText = (value: string): void => {
    if (!value) return;
    const input = renderer.root.findDescendantById('synax-input');
    const currentPrompt = input ? readPromptValue(input) : prompt;
    syncPromptValue(`${currentPrompt}${value}`);
  };

  const appendPasteText = (value: string): void => {
    if (!value) return;
    pasteBlockCount++;
    pasteBlocks.push({ blockNumber: pasteBlockCount, charCount: value.length });
    appendPromptText(value);
  };

  /**
   * Strip protocol XML markup from reasoning content before display.
   * Prevents raw </think>, <tool_call>, <function=...> tags from
   * leaking into the user-visible Thinking card.
   *
   * Safe for streaming: strips complete blocks AND bare tags so
   * cross-chunk blocks are handled when the accumulated body is
   * re-sanitized after each append.
   */
  const sanitizeThinkingContent = (text: string): string => {
    let result = stripToolCallMarkup(text);
    // If only a non-word character remains (◇, bullet, etc.), strip it
    if (/^\W+$/.test(result)) result = '';
    return result;
  };

  const upsertThinkingCard = (chunk: string): void => {
    // Accumulate raw text to preserve original spacing between streaming chunks.
    // Individual chunks may be split at token boundaries without spaces, so
    // concatenating sanitized chunks would join words. Instead we accumulate
    // the raw body and sanitize the whole thing each time.
    if (!activeThinkingEventId) {
      const sanitized = sanitizeThinkingContent(chunk);
      if (!sanitized.trim()) return;
      thinkingRawBody = chunk;
      activeThinkingEventId = `thinking-${Date.now()}-${events.length}`;
      events.push({
        id: activeThinkingEventId,
        class: 'thinking',
        timestamp: Date.now(),
        artifact: { type: 'text', title: 'Thinking', body: sanitized.trimStart() },
        metadata: { model: state.modelId || undefined },
      });
      events = events.slice(Math.max(0, events.length - MAX_TRANSCRIPT_EVENTS));
      eventsVersion++;
      return;
    }

    const index = events.findIndex((existing) => existing.id === activeThinkingEventId);
    const existing = index >= 0 ? events[index] : undefined;
    if (!existing || existing.artifact.type !== 'text') {
      activeThinkingEventId = null;
      thinkingRawBody = '';
      upsertThinkingCard(chunk);
      return;
    }

    // Concatenate the raw chunk onto the accumulated raw body, then
    // sanitize the whole thing. This preserves spacing that the model
    // included between tokens even when chunk boundaries split words.
    thinkingRawBody += chunk;
    const sanitized = sanitizeThinkingContent(thinkingRawBody).trim();
    if (!sanitized) {
      events = events.filter((e) => e.id !== activeThinkingEventId);
      activeThinkingEventId = null;
      thinkingRawBody = '';
      eventsVersion++;
      return;
    }

    const next = {
      ...existing,
      timestamp: Date.now(),
      artifact: {
        ...existing.artifact,
        body: sanitized,
      },
    };
    events = [...events.slice(0, index), next, ...events.slice(index + 1)];
    eventsVersion++;
  };

  const stopThinkingCard = (): void => {
    if (!activeThinkingEventId) return;
    const index = events.findIndex((existing) => existing.id === activeThinkingEventId);
    const existing = index >= 0 ? events[index] : undefined;
    activeThinkingEventId = null;
    if (!existing || existing.artifact.type !== 'text') return;
    events = [
      ...events.slice(0, index),
      { ...existing, artifact: { ...existing.artifact, title: 'Stopped thinking' } },
      ...events.slice(index + 1),
    ];
    eventsVersion++;
  };

  session.setEventSink?.((event) => {
    if (exiting) return;
    if (event.type === 'task_started' || event.type === 'user_message') {
      hasAssistantResultThisTurn = false;
      // Reset thinking state for the new turn — a new prompt starts a fresh
      // thinking block rather than appending to the previous turn's.
      activeThinkingEventId = null;
      thinkingRawBody = '';
    }
    if (event.type === 'assistant_delta' && event.reasoningContent) {
      upsertThinkingCard(event.reasoningContent);
    }
    if (event.type === 'tool_started') {
      stopThinkingCard();
    }
    state = applyEventToRunState(state, event, Date.now());
    const newEvents = classifyAgentEvent(event, state, Date.now());
    if (event.type === 'assistant_message' && newEvents.length > 0) {
      hasAssistantResultThisTurn = true;
    }

    // Track subagent orchestration for the status card
    if (event.type === 'orchestration_plan_generated') {
      const planEv = event as unknown as {
        payload?: { plan?: unknown; orchestrationMode?: 'parallel' | 'sequential' };
      };
      const plan = planEv?.payload?.plan as { inline?: boolean; subTasks?: unknown[] } | undefined;
      if (!plan?.inline) {
        orchestrationReturnedCount = 0;
        activeSubAgents.length = 0; // reset for new orchestration
        orchestrationTotalSteps = plan?.subTasks?.length ?? 0;
        orchestrationMode = planEv?.payload?.orchestrationMode ?? null;
        orchestrationPhase = 'dispatching';
      }
    }
    if (event.type === 'child_session_spawned') {
      const child = event as unknown as { childSessionId?: string; subtaskId?: string };
      const label = child.subtaskId ?? child.childSessionId ?? 'sub-agent';
      if (!activeSubAgents.includes(label)) activeSubAgents.push(label);
    }
    if (event.type === 'child_session_completed' || event.type === 'child_session_failed') {
      const child = event as unknown as { childSessionId?: string; subtaskId?: string };
      const label = child.subtaskId ?? child.childSessionId ?? 'sub-agent';
      const idx = activeSubAgents.indexOf(label);
      if (idx >= 0) activeSubAgents.splice(idx, 1);
      orchestrationReturnedCount++;
      // When all subagents returned, transition to synthesizing phase
      if (activeSubAgents.length === 0 && orchestrationPhase === 'dispatching') {
        orchestrationPhase = 'synthesizing';
      }
      // Remove the stale "running" card so we don't show both running and returned
      events = events.filter(
        (ev) =>
          !(
            ev.class === 'agent_status' &&
            ev.artifact.type === 'text' &&
            ev.artifact.title === label &&
            ev.artifact.body === 'running'
          ),
      );
    }

    // Reset orchestration tracking on task finished
    if (event.type === 'task_finished') {
      orchestrationPhase = null;
      orchestrationMode = null;
    }

    // Detect committing phase during orchestration
    if (event.type === 'local_shell_command' && orchestrationPhase && event.command.trim().startsWith('git commit')) {
      orchestrationPhase = 'committing';
    }

    // Filter transient events from the transcript — they create too many
    // individual result cards during execution. Status is reflected via
    // the persistent status card and footer line instead.
    const shouldHideCard =
      (TRANSIENT_EVENT_TYPES as Set<string>).has(event.type) ||
      (event.type === 'tool_finished' && event.status === 'ok') ||
      shouldHideCompletionResultCard(event, hasAssistantResultThisTurn) ||
      event.type === 'verification_passed' ||
      event.type === 'verification_skipped';
    if (shouldHideCard) {
      // Still mark dirty so the status card gets updated
      eventsVersion++;
    } else {
      // New user-visible events reset scroll position to follow the feed.
      eventsVersion++;
      events.push(...newEvents);
      events = events.slice(Math.max(0, events.length - MAX_TRANSCRIPT_EVENTS));
    }

    // Auto-checkpoint if needed
    const currentFiles = state.filesChangedThisRun.length;
    if (shouldEmitCheckpoint(currentFiles, lastCheckpointFileCount)) {
      gitCreateCheckpoint('auto')
        .then((result) => {
          if (!result) return;
          eventsVersion++;
          events.push(createCheckpointEvent('Auto checkpoint', state.filesChangedThisRun, result.hash));
          return gitListCheckpoints();
        })
        .then((list) => {
          if (list) recentCheckpoints = list;
        })
        .catch(() => {
          /* best-effort */
        });
    }
    lastCheckpointFileCount = currentFiles;

    render(eventRenderReason(event), { immediate: shouldFlushEventPromptly(event) });
  });

  // ─── Internal helper: slash during busy ─────────────────

  function handleSlashDuringBusy(command: string): void {
    session
      .handleSlashCommand(command)
      .then((report) => {
        if (report.exit) return;
        if (report.output.trim()) {
          eventsVersion++;
          const classified = slashOutputClass(report.output);
          events.push({
            id: `slash-busy-${Date.now()}`,
            class: classified.eventClass,
            timestamp: Date.now(),
            artifact: { type: 'text', title: classified.title, body: report.output },
            metadata: {},
          });
          render();
        }
      })
      .catch(() => {});
  }

  // ─── Extracted key handler helpers ──────────────────────

  /** Ctrl+C: interrupt / clear prompt / quit */
  function handleCtrlC(input: unknown, behavior: 'interrupt' | 'clear_prompt' | 'arm_quit' | 'quit'): void {
    if (behavior === 'interrupt') {
      session.abortCurrentTurn?.();
      statusOverride = '! Turn interrupted';
      steeringBuffer = '';
      busy = false;
      render();
      return;
    }
    if (behavior === 'clear_prompt') {
      prompt = '';
      autocompleteDraft = null;
      autocompleteIsFile = false;
      promptDirty = true;
      setPromptValue(input, '');
      statusOverride = '';
      render();
      return;
    }
    if (behavior === 'quit') {
      exiting = true;
      renderer.destroy();
      return;
    }
    ctrlCPressedAt = Date.now();
    prompt = '';
    autocompleteDraft = null;
    autocompleteIsFile = false;
    promptDirty = true;
    statusOverride = 'Press Ctrl+C again to quit';
    render();
    // Clear the hint if no second Ctrl+C arrives within the quit window.
    setTimeout(() => {
      if (exiting || renderer.isDestroyed) return;
      if (statusOverride === 'Press Ctrl+C again to quit') {
        statusOverride = '';
        render();
      }
    }, CTRL_C_QUIT_TIMEOUT_MS);
  }

  /** Ctrl+D: exit */
  function handleCtrlD(): void {
    exiting = true;
    session.abortCurrentTurn?.();
    renderer.destroy();
  }

  /** Ctrl+R: raw event stream debug overlay */
  function handleCtrlR(): void {
    const visible = visibleEvents(events, state);
    const rawDump = visible
      .map((ev) => `${ev.class}:${ev.id.slice(0, 8)} ${ev.artifact.type} "${truncateTitle(ev)}"`)
      .join('\n');
    const header = `Raw event stream (${visible.length} events):`;
    eventsVersion++;
    events.push(tuiNote('slash', `${header}\n${rawDump || '(empty)'}`));
    render();
  }

  /** Escape: interrupt / dismiss autocomplete / clear interrupted flag */
  function handleEscape(): void {
    if (busy) {
      session.abortCurrentTurn?.();
      statusOverride = '! Turn interrupted';
      busy = false;
      interrupted = true;
      render();
      return;
    }
    if (autocompleteVisible) {
      autocompleteVisible = false;
      autocompleteDraft = null;
      autocompleteIsFile = false;
      render();
      return;
    }
    if (interrupted) {
      interrupted = false;
      statusOverride = '';
      render();
      return;
    }
  }

  /** Tab: autocomplete completion / cycling */
  function handleTab(shift = false): void {
    if (autocompleteVisible && autocompleteItems.length > 0) {
      if (autocompleteItems.length === 1 || (autocompleteIsFile && shift)) {
        // Accept the (single) selected completion
        const value = autocompleteItems[0] ?? prompt;
        autocompleteVisible = false;
        autocompleteDraft = null;
        autocompleteIsFile = false;
        syncPromptValue(value);
      } else {
        // Cycle through items
        const delta = shift ? -1 : 1;
        autocompleteIndex = (autocompleteIndex + delta + autocompleteItems.length) % autocompleteItems.length;

        // For file/path autocomplete, update prompt live as user cycles
        if (autocompleteIsFile) {
          const value = autocompleteItems[autocompleteIndex] ?? prompt;
          syncPromptValue(value);
        }
      }
      render();
      return;
    }

    // No existing autocomplete — try file/path/@-mention completion
    if (busy) return;
    const inputNode = findNode('synax-input');
    const value = inputNode ? readPromptValue(inputNode) : prompt;
    if (!value.trim()) return;

    const cursorPos = getInputCursorPosition(inputNode);

    const result = getCompletions(value, cursorPos, cwd, repoRoot, options?.settingsConfig);
    if (result && result.items.length > 0) {
      autocompleteItems = result.items;
      autocompleteIndex = 0;
      autocompleteVisible = true;
      autocompleteIsFile = result.kind !== 'slash_command';
      autocompleteDraft = null;

      // If only one match, complete immediately
      if (result.items.length === 1) {
        syncPromptValue(result.items[0] ?? value);
        autocompleteVisible = false;
        autocompleteIsFile = false;
      }
      render();
      return;
    }

    // Fallback: try slash command autocomplete for /-prefixed input
    if (value.startsWith('/')) {
      const slashItems = slashAutocompleteItems(value);
      if (slashItems.length > 0) {
        autocompleteItems = slashItems;
        autocompleteIndex = 0;
        autocompleteVisible = true;
        autocompleteIsFile = false;
        autocompleteDraft = value;
        render();
      }
    }
  }

  function promptValueFromInput(): string {
    const input = renderer.root.findDescendantById('synax-input');
    return input ? readPromptValue(input) : prompt;
  }

  /** Read the cursor offset from the OpenTUI input widget, defaulting to the end of the value. */
  function getInputCursorPosition(input: unknown): number {
    const promptInput = input as { cursorOffset?: number } | undefined;
    return promptInput?.cursorOffset ?? prompt.length;
  }

  function syncPromptValue(value: string): void {
    prompt = value;
    autocompleteDraft = value.startsWith('/') ? value : null;
    promptDirty = true;
    const input = renderer.root.findDescendantById('synax-input');
    if (input) setPromptValue(input, value);
  }

  function slashAutocompleteInputActive(): boolean {
    return autocompleteDraft !== null || autocompleteVisible || promptValueFromInput().startsWith('/');
  }

  function slashAutocompleteValue(): string {
    if (autocompleteDraft !== null) return autocompleteDraft;
    const inputValue = promptValueFromInput();
    if (inputValue.startsWith('/')) return inputValue;
    return prompt.startsWith('/') ? prompt : '';
  }

  function handleSlashAutocompleteEdit(key: {
    name?: string;
    sequence?: string;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
    preventDefault?: () => void;
  }): boolean {
    if (busy || key.ctrl || key.meta || !slashAutocompleteInputActive()) return false;
    if (key.name === 'backspace' || key.name === 'delete') {
      syncPromptValue(slashAutocompleteValue().slice(0, -1));
      autocompleteIndex = 0;
      key.preventDefault?.();
      render('input', { immediate: true });
      return true;
    }
    if (key.name === 'space') {
      syncPromptValue(`${slashAutocompleteValue()} `);
      autocompleteIndex = 0;
      key.preventDefault?.();
      render('input', { immediate: true });
      return true;
    }
    const typed = printableKeyValue(key);
    if (typed) {
      syncPromptValue(`${slashAutocompleteValue()}${typed}`);
      autocompleteIndex = 0;
      key.preventDefault?.();
      render('input', { immediate: true });
      return true;
    }
    return false;
  }

  function handleRawSlashAutocompleteInput(sequence: string): boolean {
    if (busy || settingsState?.active) return false;
    if (autocompleteDraft === null && (sequence !== '/' || promptValueFromInput().length > 0)) return false;

    if (isRawUpSequence(sequence)) {
      if (autocompleteVisible && autocompleteItems.length > 0) {
        autocompleteIndex = (autocompleteIndex - 1 + autocompleteItems.length) % autocompleteItems.length;
        render('input', { immediate: true });
      }
      return true;
    }
    if (isRawDownSequence(sequence)) {
      if (autocompleteVisible && autocompleteItems.length > 0) {
        autocompleteIndex = (autocompleteIndex + 1) % autocompleteItems.length;
        render('input', { immediate: true });
      }
      return true;
    }
    if (sequence === '\r' || sequence === '\n') {
      if (autocompleteVisible && autocompleteItems.length > 0) {
        const selected = autocompleteItems[autocompleteIndex] ?? autocompleteDraft ?? '';
        prompt = selected;
        autocompleteDraft = null;
        promptDirty = true;
        autocompleteVisible = false;
        handleInputSubmit(selected);
      }
      return true;
    }
    if (sequence === '\t' || sequence === '\x1b[9u') {
      handleTab();
      return true;
    }
    if (sequence === '\x1b') {
      autocompleteVisible = false;
      autocompleteDraft = null;
      render('input', { immediate: true });
      return true;
    }
    if (sequence === '\x7f' || sequence === '\b') {
      syncPromptValue(slashAutocompleteValue().slice(0, -1));
      autocompleteIndex = 0;
      render('input', { immediate: true });
      return true;
    }
    if (sequence.length === 1 && sequence >= ' ') {
      syncPromptValue(`${slashAutocompleteValue()}${sequence}`);
      autocompleteIndex = 0;
      render('input', { immediate: true });
      return true;
    }
    return false;
  }

  function handleRawHistoryScrollInput(sequence: string): boolean {
    const parsed = parseInputChunk(sequence);
    const scroll = parsed.find((event) => event.type === 'scroll_history_up' || event.type === 'scroll_history_down');
    if (!scroll) return false;
    scrollArtifactHistory(renderer, scroll.type === 'scroll_history_up' ? -SCROLL_STEP_ROWS : SCROLL_STEP_ROWS);
    render('scroll', { immediate: true });
    return true;
  }

  function handleRawBracketedPasteInput(sequence: string): boolean {
    // Use position-aware matching: the start bracket must appear at or near
    // the beginning of the sequence (after any whitespace).  In cross-chunk
    // mode, rawPasteActive is already true so we don't need to match the start.
    const startIdx = sequence.indexOf('\x1b[200~');
    const endIdx = sequence.indexOf('\x1b[201~');
    const prefix = startIdx >= 0 ? sequence.slice(0, startIdx) : '';
    const startsPaste = startIdx >= 0 && (rawPasteActive || prefix.trim() === '');
    const endsPaste = endIdx >= 0 && (startIdx < 0 || endIdx > startIdx);

    if (!rawPasteActive && !startsPaste) return false;

    if (startsPaste) rawPasteActive = true;

    // Feed the full sequence to the stateful parser.  It handles the
    // bracket protocol correctly across chunks, accumulating text between
    // \e[200~ and \e[201~ and emitting a single `paste` event.
    const parsed = bracketedPasteParser.parse(sequence);

    if (endsPaste) rawPasteActive = false;

    for (const event of parsed) {
      if (event.type === 'paste') {
        appendPasteText(event.value ?? '');
        continue;
      }
      if (event.type === 'text') {
        appendPromptText(event.value ?? '');
        continue;
      }
      if (event.type === 'newline') {
        appendPromptText('\n');
        continue;
      }
      // Ignore submit, escape, tab, backspace, arrow keys, etc. — only
      // paste-mode events are relevant during bracketed paste handling.
      // Trailing newlines after \e[201~ would otherwise trigger accidental
      // sends on the user's behalf.
    }
    render('input', { immediate: true });
    return true;
  }

  /** Autocomplete up/down navigation */
  function handleAutocompleteNav(key: { name: string; preventDefault?: () => void }): void {
    if (isUpKey(key.name)) {
      autocompleteIndex = (autocompleteIndex - 1 + autocompleteItems.length) % autocompleteItems.length;
    } else {
      autocompleteIndex = (autocompleteIndex + 1) % autocompleteItems.length;
    }
    key.preventDefault?.();
    render('input', { immediate: true });
  }

  /** Vertical arrow navigation: prompt cursor or artifact scroll */
  function handleVerticalNav(key: { name: string; preventDefault?: () => void }, input: unknown): void {
    if (key.name === 'up') {
      if (movePromptCursorVertically(input, 'up')) {
        key.preventDefault?.();
        render();
        return;
      }
      scrollArtifactHistory(renderer, -SCROLL_STEP_ROWS);
      key.preventDefault?.();
      render();
      return;
    }
    if (key.name === 'down') {
      if (movePromptCursorVertically(input, 'down')) {
        key.preventDefault?.();
        render();
        return;
      }
      scrollArtifactHistory(renderer, SCROLL_STEP_ROWS);
      key.preventDefault?.();
      render();
      return;
    }
  }

  /** Page up / page down: artifact scroll by page */
  function handlePageNav(key: { name: string; preventDefault?: () => void }): void {
    if (key.name === 'pageup') {
      scrollArtifactHistory(renderer, -Math.max(10, Math.floor(renderer.height * SCROLL_PAGE_FACTOR)));
    } else {
      scrollArtifactHistory(renderer, Math.max(10, Math.floor(renderer.height * SCROLL_PAGE_FACTOR)));
    }
    key.preventDefault?.();
    render();
  }

  renderer.prependInputHandler(handleRawBracketedPasteInput);
  renderer.prependInputHandler(handleRawSlashAutocompleteInput);
  renderer.prependInputHandler(handleRawHistoryScrollInput);

  renderer.keyInput.on('keypress', (key) => {
    // ── Suppress all keypress events during raw bracketed paste ──────
    // When the raw input handler (prependInputHandler) is actively
    // processing a bracketed paste, individual keypress events must be
    // ignored to prevent double-insertion and to stop newlines from
    // triggering submit, tab-completion, or other keybindings.
    if (rawPasteActive) return;

    // --- Ctrl+C: double-press ---
    if (key.ctrl && key.name === 'c') {
      const input = renderer.root.findDescendantById('synax-input');
      const currentPrompt = input ? readPromptValue(input) : prompt;
      const behavior = resolveCtrlCBehavior({
        prompt: currentPrompt,
        busy,
        previousPressAtMs: ctrlCPressedAt,
        nowMs: Date.now(),
      });
      handleCtrlC(input, behavior);
      return;
    }

    // --- Ctrl+D: exit ---
    if (key.ctrl && key.name === 'd') {
      handleCtrlD();
      return;
    }

    // --- Ctrl+R: raw event stream debug overlay ---
    if (key.ctrl && key.name === 'r') {
      handleCtrlR();
      return;
    }

    if (key.ctrl && key.name === 'o') {
      const id = activeThinkingEventId ?? latestThinkingEventId(events);
      if (id) {
        expandedState[id] = !expandedState[id];
        tuiStats.recordExpandToggle();
        expandCollapseVersion++;
        render('input', { immediate: true });
      }
      return;
    }

    if (handleSettingsKey(key)) {
      return;
    }

    // --- Resume picker navigation ---
    if (resumePickerState?.active) {
      if (isEscapeKey(key.name)) {
        resumePickerState = null;
        treeBuilt = false;
        key.preventDefault?.();
        render('input', { immediate: true });
        return;
      }
      if (isUpKey(key.name)) {
        resumePickerState = resumePickerReducer(resumePickerState, { type: 'move_up' });
        key.preventDefault?.();
        render('input', { immediate: true });
        return;
      }
      if (isDownKey(key.name)) {
        resumePickerState = resumePickerReducer(resumePickerState, { type: 'move_down' });
        key.preventDefault?.();
        render('input', { immediate: true });
        return;
      }
      if (isEnterKey(key.name)) {
        const selected = resumePickerState.filtered[resumePickerState.selectedRow];
        if (selected) {
          const report = session.resumeSession?.(selected.id);
          if (report?.ok) {
            events = [];
            eventsVersion = 0;
            state = createInitialRunStateSnapshot(Date.now());
            options?.resetLastModelOutput?.();
            slashInfoLines = [
              `Resumed ${selected.title || selected.id}`,
              `${report.restoredMessages} message${report.restoredMessages === 1 ? '' : 's'} restored from ${report.eventsRead} event${report.eventsRead === 1 ? '' : 's'}.`,
            ];
          } else {
            slashInfoLines = [`Resume failed: ${report?.error ?? 'session could not be restored'}`];
          }
        }
        resumePickerState = null;
        treeBuilt = false;
        key.preventDefault?.();
        render('input', { immediate: true });
        return;
      }
      if (isTabKey(key.name)) {
        resumePickerState = resumePickerReducer(resumePickerState, { type: 'toggle_sort' });
        key.preventDefault?.();
        render('input', { immediate: true });
        return;
      }
      if (key.name === 'backspace' || key.name === 'delete') {
        resumePickerState = resumePickerReducer(resumePickerState, {
          type: 'search',
          query: resumePickerState.searchQuery.slice(0, -1),
        });
        key.preventDefault?.();
        render('input', { immediate: true });
        return;
      }
      const searchChar = printableKeyValue(key);
      if (searchChar) {
        resumePickerState = resumePickerReducer(resumePickerState, {
          type: 'search',
          query: `${resumePickerState.searchQuery}${searchChar}`,
        });
        key.preventDefault?.();
        render('input', { immediate: true });
        return;
      }
      // Ignore other keys while picker is active
      return;
    }

    // --- Escape ---
    if (key.name === 'escape') {
      handleEscape();
      return;
    }

    // --- Tab: autocomplete ---
    if (isTabKey(key.name)) {
      handleTab(key.name === 'shift_tab');
      return;
    }

    // --- e (empty prompt only): expand/collapse the latest expandable card.
    // Gated on an empty prompt so typing words containing "e" never toggles cards.
    if (key.name === 'e' && !key.ctrl && !key.shift && !key.meta && !busy && promptValueFromInput() === '') {
      const id = latestExpandableEventId(visibleEvents(events, state));
      if (id) {
        expandedState[id] = !expandedState[id];
        tuiStats.recordExpandToggle();
        expandCollapseVersion++;
        key.preventDefault?.();
        render();
        return;
      }
    }

    // --- Enter (empty prompt only): expand/collapse truncated card.
    // When the prompt has text, Enter must always submit — never toggle cards.
    if (
      isEnterKey(key.name) &&
      !busy &&
      !autocompleteVisible &&
      !pasteActive &&
      !key.shift &&
      !key.ctrl &&
      promptValueFromInput().trim() === ''
    ) {
      const id = latestExpandableEventId(visibleEvents(events, state));
      if (id) {
        expandedState[id] = !expandedState[id];
        tuiStats.recordExpandToggle();
        expandCollapseVersion++;
        key.preventDefault?.();
        render();
        return;
      }
    }

    // --- Ctrl+E: toggle all expandable cards ---
    if (key.ctrl && key.name === 'e' && !busy) {
      const visible = visibleEvents(events, state);
      const expandable = visible.filter(
        (e) =>
          e.class === 'tool_result' &&
          e.artifact.type === 'text' &&
          e.artifact.body.split('\n').length > TOOL_PREVIEW_LINES,
      );
      const allExpanded = expandable.every((e) => expandedState[e.id]);
      for (const e of expandable) {
        expandedState[e.id] = !allExpanded;
      }
      tuiStats.recordExpandToggle();
      expandCollapseVersion++;
      render();
      return;
    }

    // --- Autocomplete navigation ---
    if (isUpKey(key.name) && autocompleteVisible && autocompleteItems.length > 0) {
      handleAutocompleteNav(key);
      return;
    }
    if (isDownKey(key.name) && autocompleteVisible && autocompleteItems.length > 0) {
      handleAutocompleteNav(key);
      return;
    }

    if (handleSlashAutocompleteEdit(key)) {
      return;
    }

    // --- Prompt navigation / history scrolling ---
    if (isUpKey(key.name)) {
      const input = renderer.root.findDescendantById('synax-input');
      handleVerticalNav(key, input);
      return;
    }
    if (isDownKey(key.name)) {
      const input = renderer.root.findDescendantById('synax-input');
      handleVerticalNav(key, input);
      return;
    }
    if (key.name === 'pageup') {
      handlePageNav(key);
      return;
    }
    if (key.name === 'pagedown') {
      handlePageNav(key);
      return;
    }

    // --- Steering during busy ---
    if (busy) {
      const dispatchBusySlashCommand = (): boolean => {
        const steeringCommandName = steeringBuffer.startsWith('/')
          ? (steeringBuffer.slice(1).split(/\s+/, 1)[0] ?? '')
          : '';
        const steeringCommand = steeringCommandName ? getCommand(steeringCommandName) : undefined;
        if (!steeringCommand) return false;
        if (steeringCommand.opensSettings) {
          openSettings(steeringCommand.name);
        } else {
          handleSlashDuringBusy(steeringBuffer);
        }
        steeringBuffer = '';
        render();
        return true;
      };

      if (dispatchBusySlashCommand()) {
        return;
      }
      if (key.name === 'slash' || (key.shift && key.name === '7')) {
        steeringBuffer += '/';
        if (dispatchBusySlashCommand()) return;
        render();
        return;
      }
      if (key.name === 'backspace') {
        steeringBuffer = steeringBuffer.slice(0, -1);
        key.preventDefault();
        render();
        return;
      }
      if (key.name === 'enter' || key.name === 'return') {
        if (key.shift) {
          steeringBuffer += '\n';
          key.preventDefault();
          render();
          return;
        }
        if (steeringBuffer.trim()) {
          const text = steeringBuffer;
          steeringBuffer = '';
          key.preventDefault();
          session.abortCurrentTurn?.();
          statusOverride = '! Aborted, submitting steering...';
          render();
          submitSteering(text).catch(() => {});
          return;
        }
        key.preventDefault();
        return;
      }
      if (key.name === 'space') {
        steeringBuffer += ' ';
        key.preventDefault();
        if (dispatchBusySlashCommand()) return;
        render();
        return;
      }
      if (key.name && key.name.length === 1 && !key.ctrl && !key.shift) {
        steeringBuffer += key.name;
        key.preventDefault();
        if (dispatchBusySlashCommand()) return;
        render();
        return;
      }
      return;
    }

    // --- Bracket paste detection ---
    if (key.name === 'paste' || (key.sequence && key.sequence.startsWith('\x1b[200~'))) {
      pasteActive = true;
      pasteBuffer = '';
      key.preventDefault();
      return;
    }
    if (pasteActive && key.sequence && key.sequence.startsWith('\x1b[201~')) {
      pasteActive = false;
      const input = renderer.root.findDescendantById('synax-input');
      if (pasteBuffer.length > 0) {
        pasteBlockCount++;
        pasteBlocks.push({ blockNumber: pasteBlockCount, charCount: pasteBuffer.length });
        const currentPrompt = input ? readPromptValue(input) : prompt;
        const newPrompt = currentPrompt + pasteBuffer;
        if (input) setPromptValue(input, newPrompt);
        prompt = prompt + pasteBuffer;
      }
      autocompleteDraft = null;
      promptDirty = true;
      pasteBuffer = '';
      render();
      return;
    }
    if (pasteActive) {
      if (isEnterKey(key.name) || key.name === 'enter') {
        pasteBuffer += '\n';
        key.preventDefault();
        return;
      }
      // Use key.sequence for printable characters — this handles
      // multi-byte UTF-8, emoji, and other non-ASCII input that
      // `key.name` alone would miss or mangle.
      if (key.sequence && key.sequence.length === 1 && key.sequence >= ' ' && key.sequence !== '\x7f') {
        pasteBuffer += key.sequence;
        key.preventDefault();
        return;
      }
      // Fallback for terminals that only set key.name
      if (key.name && key.name.length === 1 && key.name >= ' ' && key.name !== '\x7f') {
        pasteBuffer += key.name;
        return;
      }
      // Eat all other keys during paste (includes control chars, escapes, etc.)
      return;
    }

    // --- Enter with autocomplete visible: complete selection ---
    if (isEnterKey(key.name) && autocompleteVisible && !busy) {
      if (autocompleteItems.length > 0) {
        const selected = autocompleteItems[autocompleteIndex] ?? prompt;
        if (autocompleteIsFile) {
          // File/path autocomplete: insert the completion without submitting
          autocompleteVisible = false;
          autocompleteIsFile = false;
          autocompleteDraft = null;
          syncPromptValue(selected);
          key.preventDefault();
          return;
        }
        prompt = selected;
        autocompleteDraft = null;
        promptDirty = true;
        autocompleteVisible = false;
        handleInputSubmit(selected);
        key.preventDefault();
        return;
      }
    }

    // --- Enter: submit prompt ---
    if (isEnterKey(key.name) && !busy && !autocompleteVisible && !pasteActive && !key.shift) {
      const input = renderer.root.findDescendantById('synax-input');
      const value = input ? readPromptValue(input) : prompt;
      if (value.trim()) {
        handleInputSubmit(value);
      }
      key.preventDefault();
      return;
    }
  });

  let resizeDebounce: ReturnType<typeof setTimeout> | null = null;

  renderer.on('resize', () => {
    // Coalesce rapid resize events (e.g. corner drag) to avoid flicker.
    if (resizeDebounce) clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      resizeDebounce = null;
      treeBuilt = false;
      feedModel.reset();
      render('resize', { immediate: true });
    }, 100);
  });
  renderer.start();
  doRender();

  await new Promise<void>((resolve) => {
    renderer.on('destroy', resolve);
  });

  renderScheduler.dispose();
  if (animationTimer) clearTimeout(animationTimer);
  if (resizeDebounce) clearTimeout(resizeDebounce);
  stdout.write(DISABLE_BRACKETED_PASTE);
  session.setEventSink?.(null);
}

export {
  slashAutocompleteItems,
  movePromptCursorVertically,
  scrollArtifactHistory,
  resolveCtrlCBehavior,
  latestExpandableEventId,
} from './key-handlers';

function eventRenderReason(event: import('../agent/events').AgentEvent): DirtyReason {
  if (event.type === 'error') return 'error';
  if (event.type === 'task_finished') return 'completion';
  if (
    event.type === 'verification_failed' ||
    event.type === 'verification_passed' ||
    event.type === 'verification_skipped'
  ) {
    return 'completion';
  }
  return event.type === 'model_step_started' ? 'status' : 'semantic';
}

function shouldFlushEventPromptly(event: import('../agent/events').AgentEvent): boolean {
  return (
    event.type === 'error' ||
    event.type === 'task_finished' ||
    event.type === 'verification_failed' ||
    event.type === 'verification_passed' ||
    event.type === 'verification_skipped'
  );
}

export function shouldHideCompletionResultCard(
  event: import('../agent/events').AgentEvent,
  hasAssistantResultThisTurn: boolean,
): boolean {
  return event.type === 'task_finished' && event.status === 'completed' && hasAssistantResultThisTurn;
}

async function loadOpenTuiCore(): Promise<OpenTuiCore> {
  const importer = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<OpenTuiCore>;
  try {
    return await importer('@opentui/core');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('bun-ffi-structs') || message.includes('node:ffi')) {
      throw new Error(
        [
          'OpenTUI is installed, but this JavaScript runtime cannot load its native core.',
          'Run Synax with Bun, or with a Node build that supports node:ffi and the flags --experimental-ffi --allow-ffi.',
          'Installing Zig is only needed when building OpenTUI native artifacts; it does not add node:ffi support to Node.',
        ].join(' '),
      );
    }
    throw error;
  }
}

function visibleEvents(events: SemanticEvent[], state: RunStateSnapshot): SemanticEvent[] {
  if (events.length > 0) return events;
  return semanticEventsFromDebugHistory(state);
}

function latestThinkingEventId(events: SemanticEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.class === 'thinking') return event.id;
  }
  return undefined;
}

function railState(
  state: RunStateSnapshot,
  options?: {
    modelLabel?: string;
    endpointLabel?: string;
    providerName?: string;
    cwdLabel?: string;
    gitBranch?: string;
  },
  checkpoints?: CheckpointRailEntry[],
  pendingApprovals = 0,
): ArtifactRailState {
  const contextLabel =
    state.contextUsedTokens !== undefined && state.contextWindowTokens
      ? `${Math.round((state.contextUsedTokens / state.contextWindowTokens) * 100)}%`
      : undefined;
  return {
    model: options?.modelLabel ?? state.modelId,
    branch: options?.gitBranch,
    cwd: options?.cwdLabel,
    filesTouched: unique([...state.filesChangedThisRun, ...state.changes.items.map((item) => item.path)]),
    costLabel: state.sessionSpendLabel ?? formatCost(state.sessionCostUsd),
    contextLabel,
    uptimeLabel: elapsed(state.startedAtMs, state.nowMs),
    provider: options?.providerName ?? state.providerName,
    endpoint: options?.endpointLabel,
    recentCheckpoints: checkpoints,
    pendingApprovals,
  };
}

function activitySummary(state: RunStateSnapshot): string {
  if (state.phase === 'verifying') {
    return state.verification.currentCheckLabel ? clip(state.verification.currentCheckLabel, 58) : 'running checks';
  }

  const latest = state.timeline[state.timeline.length - 1]?.summary ?? '';
  const cleaned = cleanActivitySummary(latest);

  if (state.phase === 'tool_execution') {
    return clip(cleaned || toolNameFromStatus(state.statusNote) || 'running tool', 58);
  }

  if (state.phase === 'thinking') {
    if (/^Tool\s*·/i.test(latest)) {
      return clip(`reviewing ${cleaned || 'tool'} result`, 58);
    }
    if (/verification/i.test(latest)) {
      return clip(cleaned || 'reviewing checks', 58);
    }
    if (cleaned && !/objective registered/i.test(cleaned) && !/^step\s+\d+/i.test(cleaned)) {
      return clip(cleaned, 58);
    }
    return clip(state.objective.nextCheckpoint || 'awaiting model response', 58);
  }

  return clip(cleaned || state.objective.nextCheckpoint || 'working', 58);
}

export function activityLineActive(
  state: Pick<RunStateSnapshot, 'terminal' | 'phase'>,
  busy: boolean,
  statusOverride: string,
): boolean {
  return (
    statusOverride !== '' ||
    busy ||
    (state.terminal === 'running' && state.phase !== 'idle' && state.phase !== 'completed')
  );
}

/**
 * Compute the orchestration step text for the activity line.
 * Separated from the rendering closure so it can be unit-tested directly.
 */
export function computeOrchestrationStepText(
  mode: 'parallel' | 'sequential' | null,
  activeCount: number,
  returnedCount: number,
  totalSteps: number,
): string {
  if (mode === 'sequential') {
    const step = returnedCount + 1;
    const total = totalSteps > 0 ? totalSteps : activeCount + returnedCount;
    return `step ${step}/${total} running`;
  }
  const total = activeCount + returnedCount;
  return `${returnedCount}/${total} agents returned`;
}

function cleanActivitySummary(summary: string): string {
  return summary
    .replace(/^Working\s*·\s*/i, '')
    .replace(/^Tool\s*·\s*/i, '')
    .replace(/\s+ok$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toolNameFromStatus(statusNote?: string): string {
  return (statusNote ?? '').replace(/^tool:\s*/i, '').trim();
}

/**
 * Build the context usage + cost line shown below the prompt input.
 * Returns undefined when no data is available (before the first model call).
 */
function buildContextInfo(state: RunStateSnapshot, barWidth: number): string | undefined {
  const used = state.contextUsedTokens;
  const total = state.contextWindowTokens;
  if (used === undefined || total === undefined || total <= 0) return undefined;

  const pct = Math.min(100, Math.round((used / total) * 100));
  const filled = Math.round((pct / 100) * barWidth);
  const empty = barWidth - filled;
  const bar = `▐${'█'.repeat(filled)}${'░'.repeat(empty)}▌`;

  const usedFmt = used.toLocaleString();
  const totalFmt = total.toLocaleString();
  const countPart = `${usedFmt}/${totalFmt} (${pct}%)`;

  const cost = buildCostSuffix(state);
  return cost ? `${bar} ${countPart}  ·  ${cost}` : `${bar} ${countPart}`;
}

/** Build a compact cost suffix from session pricing data. */
function buildCostSuffix(state: RunStateSnapshot): string | undefined {
  const spend = state.sessionSpendLabel;
  if (spend === undefined || spend === '$0.00') return undefined;
  const inPrice = state.inputPricePer1MTokens;
  const outPrice = state.outputPricePer1MTokens;
  if (inPrice !== undefined && outPrice !== undefined) {
    return `${spend}  ·  $${inPrice.toFixed(0)}/M in  $${outPrice.toFixed(0)}/M out`;
  }
  return `${spend} this session`;
}

function footerState({
  state,
  prompt,
  busy,
  statusOverride,
  steeringBuffer,
  terminalWidth,
  options,
  busyAnimationFrame,
}: {
  state: RunStateSnapshot;
  prompt: string;
  busy: boolean;
  statusOverride: string;
  steeringBuffer?: string;
  terminalWidth?: number;
  options?: {
    modelLabel?: string;
    cwdLabel?: string;
    gitBranch?: string;
  };
  busyAnimationFrame: number;
}): FooterState {
  void busyAnimationFrame;
  const inputHeight = promptInputHeight(prompt, terminalWidth);
  const hints = '';
  void options;

  // Build context usage + cost line shown below the prompt input.
  const contextBarWidth = Math.min(24, Math.max(8, (terminalWidth ?? 80) - 52));
  const contextInfo = buildContextInfo(state, contextBarWidth);

  if (statusOverride) {
    return {
      status: statusOverride,
      prompt,
      placeholder: 'Ask Synax...',
      hints,
      inputHeight,
      contextInfo,
    };
  }
  if (state.phase === 'blocked') {
    return {
      status: `! ${state.objective.nextCheckpoint}`,
      prompt,
      placeholder: 'Type a message to continue...',
      hints,
      inputHeight,
      contextInfo,
    };
  }
  if (state.phase === 'tool_execution') {
    const steerHint = steeringBuffer ? ` [Steering: ${clip(steeringBuffer, 40)}]` : '';
    return {
      status: `Working · ${activitySummary(state)}${steerHint}`,
      prompt,
      placeholder: 'Steer Synax after the next tool result...',
      hints,
      inputHeight,
      contextInfo,
    };
  }
  if (busy || state.phase === 'thinking') {
    const steerHint = steeringBuffer ? ` [Steering: ${clip(steeringBuffer, 40)}]` : '';
    return {
      status: `Thinking · ${activitySummary(state)}${steerHint}`,
      prompt,
      placeholder: 'Synax is working… input paused',
      hints: '',
      inputHeight,
      contextInfo,
    };
  }
  if (state.phase === 'error') {
    return {
      status: `x ${state.terminalIssue ?? 'Error'}`,
      prompt,
      placeholder: 'Ask Synax how to recover...',
      hints,
      inputHeight,
      contextInfo,
    };
  }
  if (state.phase === 'completed') {
    return {
      status: `✓ Task complete. ${state.filesChangedThisRun.length} files, ${state.toolInvocationCount} tools.`,
      prompt,
      placeholder: 'Continue...',
      hints,
      inputHeight,
      contextInfo,
    };
  }
  if (state.phase === 'budget_exhausted') {
    return {
      status: `! Budget exhausted: ${state.objective.nextCheckpoint}`,
      prompt,
      placeholder: 'Respond or adjust settings...',
      hints,
      inputHeight,
      contextInfo,
    };
  }
  return {
    status: 'Ready.',
    prompt,
    placeholder: 'Ask Synax to inspect, edit, test, or commit...',
    hints,
    inputHeight,
    contextInfo,
  };
}

function settingsTabForCommand(commandName: string): SettingsTab | undefined {
  if (commandName === 'model') return 'model';
  if (commandName === 'providers' || commandName === 'login') return 'providers';
  if (commandName === 'skills') return 'skills';
  if (commandName === 'mcp') return 'mcp';
  return undefined;
}

function autocompleteMaxVisibleRows(terminalHeight: number, inputHeight?: number): number {
  const footerRows = 3 + (inputHeight ?? 1);
  return Math.max(4, Math.min(12, terminalHeight - footerRows - 4));
}

function autocompleteWindowStart(selectedIndex: number, itemCount: number, windowSize: number): number {
  if (itemCount <= windowSize) return 0;
  const clampedSelected = Math.max(0, Math.min(selectedIndex, itemCount - 1));
  const halfWindow = Math.floor(windowSize / 2);
  return Math.max(0, Math.min(clampedSelected - halfWindow, itemCount - windowSize));
}

function isUpKey(name: string | undefined): boolean {
  return name === 'up' || name === 'arrow_up' || name === 'arrowup';
}

function isDownKey(name: string | undefined): boolean {
  return name === 'down' || name === 'arrow_down' || name === 'arrowdown';
}

function isEnterKey(name: string | undefined): boolean {
  return name === 'enter' || name === 'return' || name === 'linefeed';
}

function isTabKey(name: string | undefined): boolean {
  return name === 'tab' || name === 'shift_tab' || name === 'shifttab';
}

function isEscapeKey(name: string | undefined): boolean {
  return name === 'escape' || name === 'esc';
}

function isRawUpSequence(sequence: string): boolean {
  const withoutEsc = stripEscapePrefix(sequence);
  return (
    sequence === '\x1b[A' ||
    sequence === '\x1bOA' ||
    sequence === '\x1b[a' ||
    sequence === '\x1bOa' ||
    sequence === '\x1bp' ||
    isCsiArrowSequence(withoutEsc, 'A') ||
    isKittyArrowSequence(withoutEsc, '57352')
  );
}

function isRawDownSequence(sequence: string): boolean {
  const withoutEsc = stripEscapePrefix(sequence);
  return (
    sequence === '\x1b[B' ||
    sequence === '\x1bOB' ||
    sequence === '\x1b[b' ||
    sequence === '\x1bOb' ||
    sequence === '\x1bn' ||
    isCsiArrowSequence(withoutEsc, 'B') ||
    isKittyArrowSequence(withoutEsc, '57353')
  );
}

function stripEscapePrefix(sequence: string): string {
  return sequence.charCodeAt(0) === 27 ? sequence.slice(1) : sequence;
}

function isCsiArrowSequence(sequence: string, suffix: 'A' | 'B'): boolean {
  if (!sequence.startsWith('[') || !sequence.endsWith(suffix)) return false;
  const body = sequence.slice(1, -1);
  return body === '' || body === '1;' || body.split(';').every((part) => part === '' || /^\d+$/.test(part));
}

function isKittyArrowSequence(sequence: string, code: '57352' | '57353'): boolean {
  if (!sequence.startsWith('[') || !sequence.endsWith('u')) return false;
  const body = sequence.slice(1, -1);
  if (body === code) return true;
  return (
    body.startsWith(`${code};`) &&
    body
      .slice(code.length + 1)
      .split(';')
      .every((part) => /^\d+$/.test(part))
  );
}

function printableKeyValue(key: { name?: string; sequence?: string; shift?: boolean }): string {
  if (key.sequence && key.sequence.length === 1 && key.sequence >= ' ' && key.sequence !== '\x7f') {
    return key.sequence;
  }
  if (key.name === 'slash') return '/';
  if (!key.name || key.name.length !== 1) return '';
  return key.shift ? key.name.toUpperCase() : key.name;
}

function sessionsForCurrentWorkspace<T extends { workspacePath?: string; repoRoot?: string }>(
  sessions: T[],
  repoRoot: string,
): T[] {
  return sessions.filter((session) => {
    const workspace = session.workspacePath ?? session.repoRoot;
    return !workspace || workspace === repoRoot;
  });
}

function stableFooterSignature(footer: FooterState): string {
  const locationKey = footer.location ? 'location' : 'no-loc';
  const ctxKey = footer.contextInfo ? 'ctx' : 'noctx';
  return `${locationKey}:${ctxKey}`;
}

function rootLayoutModeSignature(args: {
  visibleEventCount: number;
  footer: FooterState;
  settingsActive: boolean;
  slashInfoActive: boolean;
  terminalWidth: number;
  terminalHeight: number;
}): string {
  const compactStartup =
    args.visibleEventCount === 0 && !args.settingsActive && !args.slashInfoActive && args.footer.status === 'Ready.';
  const mode = compactStartup ? 'compact' : 'full';
  return [mode, String(args.slashInfoActive), String(args.terminalWidth), String(args.terminalHeight)].join('\0');
}

function elapsed(startedAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
}

function formatCost(cost?: number): string | undefined {
  if (cost === undefined) return undefined;
  return `$${cost.toFixed(4)}`;
}

function providerNameFromEndpoint(endpoint: string): string | undefined {
  if (!endpoint) return undefined;
  if (endpoint.includes('127.0.0.1') || endpoint.includes('localhost')) return 'local';
  if (endpoint.includes('openai')) return 'openai';
  return 'openai-compatible';
}

function isLocalEndpoint(endpoint: string): boolean {
  return endpoint.includes('127.0.0.1') || endpoint.includes('localhost') || endpoint.includes('0.0.0.0');
}
