/**
 * HandoffManager — spawns child Sessions with fresh context + FTS5 inheritance.
 *
 * When context is exhausted (after deterministic compaction), the parent agent
 * checkpoints its state via a HandoffManifest, spawns a child Session with
 * clean context, and the child completes the task autonomously.
 *
 * The child inherits the parent's FTS5 memory database for search_memory.
 * Handoff depth is capped at 3 to prevent infinite chains.
 */

import { Session, type AgentClient, type AgentTurnResult } from '../session/Session';
import type { HolographicMemory } from '../memory/HolographicMemory';
import type { SpanTracer } from '../telemetry/SpanTracer';
import type { TokenCounter } from '../metrics/TokenCounter';
import type { CostTracker } from '../metrics/CostTracker';
import type { Logger } from '../logging/index';
import type { RunMode } from '../agent/task-policy';
import type { ContextBudgetSettings } from '../agent/context-budget';
import { eventNow } from '../agent/events';

import type { HandoffManifest, HandoffReason, HandoffResult, HandoffManagerOptions } from './types';
import { createInspectionLedger } from '../tools';
import { createTokenLedger } from '../agent/context-budget';

export type { HandoffManifest, HandoffReason, HandoffResult, HandoffManagerOptions };

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_HANDOFF_DEPTH = 3;

// ─── HandoffManager ──────────────────────────────────────────────────────────

export class HandoffManager {
  private maxDepth: number;
  private currentDepth: number;

  constructor(options: HandoffManagerOptions = {}) {
    this.maxDepth = options.maxDepth ?? MAX_HANDOFF_DEPTH;
    this.currentDepth = options.currentDepth ?? 0;
  }

  /**
   * Check whether another handoff is allowed (depth < maxDepth).
   */
  canHandoff(): boolean {
    return this.currentDepth < this.maxDepth;
  }

  /**
   * Get the current depth of this manager.
   */
  getCurrentDepth(): number {
    return this.currentDepth;
  }

