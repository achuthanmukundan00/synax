import {
  applyEventToRunState,
  advanceClock,
  createInitialRunStateSnapshot,
  type RunStateSnapshot,
} from '../agent/tui-state';
import { isSecretTrigger } from '../backrooms/trigger';
import type { ChatSession } from '../commands/chat';
import type { EffectiveSynaxConfig } from '../config/schema';
import type { InputStreamLike } from './terminal';
import type { Writable } from 'node:stream';
import { renderArtifactRoot, renderArtifactCard, type ArtifactRailState, type FooterState } from './opentui-artifact-renderer';
import { classifyAgentEvent, semanticEventsFromDebugHistory, type SemanticEvent } from './semantic-events';

type OpenTuiCore = typeof import('@opentui/core');

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
  },
): Promise<void> {
  const stdout = options?.stdout ?? process.stdout;
  if (stdout.isTTY === false) return;

  const core = await loadOpenTuiCore();
  const renderer = await core.createCliRenderer({
    stdin: (options?.stdin ?? process.stdin) as NodeJS.ReadStream,
    stdout: stdout as NodeJS.WriteStream,
    screenMode: options?.alternateScreen === false ? 'main-screen' : 'alternate-screen',
    exitOnCtrlC: false,
    targetFps: 30,
    maxFps: 60,
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
  let tickTimer: ReturnType<typeof setInterval> | null = null;

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
  let renderPending = false;
  let eventsVersion = 0;
  let lastRenderedEventsVersion = -1;

  const doRender = (): void => {
    if (exiting || renderer.isDestroyed) return;
    state = advanceClock(state, Date.now());
    const rail = railState(state, options);
    const footer = footerState(state, prompt, busy, statusOverride);
    if (!treeBuilt) {
      renderer.root.add(
        renderArtifactRoot(core, visibleEvents(events, state), rail, footer, renderer.width, (value) => {
          void submit(value);
        }),
      );
      treeBuilt = true;
    } else {
      setNodeContent('synax-status', footer.status);
      setNodeContent('synax-hints', footer.hints);
      setNodeContent('synax-rail-model', rail.model ?? 'model n/a');
      setNodeContent('synax-rail-branch', rail.branch ?? 'no branch');
      setNodeContent('synax-rail-files', `Files (${rail.filesTouched.length})`);
      setNodeContent('synax-rail-approvals', `Approvals (${rail.approvals.length})`);
      setNodeContent('synax-rail-cost', `Cost: ${rail.costLabel ?? 'local'}`);
      setNodeContent('synax-rail-context', `Context: ${rail.contextLabel ?? 'n/a'}`);
      setNodeContent('synax-rail-uptime', `Uptime: ${rail.uptimeLabel}`);
      const input = findNode('synax-input');
      if (input) {
        (input as any).value = footer.prompt;
        (input as any).placeholder = footer.placeholder;
      }
      rebuildEvents();
    }
    findNode('synax-input')?.focus();
    renderer.requestRender();

    function findNode(id: string): any {
      return renderer.root.findDescendantById(id);
    }
    function setNodeContent(id: string, content: string): void {
      const node = findNode(id);
      if (node && typeof node === 'object' && 'content' in node) {
        (node as any).content = content;
      }
    }
    function rebuildEvents(): void {
      if (eventsVersion === lastRenderedEventsVersion) return;
      lastRenderedEventsVersion = eventsVersion;
      const scrollBox = findNode('synax-artifacts');
      if (!scrollBox) return;
      const visible = visibleEvents(events, state);
      const newCards = visible.map((ev) => renderArtifactCard(core, ev));
      if (typeof (scrollBox as any).clear === 'function' && typeof (scrollBox as any).add === 'function') {
        (scrollBox as any).clear();
        for (const card of newCards) {
          (scrollBox as any).add(card);
        }
      } else if (typeof (scrollBox as any).setChildren === 'function') {
        (scrollBox as any).setChildren(newCards);
      } else if ((scrollBox as any).children !== undefined) {
        (scrollBox as any).children = newCards;
      } else {
        /* Fallback: rebuild entire tree via remove+add.
         * Only hit for unknown openTUI versions that support none of the
         * above child‑replacement APIs.  Still throttled by the microtask
         * batching so listener accumulation stays bounded. */
        treeBuilt = false;
        renderer.root.remove('synax-root');
        doRender();
      }
    }
  };

  const render = (): void => {
    if (exiting || renderer.isDestroyed) return;
    if (renderPending) return;
    renderPending = true;
    queueMicrotask(() => {
      renderPending = false;
      doRender();
    });
  };

  const submit = async (rawValue: string): Promise<void> => {
    const value = rawValue.trim();
    if (!value || busy) return;
    if (isSecretTrigger(value)) {
      await options?.runLiminalLayer?.();
      prompt = '';
      render();
      return;
    }
    prompt = '';
    statusOverride = '';
    busy = true;
    render();
    try {
      if (value.startsWith('/')) {
        const report = await session.handleSlashCommand(value);
        if (report.exit) {
          exiting = true;
          renderer.destroy();
          return;
        }
        if (report.output.trim()) {
          eventsVersion++; events.push(noteEvent('slash', report.output));
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
        eventsVersion++; events.push({
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
      eventsVersion++; events.push(noteEvent('error', message));
      statusOverride = `x ${message}`;
    } finally {
      busy = false;
      render();
    }
  };

  session.setEventSink?.((event) => {
    if (exiting) return;
    state = applyEventToRunState(state, event, Date.now());
    eventsVersion++; events.push(...classifyAgentEvent(event, state, Date.now()));
    events = events.slice(Math.max(0, events.length - 500));
    render();
  });

  renderer.keyInput.on('keypress', (key) => {
    if (key.ctrl && key.name === 'c') {
      exiting = true;
      session.abortCurrentTurn?.();
      renderer.destroy();
      return;
    }
    if (key.name === 'escape') {
      session.abortCurrentTurn?.();
      statusOverride = '! Turn interrupted';
      busy = false;
      render();
    }
  });

  renderer.on('resize', () => {
    // Layout may change with terminal width (right rail visibility, etc.)
    treeBuilt = false;
    doRender();
  });
  renderer.start();
  tickTimer = setInterval(render, 1000);
  doRender();

  await new Promise<void>((resolve) => {
    renderer.on('destroy', resolve);
  });

  if (tickTimer) clearInterval(tickTimer);
  session.setEventSink?.(null);
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
  options:
    | {
        modelLabel?: string;
        endpointLabel?: string;
        providerName?: string;
        cwdLabel?: string;
        gitBranch?: string;
      }
    | undefined,
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
    approvals: state.phase === 'blocked' ? [{ action: state.objective.nextCheckpoint, riskLevel: 'medium' }] : [],
    costLabel: state.sessionSpendLabel ?? formatCost(state.sessionCostUsd),
    contextLabel,
    uptimeLabel: elapsed(state.startedAtMs, state.nowMs),
    provider: options?.providerName ?? state.providerName,
    endpoint: options?.endpointLabel,
  };
}

function footerState(state: RunStateSnapshot, prompt: string, busy: boolean, statusOverride: string): FooterState {
  if (statusOverride) {
    return {
      status: statusOverride,
      prompt,
      placeholder: 'Ask Synax...',
      hints: '[Enter] submit  [Esc] cancel  [Ctrl+C] quit',
    };
  }
  if (state.phase === 'tool_execution') {
    return {
      status: `$ Running tool (${elapsed(state.startedAtMs, state.nowMs)})`,
      prompt,
      placeholder: 'Steer Synax after the next tool result...',
      hints: '[Esc] interrupt  [Ctrl+C] quit',
    };
  }
  if (busy || state.phase === 'thinking') {
    return {
      status: `... Thinking${state.modelId ? ` (${state.modelId})` : ''}`,
      prompt,
      placeholder: 'Working...',
      hints: '[Esc] interrupt  [Ctrl+C] quit',
    };
  }
  if (state.phase === 'error') {
    return {
      status: `x ${state.terminalIssue ?? 'Error'}`,
      prompt,
      placeholder: 'Ask Synax how to recover...',
      hints: '[Enter] submit  [Esc] clear  [Ctrl+C] quit',
    };
  }
  if (state.phase === 'completed') {
    return {
      status: `✓ Task complete. ${state.filesChangedThisRun.length} files, ${state.toolInvocationCount} tools.`,
      prompt,
      placeholder: 'Continue...',
      hints: '[Enter] submit  [/new] new session  [Ctrl+C] quit',
    };
  }
  if (state.phase === 'blocked' || state.phase === 'budget_exhausted') {
    return {
      status: `! Needs attention: ${state.objective.nextCheckpoint}`,
      prompt,
      placeholder: 'Respond or adjust settings...',
      hints: '[Enter] submit  [Ctrl+C] quit',
    };
  }
  return {
    status: 'Ready.',
    prompt,
    placeholder: 'Ask Synax to inspect, edit, test, or commit...',
    hints: '[Enter] submit  [Esc] cancel  [Ctrl+C] quit',
  };
}

function noteEvent(kind: 'slash' | 'error', body: string): SemanticEvent {
  return {
    id: `${kind}-${Date.now()}`,
    class: kind === 'error' ? 'error' : 'note',
    timestamp: Date.now(),
    artifact: {
      type: 'text',
      title: kind === 'error' ? 'Error' : 'Command',
      body,
    },
    metadata: {},
  };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
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
