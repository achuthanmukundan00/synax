import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Writable } from 'node:stream';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { loadProjectConfig, normalizeProviderConfig, type ProjectConfig } from '../config/project';
import { createOpenAICompatibleClient } from '../llm/client';
import {
  createAgentConversation,
  buildModelFacingTools,
  resetAgentConversation,
  runAgentTurn,
  type AgentConversation,
  type AgentTerminalState,
  type AgentBudgetSnapshot,
  type AgentActivity,
} from '../agent/runner';
import { runVerification, type VerificationResult } from '../agent/verification';
import { buildProjectProfile, formatTextProfile } from '../config/profile';
import { buildInspectConfigProfile } from './inspect';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { discoverConfigPath, normalizeProviderConfig as normalizeProvider } from '../config/project';
import type { NormalizedProviderConfig } from '../llm/types';
import { detectDirtyTree, readLatestCheckpoint, undoLastEdit } from '../agent/safety';
import { runInteractiveTui } from '../tui/interactive-tui';

const execFileAsync = promisify(execFile);

export interface ChatSession {
  conversation: AgentConversation;
  handleUserMessage(message: string): Promise<ChatTurnReport>;
  handleSlashCommand(command: string): Promise<SlashCommandReport>;
  handleShellCommand?(command: string): Promise<ShellCommandReport>;
  /** Install a runtime event sink for real-time TUI state updates. */
  setEventSink?: (sink: ((event: import('../agent/events').AgentEvent) => void) | null) => void;
}

export interface ChatTurnReport {
  terminalState: AgentTerminalState;
  finalAnswer: string;
  changedFiles: string[];
  workingTreeClean?: boolean;
  steps: number;
  toolCalls?: number;
  error?: string;
}

export interface SlashCommandReport {
  handled: boolean;
  exit?: boolean;
  output: string;
  verification?: VerificationResult;
  newSession?: boolean;
}

