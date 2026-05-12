/**
 * Session — agent lifecycle orchestrator.
 *
 * Owns: config, tools, memory (SQLite+FTS5), EventBus, hooks.
 * Lifecycle: boot → trustGate → ready → running → shutdown.
 *
 * Delegates turn execution, message assembly, formatting, tool definitions,
 * and verification to focused modules. This file is the wiring layer.
 */

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
import { orchestrationPlanPrompt } from '../agent/prompts/orchestration-plan';
import { parseOrchestrationPlan } from '../orchestration/plan-parser';
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
  emitAssistantDelta,
  errorMessage,
} from './formatting';

import { buildModelRequest, guardModelRequestMultiStage, classifyResultForRecovery } from './message-assembly';

import { resolveVerificationContract, checkCompletionAgainstContract } from './verification-contracts';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOOL_CALLS = 192;
const MAX_CONSECUTIVE_RECOVERABLE_TOOL_ERRORS = 3;

// ─── Agent event type guard ──────────────────────────────────────────────────

/**
 * Set of event type strings that belong to the public AgentEvent discriminated
 * union (src/agent/events.ts). Internal EventBus lifecycle events are excluded.
 */
const AGENT_EVENT_TYPES: Set<string> = new Set([
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
  'assistant_delta',
  'task_finished',
  'error',
  'token_usage',
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
  }) {
    this.repoRoot = options.repoRoot;
    this.client = options.client;
    this.mode = options.mode ?? 'patch';
    this.maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    this.maxModelSteps = options.maxModelSteps ?? 64;
    this.bashEnabled = options.bashEnabled ?? true;
    this.env = options.env ?? new NodeExecutionEnv();
    this.sessionId = options.sessionId ?? generatePersistentSessionId();

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
  static createConversation(options: { skillMessages?: string[] } = {}): AgentConversation {
    const messages: AgentMessage[] = [{ role: 'system', content: systemPrompt() }];
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
    const messages: AgentMessage[] = [{ role: 'system', content: systemPrompt() }];
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
    // Exclude builtins that are already provided by registry to allow overrides,
    // and exclude inspection tools (read/write/edit/bash) which are already in builtins.
    const customTools = registryTools.filter(t => 
      !builtins.find(b => b.name === t.name) && 
      !['read', 'write', 'edit', 'bash', 'search_memory', 'view_image'].includes(t.name)
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
    return (estimate.strategy as string) === 'orchestrated';
  }

  /**
   * Prompts the model to decompose the task, validating and repairing the JSON response.
   * Emits the orchestration_plan_generated event.
   */
  async planOrchestratedTurn(task: string): Promise<PlanParseResult> {
    const repoMetadata = await collectRepoMetadata(this.env, this.repoRoot);
    
    // Create prompt for decomposition
    const prompt = orchestrationPlanPrompt
      .replace('{{task}}', task)
      .replace('{{repoShape}}', `Files: ${repoMetadata.fileCount}, Total KB: Math.ceil(${(repoMetadata as any).totalSizeBytes || (repoMetadata as any).totalSizeKb || 0} / 1024)`);
      
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
      content = typeof response.content === 'string' 
        ? response.content 
        : Array.isArray(response.content) 
          ? (response.content as any[]).map((c: any) => 'text' in c ? c.text : '').join('')
          : '';
    } catch (error) {
       // Log safely?
       const fallback: PlanParseResult = { success: false, inline: true };
       this.eventBus.emit({
         type: 'orchestration_plan_generated',
         timestamp: eventNow(),
         payload: { sessionId: this.sessionId, task, plan: { inline: true } }
       });
       return fallback;
    }
        
    const parsed = parseOrchestrationPlan(content);
    
    this.eventBus.emit({
      type: 'orchestration_plan_generated',
      timestamp: Date.now(),
      payload: {
        sessionId: this.sessionId,
        task,
        plan: parsed.success ? parsed.plan : { inline: true }
      }
    } as any);

    if (this.tracer && span) {
      span.metadata = { 
         success: parsed.success, 
         inlineFallback: parsed.success ? !!(parsed.plan as any).inline : true 
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
    const MAX_RECOVERY_RETRIES = 2;

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

      result = await this.startTurn(task);
      recoveryAttempt++;
    }

    return result;
  }

  // ── Core turn loop ──────────────────────────────────────────────────────

  /**
   * Execute one agent turn: take a task, run the model ↔ tool loop until
   * completion, error, budget exhaustion, or handoff.
   */
  async startTurn(task: string): Promise<AgentTurnResult> {
    const conversation = this.conversation;
    const registry = this.registry;
    const mode = this.mode;
    const bashEnabled = this.bashEnabled;
    const maxToolCalls = this.maxToolCalls;
    const changedFiles: string[] = [];
    const toolCalls: AgentTurnResult['toolCalls'] = [];
    let verificationNudgeInjected = false;
    const readCache = new Map<string, ToolResult>();
    const identicalReadCounts = new Map<string, number>();
    const identicalBashCounts = new Map<string, number>();
    let totalReadCalls = 0;
    let totalReadResultTokens = 0;
    const contextBudget = this.contextBudget;
    let consecutiveRecoverableToolErrors = 0;

    // ── Build memory index once per turn (tells model what's searchable) ─
    const memoryIndex = this.memory?.buildMemoryIndex() ?? null;

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

    const tools = buildModelFacingTools({ bashEnabled, mode });
    conversation.messages.push({ role: 'user', content: task });

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
    try {
      turnResult = await (async (): Promise<AgentTurnResult> => {
        for (let step = 1; step <= this.maxModelSteps; step += 1) {
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

            // Preflight budget guard
            const effectiveInputLimit = contextBudget.contextWindowTokens - contextBudget.reservedOutputTokens;
            const estimatedInputTokens = estimateRequestTokens(conversation.messages);
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
                temperature: 0,
                maxTokens: 2048,
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
                temperature: 0,
                maxTokens: 2048,
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
          if (response.toolCalls.length > 0 && response.content.trim().length > 0) {
            if (!isSafeToolPreamble(response.content)) {
              return {
                terminalState: 'model_error',
                finalAnswer: response.content.trim(),
                steps: step,
                toolCalls,
                changedFiles,
                conversation,
                error: 'model emitted ambiguous mixed output (tool calls plus final text)',
              };
            }

            if (toolCallFormat(response) === 'openai') {
              conversation.messages[conversation.messages.length - 1] = assistantMessage({ ...response, content: '' });
            }
          }

          // ── No tool calls → completion ──────────────────────────────
          if (response.toolCalls.length === 0) {
            if (this.tracer && toolParseSpan) {
              this.tracer.endSpan(toolParseSpan);
            }

            // Verification contract check — only enforce when the model has already
            // attempted mutation tool calls (write, edit). Read-only investigations
            // and pure-content first-step completions are accepted as-is.
            // Inject the nudge at most once per turn.
            const hasMutationAttempts = toolCalls.some((tc) => tc.name === 'write' || tc.name === 'edit');
            if (hasMutationAttempts && !verificationNudgeInjected) {
              const contract = this._verificationContract ?? resolveVerificationContract(mode);
              const nudge = checkCompletionAgainstContract(
                contract,
                { changedFiles, verificationRan: false },
                'completed',
              );
              if (nudge) {
                verificationNudgeInjected = true;
                conversation.messages.push({ role: 'user', content: nudge });
                continue;
              }
            }

            return {
              terminalState: 'completed',
              finalAnswer: response.content.trim(),
              steps: step,
              toolCalls,
              changedFiles,
              conversation,
            };
          }

          if (this.tracer && toolParseSpan) {
            this.tracer.endSpan(toolParseSpan);
          }

          // ── Tool execution loop ─────────────────────────────────────
          const contentToolResults: Array<{ id: string; content: string }> = [];
          for (const call of response.toolCalls) {
            // ── Steering: check abort before each tool call ─────────
            if (this.abortSignal?.aborted) {
              return {
                terminalState: 'blocked',
                finalAnswer: response.content.trim(),
                steps: step,
                toolCalls,
                changedFiles,
                conversation,
                error: 'turn aborted by user',
              };
            }
            const toolExecSpan =
              this.tracer && turnSpan
                ? this.tracer.startChildSpan(turnSpan, 'tool_execution', { toolName: call.name })
                : undefined;

            if (toolCalls.length >= maxToolCalls) {
              if (this.tracer && toolExecSpan) {
                this.tracer.addEvent(toolExecSpan, 'max_tool_calls_exceeded', { limit: maxToolCalls });
                this.tracer.endSpan(toolExecSpan);
              }
              this.eventBus.emit({
                type: 'tool_execution_end',
                timestamp: eventNow(),
                stepIndex: step,
                toolCallId: call.id,
                toolName: call.name,
                success: false,
                error: `max tool calls exceeded: ${maxToolCalls}`,
              });
              this.logger?.warn('Max tool calls exceeded', {
                current: toolCalls.length,
                limit: maxToolCalls,
                stepIndex: step,
              });
              return {
                terminalState: 'budget_exhausted',
                finalAnswer: response.content.trim(),
                steps: step,
                toolCalls,
                changedFiles,
                conversation,
                error: `max tool calls exceeded: ${maxToolCalls}`,
              };
            }

            this.onActivity?.({
              kind: 'tool',
              message: describeToolCall(call.name, call.arguments as Record<string, unknown>),
            });
            this.logger?.debug('Executing tool', {
              toolName: call.name,
              args: JSON.stringify(call.arguments).slice(0, 500),
              stepIndex: step,
            });
            this.eventBus.emit({
              type: 'tool_started',
              timestamp: eventNow(),
              stepIndex: step,
              toolCallId: call.id,
              toolName: call.name,
              summary: JSON.stringify(call.arguments).slice(0, 180),
              detail: JSON.stringify(call.arguments, null, 2),
            });

            // Lifecycle: tool_execution_start
            this.eventBus.emit({
              type: 'tool_execution_start',
              timestamp: eventNow(),
              stepIndex: step,
              toolCallId: call.id,
              toolName: call.name,
              arguments: call.arguments as Record<string, unknown>,
            });

            // Control hook: pre_tool_use
            const preToolDecision = await this.eventBus.emitControl({
              type: 'pre_tool_use',
              timestamp: eventNow(),
              stepIndex: step,
              toolCallId: call.id,
              toolName: call.name,
              arguments: call.arguments as Record<string, unknown>,
            });

            if (preToolDecision.allow === false) {
              this.logger?.warn('Tool call blocked by pre_tool_use hook', {
                toolName: call.name,
                reason: preToolDecision.reason,
                stepIndex: step,
              });
              if (this.tracer && toolExecSpan) {
                this.tracer.addEvent(toolExecSpan, 'tool_blocked', { reason: preToolDecision.reason });
                this.tracer.endSpan(toolExecSpan);
              }
              this.eventBus.emit({
                type: 'tool_execution_end',
                timestamp: eventNow(),
                stepIndex: step,
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
                registry,
                ledger: conversation.inspectionLedger,
                mode,
                env: this.env,
                readCache,
                identicalReadCounts,
                totalReadCalls,
                totalReadResultTokens,
                readResultBudget: contextBudget,
                ensureCheckpoint: this.ensureCheckpoint,
                approvePatch: this.approvePatch,
                onPatchPreview: (preview) => {
                  this.eventBus.emit({
                    type: 'patch_preview',
                    timestamp: eventNow(),
                    stepIndex: step,
                    toolCallId: call.id,
                    toolName: call.name,
                    ...preview,
                  });
                },
                memory: this.memory,
              },
              identicalBashCounts,
            );

            if (call.name === 'read') {
              totalReadCalls += 1;
              totalReadResultTokens += estimateReadResultTokens(result.toolResult);
            }
            toolCalls.push({
              name: call.name,
              success: result.success,
              error: result.error,
            });
            appendToolResult(conversation, response, call, result.toolResult, contentToolResults, contextBudget);

            // Memory: store tool result with persistent sessionId
            this.memory?.store({
              sessionId: this.sessionId,
              turnId: turnIndex,
              role: 'tool',
              toolName: call.name,
              filePaths: result.changedFile ? [result.changedFile] : undefined,
              content: JSON.stringify(result.toolResult).slice(0, 8000),
            });

            this.eventBus.emit({
              type: 'tool_finished',
              timestamp: eventNow(),
              stepIndex: step,
              toolCallId: call.id,
              toolName: call.name,
              status: result.success ? 'ok' : 'error',
              summary: result.success ? 'completed' : (result.error ?? 'failed'),
              detail: formatToolResultDetail(result.toolResult),
            });

            this.eventBus.emit({
              type: 'tool_execution_end',
              timestamp: eventNow(),
              stepIndex: step,
              toolCallId: call.id,
              toolName: call.name,
              success: result.success,
              error: result.error,
            });

            if (result.changedFile) changedFiles.push(result.changedFile);

            if (this.tracer && toolExecSpan) {
              this.tracer.addEvent(toolExecSpan, 'tool_finished', { success: result.success, error: result.error });
              this.tracer.endSpan(toolExecSpan);
            }

            // ── Post-tool budget check ───────────────────────────────
            const afterToolMessages = buildModelRequest(
              conversation,
              contextBudget,
              identicalReadCounts,
              totalReadCalls,
              memoryIndex,
            );
            const afterToolTokens = estimateRequestTokens(afterToolMessages);
            const effectiveLimit = contextBudget.contextWindowTokens - contextBudget.reservedOutputTokens;
            if (afterToolTokens > effectiveLimit) {
              flushContentToolResults(conversation, response, contentToolResults);
              this.logger?.warn('Context budget exhausted after tool result', {
                estimatedInputTokens: afterToolTokens,
                effectiveInputLimit: effectiveLimit,
                toolName: call.name,
                stepIndex: step,
              });

              const handoffResult = await this.tryHandoffRecovery(
                4,
                conversation,
                step,
                toolCalls,
                changedFiles,
                turnSpan,
              );
              if (handoffResult) return handoffResult;

              return {
                terminalState: 'budget_exhausted',
                finalAnswer: response.content.trim(),
                steps: step,
                toolCalls,
                changedFiles,
                conversation,
                error: formatContextBudgetError({
                  estimatedInputTokens: afterToolTokens,
                  contextWindowTokens: contextBudget.contextWindowTokens,
                  reservedOutputTokens: contextBudget.reservedOutputTokens,
                  effectiveInputLimit: effectiveLimit,
                  largestContributors: summarizeLargestContributors(afterToolMessages),
                  compactionStage: 0,
                }),
              };
            }

            // ── Error recovery classification ────────────────────────
            if (result.success) {
              consecutiveRecoverableToolErrors = 0;
            } else if (isRecoverableToolError(call, result)) {
              consecutiveRecoverableToolErrors += 1;
              this.onActivity?.({
                kind: 'tool',
                message: `recoverable error ${consecutiveRecoverableToolErrors}/${MAX_CONSECUTIVE_RECOVERABLE_TOOL_ERRORS}: ${call.name} ${describeToolCall(call.name, call.arguments as Record<string, unknown>)} — ${result.error ?? 'unknown'}`,
              });
              if (consecutiveRecoverableToolErrors < MAX_CONSECUTIVE_RECOVERABLE_TOOL_ERRORS) {
                continue;
              }
              flushContentToolResults(conversation, response, contentToolResults);
              return {
                terminalState: 'tool_error',
                finalAnswer: response.content.trim(),
                steps: step,
                toolCalls,
                changedFiles,
                conversation,
                error: `too many consecutive recoverable tool errors: ${MAX_CONSECUTIVE_RECOVERABLE_TOOL_ERRORS}`,
              };
            } else {
              flushContentToolResults(conversation, response, contentToolResults);
              return {
                terminalState: result.terminalState ?? 'tool_error',
                finalAnswer: response.content.trim(),
                steps: step,
                toolCalls,
                changedFiles,
                conversation,
                error: result.error,
              };
            }
          }
          flushContentToolResults(conversation, response, contentToolResults);

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
          task: this.conversation.messages.find((m) => m.role === 'user')?.content ?? 'Complete the task',
          filesChanged: _changedFiles,
          filesRead: conversation.inspectionLedger.getInspectedRanges().map((r) => r.path),
          contextWindowUsed: estimateIncrementalTokens(conversation.messages, conversation.tokenLedger),
          repoRoot: this.repoRoot,
          client: this.client,
          mode: this.mode,
          bashEnabled: this.bashEnabled,
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
    if (!manifest || manifest.keyFindings.length === 0) {
      this.logger?.warn('Handoff recovery not possible — no memory available', { stage, stepIndex: step });
      return null;
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
    if (msg.role === 'user' && !msg.content.startsWith('## Session Handoff')) {
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
  const rand = Math.random().toString(36).slice(2, 6);
  globalSessionCounter += 1;
  return `syn-${yyyy}${mm}${dd}-${hh}${min}${ss}-${rand}-${globalSessionCounter}`;
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
