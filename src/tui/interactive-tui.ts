import { applyEventToRunState, createInitialRunStateSnapshot, type RunStateSnapshot } from '../agent/tui-state';
import {
  classifyInlineSubmission,
  createInlinePasteInputSession,
  draftPlainText,
  flattenInlinePasteDraft,
  type ChatSession,
} from '../commands/chat';
import { isSecretTrigger } from '../backrooms/trigger';
import { stdin as defaultStdin } from 'node:process';
import { DiffRenderer } from './diff-renderer';
import { inputCursorPosition, maxHistoryScrollOffset, renderLayout, type InteractiveViewState } from './layout';
import { createInputParser, MAX_INPUT_CHARS } from './input';
import { createTerminalSession, type InputStreamLike, type TerminalSession } from './terminal';
import type { Writable } from 'node:stream';
import type { CoreMode } from './ai-core';
import {
  filterCommands,
  getCommand,
  type SlashCommand,
  type SlashCommandResult,
} from '../settings/slash-command-registry';
import { createSettingsState, settingsReducer, type SettingsState } from '../settings/settings-state';
import { renderSettings } from '../settings/settings-renderer';
import {
  createResumePickerState,
  resumePickerReducer,
  renderResumePicker,
  type ResumePickerState,
} from '../sessions/resume-renderer';
import {
  listSessionsSorted,
  readSessionEvents,
  generateSessionSummary,
  generateSessionTitle,
  type SessionMetadata,
} from '../sessions/session-store';
import { loadSynaxConfig, persistConfig } from '../config/load-config';
import type { EffectiveSynaxConfig } from '../config/schema';

export function renderAutocompleteOverlay(
  lines: string[],
  ac: { visible: boolean; selection: number; filtered: SlashCommand[] },
  width: number,
): string[] {
  if (!ac.visible || ac.filtered.length === 0) return lines;

  const renderWidth = terminalWriteWidth(width);
  const overlayLines: string[] = [];
  overlayLines.push(dim('  -- commands --'));
  for (let i = 0; i < Math.min(ac.filtered.length, 8); i += 1) {
    const cmd = ac.filtered[i];
    const desc = cmd.description ? ` - ${cmd.description}` : '';
    const text = `${i === ac.selection ? bold(` -> /${cmd.name}${desc}`) : dim(`    /${cmd.name}${desc}`)}`;
    overlayLines.push(text);
  }

  const insertAt = Math.max(0, lines.length - 5 - overlayLines.length);
  const rendered = lines.slice();
  for (let i = 0; i < overlayLines.length && insertAt + i < rendered.length; i += 1) {
    rendered[insertAt + i] = padAnsi(clipAnsi(overlayLines[i], renderWidth), renderWidth);
  }
  return rendered;
}