export interface ShellCommandReport {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export type InlineInputSegment = InlineTextSegment | InlinePasteAttachment;

export interface InlineTextSegment {
  kind: 'text';
  text: string;
}

export interface InlinePasteAttachment {
  kind: 'paste';
  text: string;
  lines: number;
  chars: number;
}

export interface InlinePasteDraft {
  segments: InlineInputSegment[];
}

export interface InlinePasteInputSession {
  handleText(text: string): void;
  handleBackspace(): void;
  handlePasteStart(): void;
  handlePasteChunk(text: string): void;
  handlePasteEnd(): void;
  getDraft(): InlinePasteDraft;
  getPreview(): string;
  getVisibleBody(): string;
  hasPaste(): boolean;
}

export function createChatSession(options: {
  repoRoot: string;
  config: ProjectConfig;
  onActivity?: (activity: AgentActivity) => void;
  /** Suppress stdout writes (for TUI mode). */
  tui?: boolean;
}): ChatSession {
  const conversation = createAgentConversation();
  let eventSink: ((event: import('../agent/events').AgentEvent) => void) | null = null;

  return {
    conversation,
    setEventSink: (sink) => {
      eventSink = sink;
    },
    async handleUserMessage(message: string): Promise<ChatTurnReport> {
      const providerConfig = normalizeProviderConfig(options.config.provider ?? {});
      const client = createOpenAICompatibleClient(providerConfig);
      const beforeHead = await gitHead(options.repoRoot);
      const result = await runAgentTurn({
        repoRoot: options.repoRoot,
        task: message,
        client,
        conversation,
        maxSteps: options.config.maxModelSteps,
        maxToolCalls: options.config.maxToolCalls,
        tools: { bashEnabled: options.config.tools?.bash?.enabled },
        contextBudget: {
          contextBudgetTokens: options.config.contextBudgetTokens,
          contextWindowTokens: options.config.contextWindowTokens,
          reservedOutputTokens: options.config.reservedOutputTokens,
          keepRecentTokens: options.config.keepRecentTokens,
          maxSingleReadResultTokens: options.config.maxSingleReadResultTokens,
          maxTotalReadResultTokensPerTurn: options.config.maxTotalReadResultTokensPerTurn,
        },
        onActivity(activity) {
          options.onActivity?.(activity);
          if (options.tui && activity.kind === 'model_response' && activity.message.trim().length > 0) {
            eventSink?.({
              type: 'assistant_message',
              timestamp: new Date().toISOString(),
              content: activity.message,
            });
          }
          if (!options.tui) {
            if (activity.kind === 'model_response') {
              const label = `[synax] model step resp`;
              if (activity.message) {
                console.log(`${label}:\n${activity.message.replace(/^/gm, '  ')}`);
              }
            } else {
              console.log(`[synax] ${activity.kind}: ${activity.message}`);
            }
          }
        },
        onEvent: (event) => eventSink?.(event),
        onBudget(snapshot) {
          eventSink?.({
            type: 'context_budget_updated',
            timestamp: new Date().toISOString(),
            estimatedInputTokens: snapshot.estimatedInputTokens,
            inputLimit: snapshot.inputLimit,
            contextWindowTokens: snapshot.contextWindowTokens,
            reservedOutputTokens: snapshot.reservedOutputTokens,
            step: snapshot.step,
          });
          if (!options.tui) {
            console.log(formatBudgetSnapshot(snapshot));
          }
        },
      });
      const afterHead = await gitHead(options.repoRoot);
      const changedByCommit =
        beforeHead && afterHead && beforeHead !== afterHead
          ? await changedFilesBetween(options.repoRoot, beforeHead, afterHead)
          : [];
      const finalDirtyTree = await detectDirtyTree(options.repoRoot);
      saveContextState(options.repoRoot, result.conversation);
      return {
        terminalState: result.terminalState,
        finalAnswer: result.finalAnswer,
        changedFiles: unique([...result.changedFiles, ...changedByCommit]),
        workingTreeClean: !finalDirtyTree.dirty,
        steps: result.steps,
        toolCalls: result.toolCalls.length,
        error: result.error,
      };
    },
    async handleSlashCommand(command: string): Promise<SlashCommandReport> {
      return handleSlashCommand(command, {
        repoRoot: options.repoRoot,
        config: options.config,
        conversation,
      });
    },
    async handleShellCommand(command: string): Promise<ShellCommandReport> {
      return runLocalShellCommand(command, {
        repoRoot: options.repoRoot,
        shell: options.config.tools?.shell ?? 'zsh',
      });
    },
  };
}

export function createInlinePasteInputSession(): InlinePasteInputSession {
  const draft: InlinePasteDraft = { segments: [{ kind: 'text', text: '' }] };
  let current = draft.segments[0] as InlineTextSegment;
  let pasteText = '';
  let pasteActive = false;

  return {
    handleText(text: string): void {
      if (!text) return;
      current.text += text;
    },
    handleBackspace(): void {
      if (current.text.length > 0) {
        current.text = current.text.slice(0, -1);
        return;
      }

      const currentIndex = draft.segments.lastIndexOf(current);
      if (currentIndex > 0) {
        const previous = draft.segments[currentIndex - 1];
        if (previous.kind === 'paste') {
          draft.segments.splice(currentIndex - 1, 1);
          return;
        }
      }

      for (let index = draft.segments.length - 2; index >= 0; index -= 1) {
        const segment = draft.segments[index];
        if (segment.kind !== 'text' || segment.text.length === 0) continue;
        segment.text = segment.text.slice(0, -1);
        current = segment;
        return;
      }
    },
    handlePasteStart(): void {
      if (pasteActive) return;
      pasteActive = true;
      pasteText = '';
      current = { kind: 'text', text: '' };
      draft.segments.push(current);
    },
    handlePasteChunk(text: string): void {
      if (!pasteActive) {
        current.text += text;
        return;
      }
      pasteText += text;
    },
    handlePasteEnd(): void {
      if (!pasteActive) return;
      pasteActive = false;
      const attachment: InlinePasteAttachment = {
        kind: 'paste',
        text: pasteText,
        lines: countLines(pasteText),
        chars: pasteText.length,
      };
      mergePasteAttachment(draft, attachment);
      pasteText = '';
    },
    getDraft(): InlinePasteDraft {
      return draft;
    },
    getPreview(): string {
      return renderInlinePastePreview(draft);
    },
    getVisibleBody(): string {
      return renderInlinePastePreview(draft);
    },
    hasPaste(): boolean {
      return draft.segments.some((segment) => segment.kind === 'paste');
    },
  };
}

export function chatCommand(program: Command): void {
  const chat = new Command('chat');
  chat
    .description('Start an interactive Synax agent shell')
    .option('-m, --message <message>', 'Run one chat turn and exit')
    .option('--plain', 'Use plain line-mode chat instead of full-screen TUI')
    .action(async (options: { message?: string; plain?: boolean }) => {
      const repoRoot = process.cwd();
      const loaded = loadProjectConfig(repoRoot);
      if (loaded.errors.length > 0) {
        console.error(`[synax] Config error:\n${loaded.errors.map((e) => `${e.path}: ${e.message}`).join('\n')}`);
        process.exitCode = 1;
        return;
      }

      const provider = normalizeProviderConfig(loaded.config.provider ?? {});
      const useTui = shouldUseInteractiveTui({
        plain: Boolean(options.plain),
        message: options.message,
        stdinIsTTY: input.isTTY,
        stdoutIsTTY: output.isTTY,
      });

      // Shared state so the TUI can observe model output in real time.
      let lastModelOutput = '';

      const modelLabel = provider.model.trim() || undefined;
      const cwdLabel = compactHome(repoRoot);
      const gitBranch = await currentGitBranch(repoRoot);

      const session = createChatSession({
        repoRoot,
        config: loaded.config,
        onActivity: useTui
          ? (activity) => {
              if (activity.kind === 'model_response' && activity.modelOutput) {
                lastModelOutput = activity.modelOutput;
              }
            }
          : undefined,
        tui: useTui,
      });
      if (options.message) {
        if (!provider.model.trim()) {
          console.error('[synax] Config error: provider.model is required for chat.');
          process.exitCode = 1;
          return;
        }
        const report = await session.handleUserMessage(options.message);
        console.log(options.message);
        if (report.finalAnswer) console.log(report.finalAnswer);
        console.log(`[synax] terminal state: ${report.terminalState}`);
        if (report.terminalState !== 'completed') process.exitCode = 1;
        return;
      }

      if (useTui) {
        await runInteractiveTui(session, {
          blockedMessage: !provider.model.trim() ? 'provider.model is required' : undefined,
          lastModelOutput: () => lastModelOutput,
          modelLabel,
          endpointLabel: provider.baseUrl || undefined,
          providerName: providerNameFromPreset(loaded.config.provider?.preset),
          cwdLabel,
          gitBranch,
          contextWindowTokens: loaded.config.contextWindowTokens ?? loaded.config.contextBudgetTokens,
        });
        return;
      }

      console.log('[synax] Chat initialized');
      printBanner(repoRoot, provider.model);
      try {
        if (input.isTTY) {
          await runInlinePasteChat(session);
        } else {
          const rl = createInterface({ input, output, terminal: false });
          let exiting = false;
          rl.on('SIGINT', () => {
            exiting = true;
            console.log('\n[synax] exiting');
            rl.close();
          });
          for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith('/')) {
              const report = await session.handleSlashCommand(trimmed);
              if (report.output) console.log(report.output);
              if (report.exit) break;
              continue;
            }
            const report = await session.handleUserMessage(trimmed);
            printTurnReport(report);
          }
          if (!exiting) rl.close();
        }
      } finally {
        // no-op
      }
    });
  program.addCommand(chat);
}

