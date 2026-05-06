import {
  applyEventToRunState,
  createBlockedRunStateSnapshot,
  createInitialRunStateSnapshot,
  type RunStateSnapshot,
} from '../agent/tui-state';
import type { ChatSession } from '../commands/chat';
import { stdin as defaultStdin } from 'node:process';
import { DiffRenderer } from './diff-renderer';
import { maxHistoryScrollOffset, renderLayout, type InteractiveViewState } from './layout';
import { parseInputChunk } from './input';
import { createTerminalSession, type InputStreamLike } from './terminal';
import type { Writable } from 'node:stream';
import type { CoreMode } from './ai-core';

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
  },
): Promise<void> {
  const terminal = createTerminalSession({ stdin: options?.stdin, stdout: options?.stdout });
  if (!terminal.isTTY) return;

  let inputBuffer = '';
  let state: RunStateSnapshot = options?.blockedMessage
    ? createBlockedRunStateSnapshot(
        Date.now(),
        'Configuration required',
        'configure .synax.toml or ~/.config/synax/config.toml',
      )
    : createInitialRunStateSnapshot(Date.now());
  let exiting = false;
  let busy = false;
  let historyScrollOffset = 0;
  const diff = new DiffRenderer();
  if (options?.modelLabel) {
    state = {
      ...state,
      modelId: options.modelLabel,
      providerName: options.providerName ?? providerNameFromEndpoint(options.endpointLabel ?? ''),
      contextWindowTokens: options.contextWindowTokens,
      coreLoaded: true,
      sessionSpendLabel: isLocalEndpoint(options.endpointLabel ?? '') ? 'local' : undefined,
    };
  }

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
    objectiveInput: inputBuffer,
    blockedMessage: options?.blockedMessage,
    coreMode: coreMode(),
    nowMs: Date.now(),
    lastModelOutput: options?.lastModelOutput?.(),
    modelLabel: options?.modelLabel,
    endpointLabel: options?.endpointLabel,
    cwdLabel: options?.cwdLabel ?? process.cwd(),
    gitBranch: options?.gitBranch,
    historyScrollOffset,
  });

  const clampHistoryScroll = (): void => {
    historyScrollOffset = Math.min(
      maxHistoryScrollOffset(viewState(), terminal.columns, terminal.rows),
      Math.max(0, historyScrollOffset),
    );
  };

  const paint = (force = false): void => {
    clampHistoryScroll();
    const lines = renderLayout(viewState(), terminal.columns, terminal.rows);
    const out = diff.render(lines, terminal.columns, terminal.rows);
    if (!out && !force) return;
    terminal.synchronizedWrite(out || '');
  };

  const finish = (): void => {
    exiting = true;
  };

  const submit = async (): Promise<void> => {
    const text = inputBuffer.trim();
    if (!text || busy) return;
    inputBuffer = '';
    busy = true;
    paint(true);

    if (text.startsWith('/')) {
      const slash = await session.handleSlashCommand(text);
      if (slash.output) {
        state = applyEventToRunState(
          state,
          { type: 'assistant_message', timestamp: new Date().toISOString(), content: slash.output },
          Date.now(),
        );
      }
      if (slash.exit) finish();
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
        endpoint: options?.endpointLabel ?? 'local',
        model: options?.modelLabel ?? 'local model',
        providerName: options?.providerName,
        contextBudgetTokens: 0,
        contextWindowTokens: options?.contextWindowTokens,
        maxModelSteps: 0,
        maxToolCalls: 0,
        tools: [],
        task: text,
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

  const stdin = options?.stdin ?? (defaultStdin as unknown as InputStreamLike);
  const onData = (chunk: Buffer): void => {
    const events = parseInputChunk(chunk.toString('utf8'));
    for (const event of events) {
      if (event.type === 'exit') {
        finish();
        break;
      }
      if (event.type === 'scroll_history_up') {
        historyScrollOffset += 3;
        clampHistoryScroll();
        continue;
      }
      if (event.type === 'scroll_history_down') {
        historyScrollOffset = Math.max(0, historyScrollOffset - 3);
        clampHistoryScroll();
        continue;
      }
      if (event.type === 'backspace') {
        inputBuffer = inputBuffer.slice(0, -1);
        continue;
      }
      if (event.type === 'submit') {
        void submit();
        continue;
      }
      if (event.type === 'text' && event.value) {
        inputBuffer += event.value;
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
