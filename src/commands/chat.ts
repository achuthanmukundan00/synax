import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Writable } from 'node:stream';
import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  applyEffectiveSynaxConfigToProjectConfig,
  discoverConfigPath,
  loadProjectConfig,
  normalizeProviderConfig,
  toProviderFactoryInput,
  type ProjectConfig,
} from '../config/project';
import { loadSynaxConfig } from '../config/load-config';
import { loadSkills, type SkillDiagnostic } from '../agent/skills';
import { resetTokenLedger } from '../agent/context-budget';
import pkg from '../../package.json';
import { createLLMClient, describeLLMProvider } from '../llm/provider-factory';
import {
  Session,
  type AgentConversation,
  type AgentTerminalState,
  type AgentBudgetSnapshot,
  type AgentActivity,
} from '../session/Session';
import { runVerification, type VerificationResult } from '../agent/verification';
import { buildProjectProfile, formatTextProfile } from '../config/profile';
import { buildInspectConfigProfile } from './inspect';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import type { NormalizedProviderConfig, ProviderMetadata } from '../llm/types';
import { detectDirtyTree, readLatestCheckpoint, undoLastEdit } from '../agent/safety';
import { runInteractiveTui } from '../tui/interactive-tui';
import { isSecretTrigger } from '../backrooms/trigger';
import {
  createSession,
  appendSessionEvent,
  upsertSessionMeta,
  generateSessionId,
  findSessionMeta,
  readSessionEvents,
  generateSessionTitle,
  generateSessionSummary,
  type SessionEvent,
} from '../sessions/session-store';

const execFileAsync = promisify(execFile);

export interface ChatSession {
  conversation: AgentConversation;
  /** Persistent session ID for cross-session resume. */
  sessionId: string;
  handleUserMessage(message: string): Promise<ChatTurnReport>;
  handleSlashCommand(command: string): Promise<SlashCommandReport>;
  handleShellCommand?(command: string): Promise<ShellCommandReport>;
  /** Install a runtime event sink for real-time TUI state updates. */
  setEventSink?: (sink: ((event: import('../agent/events').AgentEvent) => void) | null) => void;
  /** Refresh the session's config reference (called after settings changes). */
  refreshConfig?: (config: ProjectConfig, thinkingLevel?: import('../config/schema').ThinkingLevel) => void;
  /** Reset the conversation to a fresh state (for /new). Preserves skill messages. */
  resetConversation?: () => void;
  /** Finalize the current session (mark as completed/cancelled) and start a new one. */
  startNewSession?: () => void;
  /** Append a session event for persistence. */
  appendSessionEvent?: (event: SessionEvent) => void;
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
  handleCursorLeft(): void;
  handleCursorRight(): void;
  handleCursorUp(): void;
  handleCursorDown(): void;
  handleHome(): void;
  handleEnd(): void;
  getDraft(): InlinePasteDraft;
  getPreview(): string;
  getVisibleBody(): string;
  getCursorOffset(): number;
  hasPaste(): boolean;
}