export function shouldUseInteractiveTui(options: {
  plain: boolean;
  message?: string;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}): boolean {
  if (options.plain) return false;
  if (options.message) return false;
  return Boolean(options.stdinIsTTY && options.stdoutIsTTY);
}

export async function promptInteractiveLine(
  rl: Pick<ReturnType<typeof createInterface>, 'question'>,
  prompt = 'synax> ',
): Promise<string | null> {
  try {
    return await rl.question(prompt);
  } catch (error) {
    if (isUseAfterCloseError(error)) return null;
    throw error;
  }
}

export function flattenInlinePasteDraft(draft: InlinePasteDraft): string {
  const parts: string[] = [];
  let pasteIndex = 0;
  for (const segment of draft.segments) {
    if (segment.kind === 'text') {
      if (segment.text.length > 0) parts.push(segment.text);
      continue;
    }
    pasteIndex += 1;
    const text = limitPasteText(segment.text);
    parts.push(`--- BEGIN PASTED CONTENT ${pasteIndex}: ${countLines(text)} lines, ${text.length} chars ---`);
    parts.push(text);
    parts.push(`--- END PASTED CONTENT ${pasteIndex} ---`);
  }
  return parts
    .map((part) => part.replace(/\r\n/g, '\n'))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function draftContainsPaste(draft: InlinePasteDraft): boolean {
  return draft.segments.some((segment) => segment.kind === 'paste');
}

export function draftPlainText(draft: InlinePasteDraft): string {
  return draft.segments
    .filter((segment): segment is InlineTextSegment => segment.kind === 'text')
    .map((segment) => segment.text)
    .join('');
}

export type InlineSubmissionKind = 'empty' | 'slash' | 'message';

export function classifyInlineSubmission(draft: InlinePasteDraft): InlineSubmissionKind {
  const plainText = draftPlainText(draft).trim();
  if (!plainText && !draftContainsPaste(draft)) return 'empty';
  if (!draftContainsPaste(draft) && plainText.startsWith('/')) return 'slash';
  return 'message';
}

function renderInlinePastePreview(draft: InlinePasteDraft): string {
  return draft.segments
    .map((segment) =>
      segment.kind === 'text' ? segment.text : `[pasted: ${segment.lines} lines, ${segment.chars} chars]`,
    )
    .join('')
    .trim();
}

function mergePasteAttachment(draft: InlinePasteDraft, attachment: InlinePasteAttachment): void {
  for (let index = draft.segments.length - 1; index >= 0; index -= 1) {
    const segment = draft.segments[index];
    if (segment.kind !== 'paste') continue;
    const text =
      segment.text.length > 0 && attachment.text.length > 0
        ? `${segment.text}\n${attachment.text}`
        : segment.text + attachment.text;
    draft.segments[index] = {
      kind: 'paste',
      text,
      lines: countLines(text),
      chars: text.length,
    };
    return;
  }
  draft.segments.splice(draft.segments.length - 1, 0, attachment);
}

function limitPasteText(text: string): string {
  const maxChars = 12000;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… [truncated]`;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function printTurnReport(report: ChatTurnReport): void {
  if (report.finalAnswer) console.log(report.finalAnswer);
  if (report.error) console.log(`[synax] ${report.error}`);
  console.log(`[synax] terminal state: ${report.terminalState}`);
  if (report.changedFiles.length > 0) {
    console.log(`[synax] changed files: ${unique(report.changedFiles).join(', ')}`);
  }
}

async function currentGitBranch(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function gitHead(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function changedFilesBetween(repoRoot: string, before: string, after: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', `${before}..${after}`], {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function compactHome(path: string): string {
  const home = process.env.HOME;
  if (!home) return path;
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function providerNameFromPreset(preset: string | undefined): string | undefined {
  if (!preset) return undefined;
  if (preset === 'relay-local' || preset === 'relay-cloudflare') return 'Relay';
  if (preset === 'openai') return 'OpenAI';
  if (preset === 'anthropic') return 'Anthropic';
  if (preset === 'openrouter') return 'OpenRouter';
  return undefined;
}

export async function runInlinePasteChat(
  session: ChatSession,
  streams: {
    stdin?: {
      isTTY: boolean;
      setRawMode(mode: boolean): void;
      resume(): void;
      pause(): void;
      on(event: 'data', listener: (chunk: Buffer) => void): void;
      off(event: 'data', listener: (chunk: Buffer) => void): void;
    };
    stdout?: Writable;
  } = {},
): Promise<void> {
  let draft = createInlinePasteInputSession();
  const stdin = streams.stdin ?? input;
  const stdout = streams.stdout ?? output;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return;
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write('synax> ');
  let pasteMode = false;
  let suppressPasteTerminatorNewline = false;
  let pending = '';
  let resolveExit: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const render = (): void => {
    stdout.write(`\r\x1b[2Ksynax> ${draft.getPreview()}`);
  };

  const resetPrompt = (): void => {
    draft = createInlinePasteInputSession();
    render();
  };

  const submit = async (): Promise<void> => {
    const currentDraft = draft.getDraft();
    const plainText = draftPlainText(currentDraft).trim();
    const kind = classifyInlineSubmission(currentDraft);
    if (kind === 'empty') {
      stdout.write('\n');
      return;
    }
    if (kind === 'slash') {
      stdout.write('\n');
      const report = await session.handleSlashCommand(plainText);
      if (report.output) console.log(report.output);
      if (report.exit) {
        finish();
        return;
      }
      draft = createInlinePasteInputSession();
      render();
      return;
    }
    const message = flattenInlinePasteDraft(currentDraft);
    stdout.write('\n');
    try {
      const report = await session.handleUserMessage(message);
      printTurnReport(report);
      if (report.terminalState !== 'completed') {
        stdout.write(`[synax] model response rejected: ${report.error ?? report.terminalState}\n`);
      }
    } catch (error) {
      stdout.write(`[synax] model response rejected: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      resetPrompt();
    }
  };

  const finish = (): void => {
    stdin.off('data', onData);
    resolveExit?.();
  };

  const flushPendingOutsidePaste = (): void => {
    while (pending.length > 0) {
      if (pending.startsWith('\x1b[200~')) {
        pending = pending.slice(6);
        pasteMode = true;
        suppressPasteTerminatorNewline = false;
        draft.handlePasteStart();
        render();
        flushPendingInsidePaste();
        return;
      }
      if (pending.startsWith('\x1b[201~')) {
        pending = pending.slice(6);
        pasteMode = false;
        suppressPasteTerminatorNewline = true;
        draft.handlePasteEnd();
        render();
        flushPendingOutsidePaste();
        return;
      }
      if (suppressPasteTerminatorNewline) {
        suppressPasteTerminatorNewline = false;
        if (pending.startsWith('\r\n')) {
          pending = pending.slice(2);
          continue;
        }
        if (pending.startsWith('\r') || pending.startsWith('\n')) {
          pending = pending.slice(1);
          continue;
        }
      }
      const char = pending[0];
      pending = pending.slice(1);
      if (char === '\u0003') {
        stdout.write('\n[synax] exiting\n');
        finish();
        return;
      }
      if (char === '\u007f' || char === '\b') {
        draft.handleBackspace();
        render();
        continue;
      }
      if (char === '\r' || char === '\n') {
        void submit();
        continue;
      }
      draft.handleText(char);
      render();
    }
  };

  const flushPendingInsidePaste = (): void => {
    while (pending.length > 0) {
      if (pending.startsWith('\x1b[201~')) {
        pending = pending.slice(6);
        pasteMode = false;
        suppressPasteTerminatorNewline = true;
        draft.handlePasteEnd();
        render();
        flushPendingOutsidePaste();
        return;
      }
      if (pending.startsWith('\x1b[200~')) {
        pending = pending.slice(6);
        continue;
      }
      const char = pending[0];
      pending = pending.slice(1);
      if (char === '\u0003') {
        stdout.write('\n[synax] exiting\n');
        finish();
        return;
      }
      if (char === '\u007f' || char === '\b') {
        continue;
      }
      draft.handlePasteChunk(char);
    }
    render();
  };

  const onData = (chunk: Buffer): void => {
    pending += chunk.toString('utf8');
    if (pasteMode) {
      flushPendingInsidePaste();
      return;
    }
    flushPendingOutsidePaste();
  };

  stdout.write('\x1b[?2004h');
  stdin.on('data', onData);
  try {
    await exited;
  } finally {
    stdin.off('data', onData);
    stdout.write('\x1b[?2004l');
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write('\n');
  }
}

