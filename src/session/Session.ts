/**
 * Session — agent lifecycle orchestrator.
 *
 * Owns: config, tools, memory (SQLite+FTS5), EventBus, hooks.
 * Lifecycle: boot → trustGate → ready → running → shutdown.
 *
 * Delegates turn execution, message assembly, formatting, tool definitions,
 * and verification to focused modules. This file is the wiring layer.
 */

import { randomBytes } from 'crypto';
import { type Logger } from '../logging/index.js';
import { EventBus } from '../events/index';
import type { HolographicMemory, HandoffManifest } from '../memory/HolographicMemory';
import type { SpanTracer } from '../telemetry/SpanTracer';
import type { TokenCounter } from '../metrics/TokenCounter';
import type { CostTracker } from '../metrics/CostTracker';
import { HandoffManager } from '../handoff/HandoffManager';
import { type ChatResponse } from '../llm/types';
import { createInspectionLedger, createToolRegistry } from '../tools';
import { type ToolDefinition, type ToolRegistry, type ToolResult } from '../tools/types';
import { type PatchPreview } from '../agent/patch';
import {
  createTokenLedger,
  estimateIncrementalTokens,
  estimateRequestTokens,
  estimateTaskBudget,
  formatContextBudgetError,
  resolveContextBudgetSettings,
  resetTokenLedger,
  summarizeLargestContributors,
  type BudgetEstimate,
  type ContextBudgetSettings,
} from '../agent/context-budget';
import { extractTextContent } from '../llm/types';
import { orchestrationPlanPrompt } from '../agent/prompts/orchestration-plan';
import { parseOrchestrationPlan, type PlanNormalizationDefaults } from '../orchestration/plan-parser';
import type { PlanParseResult } from './types';
import { eventNow, type AgentEvent, type TerminalState } from '../agent/events';
import { describeToolCall, guardBroadTask, guardUnsupportedTask, type RunMode } from '../agent/task-policy';
import { ActionExecutor, createDefaultHandlerMap } from '../actions/ActionExecutor';
import { estimateReadResultTokens } from '../actions/handlers/read-handler';
import { NodeExecutionEnv } from '../env/NodeExecutionEnv';
import type { ExecutionEnv } from '../env/ExecutionEnv';
import { RecoveryManager } from '../recovery/RecoveryManager';

// ── Extracted modules ──────────────────────────────────────────────────────
import {
  type AgentMessage,
  type AgentClient,
  type AgentConversation,
  type AgentRunnerOptions,
  type ModelToolSurfaceOptions,
  type AgentActivity,
  type AgentBudgetSnapshot,
  type PatchApprovalDecision,
  type AgentTurnResult,
  type AgentTerminalState,
} from './types';
export type {
  AgentTerminalState,
  AgentMessage,
  AgentClient,
  AgentConversation,
  AgentRunnerOptions,
  ModelToolSurfaceOptions,
  AgentActivity,
  AgentBudgetSnapshot,
  PatchApprovalDecision,
  AgentTurnResult,
};

import { buildModelFacingTools, systemPrompt } from './tool-definitions';
export { systemPrompt };

import {
  assistantMessage,
  appendToolResult,
  flushContentToolResults,
  toolCallFormat,
  formatToolResultDetail,
  formatModelResponseActivity,
  isSafeToolPreamble,
  isRecoverableToolError,
  isPolicyRefusal,
  emitAssistantDelta,
  errorMessage,
  assistantVisibleContent,
  isStatusOnlyOutput,
  tryBuildImageViewMessage,
} from './formatting';
import { sanitizeReasoning } from '../llm/repair/reasoning-sanitizer';

import { buildModelRequest, guardModelRequestMultiStage, classifyResultForRecovery } from './message-assembly';

import { checkCompletionAgainstContract } from './verification-contracts';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOOL_CALLS = 192;
const MAX_CONSECUTIVE_RECOVERABLE_TOOL_ERRORS = 3;
const MAX_CONSECUTIVE_TRUNCATIONS = 3;

export function finalAnswerFromResponse(response: ChatResponse): string {
  const visible = assistantVisibleContent(response.content) || '';
  // Reject status-only placeholder outputs (e.g. "completed", empty string)
  if (!isStatusOnlyOutput(visible)) return visible;

  // Fall back to reasoningContent when content is empty or status-only (#114)
  if (response.reasoningContent) {
    const sanitized = sanitizeReasoning(response.reasoningContent).content.trim();
    if (sanitized && !isStatusOnlyOutput(sanitized)) return sanitized;
  }

  return '';
}

/**
 * Find the most recent user message text in a conversation.
 * Returns null if no user message is found.
 */
function resolveLastUserMessageText(conversation: {
  messages: Array<{ role: string; content: import('../llm/types').ChatContent }>;
}): string | null {
  const userMessages = conversation.messages.filter(
    (m) => m.role === 'user' && !extractTextContent(m.content).startsWith('Context was compacted'),
  );
  if (userMessages.length === 0) return null;
  const last = userMessages[userMessages.length - 1];
  return extractTextContent(last.content);
}

// ─── Agent event type guard ──────────────────────────────────────────────────

/**
 * Set of event type strings that belong to the public AgentEvent discriminated
 * union (src/agent/events.ts). Internal EventBus lifecycle events are excluded.
 */
export const AGENT_EVENT_TYPES: Set<string> = new Set([
  'task_started',
  'model_step_started',
  'context_budget_updated',
  'tool_started',
  'tool_finished',
  'verification_planned',
  'verification_started',
  'verification_passed',
  'verification_failed',
  'verification_skipped',
  'patch_preview',
  'command_output',
  'local_shell_command',
  'assistant_message',
  'user_message',
  'assistant_delta',
  'task_finished',
  'error',
  'token_usage',
  'orchestration_plan_generated',
  'child_session_spawned',
  'child_session_completed',
  'child_session_failed',
  'planner_started',
  'planner_intent_detected',
  'planner_strategy_selected',
  'dispatch_started',
  'dispatch_worker_spawned',
  'dispatch_workers_completed',
]);

// ─── Session Class ───────────────────────────────────────────────────────────

/**
 * Session owns the agent lifecycle: conversation state, tool registry,
 * memory, EventBus, and turn orchestration.
 *
 * ```ts
 * const session = new Session({ repoRoot: '/project', client });
 * const result = await session.startTurnWithRecovery('fix the build');
 * ```
 */
/**
 * @public
 */
export class Session {
  readonly conversation: AgentConversation;
  readonly registry: ToolRegistry;
  readonly eventBus: EventBus = new EventBus();
  readonly executor: ActionExecutor;
  readonly env: ExecutionEnv;
  readonly recovery: RecoveryManager = new RecoveryManager();

  private repoRoot: string;
  private client: AgentClient;
  private maxToolCalls: number;
  private maxModelSteps: number;
  private mode: RunMode;
  private bashEnabled: boolean;
  private contextBudget: ContextBudgetSettings;
  private maxOutputTokens: number | undefined;

  // ── Callbacks (subscribed through EventBus) ──────────────────────────
  onActivity?: (activity: AgentActivity) => void;
  onEvent?: (event: AgentEvent) => void;
  onBudget?: (snapshot: AgentBudgetSnapshot) => void;
  approvePatch?: (preview: PatchPreview) => PatchApprovalDecision | Promise<PatchApprovalDecision>;
  ensureCheckpoint?: () => Promise<unknown>;

  // ── Steering ───────────────────────────────────────────────────────
  /** Abort signal to cancel a running turn mid-generation. */
  abortSignal?: AbortSignal;
  /**
   * Called after each tool call result is appended to the conversation.
   * Return a non-empty string to inject it as the next user message
   * (steering injection, continues the current turn without aborting).
   */
  onSteeringCheck?: () => string | undefined;

  // ── Observability ────────────────────────────────────────────────────
  logger?: Logger;
  tracer?: SpanTracer;
  tokenCounter?: TokenCounter;
  costTracker?: CostTracker;
  maxBudget?: number;

  // ── Memory ───────────────────────────────────────────────────────────
  /** Holographic memory — FTS5 semantic store, set externally by run-task. */
  memory: HolographicMemory | null = null;
  /** Persistent session identity for cross-turn memory retrieval. */
  readonly sessionId: string;

  // ── Handoff ──────────────────────────────────────────────────────────
  /** Handoff manager for spawning child sessions. Set via setHandoffManager(). */
  private _handoffManager: HandoffManager | null = null;

  // ── Verification contract override ──────────────────────────────────
  /** Explicit verification contract (overrides mode-based default). */
  private _verificationContract: import('./verification-contracts').VerificationContract | null = null;

  private _sessionStarted = false;

