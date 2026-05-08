import type { AgentEvent, TerminalState } from './events';

export type TuiSeverity = 'S0' | 'S1' | 'S2' | 'S3';
export type TuiPhase =
  | 'idle'
  | 'thinking'
  | 'tool_execution'
  | 'verifying'
  | 'completed'
  | 'blocked'
  | 'budget_exhausted'
  | 'error';
export type ChangeOp = 'create' | 'edit' | 'delete' | 'read' | 'test' | 'other';

export interface TuiTimelineItem {
  atMs: number;
  phase: TuiPhase;
  summary: string;
  severity: TuiSeverity;
}

export interface TuiChangeItem {
  path: string;
  op: ChangeOp;
}

export type TuiDebugKind =
  | 'user'
  | 'model'
  | 'command'
  | 'local_command'
  | 'tool_call'
  | 'tool_result'
  | 'final_summary';

export interface TuiDebugHistoryItem {
  atMs: number;
  kind: TuiDebugKind;
  summary: string;
  detail: string;
}

export interface TuiVerificationState {
  state: 'planned' | 'running' | 'passed' | 'failed' | 'skipped';
  checksPlanned: number;
  checksRunning: number;
  checksPassed: number;
  checksFailed: number;
  checksSkipped: number;
  summary: string;
  currentCheckLabel: string;
  seenCheckIds: Set<string>;
}

export interface RunStateSnapshot {
  runId: string;
  startedAtMs: number;
  nowMs: number;
  mode: string;
  providerLabel: string;
  modelId: string;
  providerName: string;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  thinkingEnabled?: boolean;
  sessionSpendLabel?: string;
  /** Cumulative session cost in USD. */
  sessionCostUsd?: number;
  /** Price per 1M input tokens in USD. */
  inputPricePer1MTokens?: number;
  /** Price per 1M output tokens in USD. */
  outputPricePer1MTokens?: number;
  /** Cumulative input tokens for session cost tracking. */
  sessionInputTokens?: number;
  /** Cumulative output tokens for session cost tracking. */
  sessionOutputTokens?: number;
  coreLoaded: boolean;
  phase: TuiPhase;
  objective: {
    label: string;
    currentPhase: TuiPhase;
    nextCheckpoint: string;
  };
  phaseTransitions: Array<{ atMs: number; from: TuiPhase; to: TuiPhase; note: string }>;
  timeline: TuiTimelineItem[];
  changes: { items: TuiChangeItem[]; overflowCount: number };
  filesChangedThisRun: string[];
  workingTreeClean?: boolean;
  toolInvocationCount: number;
  verification: TuiVerificationState;
  statusNote: string;
  riskLine: string;
  terminalIssue?: string;
  severity: TuiSeverity;
  terminal: 'running' | 'completed' | 'failed' | 'blocked';
  /** Last model response text for observability in the TUI overlay. */
  lastModelOutput: string;
  /** Last validated edit preview, shown before/after file writes for inspectability. */
  patchPreview?: {
    path: string;
    diff: string;
  };
  /** Scrollable transcript/debug history for model output, tool calls, and tool results. */
  debugHistory: TuiDebugHistoryItem[];
  /** Names of active skills loaded into the agent context (e.g. ['coderabbit-review']). */
  activeSkills: string[];
}

const MAX_TIMELINE_ITEMS = 10;
const MAX_CHANGE_ITEMS = 8;

export function createInitialRunStateSnapshot(nowMs: number): RunStateSnapshot {
  return {
    runId: 'pending',
    startedAtMs: nowMs,
    nowMs,
    mode: 'patch',
    providerLabel: 'n/a',
    modelId: '',
    providerName: 'unknown',
    contextUsedTokens: undefined,
    contextWindowTokens: undefined,
    thinkingEnabled: undefined,
    sessionSpendLabel: undefined,
    sessionCostUsd: undefined,
    inputPricePer1MTokens: undefined,
    outputPricePer1MTokens: undefined,
    sessionInputTokens: undefined,
    sessionOutputTokens: undefined,
    coreLoaded: false,
    phase: 'idle',
    objective: {
      label: 'Waiting for run start',
      currentPhase: 'idle',
      nextCheckpoint: 'awaiting task',
    },
    phaseTransitions: [],
    timeline: [],
    changes: { items: [], overflowCount: 0 },
    filesChangedThisRun: [],
    workingTreeClean: undefined,
    toolInvocationCount: 0,
    verification: createEmptyVerificationState(),
    statusNote: '',
    riskLine: 'risk: nominal',
    severity: 'S0',
    terminal: 'running',
    lastModelOutput: '',
    debugHistory: [],
    activeSkills: [],
  };
}