function isUseAfterCloseError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_USE_AFTER_CLOSE';
}

async function handleSlashCommand(
  rawCommand: string,
  context: { repoRoot: string; config: ProjectConfig; conversation: AgentConversation },
): Promise<SlashCommandReport> {
  const trimmedCommand = rawCommand.trim();
  const command = trimmedCommand.toLowerCase();
  if (command === '/exit' || command === '/quit') {
    return { handled: true, exit: true, output: '[synax] bye' };
  }
  if (command === '/help') {
    return {
      handled: true,
      output: renderHelpPanel(),
    };
  }
  if (command === '/clear') {
    resetAgentConversation(context.conversation);
    return { handled: true, output: '[synax] conversation cleared' };
  }
  if (command === '/new') {
    resetAgentConversation(context.conversation);
    return { handled: true, output: '[synax] new session started', newSession: true };
  }
  if (command === '/settings') {
    return { handled: true, output: renderSettingsPanel(context.repoRoot, context.config) };
  }
  if (command.startsWith('/settings set ')) {
    return { handled: true, output: applySettingsSet(trimmedCommand, context.config) };
  }
  if (command === '/tools') {
    const exposed = buildModelFacingTools({ bashEnabled: context.config.tools?.bash?.enabled }).map(
      (tool) => tool.name,
    );
    return {
      handled: true,
      output: `Tools\n-----\nExposed: ${exposed.join(', ')}\nShell: ${context.config.tools?.shell ?? 'zsh'}\nBash: ${(context.config.tools?.bash?.enabled ?? false) ? 'enabled' : 'disabled'}\nUnsafe: ${(context.config.tools?.unsafe ?? false) ? 'enabled' : 'disabled'}`,
    };
  }
  if (command === '/budget') {
    const liveEstimate = context.conversation.tokenLedger.lastKnownTokenCount;
    const liveLimit = (context.config.contextBudgetTokens ?? 131072) - (context.config.reservedOutputTokens ?? 8192);
    const usedPercent = liveLimit > 0 ? Math.round((liveEstimate / liveLimit) * 100) : 0;
    const liveLine =
      liveEstimate > 0
        ? `Live estimate: ~${liveEstimate}/${liveLimit} tokens (${usedPercent}%)`
        : 'Live estimate: (no model calls yet)';
    const compactionLine = context.conversation.latestCompaction
      ? `Last compaction: stage ${context.conversation.latestCompaction.stage}, ${context.conversation.latestCompaction.summary.length} chars`
      : 'Last compaction: none';
    const assemblyLine = context.conversation.assemblyStats
      ? `Assembly: ${context.conversation.assemblyStats.totalMessagesIn} → ${context.conversation.assemblyStats.totalMessagesOut} msgs, ${context.conversation.assemblyStats.compactedToolResults} compacted`
      : 'Assembly: not run yet';
    return {
      handled: true,
      output: [
        'Budget',
        '------',
        `Context window:  ${context.config.contextBudgetTokens ?? 131072}`,
        `Reserved output:  ${context.config.reservedOutputTokens ?? 8192}`,
        `Max model steps:  ${context.config.maxModelSteps ?? 64}`,
        `Max tool calls:   ${context.config.maxToolCalls ?? 192}`,
        `Max single read:  ${context.config.maxSingleReadResultTokens ?? 12000}`,
        `Max total reads:  ${context.config.maxTotalReadResultTokensPerTurn ?? 40000}`,
        `Keep recent:      ${context.config.keepRecentTokens ?? 20000}`,
        '',
        liveLine,
        compactionLine,
        assemblyLine,
      ].join('\n'),
    };
  }
  if (command === '/test-provider') {
    return { handled: true, output: await renderProviderTest(context.config) };
  }
  if (command === '/inspect') {
    const profile = buildProjectProfile(context.repoRoot);
    return {
      handled: true,
      output: formatTextProfile({ project: profile, config: buildInspectConfigProfile(context.repoRoot) }),
    };
  }
  if (command === '/status') {
    const profile = buildProjectProfile(context.repoRoot);
    const git = profile.git;
    const filesRead = unique(context.conversation.inspectionLedger.getInspectedRanges().map((range) => range.path));
    const checkpoint = await readLatestCheckpoint(context.repoRoot);
    if (!git) return { handled: true, output: '[synax] git status unavailable' };
    const liveEstimate = context.conversation.tokenLedger.lastKnownTokenCount;
    const liveLimit = (context.config.contextBudgetTokens ?? 131072) - (context.config.reservedOutputTokens ?? 8192);
    const usedPercent = liveLimit > 0 ? Math.round((liveEstimate / liveLimit) * 100) : 0;
    const liveTokenLine =
      liveEstimate > 0 ? `~${liveEstimate}/${liveLimit} tokens (${usedPercent}%)` : '(no model calls yet)';
    return {
      handled: true,
      output: [
        `Repo: ${git.root}`,
        `Branch: ${git.branch}`,
        `Dirty: ${git.isDirty ? 'yes' : 'no'}`,
        `Context budget: ${liveTokenLine}`,
        `Max model steps: ${context.config.maxModelSteps ?? 'not configured'}`,
        `Max tool calls: ${context.config.maxToolCalls ?? 'not configured'}`,
        `Files read this session: ${filesRead.length > 0 ? filesRead.join(', ') : '(none)'}`,
        `Latest checkpoint: ${checkpoint ? `${checkpoint.id} (${checkpoint.statusPath})` : '(none)'}`,
      ].join('\n'),
    };
  }
  const verifyMatch = trimmedCommand.match(/^\/verify(?:\s+(quick|full))?$/i);
  if (verifyMatch) {
    const profile = verifyMatch[1]?.toLowerCase() === 'full' ? 'full' : 'quick';
    const verification = await runVerification({
      repoRoot: context.repoRoot,
      command: context.config.verification?.defaultCommand,
      timeoutMs: profile === 'full' ? 120000 : 30000,
      maxOutputChars: profile === 'full' ? 12000 : 4000,
    });
    return {
      handled: true,
      verification,
      output: formatVerification(verification, profile),
    };
  }
  if (command === '/diff') {
    return { handled: true, output: await renderGitDiff(context.repoRoot) };
  }
  if (command === '/undo-last-edit') {
    const undone = await undoLastEdit(context.repoRoot);
    return { handled: true, output: undone.ok ? `[synax] ${undone.message}` : `[synax] ${undone.message}` };
  }
  return { handled: false, output: `[synax] unknown command: ${rawCommand}` };
}