  constructor(options: {
    repoRoot: string;
    client: AgentClient;
    sessionId?: string;
    mode?: RunMode;
    maxToolCalls?: number;
    maxModelSteps?: number;
    maxSteps?: number;
    bashEnabled?: boolean;
    skillMessages?: string[];
    conversation?: AgentConversation;
    registry?: ToolRegistry;
    contextBudget?: Partial<ContextBudgetSettings> & { contextBudgetTokens?: number };
    onActivity?: (activity: AgentActivity) => void;
    onEvent?: (event: AgentEvent) => void;
    onBudget?: (snapshot: AgentBudgetSnapshot) => void;
    approvePatch?: (preview: PatchPreview) => PatchApprovalDecision | Promise<PatchApprovalDecision>;
    ensureCheckpoint?: () => Promise<unknown>;
    logger?: Logger;
    tracer?: SpanTracer;
    env?: ExecutionEnv;
    tokenCounter?: TokenCounter;
    costTracker?: CostTracker;
    maxBudget?: number;
    memory?: HolographicMemory | null;
    abortSignal?: AbortSignal;
    onSteeringCheck?: () => string | undefined;
    /** Per-provider max output token limit. */
    maxOutputTokens?: number;
  }) {
    this.repoRoot = options.repoRoot;
    this.client = options.client;
    this.mode = options.mode ?? 'patch';
    this.maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    this.maxModelSteps = options.maxModelSteps ?? options.maxSteps ?? 64;
    this.bashEnabled = options.bashEnabled ?? true;
    this.env = options.env ?? new NodeExecutionEnv();
    this.sessionId = options.sessionId ?? generatePersistentSessionId();
    this.maxOutputTokens = options.maxOutputTokens;

    // Memory: accept from constructor (preferred) or set externally later
    if (options.memory !== undefined) {
      this.memory = options.memory;
    }

    // Callbacks
    this.onActivity = options.onActivity;
    this.onEvent = options.onEvent;
    this.onBudget = options.onBudget;
    this.approvePatch = options.approvePatch;
    this.ensureCheckpoint = options.ensureCheckpoint;

    // Observability
    this.logger = options.logger;
    this.tracer = options.tracer;
    this.tokenCounter = options.tokenCounter;
    this.costTracker = options.costTracker;
    this.maxBudget = options.maxBudget;

    // ── Steering ─────────────────────────────────────────────────────
    this.abortSignal = options.abortSignal;
    this.onSteeringCheck = options.onSteeringCheck;

    // ── Wire EventBus: legacy callbacks as subscribers ──────────────────
    // Only forward events that belong to the AgentEvent discriminated union.
    // Internal lifecycle events (turn_start, tool_execution_start, etc.) are
    // not part of the public AgentEvent surface and are filtered out here.
    this.eventBus.onAny((event) => {
      if (AGENT_EVENT_TYPES.has(event.type)) {
        this.onEvent?.(event as AgentEvent);
      }
    });

    // ── Conversation ────────────────────────────────────────────────────
    this.conversation = options.conversation ?? Session.createConversation({ skillMessages: options.skillMessages });
    this.registry =
      options.registry ??
      createToolRegistry({
        repoRoot: options.repoRoot,
        ledger: this.conversation.inspectionLedger,
      });
    this.contextBudget = resolveContextBudgetSettings(options.contextBudget ?? {});
    this.executor = new ActionExecutor({
      handlers: createDefaultHandlerMap(),
      repoRoot: options.repoRoot,
      registry: this.registry,
    });
  }

  // ── Static factory ──────────────────────────────────────────────────────

  /** Create a fresh agent conversation with the Synax system prompt. */
  static createConversation(
    options: {
      skillMessages?: string[];
      tools?: string[];
      memoryWired?: boolean;
      hasMutationTools?: boolean;
    } = {},
  ): AgentConversation {
    const toolNames =
      options.tools && options.tools.length > 0
        ? options.tools
        : ['read', 'write', 'edit', 'bash', 'search_memory', 'save_memory', 'view_image'];
    const messages: AgentMessage[] = [
      {
        role: 'system',
        content: systemPrompt({
          tools: toolNames,
          memoryWired: options.memoryWired,
          hasMutationTools: options.hasMutationTools,
        }),
      },
    ];
    if (options.skillMessages && options.skillMessages.length > 0) {
      for (const message of options.skillMessages) {
        if (message.trim().length === 0) continue;
        messages.push({ role: 'system', content: message });
      }
    }
    return {
      messages,
      inspectionLedger: createInspectionLedger(),
      latestCompaction: null,
      tokenLedger: createTokenLedger(),
      assemblyStats: null,
    };
  }

  // ── Instance helpers ────────────────────────────────────────────────────

  /** Reset this session's conversation to a fresh state (preserves event subscriptions). */
  resetConversation(options: { skillMessages?: string[] } = {}): void {
    const tools = this.getModelTools();
    const toolNames = tools.map((t) => t.name);
    const hasMutation = toolNames.some((n) => n === 'write' || n === 'edit' || n === 'bash' || n === 'save_memory');
    const messages: AgentMessage[] = [
      {
        role: 'system',
        content: systemPrompt({
          tools: toolNames,
          memoryWired: this.memory !== null && this.memory.isAvailable,
          hasMutationTools: hasMutation,
        }),
      },
    ];
    if (options.skillMessages && options.skillMessages.length > 0) {
      for (const message of options.skillMessages) {
        if (message.trim().length === 0) continue;
        messages.push({ role: 'system', content: message });
      }
    }
    this.conversation.messages.splice(0, this.conversation.messages.length, ...messages);
    this.conversation.inspectionLedger = createInspectionLedger();
    this.conversation.latestCompaction = null;
    this.conversation.assemblyStats = null;
    resetTokenLedger(this.conversation.tokenLedger);
  }

  /** Build the model-facing tool definitions for this session's configuration. */
  static buildModelTools(options: ModelToolSurfaceOptions = {}): ToolDefinition[] {
    return buildModelFacingTools(options);
  }

  /** Build model-facing tools for this session's active configuration. */
  getModelTools(): ToolDefinition[] {
    const builtins = buildModelFacingTools({ bashEnabled: this.bashEnabled, mode: this.mode });
    const registryTools = this.registry.list();
    // Exclude inspection tools which are internal runner infrastructure,
    // not model-facing tools. Only custom tools registered by API consumers pass through.
    const customTools = registryTools.filter(
      (t) =>
        !builtins.find((b) => b.name === t.name) &&
        !['list_files', 'read_file_range', 'search_text', 'show_git_status', 'show_git_diff'].includes(t.name),
    );
    return [...builtins, ...customTools];
  }

  /** Set the handoff manager for spawning child sessions on context exhaustion. */
  setHandoffManager(manager: HandoffManager): void {
    this._handoffManager = manager;
  }

  /** Override the verification contract (normally derived from mode). */
  setVerificationContract(contract: import('./verification-contracts').VerificationContract | null): void {
    this._verificationContract = contract;
  }

  /**
   * Spawn a child session for evaluating a specific sub-task in an orchestration plan (Spec 021 Phase 3).
   *
   * The new session operates in an isolated environment but receives the parent's memory
   * and selected orchestration context. Emits orchestration lifecycle events directly to parent event bus.
   */
  async fork(
    subtask: import('./types').SubTask,
    parentManifest: import('../handoff/types').HandoffManifest,
    options?: {
      maxToolCalls?: number;
      maxModelSteps?: number;
      contextBudget?: Partial<ContextBudgetSettings>;
    },
  ): Promise<import('./types').SubAgentResult> {
    const parentDepth = this._handoffManager?.getCurrentDepth() ?? 0;

    // 1. Create a child handoff manifest matching parent but enriched with orchestration scope
    const childManifest: import('../handoff/types').HandoffManifest = {
      ...parentManifest,
      handoffId: `fork-${this.sessionId}-${subtask.id}-${Date.now()}`,
      parentSessionId: this.sessionId,
      reason: 'task_delegation',
      depth: parentDepth, // Depth does not increase monotonically for forks vs exhaustions across same tree layer
      createdAt: new Date().toISOString(),
      subtaskId: subtask.id,
      orchestrationContext: `Sub-task dependencies: ${subtask.dependencies.length > 0 ? subtask.dependencies.join(', ') : 'none'}. Verification strictness: ${subtask.verification.level}.`,
    };

    const orchestratorHandoffManager = this._handoffManager ?? new HandoffManager();
    const childSessionId = `${this.sessionId}-fork-${subtask.id}`;

    // 2. Emit spawn event
    this.eventBus.emit({
      type: 'child_session_spawned',
      timestamp: eventNow(),
      parentSessionId: this.sessionId,
      childSessionId,
      subtaskId: subtask.id,
    });

    const skillMessages = [
      `You are executing an orchestrated sub-task. Your specific goal is: ${subtask.description}`,
      `Your file scope is restricted to: ${subtask.fileScope.length > 0 ? subtask.fileScope.join(', ') : 'Any relevant files'}`,
    ];

    try {
      // 3. Delegate child execution to handoff manager (which will spawn a fresh context)
      const executionResult = await orchestratorHandoffManager.executeOrchestratedHandoff({
        manifest: childManifest,
        repoRoot: this.repoRoot,
        client: this.client,
        mode: this.mode,
        memory: this.memory,
        skillMessages,
        bashEnabled: this.bashEnabled,
        maxToolCalls: options?.maxToolCalls ?? this.maxToolCalls,
        maxModelSteps: options?.maxModelSteps ?? this.maxModelSteps,
        maxOutputTokens: this.maxOutputTokens,
        contextBudget: options?.contextBudget ?? this.contextBudget,
        logger: this.logger,
        tracer: this.tracer,
        tokenCounter: this.tokenCounter,
        costTracker: this.costTracker,
        onEvent: (event) => {
          // Do NOT forward child lifecycle events to the parent TUI.
          // Child-internal tool_finished, assistant_message, task_finished, etc.
          // produce noisy ◇ cards and duplicate Result cards. The child's outcome
          // is conveyed via child_session_completed/failed emitted separately on
          // the parent event bus. Only forward critical errors.
          if ((event as import('../agent/events').AgentEvent).type === 'error') {
            this.onEvent?.(event as import('../agent/events').AgentEvent);
          }
        },
      });

      // 4. Map to SubAgentResult and emit completion/failure
      const subResult: import('./types').SubAgentResult = {
        subTaskId: subtask.id,
        terminalState: executionResult.turnResult.terminalState,
        changedFiles: executionResult.turnResult.changedFiles,
        toolCalls: executionResult.turnResult.toolCalls.length,
        error: executionResult.error || executionResult.turnResult.error,
        finalAnswer: executionResult.turnResult.finalAnswer,
      };

      if (executionResult.success) {
        this.eventBus.emit({
          type: 'child_session_completed',
          timestamp: eventNow(),
          parentSessionId: this.sessionId,
          childSessionId,
          subtaskId: subtask.id,
          result: subResult,
        });
      } else {
        this.eventBus.emit({
          type: 'child_session_failed',
          timestamp: eventNow(),
          parentSessionId: this.sessionId,
          childSessionId,
          subtaskId: subtask.id,
          error: executionResult.error ?? 'Unknown child execution failure',
          partialResult: subResult,
        });
      }

      return subResult;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failedResult: import('./types').SubAgentResult = {
        subTaskId: subtask.id,
        terminalState: 'model_error',
        changedFiles: [],
        toolCalls: 0,
        error: errorMessage,
      };

      this.eventBus.emit({
        type: 'child_session_failed',
        timestamp: eventNow(),
        parentSessionId: this.sessionId,
        childSessionId,
        subtaskId: subtask.id,
        error: errorMessage,
        partialResult: failedResult,
      });

      return failedResult;
    }
  }

