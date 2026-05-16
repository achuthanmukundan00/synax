import type { AgentEvent } from '../agent/events';
import type { SynaxEvent } from '../events/types';
import type { PresentationState, PresentationBlock, SubAgentSummary, MemoryDecision, HandoffPacketView } from './types';
import { createInitialPresentationState } from './types';

// ─── Fixture event types (preview-only, not runtime) ──────────────────
// These event shapes do NOT exist in the real event bus. They are used
// exclusively by the preview harness and fixture tests. When the real
// event bus adds memory/handoff events, migrate these cases to real
// AgentEvent | SynaxEvent types.

export interface MemoryDecisionFixtureEvent {
  type: 'memory_decision';
  queryType: string;
  queryKey: string;
  disposition: 'used' | 'ignored' | 'rejected' | 'quarantined';
  reason: string;
  provenance: string;
  stale?: boolean;
  conflict?: boolean;
}

export interface MemoryContextInjectedFixtureEvent {
  type: 'memory_context_injected';
  decisions: Array<{
    queryType: string;
    queryKey: string;
    disposition: 'used' | 'ignored' | 'rejected' | 'quarantined';
    reason: string;
    provenance: string;
    stale?: boolean;
    conflict?: boolean;
  }>;
}

export interface HandoffPlannedFixtureEvent {
  type: 'handoff_planned';
  sourceModel: string;
  targetModel: string;
  reason: string;
  summary: string;
  includedContextKeys: string[];
  excludedContextKeys: string[];
  contextWindowBudgetRemaining?: number;
}

export interface HandoffCompletedFixtureEvent {
  type: 'handoff_completed';
}

export type PresentationFixtureEvent =
  | MemoryDecisionFixtureEvent
  | MemoryContextInjectedFixtureEvent
  | HandoffPlannedFixtureEvent
  | HandoffCompletedFixtureEvent;

/** Union of runtime events + presentation fixture events (preview only). */
export type ReducableEvent = AgentEvent | SynaxEvent | PresentationFixtureEvent;

/**
 * Internal bookkeeping for the reducer — not exposed outside.
 * Allows orchestration block index tracking and streaming buffer management.
 */
interface ReducerContext {
  /** Index in blocks[] of the last orchestration block (for in-place replacement). */
  lastOrchestrationIndex: number;
  /** Whether we've seen a task_started event. */
  taskStarted: boolean;
  /** Last tool that was started (for matching tool_finished to tool_started). */
  lastToolName: string;
}

function createInitialContext(): ReducerContext {
  return { lastOrchestrationIndex: -1, taskStarted: false, lastToolName: '' };
}

function replaceBlock(state: PresentationState, index: number, block: PresentationBlock): PresentationState {
  if (index < 0 || index >= state.blocks.length) return state;
  const blocks = state.blocks.slice();
  blocks[index] = block;
  return { ...state, blocks };
}

function appendBlock(
  state: PresentationState,
  ctx: ReducerContext,
  block: PresentationBlock,
): { state: PresentationState; ctx: ReducerContext; index: number } {
  const index = state.blocks.length;
  const state2 = { ...state, blocks: [...state.blocks, block] };
  if (block.kind === 'orchestration') ctx.lastOrchestrationIndex = index;
  return { state: state2, ctx, index };
}

function extractProse(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<\/think(?:ing)?>/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .trim();
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 3)) + '...';
}