async function runLocalShellCommand(
  command: string,
  context: { repoRoot: string; shell: string },
): Promise<ShellCommandReport> {
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(context.shell, ['-lc', command], {
      cwd: context.repoRoot,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    return {
      command,
      exitCode: 0,
      stdout: truncateShellOutput(result.stdout),
      stderr: truncateShellOutput(result.stderr),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const shellError = error as {
      code?: number | string;
      signal?: string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const exitCode = typeof shellError.code === 'number' ? shellError.code : 1;
    const stderr =
      shellError.stderr ??
      (shellError.signal ? `terminated by signal ${shellError.signal}` : (shellError.message ?? ''));
    return {
      command,
      exitCode,
      stdout: truncateShellOutput(shellError.stdout ?? ''),
      stderr: truncateShellOutput(stderr),
      durationMs: Date.now() - startedAt,
    };
  }
}

function truncateShellOutput(output: string, limit = 6000): string {
  if (output.length <= limit) return output;
  return `${output.slice(0, limit)}\n[synax] output truncated to ${limit} chars`;
}

async function renderGitDiff(repoRoot: string): Promise<string> {
  try {
    const [{ stdout: status }, { stdout: diff }] = await Promise.all([
      execFileAsync('git', ['status', '--short'], { cwd: repoRoot, maxBuffer: 64 * 1024 }),
      execFileAsync('git', ['diff', '--no-ext-diff'], { cwd: repoRoot, maxBuffer: 256 * 1024 }),
    ]);
    const statusLines = status
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(0, 80);
    const diffLines = diff
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .slice(0, 200);
    const sections = ['Synax Diff', '----------', 'Status:'];
    sections.push(statusLines.length > 0 ? statusLines.map((line) => `  ${line}`).join('\n') : '  (clean)');
    sections.push('', 'Diff:');
    sections.push(diffLines.length > 0 ? diffLines.join('\n') : '  (no unstaged diff)');
    return sections.join('\n');
  } catch (error) {
    return `[synax] diff unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function applySettingsSet(rawCommand: string, config: ProjectConfig): string {
  const match = rawCommand.match(/^\/settings\s+set\s+(\S+)\s+([\s\S]+)$/i);
  if (!match) {
    return invalidSettingsPath();
  }
  const path = match[1];
  const value = match[2].trim();
  const normalizedPath = path.toLowerCase();
  if (!value) {
    return '[synax] Invalid settings value: value is required';
  }

  config.provider ??= {};
  if (normalizedPath === 'provider.endpoint') {
    config.provider.base_url = value;
    config.provider.baseUrl = value;
    return '[synax] provider.endpoint updated for current session only';
  }
  if (normalizedPath === 'provider.model') {
    config.provider.model = value;
    return '[synax] provider.model updated for current session only';
  }
  if (normalizedPath.startsWith('provider.header.')) {
    const headerName = path.slice('provider.header.'.length);
    if (!headerName.trim()) return invalidSettingsPath();
    config.provider.custom_headers = { ...(config.provider.custom_headers ?? config.provider.customHeaders ?? {}) };
    config.provider.custom_headers[headerName] = value;
    config.provider.customHeaders = config.provider.custom_headers;
    return `[synax] provider.header.${headerName} updated for current session only (value redacted)`;
  }

  const numeric = parsePositiveInteger(value);
  if (normalizedPath === 'agent.context_budget_tokens') {
    if (numeric === null)
      return '[synax] Invalid settings value: agent.context_budget_tokens must be a positive integer';
    config.contextBudgetTokens = numeric;
    return '[synax] agent.context_budget_tokens updated for current session only';
  }
  if (normalizedPath === 'agent.max_model_steps') {
    if (numeric === null) return '[synax] Invalid settings value: agent.max_model_steps must be a positive integer';
    config.maxModelSteps = numeric;
    return '[synax] agent.max_model_steps updated for current session only';
  }
  if (normalizedPath === 'agent.max_tool_calls') {
    if (numeric === null) return '[synax] Invalid settings value: agent.max_tool_calls must be a positive integer';
    config.maxToolCalls = numeric;
    return '[synax] agent.max_tool_calls updated for current session only';
  }

  return invalidSettingsPath();
}

function invalidSettingsPath(): string {
  return [
    '[synax] Invalid settings path.',
    'Examples:',
    '  /settings set provider.endpoint http://127.0.0.1:1234/v1',
    '  /settings set provider.model Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf',
    '  /settings set provider.header.Authorization Bearer <token>',
    '  /settings set agent.context_budget_tokens 16000',
    '  /settings set agent.max_model_steps 64',
    '  /settings set agent.max_tool_calls 192',
  ].join('\n');
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

type ProviderTestStatus = 'ready' | 'degraded' | 'blocked' | 'failed';

interface ProviderProbe {
  status: 'ok' | 'unavailable' | 'auth' | 'error';
  message: string;
  modelFound?: boolean;
}

async function renderProviderTest(config: ProjectConfig): Promise<string> {
  const provider = normalizeProvider(config.provider ?? {});
  if (!provider.baseUrl.trim() || !provider.model.trim()) {
    return formatProviderTest(config, provider, 'blocked', [
      provider.baseUrl.trim() ? '[ok] endpoint configured' : '[blocked] endpoint missing',
      provider.model.trim() ? '[ok] model configured' : '[blocked] model missing',
    ]);
  }

  const models = await probeModels(provider);
  if (models.status === 'auth') {
    return formatProviderTest(config, provider, 'blocked', [`[blocked] models: ${models.message}`]);
  }

  const chat = await probeChat(provider);
  if (chat.status === 'auth') {
    return formatProviderTest(config, provider, 'blocked', [
      formatModelsLine(models, provider.model),
      `[blocked] chat: ${chat.message}`,
    ]);
  }
  if (chat.status !== 'ok') {
    return formatProviderTest(config, provider, 'failed', [
      formatModelsLine(models, provider.model),
      `[failed] chat: ${chat.message}`,
    ]);
  }

  const status: ProviderTestStatus =
    models.status === 'ok' && models.modelFound !== false
      ? 'ready'
      : models.status === 'unavailable'
        ? 'degraded'
        : 'failed';
  return formatProviderTest(config, provider, status, [
    formatModelsLine(models, provider.model),
    `[ok] chat: ${chat.message}`,
  ]);
}

async function probeModels(provider: NormalizedProviderConfig): Promise<ProviderProbe> {
  try {
    const res = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: providerHeaders(provider),
    });
    if (res.status === 401 || res.status === 403) return { status: 'auth', message: `HTTP ${res.status}` };
    if (!res.ok) return { status: 'unavailable', message: `HTTP ${res.status}` };
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    if (!Array.isArray(data.data)) return { status: 'unavailable', message: 'listing not supported' };
    return {
      status: 'ok',
      message: `${data.data.length} models listed`,
      modelFound: data.data.some((model) => model.id === provider.model),
    };
  } catch (error) {
    return { status: 'unavailable', message: errorMessage(error) };
  }
}

async function probeChat(provider: NormalizedProviderConfig): Promise<ProviderProbe> {
  try {
    const res = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { ...providerHeaders(provider), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: 'Reply with exactly: OK' },
          { role: 'user', content: 'OK' },
        ],
        temperature: 0,
        max_tokens: 8,
        stream: false,
      }),
    });
    if (res.status === 401 || res.status === 403) return { status: 'auth', message: `HTTP ${res.status}` };
    if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` };
    return { status: 'ok', message: 'smoke request passed' };
  } catch (error) {
    return { status: 'error', message: errorMessage(error) };
  }
}

function providerHeaders(provider: NormalizedProviderConfig): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'synax-chat/0.3.0' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  for (const [key, value] of Object.entries(provider.customHeaders ?? {})) headers[key] = value;
  return headers;
}

function formatModelsLine(models: ProviderProbe, model: string): string {
  if (models.status === 'ok') {
    return models.modelFound === false
      ? `[failed] models: configured model not listed (${model})`
      : `[ok] models: ${models.message}`;
  }
  return `[warn] models: ${models.message}`;
}

function formatProviderTest(
  config: ProjectConfig,
  provider: NormalizedProviderConfig,
  status: ProviderTestStatus,
  checks: string[],
): string {
  return [
    'Provider Check',
    '--------------',
    `Status:      ${status}`,
    `Profile:     ${config.activeProfile ?? 'default'}`,
    `Endpoint:    ${sanitizeEndpoint(provider.baseUrl)}`,
    `Model:       ${provider.model || '(not set)'}`,
    '',
    'Checks',
    ...checks.map((line) => `  ${line}`),
  ].join('\n');
}

function sanitizeEndpoint(raw: string): string {
  try {
    const url = new URL(raw);
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, url.pathname === '/' ? '/' : '');
  } catch {
    return raw.split('?')[0];
  }
}