  /**
   * Estimate the token budget for a task by collecting repository metadata
   * and delegating to the context-budget estimation engine.
   *
   * This is a thin wrapper that:
   * 1. Collects repo metadata (file count, total KB, source KB) via find/du.
   * 2. Delegates to estimateTaskBudget() with the model's context window.
   *
   * Returns a BudgetEstimate with strategy classification and component breakdown.
   */
  async estimateTaskBudget(task: string): Promise<BudgetEstimate> {
    const repoMetadata = await collectRepoMetadata(this.env, this.repoRoot);
    return estimateTaskBudget({
      task,
      repoMetadata,
      contextWindow: this.contextBudget.contextWindowTokens,
      tokenCounter: this.tokenCounter,
    });
  }

  /**
   * Determines if a task requires orchestration based on budget estimation.
   */
  shouldOrchestrate(estimate: BudgetEstimate): boolean {
    return estimate.strategy === 'orchestrate';
  }

  /**
   * Prompts the model to decompose the task, validating and repairing the JSON response.
   * Emits the orchestration_plan_generated event.
   */
  async planOrchestratedTurn(task: string, mode?: 'parallel' | 'sequential'): Promise<PlanParseResult> {
    const repoMetadata = await collectRepoMetadata(this.env, this.repoRoot);

    // Create prompt for decomposition
    const prompt = orchestrationPlanPrompt
      .replace('{{task}}', task)
      .replace('{{repoShape}}', `Files: ${repoMetadata.fileCount}, Total KB: ${Math.ceil(repoMetadata.totalKB)}`);

    // Create system message
    const messages = [{ role: 'system', content: prompt }];

    // Trace the call if tracer is available
    let span: any;
    if (this.tracer) {
      span = this.tracer.startSpan({ kind: 'orchestration' });
    }

    let content = '';

    try {
      const response = await this.client.chat({
        messages,
      });
      content =
        typeof response.content === 'string'
          ? response.content
          : Array.isArray(response.content)
            ? (response.content as any[]).map((c: any) => ('text' in c ? c.text : '')).join('')
            : '';
    } catch {
      // Log safely?
      const fallback: PlanParseResult = { success: false, inline: true };
      this.eventBus.emit({
        type: 'orchestration_plan_generated',
        timestamp: eventNow(),
        payload: { sessionId: this.sessionId, task, plan: { inline: true }, orchestrationMode: mode },
      });
      return fallback;
    }

    const planDefaults: PlanNormalizationDefaults = {
      defaultVerification: this._verificationContract ?? undefined,
      defaultBudget: Math.floor(this.contextBudget.contextWindowTokens / 16),
    };
    const parsed = parseOrchestrationPlan(content, planDefaults);

    this.eventBus.emit({
      type: 'orchestration_plan_generated',
      timestamp: eventNow(),
      payload: {
        sessionId: this.sessionId,
        task,
        plan: parsed.success ? parsed.plan : { inline: true },
        orchestrationMode: mode,
      },
    } as any);

    if (this.tracer && span) {
      span.metadata = {
        success: parsed.success,
        inlineFallback: parsed.success ? !!(parsed.plan as any).inline : true,
      };
      this.tracer.endSpan(span);
    }

    return parsed;
  }

  /** Shutdown the session, emit session_shutdown, and clean up the bus. */
  shutdown(terminalState: TerminalState = 'completed'): void {
    this.eventBus.emit({
      type: 'session_shutdown',
      timestamp: eventNow(),
      terminalState,
    });
    this.eventBus.destroy();
  }

  // ── Recovery-aware turn (primary public API) ──────────────────────────

  /**
   * Execute a turn with automatic recovery from known failure scenarios.
   *
   * Wraps startTurn() in a recovery loop that handles:
   * - Empty model responses → inject nudge + retry
   * - Bash failures → feed stderr back to model
   * - Context exhaustion → inject compaction nudge
   * - Infinite loops → inject steering message
   */
  async startTurnWithRecovery(task: string): Promise<AgentTurnResult> {
    this.recovery.resetForTurn();

    let result = await this.startTurn(task);
    let recoveryAttempt = 0;
    const MAX_RECOVERY_RETRIES = 5;

    while (recoveryAttempt < MAX_RECOVERY_RETRIES) {
      const scenario = classifyResultForRecovery(result);
      if (!scenario) break;

      const recoveryResult = await this.recovery.attemptRecovery({
        scenario,
        conversation: result.conversation as unknown as import('../recovery/types').RecoveryConversation,
        task,
        attempt: recoveryAttempt,
        details: result.error,
        stderr: scenario === 'bash_failure' ? result.error : undefined,
      });

      if (!recoveryResult?.recovered) break;

      // Resume from existing conversation — do NOT push the task again.
      // The recovery manager already injected a nudge into the conversation.
      result = await this.startTurn(task, { skipTaskPush: true });
      recoveryAttempt++;
    }

    return result;
  }

  // ── Core turn loop ──────────────────────────────────────────────────────

