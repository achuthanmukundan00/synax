/**
 * Typed event definitions for the Synax EventBus.
 *
 * Extends the existing AgentEvent discriminated union in src/agent/events.ts
 * with lifecycle and control-hook events. All events share a base interface
 * with type, timestamp, and optional taskId/stepIndex for traceability.
 *
 * Lifecycle events (fire-and-forget): session_start, turn_start, turn_end,
 *   tool_execution_start, tool_execution_end, before_compact, session_compact,
 *   session_shutdown.
 *
 * Control hooks (can intercept): pre_tool_use — handlers return a
 *   ControlDecision to allow, block, or modify the tool call.
 */

import type { AgentEventBase, TerminalState } from '../agent/events';

// ─── Control decision ────────────────────────────────────────────────────────

/**
 * Outcome of a control hook such as pre_tool_use.
 *
 * - { allow: true }: proceed normally
 * - { allow: false, reason: "..." }: block the operation with a reason
 * - { modify: true, modifiedAction: {...} }: replace the action before execution
 */
export type ControlDecision = { allow: true } | { allow: false; reason: string };

// ─── Session lifecycle events ────────────────────────────────────────────────

export interface SessionStartEvent extends AgentEventBase {
  type: 'session_start';
  taskId?: string;
  mode: string;
  model: string;
}

export interface SessionShutdownEvent extends AgentEventBase {
  type: 'session_shutdown';
  terminalState: TerminalState;
}

// ─── Turn lifecycle events ───────────────────────────────────────────────────

export interface TurnStartEvent extends AgentEventBase {
  type: 'turn_start';
  stepIndex: number;
  task?: string;
}

export interface TurnEndEvent extends AgentEventBase {
  type: 'turn_end';
  stepIndex: number;
  terminalState: TerminalState;
  toolCalls: number;
  steps: number;
}

// ─── Tool execution lifecycle events ─────────────────────────────────────────

export interface ToolExecutionStartEvent extends AgentEventBase {
  type: 'tool_execution_start';
  stepIndex: number;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface ToolExecutionEndEvent extends AgentEventBase {
  type: 'tool_execution_end';
  stepIndex: number;
  toolCallId: string;
  toolName: string;
  success: boolean;
  error?: string;
}

// ─── Compaction lifecycle events ─────────────────────────────────────────────

export interface BeforeCompactEvent extends AgentEventBase {
  type: 'before_compact';
  stepIndex?: number;
  estimatedInputTokens: number;
  inputLimit: number;
  stage?: number;
}

export interface SessionCompactEvent extends AgentEventBase {
  type: 'session_compact';
  stepIndex?: number;
  stage: number;
  tokensBefore: number;
  tokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
}

// ─── Control hook events ─────────────────────────────────────────────────────

export interface PreToolUseEvent extends AgentEventBase {
  type: 'pre_tool_use';
  stepIndex: number;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface PostToolUseFailureEvent extends AgentEventBase {
  type: 'post_tool_use_failure';
  stepIndex: number;
  toolCallId: string;
  toolName: string;
  error: string;
  attemptCount: number;
}

// ─── Child session lifecycle events (orchestration) ──────────────────────────

export interface ChildSessionSpawnedEvent extends AgentEventBase {
  type: 'child_session_spawned';
  parentSessionId: string;
  childSessionId: string;
  subtaskId?: string;
}

import type { SubAgentResult } from '../session/types';

export interface ChildSessionCompletedEvent extends AgentEventBase {
  type: 'child_session_completed';
  parentSessionId: string;
  childSessionId: string;
  subtaskId?: string;
  result: SubAgentResult;
}

export interface ChildSessionFailedEvent extends AgentEventBase {
  type: 'child_session_failed';
  parentSessionId: string;
  childSessionId: string;
  subtaskId?: string;
  error: string;
  partialResult: SubAgentResult;
}

// ─── Union types ─────────────────────────────────────────────────────────────

export type LifecycleEvent =
  | SessionStartEvent
  | SessionShutdownEvent
  | TurnStartEvent
  | TurnEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionEndEvent
  | BeforeCompactEvent
  | SessionCompactEvent
  | ChildSessionSpawnedEvent
  | ChildSessionCompletedEvent
  | ChildSessionFailedEvent;

export type ControlHookEvent = PreToolUseEvent | PostToolUseFailureEvent;

export type SynaxEvent = LifecycleEvent | ControlHookEvent;