function printBanner(repoRoot: string, model: string): void {
  console.log('Synax');
  console.log('-----');
  console.log(`Repo: ${repoRoot}`);
  console.log(`Model: ${model}`);
  console.log(
    'Commands: /help /settings /tools /budget /test-provider /inspect /verify /verify quick /verify full /diff /undo-last-edit /clear /new /status /exit',
  );
  console.log('TUI shell: !<command>');
  console.log('');
}

function renderHelpPanel(): string {
  return [
    'Chat Commands',
    '-------------',
    '/help                      Show this help panel',
    '/settings                  Show provider, agent, tool, and verification settings',
    '/settings set <path> <value>',
    '                           Change a supported setting for the current session',
    '/tools                     Show model-facing tools',
    '/budget                    Show context and loop limits',
    '/test-provider             Probe provider models and chat endpoints',
    '/inspect                   Show project profile',
    '/verify [quick|full]       Run configured verification command',
    '/diff                      Show bounded git diff',
    '/undo-last-edit            Revert last Synax-owned edit when unchanged',
    '/clear                     Reset the conversation',
    '/new                       Start a fresh session',
    '/status                    Show git and budget status',
    '/exit, /quit               Exit chat',
    '!<command>                 Run a local shell command from the TUI',
    '',
    'Session Settings',
    '----------------',
    '/settings set provider.endpoint http://127.0.0.1:1234/v1',
    '/settings set provider.model Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf',
    '/settings set provider.header.Authorization Bearer <token>',
    '/settings set agent.context_budget_tokens 65536',
    '/settings set agent.max_model_steps 24',
    '/settings set agent.max_tool_calls 64',
  ].join('\n');
}