  /**
   * Execute one agent turn: take a task, run the model ↔ tool loop until
   * completion, error, budget exhaustion, or handoff.
   */
  async startTurn(task: string, opts?: { skipTaskPush?: boolean }): Promise<AgentTurnResult> {
    const conversation = this.conversation;
    const registry = this.registry;
    const mode = this.mode;
    const bashEnabled = this.bashEnabled;
    const maxToolCalls = this.maxToolCalls;
    let changedFiles: string[] = [];
    let toolCalls: AgentTurnResult['toolCalls'] = [];
    const readCache = new Map<string, ToolResult>();
    const identicalReadCounts = new Map<string, number>();
    const identicalBashCounts = new Map<string, number>();
    let totalReadCalls = 0;
    let totalReadResultTokens = 0;
    const contextBudget = this.contextBudget;
    let consecutiveRecoverableToolErrors = 0;

    // ── Build memory index once per turn (tells model what's searchable) ─
    const memoryIndex = (await this.memory?.buildMemoryIndex()) ?? null;

    // ── Steering: abort before any work ────────────────────────────
    if (this.abortSignal?.aborted) {
      return {
        terminalState: 'blocked',
        finalAnswer: '',
        steps: 0,
        toolCalls,
        changedFiles,
        conversation,
        error: 'turn aborted by user',
      };
    }

    // ── Task guards ────────────────────────────────────────────────────
    const broadTask = guardBroadTask(task);
    if (broadTask) {
      return {
        terminalState: 'blocked',
        finalAnswer: `${broadTask.message}\nSuggested first step: ${broadTask.suggestedFirstStep}`,
        steps: 0,
        toolCalls,
        changedFiles,
        conversation,
        error: broadTask.message,
      };
    }

    const unsupportedTask = guardUnsupportedTask(task, bashEnabled);
    if (unsupportedTask) {
      return {
        terminalState: 'blocked',
        finalAnswer: `${unsupportedTask.message}\nSuggested first step: ${unsupportedTask.suggestedFirstStep}`,
        steps: 0,
        toolCalls,
        changedFiles,
        conversation,
        error: unsupportedTask.message,
      };
    }

    const tools = this.getModelTools();
    if (!opts?.skipTaskPush) {
      conversation.messages.push({ role: 'user', content: task });
    }

    // ── Spans & lifecycle ──────────────────────────────────────────────
    const turnSpan = this.tracer?.startSpan({ kind: 'turn', metadata: { task: task.slice(0, 120) } });
    const turnIndex = conversation.messages.filter((m) => m.role === 'user').length;

    // Memory: store user message with persistent sessionId
    this.memory?.store({
      sessionId: this.sessionId,
      turnId: turnIndex,
      role: 'user',
      content: task.slice(0, 8000),
    });

    this.eventBus.emit({
      type: 'turn_start',
      timestamp: eventNow(),
      stepIndex: turnIndex,
      task: task.slice(0, 200),
    });

    // Session start on first turn
    if (!this._sessionStarted) {
      this._sessionStarted = true;
      this.eventBus.emit({
        type: 'session_start',
        timestamp: eventNow(),
        taskId: undefined,
        mode: this.mode,
        model: 'local',
      });
    }

    let turnResult: AgentTurnResult | undefined;
    let consecutiveContractNudges = 0;
    let consecutiveTruncations = 0;
    const MAX_CONSECUTIVE_CONTRACT_NUDGES = 5;
    try {
      turnResult = await (async (): Promise<AgentTurnResult> => {
        for (let step = 1; step <= this.maxModelSteps; step += 1) {
          if (step % 25 === 0) {
            this.eventBus.emit({
              type: 'command_output',
              timestamp: eventNow(),
              command: 'progress',
              content: `[synax] heartbeat: step=${step}, tool_calls=${toolCalls.length}, changed_files=${changedFiles.length}`,
            });
          }
          // ── Steering: check abort before each model step ──────────
          if (this.abortSignal?.aborted) {
            return {
              terminalState: 'blocked',
              finalAnswer: '',
              steps: step - 1,
              toolCalls,
              changedFiles,
              conversation,
              error: 'turn aborted by user',
            };
          }

          let response: ChatResponse;
          let modelSpan: ReturnType<SpanTracer['startSpan']> | undefined;

          // ── Model call ───────────────────────────────────────────────
          try {
            this.onActivity?.({ kind: 'model', message: `model step ${step}` });
            this.eventBus.emit({
              type: 'model_step_started',
              timestamp: eventNow(),
              stepIndex: step,
            });

            modelSpan =
              this.tracer && turnSpan ? this.tracer.startChildSpan(turnSpan, 'model_call', { step }) : undefined;

            // Preflight budget guard — use assembled model request (includes
            // orientation, memory index, etc.) for accurate estimation.
            const effectiveInputLimit = contextBudget.contextWindowTokens - contextBudget.reservedOutputTokens;
            const preflightAssembled = buildModelRequest(
              conversation,
              contextBudget,
              identicalReadCounts,
              totalReadCalls,
              memoryIndex,
            );
            const estimatedInputTokens = estimateRequestTokens(preflightAssembled);
            // Keep the token ledger in sync with raw conversation messages
            resetTokenLedger(conversation.tokenLedger);
            estimateIncrementalTokens(conversation.messages, conversation.tokenLedger);

            this.onBudget?.({
              estimatedInputTokens,
              inputLimit: effectiveInputLimit,
              contextWindowTokens: contextBudget.contextWindowTokens,
              reservedOutputTokens: contextBudget.reservedOutputTokens,
              step,
            });

            if (estimatedInputTokens > effectiveInputLimit) {
              this.logger?.warn('Context budget near limit before model call', {
                estimatedInputTokens,
                effectiveInputLimit,
                stepIndex: step,
              });
              const guarded = guardModelRequestMultiStage(conversation.messages, contextBudget, conversation);
              if (guarded.error) {
                // ── Handoff path: don't fail-closed, try to recover ──
                const handoffResult = await this.tryHandoffRecovery(
                  guarded.compaction?.stage ?? 4,
                  conversation,
                  step,
                  toolCalls,
                  changedFiles,
                  turnSpan,
                );
                if (handoffResult) return handoffResult;
                // null from tryHandoffRecovery means compaction succeeded — re-check
                const reEstimated = estimateRequestTokens(conversation.messages);
                if (reEstimated <= effectiveInputLimit) continue;

                // No handoff possible — fail closed
                return {
                  terminalState: 'budget_exhausted',
                  finalAnswer: '',
                  steps: step,
                  toolCalls,
                  changedFiles,
                  conversation,
                  error: guarded.error,
                };
              }
              if (guarded.compaction) {
                conversation.latestCompaction = guarded.compaction;
                this.logger?.info('Compaction applied', {
                  stage: guarded.compaction.stage,
                  tokensBefore: guarded.compaction.tokensBefore,
                  tokensAfter: guarded.compaction.tokensAfter,
                  stepIndex: step,
                });

                // ── Proactive handoff: aggressive compaction (stage >= 3) ──────
                // If compaction reached Stage 3 (aggressive summarization), try
                // handoff preemptively. Aggressive compaction degrades context quality,
                // so a child session with fresh context often produces better results.
                if (guarded.compaction.stage >= 3) {
                  this.logger?.info('Aggressive compaction stage reached — attempting preemptive handoff', {
                    stage: guarded.compaction.stage,
                    stepIndex: step,
                  });
                  const preemptiveHandoff = await this.tryHandoffRecovery(
                    guarded.compaction.stage,
                    conversation,
                    step,
                    toolCalls,
                    changedFiles,
                    turnSpan,
                  );
                  if (preemptiveHandoff) return preemptiveHandoff;
                  // Handoff unavailable or failed — continue with compacted context
                }
              }

              const postCompactTokens = estimateRequestTokens(guarded.messages);
              if (postCompactTokens > effectiveInputLimit) {
                const handoffResult = await this.tryHandoffRecovery(
                  4,
                  conversation,
                  step,
                  toolCalls,
                  changedFiles,
                  turnSpan,
                );
                if (handoffResult) return handoffResult;
                // null means compaction succeeded — re-check budget
                const reEstimated2 = estimateRequestTokens(conversation.messages);
                if (reEstimated2 <= effectiveInputLimit) continue;

                return {
                  terminalState: 'budget_exhausted',
                  finalAnswer: '',
                  steps: step,
                  toolCalls,
                  changedFiles,
                  conversation,
                  error: formatContextBudgetError({
                    estimatedInputTokens: postCompactTokens,
                    contextWindowTokens: contextBudget.contextWindowTokens,
                    reservedOutputTokens: contextBudget.reservedOutputTokens,
                    effectiveInputLimit,
                    largestContributors: summarizeLargestContributors(guarded.messages),
                    compactionStage: 4,
                  }),
                };
              }

              const assembled = buildModelRequest(
                conversation,
                contextBudget,
                identicalReadCounts,
                totalReadCalls,
                memoryIndex,
              );
              response = await this.client.chat({
                messages: assembled,
                tools,
                maxTokens: this.maxOutputTokens,
                signal: this.abortSignal,
                onDelta: (delta) => emitAssistantDelta(this, delta),
              });
            } else {
              const assembled = buildModelRequest(
                conversation,
                contextBudget,
                identicalReadCounts,
                totalReadCalls,
                memoryIndex,
              );
              response = await this.client.chat({
                messages: assembled,
                tools,
                maxTokens: this.maxOutputTokens,
                signal: this.abortSignal,
                onDelta: (delta) => emitAssistantDelta(this, delta),
              });
            }
          } catch (error) {
            if (this.tracer && modelSpan) {
              this.tracer.addEvent(modelSpan, 'error', { message: errorMessage(error) });
              this.tracer.endSpan(modelSpan);
            }

            // Re-throw on user abort so the outer catch in handleUserMessage
            // can convert it to a proper 'blocked' / 'turn aborted' result.
            if (this.abortSignal?.aborted) {
              throw error;
            }

            const message = errorMessage(error);
            this.logger?.error('Model call failed', error instanceof Error ? error : new Error(message), {
              stepIndex: step,
              model: 'local',
            });
            return {
              terminalState: message.toLowerCase().includes('context budget') ? 'budget_exhausted' : 'model_error',
              finalAnswer: '',
              steps: step,
              toolCalls,
              changedFiles,
              conversation,
              error: message,
            };
          }

          if (this.tracer && modelSpan) {
            this.tracer.addEvent(modelSpan, 'response_received', {
              toolCallCount: response.toolCalls.length,
              contentLength: response.content.length,
            });
            this.tracer.endSpan(modelSpan);
          }

          // ── Token counting ──────────────────────────────────────────
          let turnTokenStats: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
          if (this.tokenCounter) {
            const assembled = buildModelRequest(
              conversation,
              contextBudget,
              identicalReadCounts,
              totalReadCalls,
              memoryIndex,
            );
            const inputTokens = this.tokenCounter.countInput(assembled);
            const outputTokens = this.tokenCounter.countOutput({
              content: response.content,
              reasoningContent: response.reasoningContent,
              toolCalls: response.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
            });
            turnTokenStats = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
            this.tokenCounter.recordTurn(turnTokenStats);

            if (this.costTracker) {
              const cost = this.costTracker.recordTurn(turnTokenStats);
              this.eventBus.emit({
                type: 'token_usage',
                timestamp: eventNow(),
                stepIndex: step,
                inputTokens: turnTokenStats.inputTokens,
                outputTokens: turnTokenStats.outputTokens,
                estimatedCost: cost.totalCost,
              });

              if (this.maxBudget !== undefined && this.costTracker.isOverBudget(this.maxBudget)) {
                this.logger?.warn('API cost budget exceeded', {
                  cumulativeCost: this.costTracker.getCumulativeCost(),
                  maxBudget: this.maxBudget,
                  stepIndex: step,
                });
                return {
                  terminalState: 'budget_exhausted',
                  finalAnswer: '',
                  steps: step,
                  toolCalls,
                  changedFiles,
                  conversation,
                  error: `API cost budget exceeded: $${this.costTracker.getCumulativeCost().toFixed(4)} > $${this.maxBudget.toFixed(4)}`,
                };
              }
            }
          }

          // ── Tool parsing span ───────────────────────────────────────
          const toolParseSpan =
            this.tracer && turnSpan
              ? this.tracer.startChildSpan(turnSpan, 'tool_parse', { toolCallCount: response.toolCalls.length })
              : undefined;

          this.onActivity?.(formatModelResponseActivity(response, step));
          conversation.messages.push(assistantMessage(response, contextBudget));

          // Memory: store assistant response with persistent sessionId
          this.memory?.store({
            sessionId: this.sessionId,
            turnId: turnIndex,
            role: 'assistant',
            content: response.content.slice(0, 8000),
          });

          // ── Mixed output guard ──────────────────────────────────────
          const visibleContentBeforeToolCalls = assistantVisibleContent(response.content);
          if (response.toolCalls.length > 0 && visibleContentBeforeToolCalls.length > 0) {
            if (!isSafeToolPreamble(visibleContentBeforeToolCalls)) {
              // Local models often mix prose and tool calls. Strip the unsafe prose
              // and proceed with tool execution rather than aborting the turn.
              this.logger?.warn('Model emitted mixed output (prose + tool calls) — stripping prose', {
                stepIndex: step,
                proseLength: visibleContentBeforeToolCalls.length,
                toolCallCount: response.toolCalls.length,
              });
              // REPLACE the just-pushed assistant message (do not push a second
              // one — duplicated tool_calls break strict providers). For
              // content_xml, keep only the tool-call blocks so the model still
              // sees its own call next to the tool_response; for openai format
              // the structured tool_calls field carries the call.
              const xmlBlocks =
                toolCallFormat(response) === 'content_xml'
                  ? (response.content.match(/<tool_call>[\s\S]*?<\/tool_call>/gi)?.join('\n') ?? '')
                  : '';
              conversation.messages[conversation.messages.length - 1] = assistantMessage({
                ...response,
                content: xmlBlocks,
              });
            } else if (toolCallFormat(response) === 'openai') {
              conversation.messages[conversation.messages.length - 1] = assistantMessage({ ...response, content: '' });
            }
          }

          // ── Truncation guard: if response was cut off by output token
          // limit, inject a continuation nudge instead of treating as
          // completion. The model may have been mid-thought or mid-tool-call.
          // Check BEFORE tool-call processing so truncated tool calls are not
          // executed with incomplete arguments.
          if (response.finishReason === 'length') {
            consecutiveTruncations += 1;
            this.logger?.warn('Model output truncated by token limit (finish_reason=length)', {
              stepIndex: step,
              toolCallCount: response.toolCalls.length,
              contentLength: response.content.length,
              consecutiveTruncations,
            });
            // Emit observability event for monitoring truncated responses
            this.eventBus.emit({
              type: 'command_output',
              timestamp: eventNow(),
              command: 'truncation',
              content: `[synax] ⚠️ model output truncated at step ${step} — injecting continuation nudge (${consecutiveTruncations}/${MAX_CONSECUTIVE_TRUNCATIONS})`,
            });
            // Replace the stored assistant message: drop the incomplete tool
            // calls and tool-call markup so strict providers never see an
            // orphaned tool_call (no matching tool result will ever follow).
            conversation.messages[conversation.messages.length - 1] = {
              role: 'assistant',
              content: assistantVisibleContent(response.content),
            };
            if (consecutiveTruncations >= MAX_CONSECUTIVE_TRUNCATIONS) {
              return {
                terminalState: 'model_error',
                finalAnswer: finalAnswerFromResponse(response),
                reasoningContent: response.reasoningContent,
                steps: step,
                toolCalls,
                changedFiles,
                conversation,
                error: `model output truncated ${consecutiveTruncations} times in a row (finish_reason=length); increase provider maxOutputTokens or narrow the task`,
              };
            }
            // Inject a continuation nudge so the model can continue from where it was cut off.
            // Do NOT execute any tool calls from this response — their arguments may be truncated.
            conversation.messages.push({
              role: 'user',
              content:
                '[synax] Your previous response was cut off by the output token limit. Continue from where you stopped, in smaller pieces. If you were emitting a tool call, re-emit it with complete arguments; for large file writes, split the work into multiple smaller edit/write calls.',
            });
            continue;
          }
          consecutiveTruncations = 0;

          // ── No tool calls → completion ──────────────────────────────
          if (response.toolCalls.length === 0) {
            if (this.tracer && toolParseSpan) {
              this.tracer.endSpan(toolParseSpan);
            }

            // ── Verification contract check: before claiming completion,
            // verify the contract is satisfied. Resolve from mode if not set.
            const contract = this._verificationContract ??
              (mode === 'verify' ? { level: 'verification_passed' as const, label: 'Verification passed' } :
               mode === 'patch' ? { level: 'files_changed' as const, label: 'Files changed' } :
               { level: 'none' as const, label: 'No verification required' });
            if (contract.level !== 'none') {
              const nudge = checkCompletionAgainstContract(
                contract,
                {
                  changedFiles,
                  verificationRan: false,
                  responseContent: response.content,
                },
                'completed',
              );
              if (nudge) {
                consecutiveContractNudges += 1;
                if (consecutiveContractNudges > MAX_CONSECUTIVE_CONTRACT_NUDGES) {
                  this.logger?.warn('Verification contract nudge limit exceeded, accepting completion', {
                    stepIndex: step,
                    mode,
                    contractLevel: contract.level,
                  });
                  return {
                    terminalState: 'completed',
                    finalAnswer: finalAnswerFromResponse(response),
                    reasoningContent: response.reasoningContent,
                    steps: step,
                    toolCalls,
                    changedFiles,
                    conversation,
                  };
                }
                conversation.messages.push({ role: 'user', content: nudge });
                this.logger?.info('Verification contract not satisfied, injecting nudge', {
                  stepIndex: step,
                  mode,
                  contractLevel: contract.level,
                  changedFiles: changedFiles.length,
                });
                continue;
              }
            }

            return {
              terminalState: 'completed',
              finalAnswer: finalAnswerFromResponse(response),
              reasoningContent: response.reasoningContent,
              steps: step,
              toolCalls,
              changedFiles,
              conversation,
            };
          }

          if (this.tracer && toolParseSpan) {
            this.tracer.endSpan(toolParseSpan);
          }

          // ── Tool execution loop (extracted) ──────────────────────────────────────
          const toolResult = await this.executeToolCalls({
            response,
            step,
            turnIndex,
            mode,
            turnSpan,
            contextBudget,
            readCache,
            identicalReadCounts,
            identicalBashCounts,
            totalReadCalls,
            totalReadResultTokens,
            memoryIndex,
            registry,
            toolCalls,
            changedFiles,
            conversation,
            consecutiveRecoverableToolErrors,
            maxToolCalls,
          });
          if (toolResult.terminalResult) return toolResult.terminalResult;
          toolCalls = toolResult.toolCalls;
          changedFiles = toolResult.changedFiles;
          consecutiveRecoverableToolErrors = toolResult.consecutiveRecoverableToolErrors;
          totalReadCalls = toolResult.totalReadCalls;
          totalReadResultTokens = toolResult.totalReadResultTokens;
          const contentToolResults = toolResult.contentToolResults;

          flushContentToolResults(conversation, response, contentToolResults);

          // ── Tool calls were made → reset the contract nudge counter
          consecutiveContractNudges = 0;

          // ── Steering: inject queued message after tool call results ──
          const steeringInject = this.onSteeringCheck?.();
          if (steeringInject) {
            conversation.messages.push({ role: 'user', content: steeringInject });
            // Memory: store steering injection
            this.memory?.store({
              sessionId: this.sessionId,
              turnId: turnIndex,
              role: 'user',
              content: `[steering] ${steeringInject.slice(0, 8000)}`,
            });
            this.eventBus.emit({
              type: 'command_output',
              timestamp: eventNow(),
              command: 'steering',
              content: `[synax] steering injected: ${steeringInject.slice(0, 120)}`,
            });
          }
        }
        // Loop exhausted without returning — max steps hit
        return {
          terminalState: 'budget_exhausted',
          finalAnswer: '',
          steps: this.maxModelSteps,
          toolCalls,
          changedFiles,
          conversation,
          error: `max model steps exceeded: ${this.maxModelSteps}`,
        };
      })();
      return turnResult;
    } finally {
      this.eventBus.emit({
        type: 'turn_end',
        timestamp: eventNow(),
        stepIndex: turnIndex,
        terminalState: turnResult?.terminalState ?? 'model_error',
        toolCalls: turnResult?.toolCalls?.length ?? 0,
        steps: turnResult?.steps ?? 0,
      });
      if (this.tracer && turnSpan) {
        this.tracer.endSpan(turnSpan);
      }
    }
  }