export function createBlockedRunStateSnapshot(nowMs: number, label: string, nextCheckpoint: string): RunStateSnapshot {
  return {
    ...createInitialRunStateSnapshot(nowMs),
    phase: 'blocked',
    objective: {
      label,
      currentPhase: 'blocked',
      nextCheckpoint,
    },
    riskLine: 'risk: configuration required',
    terminal: 'blocked',
  };
}

export function applyEventToRunState(state: RunStateSnapshot, event: AgentEvent, nowMs: number): RunStateSnapshot {
  let next = { ...state, nowMs };
  switch (event.type) {
    case 'task_started': {
      const runId = event.timestamp.replace(/[-:.TZ]/g, '').slice(0, 14);
      next = {
        ...next,
        runId,
        startedAtMs: Date.parse(event.timestamp) || nowMs,
        mode: event.mode,
        providerLabel: `${event.model} @ ${event.endpoint}`,
        modelId: event.model,
        providerName: event.providerName ?? providerNameFromEndpoint(event.endpoint),
        contextWindowTokens: event.contextWindowTokens ?? event.contextBudgetTokens,
        coreLoaded: event.model.trim().length > 0,
        sessionSpendLabel: isLocalEndpoint(event.endpoint) ? 'local' : formatCost(0),
        sessionCostUsd: 0,
        inputPricePer1MTokens: event.inputPricePer1MTokens,
        outputPricePer1MTokens: event.outputPricePer1MTokens,
        sessionInputTokens: 0,
        sessionOutputTokens: 0,
        objective: {
          label: event.task.trim() || 'No objective',
          currentPhase: 'thinking',
          nextCheckpoint: 'awaiting model output',
        },
        changes: { items: [], overflowCount: 0 },
        filesChangedThisRun: [],
        workingTreeClean: undefined,
        toolInvocationCount: 0,
        verification: createEmptyVerificationState(),
        statusNote: '',
        riskLine: 'risk: nominal',
        terminalIssue: undefined,
        severity: 'S0',
        terminal: 'running',
        lastModelOutput: '',
        patchPreview: undefined,
        activeSkills: event.activeSkills ?? [],
      };
      next = withPhase(next, 'thinking', 'task started');
      next = withDebugHistory(next, {
        atMs: nowMs,
        kind: 'user',
        summary: 'user prompt',
        detail: event.task,
      });
      return withTimeline(next, 'thinking', 'objective registered', 'S0');
    }
    case 'model_step_started': {
      next = withPhase(next, 'thinking', 'model step');
      return withTimeline(next, 'thinking', `Thinking · step ${event.stepIndex ?? next.timeline.length + 1}`, 'S0');
    }
    case 'context_budget_updated': {
      const prevInputTokens = next.sessionInputTokens ?? 0;
      const newInputTokens = prevInputTokens + (event.estimatedInputTokens - (next.contextUsedTokens ?? 0));
      next = {
        ...next,
        contextUsedTokens: event.estimatedInputTokens,
        contextWindowTokens: event.contextWindowTokens,
        sessionInputTokens: Math.max(0, newInputTokens),
      };
      // Update cost estimate from accumulated tokens
      next = updateSessionCost(next);
      return next;
    }
    case 'assistant_message': {
      const note = summarizeModelOutput(event.content);
      next = withDebugHistory(next, {
        atMs: nowMs,
        kind: 'model',
        summary: note || 'model response',
        detail: event.content,
      });
      if (!note) return next;
      next = {
        ...next,
        lastModelOutput: note,
      };
      return withTimeline(next, next.phase, `Thinking · ${note}`, 'S0');
    }
    case 'command_output': {
      next = withDebugHistory(next, {
        atMs: nowMs,
        kind: 'command',
        summary: event.command,
        detail: event.content,
      });
      return withTimeline(next, next.phase, `Command · ${event.command}`, 'S0');
    }
    case 'local_shell_command': {
      next = withDebugHistory(next, {
        atMs: nowMs,
        kind: 'local_command',
        summary: event.command,
        detail: [
          event.command,
          `exit code: ${event.exitCode}`,
          `duration: ${formatDuration(event.durationMs)}`,
          event.stdout ? `stdout:\n${event.stdout}` : '',
          event.stderr ? `stderr:\n${event.stderr}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      });
      return withTimeline(next, next.phase, `Command · !${event.command}`, event.exitCode === 0 ? 'S0' : 'S2');
    }
    case 'tool_started': {
      next = withPhase(next, 'tool_execution', `tool ${event.toolName}`);
      next = withStatus(next, `tool: ${event.toolName}`, 'S0');
      next = {
        ...next,
        toolInvocationCount: next.toolInvocationCount + 1,
      };
      next = withDebugHistory(next, {
        atMs: nowMs,
        kind: 'tool_call',
        summary: `${event.toolName} call`,
        detail: `${event.toolName}\n${event.detail ?? event.summary}`,
      });
      return withTimeline(next, 'tool_execution', `Tool · ${event.toolName}`, 'S0');
    }
    case 'tool_finished': {
      const severity = event.status === 'error' ? 'S1' : 'S0';
      next = withPhase(next, event.status === 'error' ? 'error' : 'thinking', `tool ${event.toolName} finished`);
      next = withDebugHistory(next, {
        atMs: nowMs,
        kind: 'tool_result',
        summary: `${event.toolName} ${event.status === 'ok' ? 'ok' : 'error'}`,
        detail: event.detail ?? event.summary,
      });
      if (event.status === 'ok') {
        // Only track file changes for successful mutating tools.
        // Patch previews handle edit preview tracking separately;
        // this catches writes and other successful mutations.
        const op = classifyTool(event.toolName);
        if (op !== 'read') {
          // tool_finished summary is 'completed' on success; the path is in the
          // tool result detail (e.g. {"success":true,"toolName":"write","output":{"path":"..."}}).
          const path = extractPath(event.summary) ?? extractPath(event.detail ?? '');
          if (path) {
            next = {
              ...next,
              changes: compressChanges([...next.changes.items, { path, op }]),
            };
          }
        }
      } else {
        // Surface the actual tool error rather than claiming recovery.
        next = withStatus(next, `${event.toolName} error: ${event.summary}`, severity);
      }
      if (event.status === 'ok') {
        next = withStatus(next, `${event.toolName} ok`, 'S0');
      }
      return withTimeline(
        next,
        next.phase,
        `Tool · ${event.toolName} ${event.status === 'ok' ? 'ok' : 'error'}`,
        severity,
      );
    }
    case 'patch_preview': {
      const compressed = compressChanges([
        ...next.changes.items,
        { path: event.path, op: classifyTool(event.toolName) },
      ]);
      next = {
        ...next,
        changes: compressed,
        patchPreview: {
          path: event.path,
          diff: clipPatchPreview(event.diff),
        },
      };
      next = withStatus(next, `previewing edit: ${event.path}`, 'S0');
      return withTimeline(next, 'tool_execution', `patch preview: ${event.path}`, 'S0');
    }
    case 'verification_planned': {
      next = applyVerificationPlanned(next, event.checkId, event.checkLabel, event.summary);
      next = withPhase(next, 'verifying', 'verification planned');
      return withTimeline(next, 'verifying', `planned: ${event.checkLabel}`, 'S0');
    }
    case 'verification_started': {
      next = applyVerificationStarted(next, event.checkId, event.checkLabel);
      next = withPhase(next, 'verifying', `verification running: ${event.checkLabel}`);
      return withTimeline(next, 'verifying', `verifying: ${event.checkLabel}`, 'S0');
    }
    case 'verification_passed': {
      next = applyVerificationPassed(next, event.checkId, event.summary, event.durationMs);
      next = withPhase(
        next,
        next.terminal === 'running' ? 'thinking' : 'completed',
        `verification passed: ${event.checkLabel}`,
      );
      next = withStatus(next, `passed: ${event.checkLabel}`, 'S0');
      return withTimeline(next, next.phase, `passed: ${event.checkLabel}`, 'S0');
    }
    case 'verification_failed': {
      next = applyVerificationFailed(next, event.checkId, event.summary, event.severity ?? 'S2', event.durationMs);
      next = withPhase(next, 'verifying', `verification failed: ${event.checkLabel}`);
      next = withRisk(next, `verification failed: ${event.summary ?? event.checkLabel}`, event.severity ?? 'S2');
      if (event.severity !== 'S3') {
        next = withStatus(next, `failed: ${event.checkLabel}`, 'S2');
      }
      return withTimeline(next, 'verifying', `failed: ${event.checkLabel}`, event.severity ?? 'S2');
    }
    case 'verification_skipped': {
      next = applyVerificationSkipped(next, event.checkId, event.summary);
      next = withStatus(next, `skipped: ${event.checkLabel}`, 'S0');
      return withTimeline(next, next.phase, `skipped: ${event.checkLabel}`, 'S0');
    }
    case 'task_finished': {
      // Derive aggregate state from lifecycle events, not summary text.
      // Fallback to summary-derived only when no lifecycle events were emitted.
      if (next.verification.seenCheckIds.size === 0) {
        next = {
          ...next,
          verification:
            event.status === 'completed' || event.status === 'failed_verification'
              ? deriveVerificationFallback(event.verification)
              : deriveSkippedVerification(event.verification),
        };
      }
      if (next.verification.state === 'failed') {
        next = withRisk(next, `verification failed: ${next.verification.summary}`, 'S2');
      }
      const phase = terminalStateToPhase(event.status, next.verification.state);
      next = withPhase(next, phase, `run ${event.status}`);
      next = {
        ...next,
        terminal:
          event.status === 'completed'
            ? 'completed'
            : event.status === 'blocked' || event.status === 'user_input_required'
              ? 'blocked'
              : 'failed',
        objective: {
          ...next.objective,
          currentPhase: phase,
          nextCheckpoint:
            phase === 'completed'
              ? 'run finalized'
              : phase === 'blocked'
                ? 'operator decision required'
                : 'inspect terminal issue',
        },
      };
      if (event.error) {
        next = withRisk(next, `blocker: ${event.error}`, 'S3');
      }
      if (event.status === 'completed') {
        const filesChangedThisRun = unique(event.changedFiles);
        const summary = completionSummary(event.modelSteps, event.toolCalls, event.changedFiles.length);
        next = {
          ...withStatus(next, summary, 'S0'),
          lastModelOutput: next.lastModelOutput || summary,
          filesChangedThisRun,
          workingTreeClean: event.workingTreeClean,
          toolInvocationCount: event.toolCalls,
        };
      }
      next = withDebugHistory(next, {
        atMs: nowMs,
        kind: 'final_summary',
        summary: 'final summary',
        detail: formatFinalSummaryDebugItem(next),
      });
      return withTimeline(next, phase, `run ${event.status}`, next.severity);
    }
    case 'error': {
      next = withPhase(next, 'error', 'runtime error');
      next = withRisk(next, event.message, 'S3');
      return withTimeline(next, 'error', 'runtime error', 'S3');
    }
    default:
      return next;
  }
}

export function advanceClock(state: RunStateSnapshot, nowMs: number): RunStateSnapshot {
  return { ...state, nowMs };
}

export function compressTimeline(items: TuiTimelineItem[], limit: number = MAX_TIMELINE_ITEMS): TuiTimelineItem[] {
  if (items.length <= limit) return items;
  return items.slice(items.length - limit);
}

export function compressChanges(
  items: TuiChangeItem[],
  limit: number = MAX_CHANGE_ITEMS,
): { items: TuiChangeItem[]; overflowCount: number } {
  const deduped: TuiChangeItem[] = [];
  const seen = new Set<string>();
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    const key = `${item.op}:${item.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  deduped.reverse();
  const overflowCount = Math.max(0, deduped.length - limit);
  return {
    items: deduped.slice(Math.max(0, deduped.length - limit)),
    overflowCount,
  };
}

function withTimeline(
  state: RunStateSnapshot,
  phase: TuiPhase,
  summary: string,
  severity: TuiSeverity,
): RunStateSnapshot {
  const timeline = compressTimeline([
    ...state.timeline,
    { atMs: state.nowMs, phase, summary: clipText(summary, 90), severity },
  ]);
  return { ...state, timeline, severity: maxSeverity(state.severity, severity) };
}

function withPhase(state: RunStateSnapshot, phase: TuiPhase, note: string): RunStateSnapshot {
  if (state.phase === phase) {
    return {
      ...state,
      objective: {
        ...state.objective,
        currentPhase: phase,
        nextCheckpoint: checkpointForPhase(phase),
      },
    };
  }
  return {
    ...state,
    phase,
    objective: {
      ...state.objective,
      currentPhase: phase,
      nextCheckpoint: checkpointForPhase(phase),
    },
    phaseTransitions: [
      ...state.phaseTransitions,
      {
        atMs: state.nowMs,
        from: state.phase,
        to: phase,
        note,
      },
    ],
  };
}

function withStatus(state: RunStateSnapshot, statusNote: string, severity: TuiSeverity): RunStateSnapshot {
  return { ...state, statusNote: clipText(statusNote, 120), severity: maxSeverity(state.severity, severity) };
}

/** Maximum debug history entries retained for transcript rendering.
 *  Keep bounded so render cost stays O(1) regardless of session length. */
const MAX_DEBUG_HISTORY = 200;

function withDebugHistory(state: RunStateSnapshot, item: TuiDebugHistoryItem): RunStateSnapshot {
  const debugHistory = [...state.debugHistory, { ...item, detail: clipText(item.detail, 6000) }];
  return { ...state, debugHistory: debugHistory.slice(Math.max(0, debugHistory.length - MAX_DEBUG_HISTORY)) };
}

function createEmptyVerificationState(): TuiVerificationState {
  return {
    state: 'planned',
    checksPlanned: 0,
    checksRunning: 0,
    checksPassed: 0,
    checksFailed: 0,
    checksSkipped: 0,
    summary: 'planned',
    currentCheckLabel: '',
    seenCheckIds: new Set(),
  };
}

function formatFinalSummaryDebugItem(state: RunStateSnapshot): string {
  const fileCount =
    state.filesChangedThisRun.length > 0
      ? state.filesChangedThisRun.length
      : state.changes.items.filter((item) => item.op !== 'read').length + state.changes.overflowCount;
  const blockers = state.terminalIssue || (state.verification.state === 'failed' ? state.verification.summary : 'none');
  const completed = state.terminal === 'completed' || state.phase === 'completed';
  const result = completed ? 'completed' : state.terminal;
  const followUp =
    completed && state.verification.state !== 'failed' ? 'none' : 'resolve blocker and rerun verification';
  return [
    state.statusNote ? `Completed · ${state.statusNote.replace(/^completed:\s*/i, '')}` : '',
    'Final summary',
    `  objective: ${state.objective.label}`,
    `  result: ${result}`,
    `  Changed this run: ${plural(fileCount, 'file')}`,
    `  Working tree: ${state.workingTreeClean === undefined ? 'unknown' : state.workingTreeClean ? 'clean' : 'dirty'}`,
    `  tool invocations: ${state.toolInvocationCount}`,
    `  tools used: ${toolsUsedForDebugSummary(state).join(', ') || 'none'}`,
    `  commands run: ${commandsRunForDebugSummary(state).join(', ') || 'none'}`,
    `  verification: ${state.verification.state}`,
    `  blockers: ${blockers}`,
    `  follow-up: ${followUp}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function toolsUsedForDebugSummary(state: RunStateSnapshot): string[] {
  const tools = new Set<string>();
  for (const item of state.debugHistory) {
    if (item.kind !== 'tool_call') continue;
    const [rawName = 'tool'] = item.detail.split('\n');
    tools.add(rawName.trim());
  }
  return Array.from(tools);
}

function commandsRunForDebugSummary(state: RunStateSnapshot): string[] {
  const commands: string[] = [];
  for (const item of state.debugHistory) {
    if (item.kind !== 'tool_call') continue;
    const command = extractJsonStringValue(item.detail, 'command') ?? extractJsonStringValue(item.detail, 'cmd');
    if (command) commands.push(command);
  }
  return commands;
}

function extractJsonStringValue(text: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`"${escapedKey}"\\s*:\\s*"([^"]+)"`).exec(text);
  return match?.[1];
}

function withRisk(state: RunStateSnapshot, riskLine: string, severity: TuiSeverity): RunStateSnapshot {
  return {
    ...state,
    riskLine: clipText(riskLine, 120),
    terminalIssue: riskLine,
    severity: maxSeverity(state.severity, severity),
  };
}

function applyVerificationPlanned(
  state: RunStateSnapshot,
  checkId: string,
  checkLabel: string,
  summary?: string,
): RunStateSnapshot {
  const v = { ...state.verification };
  if (v.seenCheckIds.has(checkId)) return state;
  v.seenCheckIds = new Set(v.seenCheckIds);
  v.seenCheckIds.add(checkId);
  v.checksPlanned += 1;
  v.currentCheckLabel = checkLabel;
  v.state = 'planned';
  v.summary = summary ?? checkLabel;
  return { ...state, verification: v };
}

function applyVerificationStarted(state: RunStateSnapshot, _checkId: string, checkLabel: string): RunStateSnapshot {
  const v = { ...state.verification };
  v.currentCheckLabel = checkLabel;
  if (v.checksPlanned > 0) {
    v.checksPlanned -= 1;
    v.checksRunning += 1;
  }
  v.state = 'running';
  return { ...state, verification: v };
}

function applyVerificationPassed(
  state: RunStateSnapshot,
  _checkId: string,
  summary?: string,
  durationMs?: number,
): RunStateSnapshot {
  const v = { ...state.verification };
  if (v.checksRunning > 0) {
    v.checksRunning -= 1;
    v.checksPassed += 1;
  }
  if (summary) v.summary = summary;
  if (durationMs !== undefined) {
    v.summary = `${v.summary} (${formatDuration(durationMs)})`;
  }
  v.state = v.checksFailed > 0 ? 'failed' : v.checksRunning > 0 || v.checksPlanned > 0 ? 'running' : 'passed';
  return { ...state, verification: v };
}

function applyVerificationFailed(
  state: RunStateSnapshot,
  _checkId: string,
  summary?: string,
  _severity?: string,
  durationMs?: number,
): RunStateSnapshot {
  const v = { ...state.verification };
  if (v.checksRunning > 0) {
    v.checksRunning -= 1;
    v.checksFailed += 1;
  }
  if (summary) v.summary = summary;
  if (durationMs !== undefined) {
    v.summary = `${v.summary} (${formatDuration(durationMs)})`;
  }
  v.state = 'failed';
  return { ...state, verification: v };
}

function applyVerificationSkipped(state: RunStateSnapshot, checkId: string, summary?: string): RunStateSnapshot {
  const v = { ...state.verification };
  v.seenCheckIds = new Set(v.seenCheckIds);
  v.seenCheckIds.add(checkId);
  v.checksSkipped += 1;
  v.currentCheckLabel = checkId;
  if (summary) v.summary = summary;
  return { ...state, verification: v };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

/** Update session spend label from accumulated token counts and pricing. */
function updateSessionCost(state: RunStateSnapshot): RunStateSnapshot {
  const inputPrice = state.inputPricePer1MTokens;
  const outputPrice = state.outputPricePer1MTokens;
  if (inputPrice === undefined && outputPrice === undefined) return state;

  const inputTokens = state.sessionInputTokens ?? 0;
  const outputTokens = state.sessionOutputTokens ?? 0;

  const inputCost = inputPrice !== undefined ? (inputTokens / 1_000_000) * inputPrice : 0;
  const outputCost = outputPrice !== undefined ? (outputTokens / 1_000_000) * outputPrice : 0;
  const totalCost = inputCost + outputCost;

  return {
    ...state,
    sessionCostUsd: totalCost,
    sessionSpendLabel: formatCost(totalCost),
  };
}

/** Format cost as a compact dollar string. */
function formatCost(usd: number): string {
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  if (usd >= 0.0001) return `$${usd.toFixed(3)}`;
  if (usd > 0) return '<$0.001';
  return '$0.00';
}

/**
 * Fallback for when no verification lifecycle events were emitted.
 * The TUI should not normally hit this path once the runtime emits events.
 */
function deriveVerificationFallback(verification: string): TuiVerificationState {
  const v = verification.toLowerCase();
  const base = baseVerificationFallback(verification);
  if (v.includes('failed')) {
    return { ...base, state: 'failed', checksFailed: 1 };
  }
  if (v.includes('not run')) {
    return { ...base, state: 'skipped', checksSkipped: 1 };
  }
  if (v === 'passed' || /\b(?:verification|test|tests|build|typecheck|lint)\s+passed\b/.test(v)) {
    return { ...base, state: 'passed', checksPassed: 1 };
  }
  return { ...base, state: 'skipped', checksSkipped: 1 };
}

function deriveSkippedVerification(summary: string): TuiVerificationState {
  return { ...baseVerificationFallback(summary), state: 'skipped', checksSkipped: 1 };
}

function baseVerificationFallback(summary: string): TuiVerificationState {
  return {
    state: 'running',
    checksPlanned: 0,
    checksRunning: 0,
    checksPassed: 0,
    checksFailed: 0,
    checksSkipped: 0,
    summary,
    currentCheckLabel: '',
    seenCheckIds: new Set(),
  };
}

function terminalStateToPhase(status: TerminalState, verificationState: TuiVerificationState['state']): TuiPhase {
  if (status === 'completed') return verificationState === 'passed' ? 'completed' : 'verifying';
  if (status === 'blocked' || status === 'user_input_required') return 'blocked';
  if (status === 'budget_exhausted') return 'budget_exhausted';
  if (status === 'failed_verification') return 'verifying';
  if (status === 'model_error' || status === 'tool_error') return 'error';
  return 'error';
}

function classifyTool(toolName: string): ChangeOp {
  if (toolName === 'write' || toolName === 'replace_in_file' || toolName === 'edit') return 'edit';
  if (toolName === 'read') return 'read';
  if (toolName.includes('test') || toolName === 'run_verification') return 'test';
  return 'other';
}

function extractPath(summary: string): string | null {
  const match = /"path"\s*:\s*"([^"]+)"/.exec(summary);
  if (match) return match[1];
  return null;
}

function checkpointForPhase(phase: TuiPhase): string {
  if (phase === 'thinking') return 'awaiting model output';
  if (phase === 'tool_execution') return 'awaiting tool result';
  if (phase === 'verifying') return 'awaiting verification result';
  if (phase === 'completed') return 'run finalized';
  if (phase === 'budget_exhausted') return 'context budget exhausted — narrow task or raise limit';
  if (phase === 'blocked' || phase === 'error') return 'operator decision required';
  return 'awaiting task';
}

function maxSeverity(current: TuiSeverity, incoming: TuiSeverity): TuiSeverity {
  const rank: Record<TuiSeverity, number> = { S0: 0, S1: 1, S2: 2, S3: 3 };
  return rank[incoming] > rank[current] ? incoming : current;
}

function clipText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function summarizeModelOutput(content: string): string {
  const normalized = content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clipText(normalized, 120);
}

function clipPatchPreview(diff: string): string {
  return diff
    .split('\n')
    .slice(0, 20)
    .map((line) => clipText(line, 160))
    .join('\n');
}

function completionSummary(modelSteps: number, toolCalls: number, changedFiles: number): string {
  return `completed: ${[
    plural(modelSteps, 'model step'),
    plural(toolCalls, 'tool call'),
    plural(changedFiles, 'file changed', 'files changed'),
  ].join(', ')}`;
}

function plural(count: number, singular: string, pluralText = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralText}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isLocalEndpoint(endpoint: string): boolean {
  return /(?:^|\/\/)(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(endpoint);
}

function providerNameFromEndpoint(endpoint: string): string {
  if (isLocalEndpoint(endpoint)) return 'Relay';
  if (/api\.openai\.com/i.test(endpoint)) return 'OpenAI';
  if (/anthropic/i.test(endpoint)) return 'Anthropic';
  if (/openrouter/i.test(endpoint)) return 'OpenRouter';
  return 'OpenAI-compatible';
}