export function reduceEvent(
  state: PresentationState,
  event: ReducableEvent,
  ctx?: ReducerContext,
): { state: PresentationState; ctx: ReducerContext } {
  let s = { ...state };
  let c = ctx ?? createInitialContext();

  switch (event.type) {
    case 'task_started': {
      c = { ...c, taskStarted: true, lastOrchestrationIndex: -1, lastToolName: '' };
      // Reset streaming text on new task
      s = { ...s, streamingText: '' };

      const modelSummary = event.model ? `${event.model} @ ${event.endpoint}` : 'local';
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'runtime_status',
        label: 'model',
        value: modelSummary,
        priority: 'line',
      }));
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'runtime_status',
        label: 'mode',
        value: event.mode,
        priority: 'line',
      }));
      return { state: s, ctx: c };
    }

    case 'model_step_started': {
      // Reset streaming buffer so leftover delta doesn't carry across steps
      return { state: { ...s, streamingText: '' }, ctx: c };
    }

    case 'context_budget_updated': {
      const used = event.estimatedInputTokens ?? 0;
      const total = event.contextWindowTokens ?? 0;
      const pct = total > 0 ? ` (${Math.round((used / total) * 100)}%)` : '';
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'runtime_status',
        label: 'context',
        value: `${used} / ${total}${pct}`,
        priority: 'detail',
      }));
      return { state: s, ctx: c };
    }

    case 'assistant_delta': {
      const content = event.content ?? '';
      const reasoning = event.reasoningContent ?? '';
      let text = s.streamingText;
      if (reasoning) text += reasoning;
      if (content) text += content;
      return { state: { ...s, streamingText: text }, ctx: c };
    }

    case 'assistant_message': {
      s = { ...s, streamingText: '' };
      const prose = extractProse(event.content);
      if (!prose) return { state: s, ctx: c };

      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'model_output',
        role: 'primary',
        text: prose,
      }));
      return { state: s, ctx: c };
    }

    case 'command_output': {
      const text = truncate(event.content, 200);
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'debug_detail',
        tag: 'command_output',
        text: `${event.command}: ${text}`,
      }));
      return { state: s, ctx: c };
    }

    case 'local_shell_command': {
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'shell_command',
        command: event.command,
        exitCode: event.exitCode,
        durationMs: event.durationMs,
        stdout: event.stdout,
        stderr: event.stderr,
      }));
      return { state: s, ctx: c };
    }

    case 'tool_started': {
      c = { ...c, lastToolName: event.toolName };
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'tool_activity',
        toolName: event.toolName,
        phase: 'started',
        summary: event.detail ?? event.summary,
      }));
      return { state: s, ctx: c };
    }

    case 'tool_finished': {
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'tool_activity',
        toolName: event.toolName,
        phase: event.status === 'ok' ? 'completed' : 'failed',
        summary: event.summary,
        detail: event.detail,
      }));
      return { state: s, ctx: c };
    }

    case 'patch_preview': {
      const lines = event.diff.split('\n');
      const detail = lines.slice(0, 8).join('\n') + (lines.length > 8 ? '\n...' : '');
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'debug_detail',
        tag: 'patch_preview',
        text: `${event.path}\n${detail}`,
      }));
      return { state: s, ctx: c };
    }

    case 'verification_planned':
    case 'verification_started': {
      // Staged: merge verification lifecycle into a single tool_activity
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'tool_activity',
        toolName: 'run_verification',
        phase: 'started',
        summary: event.checkLabel,
      }));
      return { state: s, ctx: c };
    }

    case 'verification_passed': {
      const dur = event.durationMs !== undefined ? ` (${formatDuration(event.durationMs)})` : '';
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'tool_activity',
        toolName: 'run_verification',
        phase: 'completed',
        summary: `${event.checkLabel}${dur}`,
      }));
      return { state: s, ctx: c };
    }

    case 'verification_failed': {
      const dur = event.durationMs !== undefined ? ` (${formatDuration(event.durationMs)})` : '';
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'tool_activity',
        toolName: 'run_verification',
        phase: 'failed',
        summary: event.summary ?? event.checkLabel,
        detail: `${event.checkLabel}${dur}${event.summary ? `\n${event.summary}` : ''}`,
      }));
      return { state: s, ctx: c };
    }

    case 'verification_skipped': {
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'tool_activity',
        toolName: 'run_verification',
        phase: 'completed',
        summary: `skipped: ${event.checkLabel}`,
      }));
      return { state: s, ctx: c };
    }

    case 'orchestration_plan_generated': {
      const plan = event.payload.plan;
      if ('inline' in plan && plan.inline) {
        // Inline plans don't produce orchestration blocks — execution falls
        // through to normal turn loop.
        // Also clear agent panes for a fresh orchestration view.
        s = { ...s, agentPanes: [] };
        return { state: s, ctx: c };
      }
      const subTasks = plan.subTasks ?? [];
      const agents: SubAgentSummary[] = subTasks.map((st: { id: string; description: string }) => ({
        id: st.id,
        task: st.description,
        phase: 'pending' as const,
      }));
      // Clear agent panes for new plan
      s = { ...s, agentPanes: [] };
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'orchestration',
        mode: plan.strategy === 'orchestrate' ? 'parallel' : 'sequential',
        phase: 'planning',
        summary: `${subTasks.length} sub-tasks planned, mode: ${plan.strategy}`,
        subAgents: agents,
      }));
      return { state: s, ctx: c };
    }

    case 'child_session_spawned': {
      // Update the last orchestration block's subAgent
      const orchBlock = s.blocks[c.lastOrchestrationIndex];
      if (c.lastOrchestrationIndex >= 0 && orchBlock?.kind === 'orchestration') {
        const updatedAgents = orchBlock.subAgents.map((a) =>
          a.id === (event.subtaskId ?? event.childSessionId) ? { ...a, phase: 'active' as const } : a,
        );
        s = replaceBlock(s, c.lastOrchestrationIndex, {
          ...orchBlock,
          phase: 'active' as const,
          subAgents: updatedAgents,
        });
      }
      // Also create agent pane for swarm views
      s = {
        ...s,
        agentPanes: [
          ...s.agentPanes,
          {
            id: event.childSessionId,
            role: event.subtaskId ?? 'sub-agent',
            model: 'local',
            phase: 'active',
            lastAction: `spawned (parent: ${truncate(event.parentSessionId, 12)})`,
          },
        ],
      };
      return { state: s, ctx: c };
    }

    case 'child_session_completed': {
      const block = s.blocks[c.lastOrchestrationIndex];
      if (c.lastOrchestrationIndex >= 0 && block?.kind === 'orchestration') {
        const subTaskId = event.subtaskId ?? event.childSessionId;
        const changedFiles = event.result?.changedFiles;
        const updatedAgents = block.subAgents.map((a) =>
          a.id === subTaskId ? { ...a, phase: 'completed' as const, changedFiles: changedFiles ?? a.changedFiles } : a,
        );
        const allDone = updatedAgents.every((a) => a.phase === 'completed' || a.phase === 'failed');
        s = replaceBlock(s, c.lastOrchestrationIndex, {
          ...block,
          phase: allDone ? ('completed' as const) : ('active' as const),
          subAgents: updatedAgents,
        });
      }
      // Update agent pane for swarm views
      s = {
        ...s,
        agentPanes: s.agentPanes.map((p) =>
          p.id === event.childSessionId
            ? {
                ...p,
                phase: 'completed' as const,
                lastAction: event.result.terminalState,
                finding: `${event.result.toolCalls} tool calls · ${event.result.changedFiles.length} files`,
                changedFiles: event.result.changedFiles,
              }
            : p,
        ),
      };
      return { state: s, ctx: c };
    }

    case 'child_session_failed': {
      const b = s.blocks[c.lastOrchestrationIndex];
      if (c.lastOrchestrationIndex >= 0 && b?.kind === 'orchestration') {
        const subTaskId = event.subtaskId ?? event.childSessionId;
        const updatedAgents = b.subAgents.map((a) =>
          a.id === subTaskId ? { ...a, phase: 'failed' as const, error: event.error } : a,
        );
        s = replaceBlock(s, c.lastOrchestrationIndex, {
          ...b,
          phase: 'failed' as const,
          subAgents: updatedAgents,
        });
      }
      // Update agent pane for swarm views
      s = {
        ...s,
        agentPanes: s.agentPanes.map((p) =>
          p.id === event.childSessionId
            ? {
                ...p,
                phase: 'failed' as const,
                lastAction: `failed: ${truncate(event.error, 60)}`,
                finding: event.partialResult?.error ?? event.error,
              }
            : p,
        ),
      };
      return { state: s, ctx: c };
    }

    case 'task_finished': {
      // Flush any remaining streaming text as a model note
      if (s.streamingText.trim()) {
        const prose = extractProse(s.streamingText);
        if (prose) {
          ({ state: s, ctx: c } = appendBlock(s, c, {
            kind: 'model_output',
            role: 'note',
            text: prose,
          }));
        }
        s = { ...s, streamingText: '' };
      }

      // Update orchestration phase if active
      if (c.lastOrchestrationIndex >= 0) {
        const b = s.blocks[c.lastOrchestrationIndex];
        if (b?.kind === 'orchestration' && b.phase === 'active') {
          s = replaceBlock(s, c.lastOrchestrationIndex, {
            ...b,
            phase: event.status === 'completed' ? 'completed' : 'failed',
            summary: event.status === 'completed' ? b.summary : `${b.summary} — interrupted: ${event.status}`,
          });
        }
      }

      const isQuestion = event.status === 'user_input_required';
      if (isQuestion && s.blocks.some((b) => b.kind === 'model_output' && b.role === 'primary')) {
        const lastPrimary = [...s.blocks].reverse().find((b) => b.kind === 'model_output' && b.role === 'primary');
        if (lastPrimary?.kind === 'model_output') {
          s = replaceBlock(s, s.blocks.indexOf(lastPrimary), {
            ...lastPrimary,
            role: 'question',
          });
        }
      }

      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'runtime_status',
        label: 'summary',
        value: `Status: ${event.status} · ${event.modelSteps ?? 0} steps · ${event.toolCalls ?? 0} tool calls · ${event.changedFiles?.length ?? 0} files`,
        priority: 'line',
      }));

      if (event.error) {
        ({ state: s, ctx: c } = appendBlock(s, c, {
          kind: 'runtime_status',
          label: 'error',
          value: event.error,
          priority: 'line',
        }));
      }
      return { state: s, ctx: c };
    }

    case 'error': {
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'runtime_status',
        label: 'error',
        value: event.message,
        priority: 'line',
      }));
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'debug_detail',
        tag: 'error',
        text: event.message,
      }));
      return { state: s, ctx: c };
    }

    case 'token_usage': {
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'runtime_status',
        label: 'tokens',
        value: `in: ${event.inputTokens}, out: ${event.outputTokens}, cost: $${event.estimatedCost.toFixed(4)}`,
        priority: 'detail',
      }));
      return { state: s, ctx: c };
    }

    // ── SynaxEvent / lifecycle events ─────────────────────────────
    case 'session_start':
    case 'turn_start': {
      // Notable lifecycle events — emit as debug_detail for traceability
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'debug_detail',
        tag: 'lifecycle',
        text: `${event.type}${'task' in event && event.task ? `: ${truncate(event.task, 80)}` : ''}`,
      }));
      return { state: s, ctx: c };
    }

    case 'session_shutdown':
    case 'turn_end': {
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'debug_detail',
        tag: 'lifecycle',
        text: `${event.type}: ${event.terminalState}`,
      }));
      return { state: s, ctx: c };
    }

    case 'before_compact':
    case 'session_compact': {
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'runtime_status',
        label: 'compaction',
        value: `${event.type}`,
        priority: 'detail',
      }));
      return { state: s, ctx: c };
    }

    case 'pre_tool_use': {
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'debug_detail',
        tag: 'control_hook',
        text: `tool: ${event.toolName} (call ${event.toolCallId})`,
      }));
      return { state: s, ctx: c };
    }

    case 'post_tool_use_failure': {
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'debug_detail',
        tag: 'control_hook',
        text: `tool failure: ${event.toolName} (attempt ${event.attemptCount}): ${event.error}`,
      }));
      return { state: s, ctx: c };
    }

    case 'tool_execution_start': {
      c = { ...c, lastToolName: event.toolName };
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'tool_activity',
        toolName: event.toolName,
        phase: 'started',
        summary: JSON.stringify(event.arguments).slice(0, 200),
      }));
      return { state: s, ctx: c };
    }

    case 'tool_execution_end': {
      ({ state: s, ctx: c } = appendBlock(s, c, {
        kind: 'tool_activity',
        toolName: event.toolName,
        phase: event.success ? 'completed' : 'failed',
        summary: event.error ?? 'ok',
      }));
      return { state: s, ctx: c };
    }

    // ── Memory events (fixture events for preview only) ──────────
    case 'memory_decision': {
      const decision: MemoryDecision = {
        label: `${event.queryType}: ${event.queryKey}`,
        disposition: event.disposition as MemoryDecision['disposition'],
        reason: event.reason,
        provenance: event.provenance,
        stale: 'stale' in event ? (event as any).stale : undefined,
        conflict: 'conflict' in event ? (event as any).conflict : undefined,
      };
      s = { ...s, memoryDecisions: [...s.memoryDecisions, decision] };
      return { state: s, ctx: c };
    }

    case 'memory_context_injected': {
      const decisions: MemoryDecision[] = (event.decisions ?? []).map((d: any) => ({
        label: `${d.queryType}: ${d.queryKey}`,
        disposition: d.disposition as MemoryDecision['disposition'],
        reason: d.reason,
        provenance: d.provenance,
        stale: d.stale,
        conflict: d.conflict,
      }));
      s = { ...s, memoryDecisions: decisions };
      return { state: s, ctx: c };
    }

    // ── Handoff events (fixture events for preview only) ─────────
    case 'handoff_planned': {
      const packet: HandoffPacketView = {
        source: event.sourceModel,
        target: event.targetModel,
        reason:
          'contextWindowBudgetRemaining' in event
            ? `${event.reason} (${(event as any).contextWindowBudgetRemaining} tokens remaining)`
            : event.reason,
        summary: event.summary,
        includedContext: event.includedContextKeys,
        excludedContext: event.excludedContextKeys,
      };
      s = { ...s, handoffPackets: [...s.handoffPackets, packet] };
      return { state: s, ctx: c };
    }

    case 'handoff_completed': {
      // No-op: handoff completion is informational, no block mutation needed
      return { state: s, ctx: c };
    }

    default:
      // Unhandled event types are silently ignored
      return { state: s, ctx: c };
  }
}

/** Reduce an array of events into a single PresentationState. */
export function reduceEvents(events: Array<ReducableEvent>, initialState?: PresentationState): PresentationState {
  let result = initialState ?? createInitialPresentationState();
  let ctx = createInitialContext();
  for (const event of events) {
    const next = reduceEvent(result, event, ctx);
    result = next.state;
    ctx = next.ctx;
  }
  return result;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}