  /**
   * Execute all tool calls from a model response.
   *
   * Iterates over response.toolCalls, executing each via the ActionExecutor,
   * recording results, checking abort signals and budget, and classifying errors.
   * Returns a terminal result on failure/exhaustion, or signals continuation
   * by returning terminalResult: undefined (caller must then flush content tool
   * results and handle steering injection).
   */
  private async executeToolCalls(options: {
    response: ChatResponse;
    step: number;
    turnIndex: number;
    mode: RunMode;
    turnSpan: ReturnType<SpanTracer['startChildSpan']> | undefined;
    contextBudget: ContextBudgetSettings;
    readCache: Map<string, ToolResult>;
    identicalReadCounts: Map<string, number>;
    identicalBashCounts: Map<string, number>;
    totalReadCalls: number;
    totalReadResultTokens: number;
    memoryIndex: string | null;
    registry: ToolRegistry;
    toolCalls: AgentTurnResult['toolCalls'];
    changedFiles: string[];
    conversation: AgentConversation;
    consecutiveRecoverableToolErrors: number;
    maxToolCalls: number;
  }): Promise<{
    terminalResult?: AgentTurnResult;
    toolCalls: AgentTurnResult['toolCalls'];
    changedFiles: string[];
    consecutiveRecoverableToolErrors: number;
    totalReadCalls: number;
    totalReadResultTokens: number;
    contentToolResults: Array<{ id: string; content: string }>;
    conversation: AgentConversation;
  }> {
    // ── Tool execution loop ─────────────────────────────────────
    const contentToolResults: Array<{ id: string; content: string }> = [];

    // Keep paste_context_range tool informed of the last user message
    const lastUserMsg = resolveLastUserMessageText(options.conversation);
    if (lastUserMsg !== null) {
      options.registry.setLastUserMessage(lastUserMsg);
    }

    for (const call of options.response.toolCalls) {
      // ── Steering: check abort before each tool call ─────────
      if (this.abortSignal?.aborted) {
        return {
          terminalResult: {
            terminalState: 'blocked',
            finalAnswer: finalAnswerFromResponse(options.response),
            reasoningContent: options.response.reasoningContent,
            steps: options.step,
            toolCalls: options.toolCalls,
            changedFiles: options.changedFiles,
            conversation: options.conversation,
            error: 'turn aborted by user',
          },
          toolCalls: options.toolCalls,
          changedFiles: options.changedFiles,
          consecutiveRecoverableToolErrors: options.consecutiveRecoverableToolErrors,
          totalReadCalls: options.totalReadCalls,
          totalReadResultTokens: options.totalReadResultTokens,
          contentToolResults,
          conversation: options.conversation,
        };
      }
      const toolExecSpan =
        this.tracer && options.turnSpan
          ? this.tracer.startChildSpan(options.turnSpan, 'tool_execution', { toolName: call.name })
          : undefined;

      // Hard-stop on tool-call count to prevent runaway loops.
      if (options.toolCalls.length >= options.maxToolCalls) {
        this.logger?.warn('Max tool calls reached', {
          max: options.maxToolCalls,
          stepIndex: options.step,
        });
        return {
          terminalResult: {
            terminalState: 'budget_exhausted',
            finalAnswer: '',
            reasoningContent: options.response.reasoningContent,
            steps: options.step,
            toolCalls: options.toolCalls,
            changedFiles: options.changedFiles,
            conversation: options.conversation,
            error: `max tool calls exceeded: ${options.maxToolCalls}`,
          },
          toolCalls: options.toolCalls,
          changedFiles: options.changedFiles,
          consecutiveRecoverableToolErrors: options.consecutiveRecoverableToolErrors,
          totalReadCalls: options.totalReadCalls,
          totalReadResultTokens: options.totalReadResultTokens,
          contentToolResults,
          conversation: options.conversation,
        };
      }

      this.onActivity?.({
        kind: 'tool',
        message: describeToolCall(call.name, call.arguments as Record<string, unknown>),
      });
      this.logger?.debug('Executing tool', {
        toolName: call.name,
        args: JSON.stringify(call.arguments).slice(0, 500),
        stepIndex: options.step,
      });
      this.eventBus.emit({
        type: 'tool_started',
        timestamp: eventNow(),
        stepIndex: options.step,
        toolCallId: call.id,
        toolName: call.name,
        summary: JSON.stringify(call.arguments),
        detail: JSON.stringify(call.arguments, null, 2),
      });

      // Lifecycle: tool_execution_start
      this.eventBus.emit({
        type: 'tool_execution_start',
        timestamp: eventNow(),
        stepIndex: options.step,
        toolCallId: call.id,
        toolName: call.name,
        arguments: call.arguments as Record<string, unknown>,
      });

      // Control hook: pre_tool_use
      const preToolDecision = await this.eventBus.emitControl({
        type: 'pre_tool_use',
        timestamp: eventNow(),
        stepIndex: options.step,
        toolCallId: call.id,
        toolName: call.name,
        arguments: call.arguments as Record<string, unknown>,
      });

      if (preToolDecision.allow === false) {
        this.logger?.warn('Tool call blocked by pre_tool_use hook', {
          toolName: call.name,
          reason: preToolDecision.reason,
          stepIndex: options.step,
        });
        if (this.tracer && toolExecSpan) {
          this.tracer.addEvent(toolExecSpan, 'tool_blocked', { reason: preToolDecision.reason });
          this.tracer.endSpan(toolExecSpan);
        }
        this.eventBus.emit({
          type: 'tool_execution_end',
          timestamp: eventNow(),
          stepIndex: options.step,
          toolCallId: call.id,
          toolName: call.name,
          success: false,
          error: `Blocked by pre_tool_use hook: ${preToolDecision.reason}`,
        });
        continue;
      }

      const result = await this.executor.execute(
        call,
        {
          repoRoot: this.repoRoot,
          registry: options.registry,
          ledger: options.conversation.inspectionLedger,
          mode: options.mode,
          env: this.env,
          readCache: options.readCache,
          identicalReadCounts: options.identicalReadCounts,
          totalReadCalls: options.totalReadCalls,
          totalReadResultTokens: options.totalReadResultTokens,
          readResultBudget: options.contextBudget,
          ensureCheckpoint: this.ensureCheckpoint,
          approvePatch: this.approvePatch,
          onPatchPreview: (preview) => {
            this.eventBus.emit({
              type: 'patch_preview',
              timestamp: eventNow(),
              stepIndex: options.step,
              toolCallId: call.id,
              toolName: call.name,
              ...preview,
            });
          },
          memory: this.memory,
        },
        options.identicalBashCounts,
      );

      if (call.name === 'read') {
        options.totalReadCalls += 1;
        // Cache hits re-surface content already paid for this turn — do not
        // double-charge the per-turn read budget for them.
        if (!result.fromCache) {
          options.totalReadResultTokens += estimateReadResultTokens(result.toolResult);
        }
      }
      // Invalidate read cache on any successful mutation so subsequent
      // reads return fresh content (prevents stale-read→edit mismatch loops).
      // edit/write definitely changed a file; bash may have changed anything.
      // Clearing the whole cache is the safest default — re-reads are cheap
      // relative to a stale-read edit loop.
      if (result.success && (call.name === 'edit' || call.name === 'write' || call.name === 'bash')) {
        options.readCache.clear();
      }
      options.toolCalls.push({
        name: call.name,
        success: result.success,
        error: result.error,
      });
      if (options.toolCalls.length % 100 === 0) {
        this.eventBus.emit({
          type: 'command_output',
          timestamp: eventNow(),
          command: 'progress',
          content: `[synax] heartbeat: tool_calls=${options.toolCalls.length}, step=${options.step}, changed_files=${options.changedFiles.length}`,
        });
      }
      appendToolResult(
        options.conversation,
        options.response,
        call,
        result.toolResult,
        contentToolResults,
        options.contextBudget,
      );

      // If view_image succeeded, inject a user message with the actual
      // image_url content block so vision-capable models can "see" it.
      const imageMsg = tryBuildImageViewMessage(result.toolResult);
      if (imageMsg) {
        options.conversation.messages.push(imageMsg);
        this.memory?.store({
          sessionId: this.sessionId,
          turnId: options.turnIndex,
          role: 'user',
          toolName: 'view_image',
          content: '(image content block)',
        });
      }

      // Memory: store tool result with persistent sessionId
      this.memory?.store({
        sessionId: this.sessionId,
        turnId: options.turnIndex,
        role: 'tool',
        toolName: call.name,
        filePaths: result.changedFile ? [result.changedFile] : undefined,
        content: JSON.stringify(result.toolResult).slice(0, 8000),
      });

      this.eventBus.emit({
        type: 'tool_finished',
        timestamp: eventNow(),
        stepIndex: options.step,
        toolCallId: call.id,
        toolName: call.name,
        status: result.success ? 'ok' : 'error',
        summary: result.success ? 'completed' : (result.error ?? 'failed'),
        detail: formatToolResultDetail(result.toolResult),
      });

      this.eventBus.emit({
        type: 'tool_execution_end',
        timestamp: eventNow(),
        stepIndex: options.step,
        toolCallId: call.id,
        toolName: call.name,
        success: result.success,
        error: result.error,
      });

      if (result.changedFile) options.changedFiles.push(result.changedFile);

      if (this.tracer && toolExecSpan) {
        this.tracer.addEvent(toolExecSpan, 'tool_finished', { success: result.success, error: result.error });
        this.tracer.endSpan(toolExecSpan);
      }

      // ── Post-tool budget check ───────────────────────────────
      const afterToolMessages = buildModelRequest(
        options.conversation,
        options.contextBudget,
        options.identicalReadCounts,
        options.totalReadCalls,
        options.memoryIndex,
      );
      const afterToolTokens = estimateRequestTokens(afterToolMessages);
      const effectiveLimit = options.contextBudget.contextWindowTokens - options.contextBudget.reservedOutputTokens;
      if (afterToolTokens > effectiveLimit) {
        flushContentToolResults(options.conversation, options.response, contentToolResults);
        this.logger?.warn('Context budget exhausted after tool result', {
          estimatedInputTokens: afterToolTokens,
          effectiveInputLimit: effectiveLimit,
          toolName: call.name,
          stepIndex: options.step,
        });

        const handoffResult = await this.tryHandoffRecovery(
          4,
          options.conversation,
          options.step,
          options.toolCalls,
          options.changedFiles,
          options.turnSpan,
        );
        if (handoffResult) {
          return {
            terminalResult: handoffResult,
            toolCalls: options.toolCalls,
            changedFiles: options.changedFiles,
            consecutiveRecoverableToolErrors: options.consecutiveRecoverableToolErrors,
            totalReadCalls: options.totalReadCalls,
            totalReadResultTokens: options.totalReadResultTokens,
            contentToolResults,
            conversation: options.conversation,
          };
        }

        return {
          terminalResult: {
            terminalState: 'budget_exhausted',
            finalAnswer: finalAnswerFromResponse(options.response),
            reasoningContent: options.response.reasoningContent,
            steps: options.step,
            toolCalls: options.toolCalls,
            changedFiles: options.changedFiles,
            conversation: options.conversation,
            error: formatContextBudgetError({
              estimatedInputTokens: afterToolTokens,
              contextWindowTokens: options.contextBudget.contextWindowTokens,
              reservedOutputTokens: options.contextBudget.reservedOutputTokens,
              effectiveInputLimit: effectiveLimit,
              largestContributors: summarizeLargestContributors(afterToolMessages),
              compactionStage: 0,
            }),
          },
          toolCalls: options.toolCalls,
          changedFiles: options.changedFiles,
          consecutiveRecoverableToolErrors: options.consecutiveRecoverableToolErrors,
          totalReadCalls: options.totalReadCalls,
          totalReadResultTokens: options.totalReadResultTokens,
          contentToolResults,
          conversation: options.conversation,
        };
      }

      // ── Error recovery classification ────────────────────────
      if (result.success) {
        options.consecutiveRecoverableToolErrors = 0;
      } else if (isPolicyRefusal(call, result)) {
        // Intentional, bounded policy denial (e.g., per-turn read cap).
        // Recoverable, but does NOT count toward the consecutive-error kill
        // switch: a batch of parallel reads issued after the cap would
        // otherwise terminate the turn and discard all completed analysis.
        // Runaway loops remain bounded by maxToolCalls and the read-loop
        // detector.
        this.onActivity?.({
          kind: 'tool',
          message: `policy refusal (not counted toward error limit): ${call.name} ${describeToolCall(call.name, call.arguments as Record<string, unknown>)} — ${result.error ?? 'unknown'}`,
        });
        continue;
      } else if (isRecoverableToolError(call, result)) {
        options.consecutiveRecoverableToolErrors += 1;
        this.onActivity?.({
          kind: 'tool',
          message: `recoverable error ${options.consecutiveRecoverableToolErrors}/${MAX_CONSECUTIVE_RECOVERABLE_TOOL_ERRORS}: ${call.name} ${describeToolCall(call.name, call.arguments as Record<string, unknown>)} — ${result.error ?? 'unknown'}`,
        });
        if (options.consecutiveRecoverableToolErrors < MAX_CONSECUTIVE_RECOVERABLE_TOOL_ERRORS) {
          continue;
        }
        flushContentToolResults(options.conversation, options.response, contentToolResults);
        return {
          terminalResult: {
            terminalState: 'tool_error',
            finalAnswer: finalAnswerFromResponse(options.response),
            reasoningContent: options.response.reasoningContent,
            steps: options.step,
            toolCalls: options.toolCalls,
            changedFiles: options.changedFiles,
            conversation: options.conversation,
            error: `too many consecutive recoverable tool errors: ${MAX_CONSECUTIVE_RECOVERABLE_TOOL_ERRORS}`,
          },
          toolCalls: options.toolCalls,
          changedFiles: options.changedFiles,
          consecutiveRecoverableToolErrors: options.consecutiveRecoverableToolErrors,
          totalReadCalls: options.totalReadCalls,
          totalReadResultTokens: options.totalReadResultTokens,
          contentToolResults,
          conversation: options.conversation,
        };
      } else {
        flushContentToolResults(options.conversation, options.response, contentToolResults);
        return {
          terminalResult: {
            terminalState: result.terminalState ?? 'tool_error',
            finalAnswer: finalAnswerFromResponse(options.response),
            reasoningContent: options.response.reasoningContent,
            steps: options.step,
            toolCalls: options.toolCalls,
            changedFiles: options.changedFiles,
            conversation: options.conversation,
            error: result.error,
          },
          toolCalls: options.toolCalls,
          changedFiles: options.changedFiles,
          consecutiveRecoverableToolErrors: options.consecutiveRecoverableToolErrors,
          totalReadCalls: options.totalReadCalls,
          totalReadResultTokens: options.totalReadResultTokens,
          contentToolResults,
          conversation: options.conversation,
        };
      }
    }

    // Loop completed normally -- no terminal result
    return {
      terminalResult: undefined,
      toolCalls: options.toolCalls,
      changedFiles: options.changedFiles,
      consecutiveRecoverableToolErrors: options.consecutiveRecoverableToolErrors,
      totalReadCalls: options.totalReadCalls,
      totalReadResultTokens: options.totalReadResultTokens,
      contentToolResults,
      conversation: options.conversation,
    };
  }

