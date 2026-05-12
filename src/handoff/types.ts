/**
 * Handoff types — structured context handoff between parent and child agents.
 *
 * When context is exhausted, the parent agent checkpoints its state,
 * spawns a child session with fresh context + FTS5 inheritance, and
 * the child completes the task autonomously.
 */

import type { AgentTurnResult } from '../session/types';

// ─── Handoff reason ──────────────────────────────────────────────────────────

export type HandoffReason = 'context_exhaustion' | 'task_delegation';

// ─── Handoff manifest (shared between parent and child) ──────────────────────

export interface HandoffManifest {
  /** Unique identifier for this handoff event. */
  handoffId: string;
  /** Session ID of the parent agent. */
  parentSessionId: string;
  /** Why the handoff was triggered. */
  reason: HandoffReason;
  /** The original user task (preserved across handoffs). */
  task: string;
  /** What was accomplished before the handoff. */
  status: string;
  /** Critical discoveries from parent's execution. */
  keyFindings: string[];
  /** Files that were modified by the parent. */
  filesChanged: string[];
  /** Files that were read/inspected by the parent. */
  filesRead: string[];
  /** Work that still needs to be done. */
  pendingWork: string[];
  /** Terms for FTS5 memory search in the child agent. */
  suggestedSearchTerms: string[];
  /** How much of the context window was used (tokens). */
  contextWindowUsed: number;
  /** Handoff depth (0 = first handoff, 1 = second, max 3). */
  depth: number;
  /** ISO 8601 timestamp of handoff creation. */
  createdAt: string;

  /** Which sub-task this child is executing (orchestration). */
  subtaskId?: string;
  /** Which plan this child belongs to (orchestration). */
  orchestrationPlanId?: string;
  /** Summary of parent progress and sibling results so far. */
  orchestrationContext?: string;
}

// ─── Handoff result ──────────────────────────────────────────────────────────

export interface HandoffResult {
  /** The child session's turn result. */
  turnResult: AgentTurnResult;
  /** The handoff manifest used for this handoff. */
  manifest: HandoffManifest;
  /** Whether the handoff was successful (child completed). */
  success: boolean;
  /** Error message if handoff failed. */
  error?: string;
}

// ─── Handoff manager options ─────────────────────────────────────────────────

export interface HandoffManagerOptions {
  /** Maximum nested handoff depth (default 3). */
  maxDepth?: number;
  /** Current handoff depth (0-indexed). */
  currentDepth?: number;
}