function renderSettingsPanel(repoRoot: string, config: ProjectConfig): string {
  const provider = normalizeProvider(config.provider ?? {});
  const headers = Object.keys(config.provider?.custom_headers ?? config.provider?.customHeaders ?? {});
  const configPath = discoverConfigPath(repoRoot) ?? '(defaults)';
  const exposed = buildModelFacingTools({ bashEnabled: config.tools?.bash?.enabled }).map((tool) => tool.name);
  return [
    'Settings',
    '--------',
    `Profile:        ${config.activeProfile ?? 'default'}`,
    `Config file:    ${configPath}`,
    '',
    'Provider',
    `  preset:       ${config.provider?.preset ?? 'relay-local'}`,
    `  base_url:     ${provider.baseUrl}`,
    `  model:        ${provider.model || '(not set)'}`,
    `  api_key_env:  ${config.provider?.api_key_env ?? config.provider?.apiKeyEnv ?? 'not set'}`,
    `  headers:      ${headers.length} configured`,
    '',
    'Agent',
    `  context:      ${config.contextBudgetTokens ?? 131072}`,
    `  max_steps:    ${config.maxModelSteps ?? 64}`,
    `  max_tools:    ${config.maxToolCalls ?? 192}`,
    '',
    'Tools',
    `  exposed:      ${exposed.join(', ')}`,
    `  shell:        ${config.tools?.shell ?? 'zsh'}`,
    `  bash:         ${(config.tools?.bash?.enabled ?? false) ? 'enabled' : 'disabled'}`,
    `  unsafe:       ${(config.tools?.unsafe ?? false) ? 'enabled' : 'disabled'}`,
    '',
    'Verification',
    `  command:      ${config.verification?.defaultCommand?.trim() || '(not set)'}`,
  ].join('\n');
}