  // ── Handoff recovery ────────────────────────────────────────────────────

  /**
   * Attempt to recover from context exhaustion via handoff.
   *
   * Two strategies (tried in order):
   * 1. Child session spawning via HandoffManager — fresh context + FTS5 inheritance.
   * 2. Context compaction — inject handoff manifest, continue loop.
   *
   * Returns a terminal result if child spawning succeeds (child IS the final answer),
   * null to continue the loop with compacted context, or fails-closed.
   */
  private async tryHandoffRecovery(
    stage: number,
    conversation: AgentConversation,
    step: number,
    _toolCalls: AgentTurnResult['toolCalls'],
    _changedFiles: string[],
    turnSpan?: ReturnType<SpanTracer['startSpan']>,
  ): Promise<AgentTurnResult | null> {
    // ── Strategy 1: Child session spawning via HandoffManager ──────────
    if (this._handoffManager?.canHandoff()) {
      this.logger?.info('Attempting handoff via child session spawning', {
        stage,
        stepIndex: step,
        depth: this._handoffManager ? 'available' : 'unavailable',
      });

      try {
        const handoffResult = await this._handoffManager.tryHandoff({
          parentSession: this,
          reason: 'context_exhaustion',
          task:
            (this.conversation.messages.find((m) => m.role === 'user')?.content
              ? extractTextContent(this.conversation.messages.find((m) => m.role === 'user')!.content!)
              : undefined) ?? 'Complete the task',
          filesChanged: _changedFiles,
          filesRead: conversation.inspectionLedger.getInspectedRanges().map((r) => r.path),
          contextWindowUsed: estimateIncrementalTokens(conversation.messages, conversation.tokenLedger),
          repoRoot: this.repoRoot,
          client: this.client,
          mode: this.mode,
          bashEnabled: this.bashEnabled,
          maxOutputTokens: this.maxOutputTokens,
          contextBudget: this.contextBudget,
          onEvent: (event) => {
            if (this.onEvent) {
              this.onEvent(event as import('../agent/events').AgentEvent);
            }
          },
        });

        if (handoffResult && handoffResult.success) {
          this.logger?.info('Handoff child session completed successfully', {
            childSteps: handoffResult.turnResult.steps,
            childToolCalls: handoffResult.turnResult.toolCalls.length,
            childFilesChanged: handoffResult.turnResult.changedFiles.length,
          });

          // Merge child's changed files and tool calls into the result
          const mergedChangedFiles = [..._changedFiles, ...handoffResult.turnResult.changedFiles];
          const mergedToolCalls = [..._toolCalls, ...handoffResult.turnResult.toolCalls];

          if (this.tracer && turnSpan) {
            this.tracer.addEvent(turnSpan, 'handoff_child_completed', {
              childSteps: handoffResult.turnResult.steps,
              childFilesChanged: handoffResult.turnResult.changedFiles.length,
            });
          }

          return {
            terminalState: handoffResult.turnResult.terminalState,
            finalAnswer: handoffResult.turnResult.finalAnswer,
            steps: step + handoffResult.turnResult.steps,
            toolCalls: mergedToolCalls,
            changedFiles: mergedChangedFiles,
            conversation: handoffResult.turnResult.conversation,
            error: handoffResult.turnResult.error,
          };
        }

        if (handoffResult && !handoffResult.success) {
          this.logger?.warn('Handoff child session failed, falling back to compaction', {
            error: handoffResult.error,
            childTerminalState: handoffResult.turnResult.terminalState,
          });
        }
      } catch (error) {
        this.logger?.error(
          'Handoff child session error, falling back to compaction',
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    // ── Strategy 2: Context compaction (existing behavior) ────────────
    const manifest = this.memory?.handoff();
    if (!manifest) {
      this.logger?.warn('Handoff recovery not possible — no memory available', { stage, stepIndex: step });
      return null;
    }

    // If memory has no key findings, supplement from conversation messages.
    // This ensures handoff still works when memory hasn't indexed enough content.
    if (manifest.keyFindings.length === 0) {
      this.logger?.info('Memory manifest has no key findings — extracting from conversation', {
        stage,
        stepIndex: step,
        turnCount: manifest.turnCount,
        filesTouched: manifest.filesTouched.length,
      });

      // Extract from recent substantive assistant messages
      for (const msg of conversation.messages) {
        if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.length > 30) {
          manifest.keyFindings.push(msg.content.trim().slice(0, 800));
          if (manifest.keyFindings.length >= 5) break;
        }
      }

      // If still empty, add task context from the most recent user message
      if (manifest.keyFindings.length === 0) {
        const lastUserMsg = [...conversation.messages]
          .reverse()
          .find((m) => m.role === 'user' && !extractTextContent(m.content).startsWith('Context was compacted'));
        if (lastUserMsg && typeof lastUserMsg.content === 'string') {
          manifest.keyFindings.push(`Task: ${lastUserMsg.content.slice(0, 500)}`);
        }
      }
    }

    this.logger?.info('Attempting handoff recovery via context compaction', {
      stage,
      stepIndex: step,
      turnCount: manifest.turnCount,
      entryCount: manifest.entryCount,
      filesTouched: manifest.filesTouched.length,
      searchTerms: manifest.suggestedSearchTerms.length,
    });

    // Compact conversation to: system prompt + handoff manifest + last 2 user/assistant turns
    const compactContext = buildHandoffContext(conversation.messages, manifest);

    // Replace conversation messages with compacted context
    conversation.messages.splice(0, conversation.messages.length, ...compactContext);
    resetTokenLedger(conversation.tokenLedger);
    conversation.latestCompaction = {
      type: 'compaction',
      stage,
      summary: `Handoff recovery — ${manifest.turnCount} turns, ${manifest.entryCount} entries, ${manifest.filesTouched.length} files`,
      firstKeptEntryId: 'handoff',
      tokensBefore: 0,
      tokensAfter: estimateRequestTokens(compactContext),
      createdAt: new Date().toISOString(),
    };

    // Emit compaction event
    this.eventBus.emit({
      type: 'session_compact',
      timestamp: eventNow(),
      stepIndex: step,
      stage,
      tokensBefore: 0,
      tokensAfter: estimateRequestTokens(compactContext),
      messagesBefore: 0,
      messagesAfter: compactContext.length,
    });

    if (this.tracer && turnSpan) {
      this.tracer.addEvent(turnSpan, 'handoff_recovery', {
        stage,
        manifestTurnCount: manifest.turnCount,
        filesTouched: manifest.filesTouched.length,
      });
    }

    // Return null to signal "continue the loop" — the caller should NOT return this
    // as a terminal result. Instead, the turn loop will continue with compacted context.
    return null;
  }
}

// ─── Handoff context builder ─────────────────────────────────────────────────

/**
 * Build a compact conversation context from a handoff manifest.
 *
 * Preserves: system prompt + handoff manifest + last 2 user/assistant exchanges.
 * Drops all intermediate tool results and old turns.
 */
function buildHandoffContext(messages: AgentMessage[], manifest: HandoffManifest): AgentMessage[] {
  const result: AgentMessage[] = [];

  // 1. Keep the system prompt
  if (messages.length > 0 && messages[0].role === 'system') {
    result.push(messages[0]);
  }

  // 2. Inject handoff manifest as a system message
  const handoffLines: string[] = [
    '## Session Handoff — Previous Context Summary',
    '',
    `**Turns completed:** ${manifest.turnCount}`,
    `**Entries stored:** ${manifest.entryCount}`,
    '',
    '### Key Findings',
    ...manifest.keyFindings.map((f) => `- ${f}`),
    '',
    '### Files Touched',
    ...manifest.filesTouched.map((f) => `- ${f}`),
    '',
    '### Suggested Search Terms',
    `Use \`search_memory\` with: ${manifest.suggestedSearchTerms.slice(0, 8).join(', ')}`,
    '',
    'Continue from where the previous context left off. Use search_memory to retrieve details.',
  ];

  result.push({
    role: 'system',
    content: handoffLines.join('\n'),
  });

  // 3. Keep the last 2 user-assistant exchanges (user + assistant pairs)
  let userCount = 0;
  const kept: AgentMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && userCount < 2; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && !extractTextContent(msg.content).startsWith('## Session Handoff')) {
      userCount++;
    }
    kept.unshift(msg);
  }

