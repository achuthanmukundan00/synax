import {
  applyEventToRunState,
  createBlockedRunStateSnapshot,
  createInitialRunStateSnapshot,
  type RunStateSnapshot,
} from '../agent/tui-state';
import {
  classifyInlineSubmission,
  createInlinePasteInputSession,
  draftPlainText,
  flattenInlinePasteDraft,
  type ChatSession,
} from '../commands/chat';
import { stdin as defaultStdin } from 'node:process';
import { DiffRenderer } from './diff-renderer';
import { inputCursorPosition, maxHistoryScrollOffset, renderLayout, type InteractiveViewState } from './layout';
import { createInputParser, MAX_INPUT_CHARS } from './input';
import { createTerminalSession, type InputStreamLike } from './terminal';
import type { Writable } from 'node:stream';
import type { CoreMode } from './ai-core';
import { filterCommands, type SlashCommand, type SlashCommandResult } from '../settings/slash-command-registry';
import { createSettingsState, settingsReducer, type SettingsState } from '../settings/settings-state';
import { renderSettings } from '../settings/settings-renderer';
import {
  createResumePickerState,
  resumePickerReducer,
  renderResumePicker,
  type ResumePickerState,
} from '../sessions/resume-renderer';
import { listSessionsSorted, type SessionMetadata } from '../sessions/session-store';
import { loadSynaxConfig, persistConfig } from '../config/load-config';
import type { EffectiveSynaxConfig } from '../config/schema';

export async function runInteractiveTui(
  session: ChatSession,
  options?: {
    stdin?: InputStreamLike;
    stdout?: Writable & { isTTY?: boolean; columns?: number; rows?: number };
    blockedMessage?: string;
    /** Returns the last model output text for real-time observability. */
    lastModelOutput?: () => string;
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
      inputPricePer1MTokens?: number;
      outputPricePer1MTokens?: number;
    };
  },
): Promise<void> {
  const terminal = createTerminalSession({ stdin: options?.stdin, stdout: options?.stdout });
  if (!terminal.isTTY) return;

  let inputDraft = createInlinePasteInputSession();
  let state: RunStateSnapshot = options?.blockedMessage
    ? createBlockedRunStateSnapshot(
        Date.now(),
        'Configuration required',
        'configure .synax.toml or ~/.config/synax/config.toml',
      )
    : createInitialRunStateSnapshot(Date.now());
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
  let historyScrollOffset = 0;
  const diff = new DiffRenderer();
  let runtimeLabels = {
    modelLabel: options?.modelLabel,
    thinkingEnabled: options?.thinkingEnabled,
    endpointLabel: options?.endpointLabel,
    providerName: options?.providerName,
    contextWindowTokens: options?.contextWindowTokens,
    coreVisualProfile: options?.coreVisualProfile,
    coreLoaded: options?.coreLoaded,
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
      coreLoaded: runtimeLabels.coreLoaded ?? true,
      inputPricePer1MTokens: runtimeLabels.inputPricePer1MTokens,
      outputPricePer1MTokens: runtimeLabels.outputPricePer1MTokens,
      sessionSpendLabel: isLocalEndpoint(runtimeLabels.endpointLabel ?? '') ? 'local' : undefined,
    };
  };
  applyOptionsToState();

  // Wire the runtime event stream from ChatSession → TUI state reducer.
  // This ensures the TUI reflects REAL runtime state, not fake animation.
  session.setEventSink?.((event) => {
    state = applyEventToRunState(state, event, Date.now());
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

  const bold = (text: string): string => `\u001b[1;37m${text}\u001b[0m`;
  const dim = (text: string): string => `\u001b[90m${text}\u001b[0m`;

  const renderAutocompleteOverlay = (
    lines: string[],
    ac: { visible: boolean; selection: number; filtered: SlashCommand[] },
    _width: number,
  ): string[] => {
    if (!ac.visible || ac.filtered.length === 0) return lines;
    const overlayLines: string[] = [];
    overlayLines.push(dim('  ── commands ──'));
    for (let i = 0; i < Math.min(ac.filtered.length, 8); i += 1) {
      const cmd = ac.filtered[i];
      const desc = cmd.description ? ` — ${cmd.description}` : '';
      const line = `${i === ac.selection ? bold(` → /${cmd.name}${desc}`) : dim(`   /${cmd.name}${desc}`)}`;
      overlayLines.push(line);
    }
    const insertAt = Math.max(0, lines.length - 5 - overlayLines.length);
    return [...lines.slice(0, insertAt), ...overlayLines, ...lines.slice(insertAt)];
  };

  const paint = (force = false): void => {
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
    // Terminal cursor positions are 1-indexed.
    terminal.write(`\u001b[${cursor.row + 1};${cursor.col + 1}H\u001b[?25h`);
  };

  const finish = (): void => {
    exiting = true;
  };

  const submit = async (): Promise<void> => {
    const currentDraft = inputDraft.getDraft();
    const plainText = draftPlainText(currentDraft).trim();
    const kind = classifyInlineSubmission(currentDraft);
    if (kind === 'empty' || busy) return;
    const text = kind === 'slash' ? plainText : flattenInlinePasteDraft(currentDraft);
    inputDraft = createInlinePasteInputSession();
    busy = true;
    paint(true);

    if (kind === 'slash') {
      const slash = await session.handleSlashCommand(text);
      if (slash.newSession) {
        state = createInitialRunStateSnapshot(Date.now());
        applyOptionsToState();
        historyScrollOffset = 0;
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

    if (runtimeLabels.coreLoaded === false) {
      state = applyEventToRunState(
        state,
        {
          type: 'command_output',
          timestamp: new Date().toISOString(),
          command: 'submit',
          content: options?.blockedMessage ?? '[synax] No queryable model is configured.',
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

    if (result.openSettings) {
      openSettingsModal();
      return;
    }

    if (result.openResume) {
      openResumePicker();
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
        state = createInitialRunStateSnapshot(Date.now());
        applyOptionsToState();
        historyScrollOffset = 0;
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
      state = createInitialRunStateSnapshot(Date.now());
      applyOptionsToState();
      historyScrollOffset = 0;
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
    settingsState = settingsReducer(settingsState, { type: 'close' });
    if (settingsState?.dirty) {
      persistSettingsConfig(settingsState.config);
      const updates = options?.onSettingsConfigChanged?.(settingsState.config);
      if (updates) {
        runtimeLabels = {
          ...runtimeLabels,
          ...updates,
        };
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
    state = applyEventToRunState(
      state,
      {
        type: 'command_output',
        timestamp: new Date().toISOString(),
        command: '/resume',
        content: `Resumed session from ${meta.branch ?? 'unknown'} · updated ${meta.updatedAt}\nModel: ${meta.activeModel ?? 'unknown'}`,
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
        active: { provider: 'relay-local', model: '', thinking: 'off' },
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

  terminal.start();
  const ticker = setInterval(() => paint(), 166);
  try {
    paint(true);
    stdin?.on('data', onData);
    while (!exiting) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    clearInterval(ticker);
    stdin?.off('data', onData);
    terminal.stop();
  }
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

function inferToolExecutionMode(state: RunStateSnapshot): CoreMode {
  const hint = `${state.statusNote} ${state.timeline[state.timeline.length - 1]?.summary ?? ''}`.toLowerCase();
  if (hint.includes('read')) return 'reading';
  if (hint.includes('write') || hint.includes('edit') || hint.includes('replace')) return 'writing';
  if (hint.includes('bash') || hint.includes('git') || hint.includes('command')) return 'bash';
  return 'reasoning';
}