function formatVerification(result: VerificationResult, profile?: 'quick' | 'full'): string {
  const lines = [`[synax] verification${profile ? ` (${profile})` : ''}: ${result.state}`];
  if (result.command) lines.push(`command: ${result.command}`);
  if (result.exitCode !== undefined) lines.push(`exit code: ${result.exitCode}`);
  if (result.stdout.trim()) lines.push(result.stdout.trim());
  if (result.stderr.trim()) lines.push(result.stderr.trim());
  return lines.join('\n');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBudgetSnapshot(snapshot: AgentBudgetSnapshot): string {
  const usedPercent =
    snapshot.inputLimit > 0 ? Math.round((snapshot.estimatedInputTokens / snapshot.inputLimit) * 100) : 0;
  const bar = renderBudgetBar(usedPercent);
  const label =
    snapshot.compactionStage !== undefined ? `[budget step ${snapshot.step}]` : `[budget step ${snapshot.step}]`;
  return `[synax] ${label} ${bar} ~${snapshot.estimatedInputTokens}/${snapshot.inputLimit} tokens (${usedPercent}%)`;
}

function renderBudgetBar(percent: number): string {
  const width = 10;
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  const empty = width - filled;
  const color = percent >= 90 ? '\x1b[31m' : percent >= 60 ? '\x1b[33m' : '\x1b[32m';
  return `${color}█`.repeat(filled) + `\x1b[90m░`.repeat(empty) + '\x1b[0m';
}

function saveContextState(repoRoot: string, conversation: AgentConversation): void {
  try {
    const state = {
      task: '',
      inspectedFiles: unique(conversation.inspectionLedger.getInspectedRanges().map((r) => r.path)),
      orientation: conversation.inspectionLedger.getOrientation(),
      gitStatus: conversation.inspectionLedger.hasGitStatusInspection(),
      gitDiff: conversation.inspectionLedger.hasGitDiffInspection(),
      tokenEstimate: conversation.tokenLedger.lastKnownTokenCount,
      assembly: conversation.assemblyStats
        ? {
            totalMessagesIn: conversation.assemblyStats.totalMessagesIn,
            totalMessagesOut: conversation.assemblyStats.totalMessagesOut,
            estimatedTokensIn: conversation.assemblyStats.estimatedTokensIn,
            estimatedTokensOut: conversation.assemblyStats.estimatedTokensOut,
            compactedToolResults: conversation.assemblyStats.compactedToolResults,
            keptRecentTurns: conversation.assemblyStats.keptRecentTurns,
          }
        : null,
      compaction: conversation.latestCompaction
        ? {
            stage: conversation.latestCompaction.stage,
            tokensBefore: conversation.latestCompaction.tokensBefore,
            tokensAfter: conversation.latestCompaction.tokensAfter ?? 0,
          }
        : null,
    };
    const dir = join(repoRoot, '.synax');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'context.json'), JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    // Best-effort only
  }
}
