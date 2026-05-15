import {
  applyEventToRunState,
  advanceClock,
  createInitialRunStateSnapshot,
  type RunStateSnapshot,
} from '../agent/tui-state';
import { isSecretTrigger } from '../backrooms/trigger';
import type { ChatSession } from '../commands/chat';
import type { EffectiveSynaxConfig } from '../config/schema';
import { renderSettings } from '../settings/settings-renderer';
import { createSettingsState, settingsReducer } from '../settings/settings-state';
import { getCommand } from '../settings/slash-command-registry';
import type { InputStreamLike } from './terminal';
import type { Writable } from 'node:stream';
import {
  renderArtifactRoot,
  renderArtifactCard,
  promptInputHeight,
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
import { MAX_TRANSCRIPT_EVENTS, TRANSIENT_EVENT_TYPES, SCROLL_STEP_ROWS, SCROLL_PAGE_FACTOR } from './tui-constants';

type OpenTuiCore = typeof import('@opentui/core');

import {
  resolveCtrlCBehavior,
  latestExpandableEventId,
  slashAutocompleteItems,
  movePromptCursorVertically,
  scrollArtifactHistory,
  readPromptValue,
  setPromptValue,
  splashFrame,
  clip,
  stripAnsi,
  truncateTitle,
  getThemeNames,
  unique,
  tuiNote,
} from './key-handlers';

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
    cwdLabel?: string;
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

  let state: RunStateSnapshot = createInitialRunStateSnapshot(Date.now());
  let events: SemanticEvent[] = [];
  let prompt = '';
  let busy = false;
  let exiting = false;
  let statusOverride = options?.blockedMessage ? `! Blocked: ${options.blockedMessage}` : '';

  // --- Theme ---
  const themeMode: 'dark' | 'light' = (await detectThemeMode(renderer as any)) ?? 'dark';
  let currentPalette: TuiPalette = getPalette(options?.blockedMessage ? 'default' : themeMode);

  // --- Keyboard shortcut state ---
  let ctrlCPressedAt: number | null = null;
  let steeringBuffer = '';
  let autocompleteItems: string[] = [];
  let autocompleteIndex = 0;
  let autocompleteVisible = false;
  let interrupted = false;
  let pasteBuffer = '';
  let pasteActive = false;
  let expandCollapseVersion = 0;
  let promptDirty = false;
  let layoutDirty = false;

  // --- Expanded state for cards ---
  const expandedState: ExpandedState = {};

  // --- Recent checkpoints ---
  let recentCheckpoints: CheckpointInfo[] = [];
  let lastCheckpointFileCount = 0;

  // --- Persistent status card state ---
  let statusEvent: SemanticEvent | null = null;
  const activeSubAgents: string[] = [];
  let lastStatusLabel = '';
  let lastStatusDetail = '';

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
  };
  applyOptionsToState();
  let treeBuilt = false;
  let eventsVersion = 0;
  let lastRenderedEventsVersion = -1;
  let lastRenderedSplashFrame = -1;
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
    promptDirty = true;
    void submit(text);
  };

  const doRender = (): void => {
    if (exiting || renderer.isDestroyed) return;
    state = advanceClock(state, Date.now());

    // Sync persistent status card at the bottom of the transcript
    syncStatusCard();

    // Keep autocomplete in sync with every prompt edit, including backspace.
    const inputForAutocomplete = renderer.root.findDescendantById('synax-input');
    const currentInputValue = inputForAutocomplete ? readPromptValue(inputForAutocomplete) : prompt;
    if (currentInputValue.startsWith('/') && !busy) {
      autocompleteItems = slashAutocompleteItems(currentInputValue);
      autocompleteIndex = Math.min(autocompleteIndex, Math.max(0, autocompleteItems.length - 1));
      autocompleteVisible = autocompleteItems.length > 0;
    } else {
      autocompleteItems = [];
      autocompleteIndex = 0;
      autocompleteVisible = false;
    }

    const pendingApprovals = events.filter((e) => e.class === 'approval').length;
    const rail = railState(
      state,
      options,
      recentCheckpoints.map((c) => ({ title: c.title, hash: c.hash })),
      pendingApprovals,
    );
    const footer = footerState({
      state,
      prompt,
      busy,
      statusOverride,
      steeringBuffer,
      terminalWidth: renderer.width,
      options,
    });
    const acState: AutocompleteState | undefined = autocompleteVisible
      ? { visible: true, items: autocompleteItems, selectedIndex: autocompleteIndex }
      : undefined;
    if (!treeBuilt) {
      removeRenderedRoot();
      renderer.root.add(
        renderArtifactRoot(
          core,
          visibleEvents(events, state),
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
          handleInputSubmit,
          (value) => {
            prompt = value;
            render('input');
          },
          { frame: splashFrame(state.nowMs) },
        ),
      );
      treeBuilt = true;
      lastRenderedEventsVersion = eventsVersion;
      lastRenderedSplashFrame = splashFrame(state.nowMs);
      expandCollapseVersion = 0;
      feedModel.reset();
      feedModel.plan(visibleEvents(events, state), expandedState);
      // Focus the Input once after initial tree build
      queueMicrotask(() => renderer.root.findDescendantById('synax-input')?.focus());
    } else {
      setNodeContent('synax-status', footer.status);
      setNodeContent('synax-hints', footer.hints);
      if (footer.location) setNodeContent('synax-location', footer.location);
      setNodeContent('synax-rail-files', `Files (${rail.filesTouched.length})`);
      setNodeContent('synax-rail-context', `Context: ${rail.contextLabel ?? 'n/a'}`);
      setNodeContent('synax-rail-cost', `Cost: ${rail.costLabel ?? 'local'}`);
      setNodeContent('synax-rail-uptime', `Uptime: ${rail.uptimeLabel}`);
      setNodeContent('synax-rail-model', rail.model ? clip(rail.model, 22) : '');
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
      }
      const footerNode = findNode('synax-footer');
      if (footerNode && 'height' in (footerNode as any)) {
        const newFooterHeight = 3 + (footer.inputHeight ?? promptInputHeight(prompt, renderer.width));
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
    }
    tuiStats.recordRepaint();
    tuiStats.recordFrame(renderScheduler.getStats());
    renderer.requestRender();

    function findNode(id: string): any {
      return renderer.root.findDescendantById(id);
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
        (node as any).content = content;
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
      for (let i = 0; i < 10; i++) {
        const row = findNode(`synax-autocomplete-row-${i}`);
        if (!row) continue;
        const item = autocompleteItems[i] ?? '';
        const isSelected = i === autocompleteIndex;
        (row as any).content = item ? (isSelected ? `> ${item}` : `  ${item}`) : '';
        if ('fg' in (row as any)) {
          (row as any).fg = isSelected ? currentPalette.brand : currentPalette.textAccent;
        }
      }
    }
  };

  // ─── Persistent status card at bottom of transcript ──────────

  const removeStatusCard = (): void => {
    if (!statusEvent) return;
    const idx = events.indexOf(statusEvent);
    if (idx >= 0) events.splice(idx, 1);
    statusEvent = null;
    lastStatusLabel = '';
    lastStatusDetail = '';
    eventsVersion++;
  };

  const syncStatusCard = (): void => {
    const needsCard =
      statusOverride !== '' || (state.terminal === 'running' && state.phase !== 'idle' && state.phase !== 'completed');

    if (!needsCard) {
      removeStatusCard();
      return;
    }

    let label: string;
    let detail: string;

    if (statusOverride) {
      label = statusOverride;
      detail = '';
    } else if (activeSubAgents.length > 0) {
      label = `◉ Orchestrating sub-agents: ${activeSubAgents.join(', ')}`;
      detail = '';
    } else if (state.phase === 'thinking') {
      label = `○ Thinking${state.modelId ? ` (${state.modelId})` : ''}`;
      detail = '';
    } else if (state.phase === 'tool_execution') {
      label = `$ Running tool (${elapsed(state.startedAtMs, state.nowMs)})`;
      const lastTimelineItem = state.timeline[state.timeline.length - 1];
      detail = lastTimelineItem?.summary
        ? lastTimelineItem.summary.length > 50
          ? `${lastTimelineItem.summary.slice(0, 47)}...`
          : lastTimelineItem.summary
        : '';
    } else if (state.phase === 'verifying') {
      label = '✓ Verifying';
      detail = state.verification.currentCheckLabel || '';
    } else if (state.phase === 'error') {
      label = '✗ Error';
      detail = state.terminalIssue ?? '';
    } else if (state.phase === 'blocked') {
      label = '! Blocked';
      detail = state.objective.nextCheckpoint;
    } else if (state.phase === 'budget_exhausted') {
      label = '! Budget exhausted';
      detail = state.objective.nextCheckpoint;
    } else {
      label = '... Working';
      detail = '';
    }

    if (label === lastStatusLabel && detail === lastStatusDetail) return;

    lastStatusLabel = label;
    lastStatusDetail = detail;

    const newStatus: SemanticEvent = {
      id: 'persistent-status-card',
      class: 'status',
      timestamp: state.nowMs,
      artifact: {
        type: 'status',
        label,
        detail,
      },
      metadata: {},
    };

    if (statusEvent) {
      const existingIdx = events.indexOf(statusEvent);
      if (existingIdx >= 0) events.splice(existingIdx, 1);
    }
    events.push(newStatus);
    statusEvent = newStatus;
    eventsVersion++;
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
      promptDirty = true;
      render();
      return;
    }
    prompt = '';
    promptDirty = true;
    statusOverride = '';
    busy = true;
    render();
    try {
      if (value.startsWith('/')) {
        // Handle /theme locally
        if (value.startsWith('/theme')) {
          const parts = value.split(/\s+/);
          const themeName = parts[1] ?? '';
          if (themeName) {
            currentPalette = getPalette(themeName);
            eventsVersion++;
            events.push(tuiNote('slash', `Theme set to "${currentPalette.name}".`));
          } else {
            eventsVersion++;
            events.push(
              tuiNote('slash', `Available themes: ${getThemeNames().join(', ')}. Current: ${currentPalette.name}`),
            );
          }
          busy = false;
          render();
          return;
        }
        // Handle /checkpoint locally
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
        if (registryCommand?.opensSettings && options?.settingsConfig) {
          eventsVersion++;
          events.push(settingsEvent(options.settingsConfig, renderer.width, renderer.height));
          busy = false;
          render();
          return;
        }

        const report = await session.handleSlashCommand(value);
        if (report.exit) {
          exiting = true;
          renderer.destroy();
          return;
        }
        if (report.output.trim()) {
          eventsVersion++;
          events.push(tuiNote('slash', report.output));
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

  session.setEventSink?.((event) => {
    if (exiting) return;
    state = applyEventToRunState(state, event, Date.now());
    const newEvents = classifyAgentEvent(event, state, Date.now());

    // Track subagent orchestration for the status card
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
    }

    // Filter transient events from the transcript — they create too many
    // individual result cards during execution. Status is reflected via
    // the persistent status card and footer line instead.
    if ((TRANSIENT_EVENT_TYPES as Set<string>).has(event.type)) {
      // Still mark dirty so the status card gets updated
      eventsVersion++;
    } else {
      if (event.type === 'task_finished') {
        removeStatusCard();
      }
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
          events.push(tuiNote('slash', report.output));
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
    promptDirty = true;
    statusOverride = '';
    render();
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
  function handleTab(): void {
    if (autocompleteVisible && autocompleteItems.length > 0) {
      if (autocompleteItems.length === 1) {
        prompt = autocompleteItems[0] ?? prompt;
        promptDirty = true;
        autocompleteVisible = false;
      } else {
        autocompleteIndex = (autocompleteIndex + 1) % autocompleteItems.length;
      }
      render();
    }
  }

  /** Autocomplete up/down navigation */
  function handleAutocompleteNav(key: { name: string; preventDefault?: () => void }): void {
    if (key.name === 'up') {
      autocompleteIndex = (autocompleteIndex - 1 + autocompleteItems.length) % autocompleteItems.length;
    } else {
      autocompleteIndex = (autocompleteIndex + 1) % autocompleteItems.length;
    }
    key.preventDefault?.();
    render();
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

  renderer.keyInput.on('keypress', (key) => {
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

    // --- Escape ---
    if (key.name === 'escape') {
      handleEscape();
      return;
    }

    // --- Tab: autocomplete ---
    if (key.name === 'tab') {
      handleTab();
      return;
    }

    if (key.name === 'e' && !key.ctrl && !key.shift && !busy) {
      const id = latestExpandableEventId(visibleEvents(events, state));
      if (id) {
        expandedState[id] = !expandedState[id];
        tuiStats.recordExpandToggle();
        expandCollapseVersion++;
        render();
        return;
      }
    }

    // --- Autocomplete navigation ---
    if (key.name === 'up' && autocompleteVisible && autocompleteItems.length > 0) {
      handleAutocompleteNav(key);
      return;
    }
    if (key.name === 'down' && autocompleteVisible && autocompleteItems.length > 0) {
      handleAutocompleteNav(key);
      return;
    }

    // --- Prompt navigation / history scrolling ---
    if (key.name === 'up') {
      const input = renderer.root.findDescendantById('synax-input');
      handleVerticalNav(key, input);
      return;
    }
    if (key.name === 'down') {
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
      // Slash command detected in full
      if (
        steeringBuffer === '/help' ||
        steeringBuffer === '/settings' ||
        steeringBuffer === '/resume' ||
        steeringBuffer === '/model' ||
        steeringBuffer === '/doctor' ||
        steeringBuffer === '/theme' ||
        steeringBuffer === '/checkpoints'
      ) {
        handleSlashDuringBusy(steeringBuffer);
        steeringBuffer = '';
        render();
        return;
      }
      if (key.name === 'slash' || (key.shift && key.name === '7')) {
        // Slash commands don't trigger steering while agent is running
        render();
        return;
      }
      if (key.name === 'backspace') {
        steeringBuffer = steeringBuffer.slice(0, -1);
        render();
        return;
      }
      if (key.name === 'enter' || key.name === 'return') {
        if (key.shift) {
          steeringBuffer += '\n';
          render();
          return;
        }
        if (steeringBuffer.trim()) {
          const text = steeringBuffer;
          steeringBuffer = '';
          session.abortCurrentTurn?.();
          statusOverride = '! Aborted, submitting steering...';
          render();
          submitSteering(text).catch(() => {});
          return;
        }
        return;
      }
      if (key.name === 'space') {
        steeringBuffer += ' ';
        render();
        return;
      }
      if (key.name && key.name.length === 1 && !key.ctrl && !key.shift) {
        steeringBuffer += key.name;
        render();
        return;
      }
      return;
    }

    // --- Bracket paste detection ---
    if (key.name === 'paste' || (key.sequence && key.sequence.startsWith('\x1b[200~'))) {
      pasteActive = true;
      pasteBuffer = '';
      return;
    }
    if (pasteActive && key.sequence && key.sequence.startsWith('\x1b[201~')) {
      pasteActive = false;
      const lines = pasteBuffer.split('\n');
      if (lines.length > 1) {
        prompt = `[pasted: ${lines.length} lines, ${pasteBuffer.length} chars]`;
      } else {
        prompt = pasteBuffer;
      }
      promptDirty = true;
      pasteBuffer = '';
      render();
      return;
    }
    if (pasteActive && key.name && key.name.length === 1) {
      pasteBuffer += key.name;
      return;
    }

    // --- Enter with autocomplete visible: complete selection ---
    if ((key.name === 'enter' || key.name === 'return') && autocompleteVisible && !busy) {
      if (autocompleteItems.length > 0) {
        prompt = autocompleteItems[autocompleteIndex] ?? prompt;
        promptDirty = true;
        autocompleteVisible = false;
        render();
        key.preventDefault();
        return;
      }
    }

    // --- Enter: submit prompt ---
    if ((key.name === 'enter' || key.name === 'return') && !busy && !autocompleteVisible && !key.shift) {
      const input = renderer.root.findDescendantById('synax-input');
      const value = input ? readPromptValue(input) : prompt;
      if (value.trim()) {
        handleInputSubmit(value);
      }
      key.preventDefault();
      return;
    }
  });

  renderer.on('resize', () => {
    treeBuilt = false;
    feedModel.reset();
    render('resize', { immediate: true });
  });
  renderer.start();
  doRender();

  await new Promise<void>((resolve) => {
    renderer.on('destroy', resolve);
  });

  renderScheduler.dispose();
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

function footerState({
  state,
  prompt,
  busy,
  statusOverride,
  steeringBuffer,
  terminalWidth,
  options,
}: {
  state: RunStateSnapshot;
  prompt: string;
  busy: boolean;
  statusOverride: string;
  steeringBuffer?: string;
  terminalWidth?: number;
  options?: {
    cwdLabel?: string;
    gitBranch?: string;
  };
}): FooterState {
  const inputHeight = promptInputHeight(prompt, terminalWidth);
  const hints = '[Enter] submit   [/help] commands   [Ctrl+D] quit';
  const location = [options?.cwdLabel, options?.gitBranch].filter(Boolean).join('  │  ');
  if (statusOverride) {
    return {
      status: statusOverride,
      prompt,
      placeholder: 'Ask Synax...',
      hints,
      location,
      inputHeight,
    };
  }
  if (state.phase === 'blocked') {
    return {
      status: `! ${state.objective.nextCheckpoint}`,
      prompt,
      placeholder: 'Type a message to continue...',
      hints,
      location,
      inputHeight,
    };
  }
  if (state.phase === 'tool_execution') {
    const steerHint = steeringBuffer ? ` [Steering: ${clip(steeringBuffer, 40)}]` : '';
    return {
      status: `$ Running tool (${elapsed(state.startedAtMs, state.nowMs)})${steerHint}`,
      prompt,
      placeholder: 'Steer Synax after the next tool result...',
      hints,
      location,
      inputHeight,
    };
  }
  if (busy || state.phase === 'thinking') {
    const steerHint = steeringBuffer ? ` [Steering: ${clip(steeringBuffer, 40)}]` : '';
    return {
      status: `... Thinking${state.modelId ? ` (${state.modelId})` : ''}${steerHint}`,
      prompt,
      placeholder: 'Working...',
      hints: '[Ctrl+D] quit',
      location,
      inputHeight,
    };
  }
  if (state.phase === 'error') {
    return {
      status: `x ${state.terminalIssue ?? 'Error'}`,
      prompt,
      placeholder: 'Ask Synax how to recover...',
      hints,
      location,
      inputHeight,
    };
  }
  if (state.phase === 'completed') {
    return {
      status: `✓ Task complete. ${state.filesChangedThisRun.length} files, ${state.toolInvocationCount} tools.`,
      prompt,
      placeholder: 'Continue...',
      hints,
      location,
      inputHeight,
    };
  }
  if (state.phase === 'budget_exhausted') {
    return {
      status: `! Budget exhausted: ${state.objective.nextCheckpoint}`,
      prompt,
      placeholder: 'Respond or adjust settings...',
      hints,
      location,
      inputHeight,
    };
  }
  return {
    status: 'Ready.',
    prompt,
    placeholder: 'Ask Synax to inspect, edit, test, or commit...',
    hints,
    location,
    inputHeight,
  };
}

function settingsEvent(config: EffectiveSynaxConfig, width: number, height: number): SemanticEvent {
  const openState = settingsReducer(createSettingsState(config), { type: 'open' });
  return {
    id: `settings-${Date.now()}`,
    class: 'note',
    timestamp: Date.now(),
    artifact: {
      type: 'text',
      title: 'Settings',
      body: renderSettings(openState, width, height).map(stripAnsi).join('\n'),
    },
    metadata: {},
  };
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