  /**
   * Generate a HandoffManifest from parent session state.
   *
   * Combines holographic memory data with conversation-level metadata
   * to produce a structured manifest that the child session can consume.
   */
  generateManifest(params: {
    parentSessionId: string;
    reason: HandoffReason;
    task: string;
    filesChanged: string[];
    filesRead: string[];
    memory: HolographicMemory | null;
    contextWindowUsed: number;
    conversationMessages?: Array<{ role: string; content: string }>;
  }): HandoffManifest {
    const memoryManifest = params.memory?.handoff();

    // Build status from conversation and memory context
    const statusParts: string[] = [];
    if (params.filesChanged.length > 0) {
      statusParts.push(`${params.filesChanged.length} file(s) changed`);
    }
    if (params.filesRead.length > 0) {
      statusParts.push(`${params.filesRead.length} file(s) read`);
    }
    if (memoryManifest && memoryManifest.turnCount > 0) {
      statusParts.push(`${memoryManifest.turnCount} turn(s) completed`);
    }

    // Collect key findings from memory manifest and conversation
    const keyFindings = (memoryManifest?.keyFindings ?? []).slice(0, 10);

    // If no key findings from memory, extract from conversation messages
    if (keyFindings.length === 0 && params.conversationMessages) {
      for (const msg of params.conversationMessages) {
        if (msg.role === 'assistant' && msg.content.length > 30 && msg.content.length < 500) {
          keyFindings.push(msg.content.trim());
          if (keyFindings.length >= 5) break;
        }
      }
    }

    // Combine files touched from memory manifest with session-level tracking
    const filesTouched = memoryManifest?.filesTouched ?? [];
    const allFilesChanged = [...new Set([...params.filesChanged, ...filesTouched])];
    const allFilesRead = [...new Set([...params.filesRead, ...filesTouched])];

    // Suggested search terms from memory analysis
    const searchTerms = memoryManifest?.suggestedSearchTerms ?? [];

    return {
      handoffId: `handoff-${params.parentSessionId}-d${this.currentDepth}-${Date.now()}`,
      parentSessionId: params.parentSessionId,
      reason: params.reason,
      task: params.task,
      status: statusParts.join('; ') || 'Initial exploration',
      keyFindings,
      filesChanged: allFilesChanged,
      filesRead: allFilesRead,
      pendingWork: this.extractPendingWork(params.task, params.filesChanged),
      suggestedSearchTerms: searchTerms,
      contextWindowUsed: params.contextWindowUsed,
      depth: this.currentDepth,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Build a clean conversation for a child session.
   *
   * The child gets: system prompt + handoff manifest as context + original task.
   * No bloated history — the child uses search_memory to query the parent's FTS5.
   */
  buildChildContext(manifest: HandoffManifest, skillMessages?: string[]): Array<{ role: string; content: string }> {
    const contextLines: string[] = [
      '## Session Handoff — Continued from Parent Agent',
      '',
      `**Handoff Reason:** ${manifest.reason === 'context_exhaustion' ? 'Context window exhausted' : 'Task delegation'}`,
      `**Handoff Depth:** ${manifest.depth + 1}/${MAX_HANDOFF_DEPTH}`,
      '',
      '### Original Task',
      manifest.task,
      '',
      '### Progress So Far',
      manifest.status,
      '',
      '### Key Findings',
      ...manifest.keyFindings.map((f) => `- ${f}`),
      '',
      manifest.filesChanged.length > 0
        ? `### Files Changed\n${manifest.filesChanged.map((f) => `- ${f}`).join('\n')}`
        : '### Files Changed\n(none)',
      '',
      manifest.filesRead.length > 0
        ? `### Files Read\n${manifest.filesRead.map((f) => `- ${f}`).join('\n')}`
        : '### Files Read\n(none)',
      '',
      '### Pending Work',
      ...manifest.pendingWork.map((w) => `- ${w}`),
      '',
      '### Search Terms for Memory',
      `Use \`search_memory\` with these terms to retrieve parent context: ${manifest.suggestedSearchTerms.slice(0, 8).join(', ')}`,
      '',
      'Continue the task from where the parent left off. Use search_memory to retrieve',
      'specific details from earlier turns if needed. Complete the remaining work.',
    ];

    const messages = [{ role: 'system' as const, content: contextLines.join('\n') }];

    if (skillMessages) {
      for (const msg of skillMessages) {
        if (msg.trim().length > 0) {
          messages.push({ role: 'system' as const, content: msg });
        }
      }
    }

    return messages;
  }

  /**
   * Spawn a child Session and execute the handoff task.
   *
   * The child starts with clean context (system prompt + handoff manifest)
   * and inherits the parent's FTS5 memory for search_memory queries.
   */
  async executeHandoff(params: {
    manifest: HandoffManifest;
    repoRoot: string;
    client: AgentClient;
    mode: RunMode;
    memory: HolographicMemory | null;
    skillMessages?: string[];
    bashEnabled?: boolean;
    maxToolCalls?: number;
    maxModelSteps?: number;
    contextBudget?: Partial<ContextBudgetSettings>;
    logger?: Logger;
    tracer?: SpanTracer;
    tokenCounter?: TokenCounter;
    costTracker?: CostTracker;
    onEvent?: (event: unknown) => void;
  }): Promise<HandoffResult> {
    if (!this.canHandoff()) {
      return {
        turnResult: {
          terminalState: 'budget_exhausted',
          finalAnswer: '',
          steps: 0,
          toolCalls: [],
          changedFiles: [],
          conversation: {
            messages: [],
            inspectionLedger: createInspectionLedger(),
            latestCompaction: null,
            tokenLedger: createTokenLedger(),
            assemblyStats: null,
          },
        } as AgentTurnResult,
        manifest: params.manifest,
        success: false,
        error: `Max handoff depth (${this.maxDepth}) exceeded. Cannot spawn child session.`,
      };
    }

    const childContext = this.buildChildContext(params.manifest, params.skillMessages);

    // Create a child HandoffManager with incremented depth
    const childHandoff = new HandoffManager({ maxDepth: this.maxDepth, currentDepth: this.currentDepth + 1 });

    const childSessionId = `${params.manifest.parentSessionId}-child-d${this.currentDepth + 1}`;

    // Build child session with clean context
    const childSession = new Session({
      repoRoot: params.repoRoot,
      client: params.client,
      sessionId: childSessionId,
      mode: params.mode,
      memory: params.memory, // Inherit parent's FTS5
      maxToolCalls: params.maxToolCalls,
      maxModelSteps: params.maxModelSteps,
      bashEnabled: params.bashEnabled,
      skillMessages: params.skillMessages,
      conversation: {
        messages: childContext,
        inspectionLedger: createInspectionLedger(),
        latestCompaction: null,
        tokenLedger: createTokenLedger(),
        assemblyStats: null,
      },
      contextBudget: params.contextBudget,
      logger: params.logger,
      tracer: params.tracer,
      tokenCounter: params.tokenCounter,
      costTracker: params.costTracker,
      onEvent: params.onEvent as ((event: import('../agent/events').AgentEvent) => void) | undefined,
    });

    // Wire child handoff manager into the child session for nested handoffs
    childSession.setHandoffManager(childHandoff);

    try {
      // Execute the child session with the original task
      const turnResult = await childSession.startTurnWithRecovery(params.manifest.task);

      return {
        turnResult,
        manifest: params.manifest,
        success: turnResult.terminalState === 'completed',
        error: turnResult.error,
      };
    } catch (error) {
      return {
        turnResult: {
          terminalState: 'model_error',
          finalAnswer: '',
          steps: 0,
          toolCalls: [],
          changedFiles: [],
          conversation: {
            messages: [],
            inspectionLedger: createInspectionLedger(),
            latestCompaction: null,
            tokenLedger: createTokenLedger(),
            assemblyStats: null,
          },
        } as AgentTurnResult,
        manifest: params.manifest,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute an orchestrated handoff for parallel sub-agents (spec 021 phase 3).
   *
   * Extends the normal handoff logic by adding orchestration context, explicitly scoped file context,
   * and isolated event emitting. The returning turn result is converted to a SubAgentResult.
   */
  async executeOrchestratedHandoff(params: {
    manifest: HandoffManifest;
    repoRoot: string;
    client: AgentClient;
    mode: RunMode;
    memory: HolographicMemory | null;
    skillMessages?: string[];
    bashEnabled?: boolean;
    maxToolCalls?: number;
    maxModelSteps?: number;
    contextBudget?: Partial<ContextBudgetSettings>;
    logger?: Logger;
    tracer?: SpanTracer;
    tokenCounter?: TokenCounter;
    costTracker?: CostTracker;
    onEvent?: (event: unknown) => void;
  }): Promise<HandoffResult> {
    // We reuse executeHandoff since it abstracts context initialization and session startup
    return this.executeHandoff(params);
  }

  /**
   * Attempt a handoff from the parent session.
   *
   * Generates the manifest and spawns a child session. Emits handoff
   * lifecycle events to the parent's EventBus.
   */
  async tryHandoff(params: {
    parentSession: Session;
    reason: HandoffReason;
    task: string;
    filesChanged: string[];
    filesRead: string[];
    contextWindowUsed: number;
    skillMessages?: string[];
    onEvent?: (event: unknown) => void;
    repoRoot: string;
    client: AgentClient;
    mode: RunMode;
    bashEnabled: boolean;
    contextBudget: Partial<ContextBudgetSettings> | undefined;
  }): Promise<HandoffResult | null> {
    if (!this.canHandoff()) {
      params.parentSession['logger']?.warn('Cannot handoff — max depth reached', {
        currentDepth: this.currentDepth,
        maxDepth: this.maxDepth,
      });
      return null;
    }

    // Emit handoff started event
    params.parentSession['eventBus']?.emit({
      type: 'session_compact', // reuse compaction event for now — handoff is a form of compaction
      timestamp: eventNow(),
      stepIndex: 0,
      stage: 4,
      tokensBefore: params.contextWindowUsed,
      tokensAfter: 0,
      messagesBefore: params.parentSession.conversation.messages.length,
      messagesAfter: -1, // child gets clean context
    });

    const manifest = this.generateManifest({
      parentSessionId: params.parentSession.sessionId,
      reason: params.reason,
      task: params.task,
      filesChanged: params.filesChanged,
      filesRead: params.filesRead,
      memory: params.parentSession.memory,
      contextWindowUsed: params.contextWindowUsed,
      conversationMessages: params.parentSession.conversation.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    params.parentSession['logger']?.info('Spawning handoff child session', {
      handoffId: manifest.handoffId,
      depth: this.currentDepth + 1,
      filesChanged: manifest.filesChanged.length,
      keyFindings: manifest.keyFindings.length,
    });

    const result = await this.executeHandoff({
      manifest,
      repoRoot: params.repoRoot,
      client: params.client,
      mode: params.mode,
      memory: params.parentSession.memory,
      skillMessages: params.skillMessages,
      bashEnabled: params.bashEnabled,
      contextBudget: params.contextBudget,
      logger: params.parentSession['logger'],
      tracer: params.parentSession['tracer'],
      tokenCounter: params.parentSession['tokenCounter'],
      costTracker: params.parentSession['costTracker'],
      onEvent: params.onEvent,
    });

    return result;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Extract pending work items from the task description and changed files.
   */
  private extractPendingWork(task: string, filesChanged: string[]): string[] {
    const pending: string[] = [];

    // If files were changed, suggest verification
    if (filesChanged.length > 0) {
      pending.push('Run verification/tests on changed files');
    }

    // Parse task for action keywords
    const lower = task.toLowerCase();
    if (lower.includes('fix') || lower.includes('repair') || lower.includes('resolve')) {
      pending.push('Verify the fix resolves the original issue');
    }
    if (lower.includes('implement') || lower.includes('add') || lower.includes('create')) {
      pending.push('Complete implementation and verify correctness');
    }
    if (lower.includes('refactor') || lower.includes('clean')) {
      pending.push('Ensure refactored code passes existing tests');
    }
    if (lower.includes('test') || lower.includes('coverage')) {
      pending.push('Ensure test coverage meets requirements');
    }

    // Always add generic continuation
    if (pending.length === 0) {
      pending.push('Continue working on the original task');
    }

    return pending;
  }
}
