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

export type TuiDebugKind = 'model' | 'tool_call' | 'tool_result';

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
  phase: TuiPhase;
  objective: {
    label: string;
    currentPhase: TuiPhase;
    nextCheckpoint: string;
  };
  phaseTransitions: Array<{ atMs: number; from: TuiPhase; to: TuiPhase; note: string }>;
  timeline: TuiTimelineItem[];
  changes: { items: TuiChangeItem[]; overflowCount: number };
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
    phase: 'idle',
    objective: {
      label: 'Waiting for run start',
      currentPhase: 'idle',
      nextCheckpoint: 'awaiting task',
    },
    phaseTransitions: [],
    timeline: [],
    changes: { items: [], overflowCount: 0 },
    verification: {
      state: 'planned',
      checksPlanned: 0,
      checksRunning: 0,
      checksPassed: 0,
      checksFailed: 0,
      checksSkipped: 0,
      summary: 'planned',
      currentCheckLabel: '',
      seenCheckIds: new Set(),
    },
    statusNote: '',
    riskLine: 'risk: nominal',
    severity: 'S0',
    terminal: 'running',
    lastModelOutput: '',
    debugHistory: [],
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
        objective: {
          label: event.task.trim() || 'No objective',
          currentPhase: 'thinking',
          nextCheckpoint: 'awaiting model output',
        },
      };
      next = withPhase(next, 'thinking', 'task started');
      return withTimeline(next, 'thinking', 'objective registered', 'S0');
    }
    case 'model_step_started': {
      next = withPhase(next, 'thinking', 'model step');
      return withTimeline(next, 'thinking', `model step ${event.stepIndex ?? next.timeline.length + 1} started`, 'S0');
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
      return withTimeline(next, next.phase, `model: ${note}`, 'S0');
    }
    case 'tool_started': {
      next = withPhase(next, 'tool_execution', `tool ${event.toolName}`);
      next = withStatus(next, `tool: ${event.toolName}`, 'S0');
      trackChangeFromToolStart(next, event.toolName, event.summary);
      next = withDebugHistory(next, {
        atMs: nowMs,
        kind: 'tool_call',
        summary: `${event.toolName} call`,
        detail: `${event.toolName}\n${event.detail ?? event.summary}`,
      });
      return withTimeline(next, 'tool_execution', `${event.toolName} started`, 'S0');
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
      if (event.status === 'error') {
        next = withStatus(next, `${event.toolName} recovered with turbulence`, severity);
      }
      return withTimeline(next, next.phase, `${event.toolName} ${event.status === 'ok' ? 'ok' : 'error'}`, severity);
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
        next = { ...next, verification: deriveVerificationFallback(event.verification) };
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
        next = withRisk(next, `terminal issue: ${event.error}`, 'S3');
      }
      if (event.status === 'completed') {
        const summary = completionSummary(event.modelSteps, event.toolCalls, event.changedFiles.length);
        next = {
          ...withStatus(next, summary, 'S0'),
          lastModelOutput: next.lastModelOutput || summary,
        };
      }
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

function withDebugHistory(state: RunStateSnapshot, item: TuiDebugHistoryItem): RunStateSnapshot {
  const debugHistory = [...state.debugHistory, { ...item, detail: clipText(item.detail, 6000) }];
  return { ...state, debugHistory: debugHistory.slice(Math.max(0, debugHistory.length - 120)) };
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

/**
 * Fallback for when no verification lifecycle events were emitted.
 * The TUI should not normally hit this path once the runtime emits events.
 */
function deriveVerificationFallback(verification: string): TuiVerificationState {
  const v = verification.toLowerCase();
  const base: TuiVerificationState = {
    state: 'running',
    checksPlanned: 0,
    checksRunning: 0,
    checksPassed: 0,
    checksFailed: 0,
    checksSkipped: 0,
    summary: verification,
    currentCheckLabel: '',
    seenCheckIds: new Set(),
  };
  if (v.includes('passed')) {
    return { ...base, state: 'passed', checksPassed: 1 };
  }
  if (v.includes('failed')) {
    return { ...base, state: 'failed', checksFailed: 1 };
  }
  if (v.includes('not run')) {
    return { ...base, state: 'skipped', checksSkipped: 1 };
  }
  return { ...base, checksRunning: 1, checksPlanned: 1 };
}

function terminalStateToPhase(status: TerminalState, verificationState: TuiVerificationState['state']): TuiPhase {
  if (status === 'completed') return verificationState === 'passed' ? 'completed' : 'verifying';
  if (status === 'blocked' || status === 'user_input_required') return 'blocked';
  if (status === 'budget_exhausted') return 'budget_exhausted';
  if (status === 'failed_verification') return 'verifying';
  if (status === 'model_error' || status === 'tool_error') return 'error';
  return 'error';
}

function trackChangeFromToolStart(state: RunStateSnapshot, toolName: string, summary: string): void {
  const path = extractPath(summary);
  if (!path) return;
  const op = classifyTool(toolName);
  const compressed = compressChanges([...state.changes.items, { path, op }]);
  state.changes = compressed;
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