export async function runInteractiveTui(
  session: ChatSession,
  options?: {
    stdin?: InputStreamLike;
    stdout?: Writable & { isTTY?: boolean; columns?: number; rows?: number };
    blockedMessage?: string;
    /** Returns the last model output text for real-time observability. */
    lastModelOutput?: () => string;
    /** Called when a /new or /clear session reset happens so stale preview text clears. */
    resetLastModelOutput?: () => void;
    /** Active model ID for input panel label. */
    modelLabel?: string;
    /** Whether provider-level thinking is enabled in the active model profile. */
    thinkingEnabled?: boolean;
    /** Active endpoint for state display. */
    endpointLabel?: string;
    /** Provider label from config when available. */
    providerName?: string;
    /** Working directory label for the input dock. */
    cwdLabel?: string;
    /** Current git branch when known. */
    gitBranch?: string;
    /** Configured total context window when known. */
    contextWindowTokens?: number;
    /** Names of loaded skills currently active for the session. */
    activeSkills?: string[];
    /** Override core visual profile: 'model' (auto-detect), 'default', 'qwen', 'openai', 'claude', 'deepseek', 'gemini'. */
    coreVisualProfile?: string;
    /** Whether the active provider/model can be queried right now. */
    coreLoaded?: boolean;
    /** Price per 1M input tokens for cost display. */
    inputPricePer1MTokens?: number;
    /** Price per 1M output tokens for cost display. */
    outputPricePer1MTokens?: number;
    /** Test seam for the hidden liminal layer. Defaults to the real renderer. */
    runLiminalLayer?: () => Promise<void>;
    /**
     * Optional callback invoked after settings are persisted.
     * Return updated runtime labels to apply immediately in the TUI.
     */
    onSettingsConfigChanged?: (settingsConfig: EffectiveSynaxConfig) => {
      modelLabel?: string;
      thinkingEnabled?: boolean;
      endpointLabel?: string;
      providerName?: string;
      contextWindowTokens?: number;
      coreVisualProfile?: string;
      coreLoaded?: boolean;
      providerWarning?: string;
      inputPricePer1MTokens?: number;
      outputPricePer1MTokens?: number;
    };
    /** Enable SGR mouse tracking for app-managed wheel scrolling. Default false. */
    enableMouse?: boolean;
    /** Use alternate screen buffer. Default true. */
    alternateScreen?: boolean;
  },
): Promise<void> {
  const terminal = createTerminalSession(
    { stdin: options?.stdin, stdout: options?.stdout },
    { enableMouse: options?.enableMouse ?? false, alternateScreen: options?.alternateScreen ?? true },
  );
  if (!terminal.isTTY) return;

  let inputDraft = createInlinePasteInputSession();
  let state: RunStateSnapshot = createInitialRunStateSnapshot(Date.now());
  // Autocomplete state
  let autocomplete: { active: boolean; selection: number; filtered: SlashCommand[]; visible: boolean } = {
    active: false,
    selection: 0,
    filtered: [],
    visible: false,
  };
  // Settings modal state
  let settingsState: SettingsState | null = null;
  // Resume picker state
  let resumeState: ResumePickerState | null = null;
  let exiting = false;
  let busy = false;
  let externalRendererActive = false;
  let historyScrollOffset = 0;
  // Ctrl+C double-press tracking: first press clears input, second within 800ms exits.
  let lastCtrlCTime = 0;
  let ctrlCClearedInput = false;
  // Active provider warning — only surfaced when user tries to submit.
  let providerWarning = options?.blockedMessage;
  const diff = new DiffRenderer();

  // Adaptive render loop — 60 FPS when active, 0 when idle.
  const TARGET_FRAME_MS = 1000 / 60;
  let renderLoopActive = false;
  let lastFrameTime = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const IDLE_GRACE_MS = 2000;

  const needsRenderLoop = (): boolean =>
    busy || state.terminal === 'running' || (settingsState?.active ?? false) || (resumeState?.active ?? false);

  // startRenderLoop is assigned after paint() is defined.
  let startRenderLoop: () => void = () => {};
  let runtimeLabels = {
    modelLabel: options?.modelLabel,
    thinkingEnabled: options?.thinkingEnabled,
    endpointLabel: options?.endpointLabel,
    providerName: options?.providerName,
    contextWindowTokens: options?.contextWindowTokens,
    coreVisualProfile: options?.coreVisualProfile,
    coreLoaded: true,
    inputPricePer1MTokens: options?.inputPricePer1MTokens,
    outputPricePer1MTokens: options?.outputPricePer1MTokens,
  };
  const applyOptionsToState = (): void => {
    state = {
      ...state,
      modelId: runtimeLabels.modelLabel ?? '',
      providerName: runtimeLabels.providerName ?? providerNameFromEndpoint(runtimeLabels.endpointLabel ?? ''),
      contextWindowTokens: runtimeLabels.contextWindowTokens,
      thinkingEnabled: runtimeLabels.thinkingEnabled,
      activeSkills: options?.activeSkills ?? [],
      coreLoaded: true,
      inputPricePer1MTokens: runtimeLabels.inputPricePer1MTokens,
      outputPricePer1MTokens: runtimeLabels.outputPricePer1MTokens,
      sessionSpendLabel: isLocalEndpoint(runtimeLabels.endpointLabel ?? '') ? 'local' : undefined,
    };
  };
  applyOptionsToState();

  // Wire the runtime event stream from ChatSession → TUI state reducer.
  // This ensures the TUI reflects REAL runtime state, not fake animation.
  session.setEventSink?.((event) => {
    if (exiting) return;
    state = applyEventToRunState(state, event, Date.now());
    startRenderLoop();
    paint(true);
  });

  const coreMode = (): CoreMode => {
    if (!state.coreLoaded) return 'unloaded';
    if (state.phase === 'error') return 'failure';
    if (state.phase === 'budget_exhausted') return 'blocked';
    if (state.phase === 'blocked') return 'blocked';
    if (state.phase === 'completed') return 'completed';
    if (state.phase === 'verifying') return 'verifying';
    if (state.phase === 'tool_execution') return inferToolExecutionMode(state);
    if (state.phase === 'thinking') return inferThinkingMode(state);
    return 'idle';
  };

  const viewState = (): InteractiveViewState => ({
    run: { ...state, nowMs: Date.now() },
    objectiveInput: inputDraft.getVisibleBody(),
    blockedMessage: options?.blockedMessage,
    coreMode: coreMode(),
    nowMs: Date.now(),
    lastModelOutput: options?.lastModelOutput?.(),
    modelLabel: runtimeLabels.modelLabel,
    endpointLabel: runtimeLabels.endpointLabel,
    cwdLabel: options?.cwdLabel ?? process.cwd(),
    gitBranch: options?.gitBranch,
    coreVisualProfile: runtimeLabels.coreVisualProfile,
    historyScrollOffset,
  });

  const clampHistoryScroll = (): void => {
    historyScrollOffset = Math.min(
      maxHistoryScrollOffset(viewState(), terminal.columns, terminal.rows),
      Math.max(0, historyScrollOffset),
    );
  };

  const paint = (force = false): void => {
    if (exiting) return;
    if (externalRendererActive) return;
    clampHistoryScroll();

    // Settings modal takes over the entire screen
    if (settingsState?.active) {
      const settingsLines = renderSettings(settingsState, terminal.columns, terminal.rows);
      const out = diff.render(settingsLines, terminal.columns, terminal.rows);
      if (out || force) terminal.synchronizedWrite(out || '');
      terminal.write('\u001b[?25l');
      return;
    }

    // Resume picker takes over the entire screen
    if (resumeState?.active) {
      const resumeLines = renderResumePicker(resumeState, terminal.columns, terminal.rows);
      const out = diff.render(resumeLines, terminal.columns, terminal.rows);
      if (out || force) terminal.synchronizedWrite(out || '');
      terminal.write('\u001b[?25l');
      return;
    }

    let lines = renderLayout(viewState(), terminal.columns, terminal.rows);

    // Render autocomplete overlay at the bottom of the input area
    if (autocomplete.visible && autocomplete.filtered.length > 0) {
      lines = renderAutocompleteOverlay(lines, autocomplete, terminal.columns);
    }

    const out = diff.render(lines, terminal.columns, terminal.rows);
    if (!out && !force) return;
    terminal.synchronizedWrite(out || '');

    // Position and show cursor beam in the input box.
    const cursor = inputCursorPosition(viewState().objectiveInput, terminal.columns, terminal.rows);
    // Terminal cursor positions are 1-indexed. Use beam cursor style to avoid
    // overwriting the first character of placeholder text.
    terminal.write(`\u001b[${cursor.row + 1};${cursor.col + 1}H\u001b[5 q\u001b[?25h`);
  };

  const finish = (): void => {
    exiting = true;
    // Disconnect the event sink immediately so no further state updates
    // trigger paint() after terminal cleanup.
    session.setEventSink?.(null);
  };

  const submit = async (): Promise<void> => {
    const currentDraft = inputDraft.getDraft();
    const plainText = draftPlainText(currentDraft).trim();
    const kind = classifyInlineSubmission(currentDraft);
    if (kind === 'empty' || busy) return;

    // Secret trigger: Synax Backrooms easter egg
    const submittedText = flattenInlinePasteDraft(currentDraft).trim();
    if (isSecretTrigger(submittedText)) {
      inputDraft = createInlinePasteInputSession();
      paint(true);
      externalRendererActive = true;
      stdin?.off('data', onData);
      terminal.stop();
      let liminalOutput = 'liminal layer closed';
      try {
        if (options?.runLiminalLayer) {
          await options.runLiminalLayer();
        } else {
          const { runSynaxBackrooms } = await import('../backrooms/runBackrooms');
          await runSynaxBackrooms();
        }
      } catch (error) {
        liminalOutput = `liminal layer error: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        externalRendererActive = false;
        terminal.start();
        stdin?.on('data', onData);
        diff.reset();
      }
      state = applyEventToRunState(
        state,
        {
          type: 'command_output',
          timestamp: new Date().toISOString(),
          command: 'liminal',
          content: liminalOutput,
        },
        Date.now(),
      );
      paint(true);
      return;
    }

    const text = kind === 'slash' ? plainText : flattenInlinePasteDraft(currentDraft);
    inputDraft = createInlinePasteInputSession();
    busy = true;
    startRenderLoop();
    paint(true);

    if (kind === 'slash') {
      // /mouse is handled locally to toggle terminal mouse tracking.
      if (plainText === '/mouse') {
        const toggled = toggleMouseMode(terminal);
        state = applyEventToRunState(
          state,
          {
            type: 'command_output',
            timestamp: new Date().toISOString(),
            command: '/mouse',
            content: toggled
              ? '[synax] Mouse mode enabled — SGR wheel scrolling active. Native text selection is disabled.'
              : '[synax] Mouse mode disabled — native text selection and copy work normally. Use keyboard or PageUp/PageDown to scroll.',
          },
          Date.now(),
        );
        busy = false;
        paint(true);
        return;
      }
      // Check if this command opens the settings modal (or resume picker).
      // The slash-command-registry is the source of truth for modal-triggering commands.
      const slashCmd = getCommand(plainText.slice(1));
      if (slashCmd?.opensSettings) {
        openSettingsModal();
        busy = false;
        paint(true);
        return;
      }
      if (slashCmd?.opensResume) {
        openResumePicker();
        busy = false;
        paint(true);
        return;
      }

      const slash = await session.handleSlashCommand(text);
      if (slash.newSession) {
        session.resetConversation?.();
        options?.resetLastModelOutput?.();
        state = createInitialRunStateSnapshot(Date.now());
        applyOptionsToState();
        historyScrollOffset = 0;
        diff.reset();
      }
      if (slash.output) {
        state = applyEventToRunState(
          state,
          { type: 'command_output', timestamp: new Date().toISOString(), command: text, content: slash.output },
          Date.now(),
        );
      }
      if (slash.exit) finish();
      busy = false;
      paint(true);
      return;
    }

    if (text.startsWith('!')) {
      const command = text.slice(1).trim();
      if (!command) {
        state = applyEventToRunState(
          state,
          {
            type: 'command_output',
            timestamp: new Date().toISOString(),
            command: '!',
            content: '[synax] shell command required after !',
          },
          Date.now(),
        );
      } else if (session.handleShellCommand) {
        const report = await session.handleShellCommand(command);
        state = applyEventToRunState(
          state,
          {
            type: 'local_shell_command',
            timestamp: new Date().toISOString(),
            command: report.command,
            exitCode: report.exitCode,
            durationMs: report.durationMs,
            stdout: report.stdout,
            stderr: report.stderr,
          },
          Date.now(),
        );
      } else {
        state = applyEventToRunState(
          state,
          {
            type: 'command_output',
            timestamp: new Date().toISOString(),
            command: text,
            content: '[synax] local shell commands are unavailable in this session',
          },
          Date.now(),
        );
      }
      busy = false;
      paint(true);
      return;
    }

    if (providerWarning) {
      state = applyEventToRunState(
        state,
        {
          type: 'command_output',
          timestamp: new Date().toISOString(),
          command: 'submit',
          content: `[synax] ${providerWarning}`,
        },
        Date.now(),
      );
      busy = false;
      paint(true);
      return;
    }

    state = applyEventToRunState(
      state,
      {
        type: 'task_started',
        timestamp: new Date().toISOString(),
        mode: 'interactive',
        profile: 'default',
        endpoint: runtimeLabels.endpointLabel ?? 'local',
        model: runtimeLabels.modelLabel ?? 'local model',
        providerName: runtimeLabels.providerName,
        contextBudgetTokens: 0,
        contextWindowTokens: runtimeLabels.contextWindowTokens,
        maxModelSteps: 0,
        maxToolCalls: 0,
        tools: [],
        task: text,
        inputPricePer1MTokens: runtimeLabels.inputPricePer1MTokens,
        outputPricePer1MTokens: runtimeLabels.outputPricePer1MTokens,
      },
      Date.now(),
    );
    paint(true);

    try {
      const report = await session.handleUserMessage(text);
      // The event sink already applied intermediate events (tool_started,
      // verifying, etc). Apply the terminal event only to override phase.
      state = applyEventToRunState(
        state,
        {
          type: 'task_finished',
          timestamp: new Date().toISOString(),
          status: report.terminalState,
          toolCalls: report.toolCalls ?? 0,
          maxToolCalls: 0,
          modelSteps: report.steps,
          maxModelSteps: report.steps,
          changedFiles: report.changedFiles,
          workingTreeClean: report.workingTreeClean,
          verification: report.terminalState === 'completed' ? 'passed' : (report.error ?? report.terminalState),
          error: report.error,
        },
        Date.now(),
      );
    } catch (error) {
      state = applyEventToRunState(
        state,
        {
          type: 'error',
          timestamp: new Date().toISOString(),
          message: error instanceof Error ? error.message : String(error),
        },
        Date.now(),
      );
    } finally {
      busy = false;
      paint(true);
    }
  };

  // ─── Autocomplete ───────────────────────────────────────────

  const updateAutocomplete = (): void => {
    const plainText = draftPlainText(inputDraft.getDraft());
    if (!inputDraft.hasPaste() && plainText.startsWith('/') && !plainText.includes(' ')) {
      const query = plainText.slice(1);
      const filtered = filterCommands(query);
      autocomplete = {
        active: true,
        visible: filtered.length > 0,
        selection: 0,
        filtered: filtered.slice(0, 10),
      };
    } else {
      autocomplete = { active: false, visible: false, selection: 0, filtered: [] };
    }
  };

  const executeAutocompleteCommand = async (cmd: SlashCommand): Promise<void> => {
    inputDraft = createInlinePasteInputSession();
    autocomplete = { active: false, visible: false, selection: 0, filtered: [] };

    const result: SlashCommandResult = await Promise.resolve(cmd.handler());

    // /mouse is handled locally to toggle terminal mouse tracking.
    if (cmd.name === 'mouse') {
      const toggled = toggleMouseMode(terminal);
      state = applyEventToRunState(
        state,
        {
          type: 'command_output',
          timestamp: new Date().toISOString(),
          command: '/mouse',
          content: toggled
            ? '[synax] Mouse mode enabled — SGR wheel scrolling active. Native text selection is disabled.'
            : '[synax] Mouse mode disabled — native text selection and copy work normally. Use keyboard or PageUp/PageDown to scroll.',
        },
        Date.now(),
      );
      return;
    }

    if (result.openSettings) {
      openSettingsModal();
      paint(true);
      return;
    }

    if (result.openResume) {
      openResumePicker();
      paint(true);
      return;
    }

    if (result.exit) {
      finish();
      return;
    }

    // For commands that return handled:false, pass through to the session
    if (!result.handled && session.handleSlashCommand) {
      const slashReport = await session.handleSlashCommand(`/${cmd.name}`);
      if (slashReport.exit) {
        finish();
        return;
      }
      if (slashReport.newSession) {
        session.resetConversation?.();
        options?.resetLastModelOutput?.();
        state = createInitialRunStateSnapshot(Date.now());
        applyOptionsToState();
        historyScrollOffset = 0;
        diff.reset();
      }
      if (slashReport.output) {
        state = applyEventToRunState(
          state,
          {
            type: 'command_output',
            timestamp: new Date().toISOString(),
            command: `/${cmd.name}`,
            content: slashReport.output,
          },
          Date.now(),
        );
      }
      return;
    }

    if (result.newSession) {
      options?.resetLastModelOutput?.();
      state = createInitialRunStateSnapshot(Date.now());
      applyOptionsToState();
      historyScrollOffset = 0;
      diff.reset();
    }

    if (result.output) {
      state = applyEventToRunState(
        state,
        {
          type: 'command_output',
          timestamp: new Date().toISOString(),
          command: `/${cmd.name}`,
          content: result.output,
        },
        Date.now(),
      );
    }
  };

  // ─── Settings modal ────────────────────────────────────────

  const openSettingsModal = (): void => {
    const config = loadSettingsConfig();
    settingsState = settingsReducer(createSettingsState(config), { type: 'open' });
    resumeState = null;
  };

  const closeSettingsModal = (): void => {
    if (!settingsState) return;
    diff.reset();
    settingsState = settingsReducer(settingsState, { type: 'close' });
    if (settingsState?.dirty) {
      persistSettingsConfig(settingsState.config);
      const updates = options?.onSettingsConfigChanged?.(settingsState.config);
      if (updates) {
        runtimeLabels = {
          ...runtimeLabels,
          ...updates,
        };
        if (updates.providerWarning !== undefined) {
          providerWarning = updates.providerWarning;
        }
        applyOptionsToState();
      }
    }
    settingsState = null;
  };

  const handleSettingsInput = (event: { type: string; value?: string }): void => {
    if (!settingsState) return;
    if (event.type === 'escape') {
      closeSettingsModal();
      return;
    }
    if (event.type === 'arrow_up' || event.type === 'scroll_history_up') {
      settingsState = settingsReducer(settingsState, { type: 'move_up' });
      return;
    }
    if (event.type === 'arrow_down' || event.type === 'scroll_history_down') {
      settingsState = settingsReducer(settingsState, { type: 'move_down' });
      return;
    }
    if (event.type === 'tab') {
      settingsState = settingsReducer(settingsState, { type: 'next_tab' });
      return;
    }
    if (event.type === 'shift_tab') {
      settingsState = settingsReducer(settingsState, { type: 'prev_tab' });
      return;
    }
    if (event.type === 'submit') {
      settingsState = settingsReducer(settingsState, { type: 'select_row' });
      return;
    }
    if (event.type === 'text' && event.value === ' ') {
      settingsState = settingsReducer(settingsState, { type: 'toggle' });
      return;
    }
    if (event.type === 'text' && event.value === 'e') {
      settingsState = settingsReducer(settingsState, { type: 'start_edit' });
      return;
    }
    if (event.type === 'text' && event.value) {
      if (settingsState.textInput) {
        settingsState = settingsReducer(settingsState, { type: 'text_input', char: event.value });
      } else if (event.value === '/') closeSettingsModal();
      else if (event.value === 'q') closeSettingsModal();
      return;
    }
    if (event.type === 'backspace' && settingsState.textInput) {
      settingsState = settingsReducer(settingsState, { type: 'text_backspace' });
    }
  };

  // ─── Resume picker ──────────────────────────────────────────

  const openResumePicker = (): void => {
    const sessions = listSessionsSorted('updated');
    resumeState = resumePickerReducer(createResumePickerState(sessions), { type: 'open' });
    settingsState = null;
  };

  const closeResumePicker = (): void => {
    if (!resumeState) return;
    diff.reset();
    resumeState = resumePickerReducer(resumeState, { type: 'close' });
    resumeState = null;
  };

  const handleResumeInput = (event: { type: string; value?: string }): void => {
    if (!resumeState) return;
    if (event.type === 'escape') {
      closeResumePicker();
      return;
    }
    if (event.type === 'arrow_up' || event.type === 'scroll_history_up') {
      resumeState = resumePickerReducer(resumeState, { type: 'move_up' });
      return;
    }
    if (event.type === 'arrow_down' || event.type === 'scroll_history_down') {
      resumeState = resumePickerReducer(resumeState, { type: 'move_down' });
      return;
    }
    if (event.type === 'tab') {
      resumeState = resumePickerReducer(resumeState, { type: 'toggle_sort' });
      return;
    }
    if (event.type === 'submit') {
      const selected = resumeState.filtered[resumeState.selectedRow];
      if (selected) void resumeSelectedSession(selected);
      return;
    }
    if (event.type === 'backspace' && resumeState.searchQuery.length > 0) {
      resumeState = resumePickerReducer(resumeState, { type: 'search', query: resumeState.searchQuery.slice(0, -1) });
      return;
    }
    if (event.type === 'text' && event.value) {
      resumeState = resumePickerReducer(resumeState, { type: 'search', query: resumeState.searchQuery + event.value });
    }
  };

  const resumeSelectedSession = async (meta: SessionMetadata): Promise<void> => {
    closeResumePicker();

    // Load actual session events to build a rich resume summary.
    const events = readSessionEvents(meta.id);
    const title = events.length > 0 ? generateSessionTitle(events) : (meta.title ?? 'Untitled');
    const summary = events.length > 0 ? generateSessionSummary(events, 200) : (meta.summary ?? 'No messages');
    const userMessages = events.filter((e) => e.type === 'user_message').length;
    const assistantMessages = events.filter((e) => e.type === 'assistant_message').length;
    const toolEvents = events.filter((e) => e.type === 'tool_call' || e.type === 'tool_result').length;

    const contentLines = [
      `Resumed session: ${title}`,
      `Branch: ${meta.branch ?? 'unknown'}  ·  Model: ${meta.activeModel ?? 'unknown'}`,
      `Updated: ${meta.updatedAt}`,
      `Messages: ${userMessages} user, ${assistantMessages} assistant, ${toolEvents} tool events`,
      '',
      `Summary: ${summary}`,
    ];

    state = applyEventToRunState(
      state,
      {
        type: 'command_output',
        timestamp: new Date().toISOString(),
        command: '/resume',
        content: contentLines.join('\n'),
      },
      Date.now(),
    );
  };

  // ─── Config bridge ──────────────────────────────────────────

  const loadSettingsConfig = (): EffectiveSynaxConfig => {
    try {
      return loadSynaxConfig();
    } catch {
      return {
        active: { provider: 'relay', model: '', thinking: 'off' },
        providers: {},
        skills: { enabled: [], disabled: [] },
        mcp: { servers: {} },
        source: null,
        errors: [],
      };
    }
  };

  const persistSettingsConfig = (config: EffectiveSynaxConfig): void => {
    try {
      persistConfig(config, process.cwd());
    } catch {
      /* best-effort */
    }
  };

  const stdin = options?.stdin ?? (defaultStdin as unknown as InputStreamLike);
  const inputParser = createInputParser();
  const onData = (chunk: Buffer): void => {
    const events = inputParser.parse(chunk.toString('utf8'));
    for (const event of events) {
      // Exit always works
      if (event.type === 'exit') {
        if (settingsState?.active) {
          closeSettingsModal();
          paint(true);
          continue;
        }
        if (resumeState?.active) {
          resumeState = resumePickerReducer(resumeState, { type: 'close' });
          paint(true);
          continue;
        }
        finish();
        break;
      }

      // Ctrl+C: first press clears input, second press within 800ms exits.
      if (event.type === 'ctrl_c') {
        if (settingsState?.active) {
          closeSettingsModal();
          paint(true);
          continue;
        }
        if (resumeState?.active) {
          closeResumePicker();
          paint(true);
          continue;
        }
        const now = Date.now();
        if (inputDraft.getVisibleBody().length > 0 || ctrlCClearedInput) {
          if (ctrlCClearedInput && now - lastCtrlCTime < 800) {
            finish();
            break;
          }
          inputDraft = createInlinePasteInputSession();
          autocomplete = { active: false, visible: false, selection: 0, filtered: [] };
          lastCtrlCTime = now;
          ctrlCClearedInput = true;
        } else {
          ctrlCClearedInput = false;
        }
        continue;
      }

      // Modal input routing
      if (settingsState?.active) {
        handleSettingsInput(event);
        continue;
      }

      if (resumeState?.active) {
        handleResumeInput(event);
        continue;
      }

      // Normal input routing
      // TODO: Esc does not currently interrupt an active run. When implemented,
      // add `Esc interrupt` to the footer help text in layout.ts.
      if (event.type === 'arrow_up' || event.type === 'scroll_history_up') {
        if (autocomplete.visible) {
          autocomplete.selection = Math.max(0, autocomplete.selection - 1);
        } else {
          historyScrollOffset += 3;
          clampHistoryScroll();
        }
        continue;
      }
      if (event.type === 'arrow_down' || event.type === 'scroll_history_down') {
        if (autocomplete.visible) {
          autocomplete.selection = Math.min(autocomplete.filtered.length - 1, autocomplete.selection + 1);
        } else {
          historyScrollOffset = Math.max(0, historyScrollOffset - 3);
          clampHistoryScroll();
        }
        continue;
      }
      if (event.type === 'backspace') {
        inputDraft.handleBackspace();
        updateAutocomplete();
        continue;
      }
      if (event.type === 'escape') {
        if (autocomplete.visible) {
          autocomplete.visible = false;
          continue;
        }
        continue;
      }
      if (event.type === 'tab') {
        if (autocomplete.visible && autocomplete.filtered.length > 0) {
          // Auto-complete to first match
          const cmd = autocomplete.filtered[autocomplete.selection] ?? autocomplete.filtered[0];
          inputDraft = createInlinePasteInputSession();
          inputDraft.handleText(`/${cmd.name} `);
          autocomplete.visible = false;
          continue;
        }
        continue;
      }
      if (event.type === 'submit') {
        if (autocomplete.visible && autocomplete.filtered.length > 0) {
          const cmd = autocomplete.filtered[autocomplete.selection] ?? autocomplete.filtered[0];
          void executeAutocompleteCommand(cmd);
          continue;
        }
        void submit();
        continue;
      }
      if (event.type === 'newline') {
        if (inputDraft.getVisibleBody().length < MAX_INPUT_CHARS) inputDraft.handleText('\n');
        updateAutocomplete();
        continue;
      }
      if (event.type === 'paste' && event.value) {
        if (inputDraft.getVisibleBody().length < MAX_INPUT_CHARS) {
          inputDraft.handlePasteStart();
          inputDraft.handlePasteChunk(event.value);
          inputDraft.handlePasteEnd();
        }
        updateAutocomplete();
        continue;
      }
      if (event.type === 'text' && event.value) {
        if (inputDraft.getVisibleBody().length < MAX_INPUT_CHARS) inputDraft.handleText(event.value);
        updateAutocomplete();
      }
    }
    paint();
  };

  // ── Assign real render loop implementation (needs paint() in scope) ──

  const scheduleFrame = (): void => {
    if (exiting || !renderLoopActive) return;
    const now = performance.now();
    const elapsed = now - lastFrameTime;
    if (elapsed >= TARGET_FRAME_MS) {
      lastFrameTime = now;
      paint();
      if (!needsRenderLoop()) {
        if (!idleTimer) idleTimer = setTimeout(() => stopRenderLoop(), IDLE_GRACE_MS);
      } else if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    }
    const delay = Math.max(1, TARGET_FRAME_MS - (performance.now() - lastFrameTime));
    setTimeout(scheduleFrame, delay);
  };

  startRenderLoop = (): void => {
    if (exiting) return;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (renderLoopActive) return;
    renderLoopActive = true;
    lastFrameTime = performance.now();
    setTimeout(scheduleFrame, 0);
  };

  const stopRenderLoop = (): void => {
    renderLoopActive = false;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  // ── Main event loop ──────────────────────────────────────────

  terminal.start();
  try {
    startRenderLoop();
    paint(true);
    stdin?.on('data', onData);
    while (!exiting) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    stopRenderLoop();
    stdin?.off('data', onData);
    terminal.stop();
  }
}

function toggleMouseMode(terminal: TerminalSession): boolean {
  if (terminal.mouseEnabled) {
    terminal.disableMouse();
    return false;
  }
  terminal.enableMouse();
  return true;
}

function isLocalEndpoint(endpoint: string): boolean {
  return /(?:^|\/\/)(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(endpoint);
}

function providerNameFromEndpoint(endpoint: string): string {
  if (isLocalEndpoint(endpoint)) return 'Relay';
  if (/api\.openai\.com/i.test(endpoint)) return 'OpenAI';
  if (/anthropic/i.test(endpoint)) return 'Anthropic';
  if (/openrouter/i.test(endpoint)) return 'OpenRouter';
  return endpoint ? 'OpenAI-compatible' : 'unknown';
}

function inferThinkingMode(state: RunStateSnapshot): CoreMode {
  const latest = state.timeline[state.timeline.length - 1]?.summary.toLowerCase() ?? '';
  if (latest.includes('objective registered') || latest.includes('task started') || latest.includes('planned:')) {
    return 'planning';
  }
  return 'reasoning';
}

function bold(text: string): string {
  return `\u001b[1;37m${text}\u001b[0m`;
}

function dim(text: string): string {
  return `\u001b[90m${text}\u001b[0m`;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function padAnsi(text: string, width: number): string {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  return `${text}${' '.repeat(width - visible)}`;
}

function clipAnsi(text: string, width: number): string {
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

function terminalWriteWidth(width: number): number {
  return width > 1 ? width - 1 : width;
}

function inferToolExecutionMode(state: RunStateSnapshot): CoreMode {
  const hint = `${state.statusNote} ${state.timeline[state.timeline.length - 1]?.summary ?? ''}`.toLowerCase();
  if (hint.includes('read')) return 'reading';
  if (hint.includes('write') || hint.includes('edit') || hint.includes('replace')) return 'writing';
  if (hint.includes('bash') || hint.includes('git') || hint.includes('command')) return 'bash';
  return 'reasoning';
}