export function createChatSession(options: {
  repoRoot: string;
  config: ProjectConfig;
  /** Thinking level from effective config. When not 'off', enables provider-level thinking. */
  thinkingLevel?: import('../config/schema').ThinkingLevel;
  onActivity?: (activity: AgentActivity) => void;
  /** Suppress stdout writes (for TUI mode). */
  tui?: boolean;
  /** Pre-loaded skill messages to inject into the agent system context. */
  skillMessages?: string[];
  /** Skill diagnostics for display/debug. */
  skillDiagnostics?: SkillDiagnostic[];
  /** Optional session ID to resume. When set, the session store entry for that ID is reused. */
  resumeSessionId?: string;
}): ChatSession {
  const conversation = Session.createConversation({
    skillMessages: options.skillMessages,
  });
  let eventSink: ((event: import('../agent/events').AgentEvent) => void) | null = null;

  /** Config wrapper: the TUI updates this reference when settings change. */
  const configRef: { current: ProjectConfig } = { current: options.config };
  /** Thinking level ref: the TUI updates this when settings change. */
  let thinkingLevelRef: import('../config/schema').ThinkingLevel | undefined = options.thinkingLevel;

  const getConfig = (): ProjectConfig => configRef.current;

  // ── Session persistence ────────────────────────────────────────────
  let sessionId = options.resumeSessionId ?? generateSessionId();
  const createSessionRecord = (id: string): void => {
    try {
      createSession({
        id,
        workspacePath: options.repoRoot,
        title: 'New session',
        activeModel: configRef.current.provider?.model ?? undefined,
      });
    } catch {
      // Best-effort: session persistence is non-critical
    }
  };
  createSessionRecord(sessionId);

  const appendSessionEventFn = (event: SessionEvent): void => {
    try {
      appendSessionEvent(sessionId, event);
    } catch {
      // Best-effort
    }
  };

  const updateSessionTitle = (): void => {
    try {
      const events = readSessionEvents(sessionId);
      const title = generateSessionTitle(events);
      const summary = generateSessionSummary(events);
      const meta = findSessionMeta(sessionId);
      if (meta) {
        upsertSessionMeta({ ...meta, title, summary });
      }
    } catch {
      // Best-effort
    }
  };

  const finalizeCurrentSession = (status: 'completed' | 'cancelled' | 'failed'): void => {
    try {
      const meta = findSessionMeta(sessionId);
      if (meta && meta.status === 'active') {
        upsertSessionMeta({ ...meta, status, updatedAt: new Date().toISOString() });
      }
    } catch {
      // Best-effort
    }
  };

  const startNewSessionId = (): string => {
    finalizeCurrentSession('cancelled');
    sessionId = generateSessionId();
    createSessionRecord(sessionId);
    return sessionId;
  };

  const doResetConversation = (): void => {
    startNewSessionId();
    const fresh = Session.createConversation({
      skillMessages: options.skillMessages,
    });
    conversation.messages.splice(0, conversation.messages.length, ...fresh.messages);
    conversation.inspectionLedger = fresh.inspectionLedger;
    conversation.latestCompaction = null;
    conversation.assemblyStats = null;
    resetTokenLedger(conversation.tokenLedger);
  };

  return {
    conversation,
    sessionId,
    setEventSink: (sink) => {
      eventSink = sink;
    },
    refreshConfig: (config: ProjectConfig, thinkingLevel?: import('../config/schema').ThinkingLevel) => {
      configRef.current = config;
      if (thinkingLevel !== undefined) thinkingLevelRef = thinkingLevel;
    },
    resetConversation: () => {
      doResetConversation();
    },
    startNewSession: () => {
      doResetConversation();
    },
    appendSessionEvent: appendSessionEventFn,
    async handleUserMessage(message: string): Promise<ChatTurnReport> {
      appendSessionEventFn({
        type: 'user_message',
        at: new Date().toISOString(),
        content: message,
      });
      const config = getConfig();
      const factoryInput = toProviderFactoryInput(config);
      if (thinkingLevelRef) factoryInput.thinkingLevel = thinkingLevelRef;
      const factoryResult = createLLMClient(factoryInput);
      const client = factoryResult.client;
      const beforeHead = await gitHead(options.repoRoot);
      const turnSession = new Session({
        repoRoot: options.repoRoot,
        client,
        maxToolCalls: config.maxToolCalls,
        bashEnabled: config.tools?.bash?.enabled,
        conversation,
        contextBudget: {
          contextBudgetTokens: config.contextBudgetTokens,
          contextWindowTokens: config.contextWindowTokens,
          reservedOutputTokens: config.reservedOutputTokens,
          keepRecentTokens: config.keepRecentTokens,
          maxSingleReadResultTokens: config.maxSingleReadResultTokens,
          maxTotalReadResultTokensPerTurn: config.maxTotalReadResultTokensPerTurn,
        },
        onActivity(activity) {
          options.onActivity?.(activity);
          if (options.tui && activity.kind === 'model_response') {
            const fullContent = activity.modelOutput || activity.message;
            if (fullContent.trim().length > 0) {
              eventSink?.({
                type: 'assistant_message',
                timestamp: new Date().toISOString(),
                content: fullContent,
              });
            }
          }
          if (!options.tui) {
            if (activity.kind === 'model_response') {
              const label = `[synax] model step resp`;
              const msg = activity.message;
              if (msg) {
                console.log(`${label}:\n${msg.replace(/^/gm, '  ')}`);
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
      const result = await turnSession.startTurn(message);
      const afterHead = await gitHead(options.repoRoot);
      const changedByCommit =
        beforeHead && afterHead && beforeHead !== afterHead
          ? await changedFilesBetween(options.repoRoot, beforeHead, afterHead)
          : [];
      const finalDirtyTree = await detectDirtyTree(options.repoRoot);
      saveContextState(options.repoRoot, result.conversation);
      appendSessionEventFn({
        type: 'assistant_message',
        at: new Date().toISOString(),
        content: result.finalAnswer || result.error || result.terminalState,
      });
      appendSessionEventFn({
        type: 'state_snapshot',
        at: new Date().toISOString(),
        snapshot: {
          terminalState: result.terminalState,
          steps: result.steps,
          toolCalls: result.toolCalls.length,
          changedFiles: result.changedFiles,
        },
      });
      // Finalize session on terminal states
      if (
        result.terminalState === 'completed' ||
        result.terminalState === 'blocked' ||
        result.terminalState === 'budget_exhausted' ||
        result.terminalState === 'model_error' ||
        result.terminalState === 'tool_error' ||
        result.terminalState === 'failed_verification'
      ) {
        finalizeCurrentSession(result.terminalState === 'completed' ? 'completed' : 'failed');
      }
      // Only refresh title/summary on first turn to avoid O(n) disk reads every turn
      const meta = findSessionMeta(sessionId);
      if (!meta || meta.messageCount <= 1) {
        updateSessionTitle();
      }
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
        config: getConfig(),
        conversation,
        skillMessages: options.skillMessages,
      });
    },
    async handleShellCommand(command: string): Promise<ShellCommandReport> {
      return runLocalShellCommand(command, {
        repoRoot: options.repoRoot,
        shell: getConfig().tools?.shell ?? 'zsh',
      });
    },
  };
}

export function createInlinePasteInputSession(): InlinePasteInputSession {
  const draft: InlinePasteDraft = { segments: [{ kind: 'text', text: '' }] };
  let current = draft.segments[0] as InlineTextSegment;
  let pasteText = '';
  let pasteActive = false;
  /** 0-indexed character offset within the current text segment. */
  let cursorCharOffset = 0;

  /** Find the last text segment in the draft, or create one. */
  const ensureTextSegment = (): InlineTextSegment => {
    const last = draft.segments[draft.segments.length - 1];
    if (last?.kind === 'text') return last;
    const seg: InlineTextSegment = { kind: 'text', text: '' };
    draft.segments.push(seg);
    return seg;
  };

  /** Map cursor to (segment index, char offset) into draft.segments. */
  const cursorToSegOffset = (): { segIdx: number; charOff: number } => {
    const currentIdx = draft.segments.lastIndexOf(current);
    if (currentIdx < 0) return { segIdx: draft.segments.length - 1, charOff: 0 };
    return { segIdx: currentIdx, charOff: Math.min(cursorCharOffset, current.text.length) };
  };

  /** Re-locate cursor to (segIdx, charOff). */
  const setCursorSeg = (segIdx: number, charOff: number): void => {
    const seg = draft.segments[segIdx];
    if (!seg || seg.kind !== 'text') {
      // Land on the nearest text segment.
      for (let i = segIdx; i >= 0; i -= 1) {
        if (draft.segments[i]?.kind === 'text') {
          current = draft.segments[i] as InlineTextSegment;
          cursorCharOffset = current.text.length;
          return;
        }
      }
      for (let i = segIdx + 1; i < draft.segments.length; i += 1) {
        if (draft.segments[i]?.kind === 'text') {
          current = draft.segments[i] as InlineTextSegment;
          cursorCharOffset = 0;
          return;
        }
      }
      current = ensureTextSegment();
      cursorCharOffset = 0;
      return;
    }
    current = seg as InlineTextSegment;
    cursorCharOffset = Math.max(0, Math.min(charOff, current.text.length));
  };

  /** Compute the flat visible-body offset from segment-level cursor. */
  const computeVisibleOffset = (): number => {
    let offset = 0;
    for (let i = 0; i < draft.segments.length; i += 1) {
      const seg = draft.segments[i];
      if (seg === current) {
        return offset + cursorCharOffset;
      }
      if (seg.kind === 'text') {
        offset += seg.text.length;
      } else {
        offset += `[pasted: ${seg.lines} lines, ${seg.chars} chars]`.length;
      }
    }
    return offset;
  };

  /** Given a flat visible-body offset, position the cursor. */
  const setCursorFromVisibleOffset = (target: number): void => {
    let offset = 0;
    for (let i = 0; i < draft.segments.length; i += 1) {
      const seg = draft.segments[i];
      let segLen = 0;
      if (seg.kind === 'text') {
        segLen = seg.text.length;
        if (offset + segLen >= target) {
          setCursorSeg(i, target - offset);
          return;
        }
      } else {
        segLen =
          `[pasted: ${(seg as InlinePasteAttachment).lines} lines, ${(seg as InlinePasteAttachment).chars} chars]`
            .length;
        if (offset + segLen >= target) {
          // Target falls in a paste segment; snap to nearest text boundary.
          // Try the next text segment.
          for (let j = i + 1; j < draft.segments.length; j += 1) {
            if (draft.segments[j]?.kind === 'text') {
              setCursorSeg(j, 0);
              return;
            }
          }
          // Try the previous text segment.
          for (let j = i - 1; j >= 0; j -= 1) {
            if (draft.segments[j]?.kind === 'text') {
              setCursorSeg(j, draft.segments[j].text.length);
              return;
            }
          }
          setCursorSeg(0, 0);
          return;
        }
      }
      offset += segLen;
    }
    // Past end: move to end of last text segment.
    for (let i = draft.segments.length - 1; i >= 0; i -= 1) {
      if (draft.segments[i]?.kind === 'text') {
        setCursorSeg(i, draft.segments[i].text.length);
        return;
      }
    }
    // No text segments at all: create one.
    const seg = ensureTextSegment();
    setCursorSeg(draft.segments.indexOf(seg), 0);
  };

  return {
    handleText(text: string): void {
      if (!text) return;
      const { segIdx, charOff } = cursorToSegOffset();
      const seg = draft.segments[segIdx];
      if (!seg || seg.kind !== 'text') {
        current.text += text;
        cursorCharOffset = current.text.length;
        return;
      }
      seg.text = seg.text.slice(0, charOff) + text + seg.text.slice(charOff);
      cursorCharOffset = charOff + text.length;
    },
    handleBackspace(): void {
      const { segIdx, charOff } = cursorToSegOffset();
      if (charOff > 0) {
        const seg = draft.segments[segIdx];
        if (seg && seg.kind === 'text') {
          seg.text = seg.text.slice(0, charOff - 1) + seg.text.slice(charOff);
          cursorCharOffset = charOff - 1;
          // If the segment is now empty and it's not the only text segment, prune it.
          if (seg.text.length === 0) {
            const textSegs = draft.segments.filter((s) => s.kind === 'text');
            if (textSegs.length > 1) {
              const idx = draft.segments.indexOf(seg);
              draft.segments.splice(idx, 1);
              // Move to the end of the previous segment.
              for (let i = idx - 1; i >= 0; i -= 1) {
                if (draft.segments[i]?.kind === 'text') {
                  current = draft.segments[i] as InlineTextSegment;
                  cursorCharOffset = current.text.length;
                  return;
                }
              }
              current = ensureTextSegment();
              cursorCharOffset = 0;
            }
          }
          return;
        }
      }

      // At start of segment: try to remove previous segment.
      if (segIdx > 0) {
        const previous = draft.segments[segIdx - 1];
        if (previous.kind === 'paste') {
          draft.segments.splice(segIdx - 1, 1);
          // Cursor stays at the same position in current segment.
          return;
        }
        if (previous.kind === 'text' && previous.text.length > 0) {
          previous.text = previous.text.slice(0, -1);
          current = previous;
          cursorCharOffset = previous.text.length;
          return;
        }
      }

      // Try any previous text segment.
      for (let index = segIdx - 1; index >= 0; index -= 1) {
        const segment = draft.segments[index];
        if (segment.kind !== 'text' || segment.text.length === 0) continue;
        segment.text = segment.text.slice(0, -1);
        current = segment;
        cursorCharOffset = current.text.length;
        return;
      }
    },
    handleCursorLeft(): void {
      const { segIdx, charOff } = cursorToSegOffset();
      if (charOff > 0) {
        setCursorSeg(segIdx, charOff - 1);
        return;
      }
      // At start of segment: move to end of previous text segment.
      for (let i = segIdx - 1; i >= 0; i -= 1) {
        if (draft.segments[i]?.kind === 'text') {
          setCursorSeg(i, draft.segments[i].text.length);
          return;
        }
      }
    },
    handleCursorRight(): void {
      const { segIdx, charOff } = cursorToSegOffset();
      const seg = draft.segments[segIdx];
      if (seg && seg.kind === 'text' && charOff < seg.text.length) {
        setCursorSeg(segIdx, charOff + 1);
        return;
      }
      // At end of segment: move to start of next text segment.
      for (let i = segIdx + 1; i < draft.segments.length; i += 1) {
        if (draft.segments[i]?.kind === 'text') {
          setCursorSeg(i, 0);
          return;
        }
      }
    },
    handleCursorUp(): void {
      const body = renderInlinePastePreview(draft);
      const cursorOffset = computeVisibleOffset();
      const lines = body.split('\n');
      // Find which line the cursor is on.
      let lineStart = 0;
      let currentLineIdx = 0;
      for (let i = 0; i < lines.length; i += 1) {
        const lineLen = lines[i].length + 1; // +1 for the \n separator
        if (cursorOffset < lineStart + lineLen || i === lines.length - 1) {
          currentLineIdx = i;
          break;
        }
        lineStart += lineLen;
      }
      if (currentLineIdx === 0) return;
      const prevLineLen = lines[currentLineIdx - 1].length;
      const colInLine = cursorOffset - lineStart;
      const newCol = Math.min(colInLine, prevLineLen);
      let newOffset = 0;
      for (let i = 0; i < currentLineIdx - 1; i += 1) {
        newOffset += lines[i].length + 1;
      }
      newOffset += newCol;
      setCursorFromVisibleOffset(newOffset);
    },
    handleCursorDown(): void {
      const body = renderInlinePastePreview(draft);
      const cursorOffset = computeVisibleOffset();
      const lines = body.split('\n');
      let lineStart = 0;
      let currentLineIdx = 0;
      for (let i = 0; i < lines.length; i += 1) {
        const lineLen = lines[i].length + 1;
        if (cursorOffset < lineStart + lineLen || i === lines.length - 1) {
          currentLineIdx = i;
          break;
        }
        lineStart += lineLen;
      }
      if (currentLineIdx >= lines.length - 1) return;
      const nextLineLen = lines[currentLineIdx + 1].length;
      const colInLine = cursorOffset - lineStart;
      const newCol = Math.min(colInLine, nextLineLen);
      let newOffset = 0;
      for (let i = 0; i <= currentLineIdx; i += 1) {
        newOffset += lines[i].length + 1;
      }
      newOffset += newCol;
      setCursorFromVisibleOffset(newOffset);
    },
    handleHome(): void {
      setCursorFromVisibleOffset(0);
    },
    handleEnd(): void {
      const body = renderInlinePastePreview(draft);
      setCursorFromVisibleOffset(body.length);
    },
    handlePasteStart(): void {
      if (pasteActive) return;
      pasteActive = true;
      pasteText = '';
      // Move cursor to end before starting paste.
      current = ensureTextSegment();
      cursorCharOffset = current.text.length;
      current = { kind: 'text', text: '' };
      draft.segments.push(current);
      cursorCharOffset = 0;
    },
    handlePasteChunk(text: string): void {
      if (!pasteActive) {
        // Fallback: regular text insertion at cursor
        this.handleText(text);
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
      // Cursor stays at the end of the last text segment.
      current = ensureTextSegment();
      cursorCharOffset = current.text.length;
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
    getCursorOffset(): number {
      return computeVisibleOffset();
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
    .option('--mouse', 'Enable SGR mouse tracking for app-managed wheel scrolling')
    .option('--no-alt-screen', 'Disable alternate screen buffer for better native scrollback/copy')
    .action(async (options: { message?: string; plain?: boolean; mouse?: boolean; altScreen?: boolean }) => {
      const repoRoot = process.cwd();
      const loaded = loadProjectConfig(repoRoot);
      if (loaded.errors.length > 0) {
        console.error(`[synax] Config error:\n${loaded.errors.map((e) => `${e.path}: ${e.message}`).join('\n')}`);
        process.exitCode = 1;
        return;
      }

      const providerDescription = describeLLMProvider(toProviderFactoryInput(loaded.config));
      const metadata = providerDescription.metadata;
      const provider = providerDescription.normalizedConfig;
      const blockedMessage = providerRuntimeBlockedMessage(metadata, provider);

      // Extract thinking level and TUI config from the effective multi-provider config.
      let thinkingLevel: import('../config/schema').ThinkingLevel = 'off';
      let skillMessages: string[] | undefined;
      let skillDiagnostics: SkillDiagnostic[] | undefined;
      let enableMouse = false;
      let alternateScreen = true;
      try {
        const effectiveConfig = loadSynaxConfig();
        if (effectiveConfig.active.thinking && effectiveConfig.active.thinking !== 'off') {
          thinkingLevel = effectiveConfig.active.thinking;
        }
        enableMouse = effectiveConfig.tui?.mouse ?? false;
        alternateScreen = effectiveConfig.tui?.alternateScreen ?? true;
        if (effectiveConfig.skills.enabled.length > 0) {
          const result = loadSkills(effectiveConfig.skills, repoRoot);
          skillMessages = result.systemMessages;
          skillDiagnostics = result.diagnostics;
        }
      } catch {
        // best-effort
      }
      // CLI flags override config.
      if (options.mouse) enableMouse = true;
      if (options.altScreen === false) alternateScreen = false;
      const useTui = shouldUseInteractiveTui({
        plain: Boolean(options.plain),
        message: options.message,
        stdinIsTTY: input.isTTY,
        stdoutIsTTY: output.isTTY,
      });

      // Shared state so the TUI can observe model output in real time.
      let lastModelOutput = '';

      const modelLabel = metadata.modelId || undefined;
      const cwdLabel = compactHome(repoRoot);
      const gitBranch = await currentGitBranch(repoRoot);

      const session = createChatSession({
        repoRoot,
        config: loaded.config,
        thinkingLevel,
        skillMessages,
        skillDiagnostics,
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
        if (blockedMessage) {
          console.error(`[synax] Config error: ${blockedMessage}`);
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
          enableMouse,
          alternateScreen,
          blockedMessage,
          lastModelOutput: () => lastModelOutput,
          resetLastModelOutput: () => {
            lastModelOutput = '';
          },
          modelLabel,
          thinkingEnabled: thinkingLevel !== 'off',
          endpointLabel: metadata.baseUrl !== '(not set)' ? metadata.baseUrl : undefined,
          providerName: metadata.displayName,
          cwdLabel,
          gitBranch,
          contextWindowTokens: loaded.config.contextWindowTokens ?? loaded.config.contextBudgetTokens,
          coreVisualProfile: loaded.config.coreVisualProfile,
          coreLoaded: true,
          activeSkills: skillDiagnostics?.filter((d) => d.loaded).map((d) => d.id),
          inputPricePer1MTokens: metadata.inputPricePer1MTokens,
          outputPricePer1MTokens: metadata.outputPricePer1MTokens,
          onSettingsConfigChanged: (settingsConfig) => {
            loaded.config = applyEffectiveSynaxConfigToProjectConfig(loaded.config, settingsConfig);
            const nextThinkingLevel = settingsConfig.active.thinking ?? thinkingLevel;
            // Keep the session's config reference and thinking level in sync.
            session.refreshConfig?.(loaded.config, nextThinkingLevel);
            const nextDescription = describeLLMProvider(toProviderFactoryInput(loaded.config));
            const nextBlockedMessage = providerRuntimeBlockedMessage(
              nextDescription.metadata,
              nextDescription.normalizedConfig,
            );
            const activeProvider = settingsConfig.providers[settingsConfig.active.provider];
            const activeModel = activeProvider?.models.find((model) => model.id === settingsConfig.active.model);
            return {
              modelLabel: nextDescription.normalizedConfig.model.trim() || undefined,
              endpointLabel: nextDescription.normalizedConfig.baseUrl || undefined,
              providerName:
                activeProvider?.name ??
                nextDescription.metadata.displayName ??
                providerNameFromPreset(loaded.config.provider?.preset),
              contextWindowTokens:
                activeModel?.contextWindow ?? loaded.config.contextWindowTokens ?? loaded.config.contextBudgetTokens,
              coreVisualProfile: loaded.config.coreVisualProfile,
              thinkingEnabled: nextThinkingLevel !== 'off',
              coreLoaded: true,
              providerWarning: nextBlockedMessage,
              inputPricePer1MTokens: nextDescription.metadata.inputPricePer1MTokens,
              outputPricePer1MTokens: nextDescription.metadata.outputPricePer1MTokens,
            };
          },
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
              if (report.newSession) {
                session.resetConversation?.();
              }
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
  const raw = draft.segments
    .map((segment) =>
      segment.kind === 'text' ? segment.text : `[pasted: ${segment.lines} lines, ${segment.chars} chars]`,
    )
    .join('');
  // Trim only leading whitespace; preserve trailing spaces for cursor positioning.
  return raw.replace(/^\s+/, '');
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

export async function currentGitBranch(repoRoot: string): Promise<string | undefined> {
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

export function compactHome(path: string): string {
  const home = process.env.HOME;
  if (!home) return path;
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function providerNameFromPreset(preset: string | undefined): string | undefined {
  if (!preset) return undefined;
  if (preset === 'relay-local' || preset === 'relay') return 'Relay';
  if (preset === 'openai') return 'OpenAI';
  if (preset === 'anthropic') return 'Anthropic';
  if (preset === 'openrouter') return 'OpenRouter';
  return undefined;
}

export function providerRuntimeBlockedMessage(
  metadata: ProviderMetadata,
  provider: NormalizedProviderConfig,
): string | undefined {
  if (!provider.model.trim()) return 'provider.model is required';
  if (!provider.baseUrl.trim()) return 'provider.base_url is required';
  if (metadata.apiKeyRequired && !metadata.apiKeyConfigured) {
    return `${metadata.displayName} API key is required`;
  }
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

    // Secret trigger: Synax Backrooms easter egg
    const submittedText = flattenInlinePasteDraft(currentDraft).trim();
    if (isSecretTrigger(submittedText)) {
      stdout.write('\n');
      draft = createInlinePasteInputSession();
      try {
        const { runSynaxBackrooms } = await import('../backrooms/runBackrooms');
        await runSynaxBackrooms();
      } finally {
        stdout.write('liminal layer closed\n');
      }
      render();
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
  context: {
    repoRoot: string;
    config: ProjectConfig;
    conversation: AgentConversation;
    skillMessages?: string[];
  },
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
    // Use a temporary session wrapper for standalone conversation reset
    const tempSession = new Session({
      repoRoot: context.repoRoot,
      client: {
        chat: async () => {
          throw new Error('noop');
        },
      },
      conversation: context.conversation,
      skillMessages: context.skillMessages,
    });
    tempSession.resetConversation({ skillMessages: context.skillMessages });
    return { handled: true, output: '[synax] conversation cleared' };
  }
  if (command === '/new') {
    const tempSession2 = new Session({
      repoRoot: context.repoRoot,
      client: {
        chat: async () => {
          throw new Error('noop');
        },
      },
      conversation: context.conversation,
      skillMessages: context.skillMessages,
    });
    tempSession2.resetConversation({ skillMessages: context.skillMessages });
    return { handled: true, output: '[synax] new session started', newSession: true };
  }
  if (command === '/settings') {
    return { handled: true, output: renderSettingsPanel(context.repoRoot, context.config) };
  }
  if (command.startsWith('/settings set ')) {
    return { handled: true, output: applySettingsSet(trimmedCommand, context.config) };
  }
  if (command === '/tools') {
    const exposed = Session.buildModelTools({ bashEnabled: context.config.tools?.bash?.enabled }).map(
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
        'Model steps:      unlimited',
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
        'Model steps: unlimited',
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
    return '[synax] agent.max_model_steps is deprecated and no longer limits the agent loop';
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
  const provider = normalizeProviderConfig(config.provider ?? {});
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
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': `synax-chat/${pkg.version}` };
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
    '/budget                    Show context and tool-call limits',
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
    '/settings set agent.max_tool_calls 64',
  ].join('\n');
}

function renderSettingsPanel(repoRoot: string, config: ProjectConfig): string {
  const provider = normalizeProviderConfig(config.provider ?? {});
  const headers = Object.keys(config.provider?.custom_headers ?? config.provider?.customHeaders ?? {});
  const configPath = discoverConfigPath(repoRoot) ?? '(defaults)';
  const exposed = Session.buildModelTools({ bashEnabled: config.tools?.bash?.enabled }).map((tool) => tool.name);
  return [
    'Settings',
    '--------',
    `Profile:        ${config.activeProfile ?? 'default'}`,
    `Config file:    ${configPath}`,
    '',
    'Provider',
    `  preset:       ${config.provider?.preset ?? 'relay'}`,
    `  base_url:     ${provider.baseUrl}`,
    `  model:        ${provider.model || '(not set)'}`,
    `  api_key_env:  ${config.provider?.api_key_env ?? config.provider?.apiKeyEnv ?? 'not set'}`,
    `  headers:      ${headers.length} configured`,
    '',
    'Agent',
    `  context:      ${config.contextBudgetTokens ?? 131072}`,
    '  max_steps:    unlimited',
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