  // Filter kept messages: only user and assistant, no tool results
  for (const msg of kept) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      result.push(msg);
    }
  }

  // Add a continuation nudge
  result.push({
    role: 'user',
    content:
      'Context was compacted to fit the budget. Review the Handoff Summary above. ' +
      'Use search_memory to retrieve specific details from earlier turns. Continue the task.',
  });

  return result;
}

// ─── Session ID generation ───────────────────────────────────────────────────

let globalSessionCounter = 0;

function generatePersistentSessionId(): string {
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  const dd = now.getDate().toString().padStart(2, '0');
  const hh = now.getHours().toString().padStart(2, '0');
  const min = now.getMinutes().toString().padStart(2, '0');
  const ss = now.getSeconds().toString().padStart(2, '0');
  const ms = now.getMilliseconds().toString().padStart(3, '0');
  const pid = process.pid.toString(36);
  const rand = randomBytes(4).toString('hex');
  globalSessionCounter += 1;
  return `syn-${yyyy}${mm}${dd}-${hh}${min}${ss}${ms}-${pid}-${rand}-${globalSessionCounter}`;
}

// ─── Repo metadata collection ─────────────────────────────────────────────────

/**
 * Collect repository metadata for budget estimation.
 *
 * Uses find/du commands via the ExecutionEnv to count files and measure sizes,
 * excluding common non-source directories (node_modules, .git, dist, build).
 */
async function collectRepoMetadata(
  env: import('../env/ExecutionEnv').ExecutionEnv,
  repoRoot: string,
): Promise<import('../agent/context-budget').RepoMetadata> {
  // Count all tracked files (excluding node_modules, .git, dist, build)
  const fileCountResult = await env.execCommand(
    `find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/.cache/*' -not -path '*/coverage/*' 2>/dev/null | wc -l`,
    repoRoot,
    { timeout: 10000 },
  );
  const fileCount = parseInt(fileCountResult.stdout.trim(), 10) || 0;

  // Get total KB of all tracked files
  const totalKBResult = await env.execCommand(
    `find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/.cache/*' -not -path '*/coverage/*' 2>/dev/null -exec du -sk {} + 2>/dev/null | awk '{sum+=$1} END {print sum+0}'`,
    repoRoot,
    { timeout: 10000 },
  );
  const totalKB = parseInt(totalKBResult.stdout.trim(), 10) || 0;

  // Get KB of source files only
  const sourceKBResult = await env.execCommand(
    `find . -type f \\( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.py' -o -name '*.rs' -o -name '*.go' -o -name '*.java' -o -name '*.rb' -o -name '*.c' -o -name '*.cpp' -o -name '*.h' -o -name '*.css' -o -name '*.html' -o -name '*.json' -o -name '*.yaml' -o -name '*.yml' -o -name '*.toml' -o -name '*.md' \\) -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/.cache/*' -not -path '*/coverage/*' 2>/dev/null -exec du -sk {} + 2>/dev/null | awk '{sum+=$1} END {print sum+0}'`,
    repoRoot,
    { timeout: 10000 },
  );
  const sourceKB = parseInt(sourceKBResult.stdout.trim(), 10) || 0;

  return { fileCount, totalKB, sourceKB };
}
