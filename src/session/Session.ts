import { type Logger } from '../logging/index.js';
import { EventBus } from '../events/index';
import type { HolographicMemory } from '../memory/HolographicMemory';
import type { SpanTracer } from '../telemetry/SpanTracer';
import type { TokenCounter } from '../metrics/TokenCounter';
import type { CostTracker } from '../metrics/CostTracker';
import { type ChatOptions, type ChatResponse } from '../llm/types';
import { type ParsedToolCall } from '../llm/tool-calls';
import { createInspectionLedger, createToolRegistry, type InspectionLedger } from '../tools';
import { type ToolDefinition, type ToolRegistry, type ToolResult } from '../tools/types';
import { type PatchPreview } from '../agent/patch';
import {
  assembleModelMessages,
  compactMessagesMultiStage,
  createTokenLedger,
  estimateIncrementalTokens,
  estimateRequestTokens,
  estimateTokens,
  formatContextBudgetError,
  resolveContextBudgetSettings,
  resetTokenLedger,
  summarizeLargestContributors,
  truncateForTokenBudget,
  type AssemblyStats,
  type CompactionRecord,
  type ContextBudgetSettings,
  type TokenLedger,
} from '../agent/context-budget';
import { eventNow, type AgentEvent, type TerminalState } from '../agent/events';
import {
  describeToolCall,
  guardBroadTask,
  guardUnsupportedTask,
  getAllowedModelTools,
  type RunMode,
} from '../agent/task-policy';
import { ActionExecutor, createDefaultHandlerMap } from '../actions/ActionExecutor';
import { estimateReadResultTokens } from '../actions/handlers/read-handler';
import { NodeExecutionEnv } from '../env/NodeExecutionEnv';
import type { ExecutionEnv } from '../env/ExecutionEnv';
import { RecoveryManager } from '../recovery/RecoveryManager';

// Re-export types for backward compatibility with runner.ts consumers.
export type AgentTerminalState = TerminalState;

export interface AgentMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: unknown;
  /** Provider-specific reasoning field required by DeepSeek thinking-mode continuation requests. */
  reasoning_content?: string;
  // Internal markers for compaction integrity (not serialized to the model).
  _tool_call_ids?: string[];
  _tool_result_ids?: string[];
}

export interface AgentClient {
  chat(options: ChatOptions): Promise<ChatResponse>;
}

export interface AgentConversation {
  messages: AgentMessage[];
  inspectionLedger: InspectionLedger;
  latestCompaction: CompactionRecord | null;
  tokenLedger: TokenLedger;
  assemblyStats: AssemblyStats | null;
}

export interface AgentRunnerOptions {
  repoRoot: string;
  client: AgentClient;
  maxSteps?: number;
  maxToolCalls?: number;
  mode?: RunMode;
  tools?: ModelToolSurfaceOptions;
  conversation?: AgentConversation;
  registry?: ToolRegistry;
  onActivity?: (activity: AgentActivity) => void;
  onEvent?: (event: AgentEvent) => void;
  onBudget?: (snapshot: AgentBudgetSnapshot) => void;
  approvePatch?: (preview: PatchPreview) => PatchApprovalDecision | Promise<PatchApprovalDecision>;
  ensureCheckpoint?: () => Promise<unknown>;
  /** Optional preloaded skill instructions injected as additional system messages. */
  skillMessages?: string[];
  contextBudget?: Partial<ContextBudgetSettings> & { contextBudgetTokens?: number };
  /** Optional structured logger for internal diagnostics. */
  logger?: Logger;
  /** Optional span tracer for telemetry instrumentation. */
  tracer?: SpanTracer;
  /** Optional token counter for per-turn usage metrics. */
  tokenCounter?: TokenCounter;
  /** Optional cost tracker for API cost estimation. */
  costTracker?: CostTracker;
  /** Maximum API cost budget (stops agent when exceeded). */
  maxBudget?: number;
}

export interface ModelToolSurfaceOptions {
  bashEnabled?: boolean;
  mode?: RunMode;
}

export interface AgentActivity {
  kind: 'model' | 'tool' | 'model_response';
  message: string;
  /** Raw model output for debugging local-model behavior. Only set when kind === 'model_response'. */
  modelOutput?: string;
  toolCallCount?: number;
}

export interface AgentBudgetSnapshot {
  estimatedInputTokens: number;
  inputLimit: number;
  contextWindowTokens: number;
  reservedOutputTokens: number;
  step: number;
  compactionStage?: number;
}

export type PatchApprovalDecision = 'accept' | 'reject';

export interface AgentTurnResult {
  terminalState: AgentTerminalState;
  finalAnswer: string;
  steps: number;
  toolCalls: Array<{ name: string; success: boolean; error?: string }>;
  changedFiles: string[];
  conversation: AgentConversation;
  error?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOOL_CALLS = 192;
const MAX_CONSECUTIVE_RECOVERABLE_TOOL_ERRORS = 3;
const MAX_TOTAL_READS_PER_TURN = 24;

// ─── Session Class ───────────────────────────────────────────────────────────

/**
 * Session owns the agent lifecycle: conversation state, tool registry,
 * and turn orchestration. Extracted from runner.ts to kill the God Object.
 *
 * ```ts
 * const session = new Session({ repoRoot: '/project', client });
 * const result = await session.startTurn('fix the build');
 * ```
 */
export class Session {
  readonly conversation: AgentConversation;
  readonly registry: ToolRegistry;
  private repoRoot: string;
  private client: AgentClient;
  private maxToolCalls: number;
  private mode: RunMode;
  private bashEnabled: boolean;
  private contextBudget: ContextBudgetSettings;
  // Public so helper functions can emit events through the session reference.
  onActivity?: (activity: AgentActivity) => void;
  onEvent?: (event: AgentEvent) => void;
  onBudget?: (snapshot: AgentBudgetSnapshot) => void;
  approvePatch?: (preview: PatchPreview) => PatchApprovalDecision | Promise<PatchApprovalDecision>;
  ensureCheckpoint?: () => Promise<unknown>;
  /** Optional structured logger for internal diagnostics. */
  logger?: Logger;
  /** Optional span tracer for telemetry instrumentation. */
  tracer?: SpanTracer;
  /** Optional token counter for per-turn usage metrics. */
  tokenCounter?: TokenCounter;
  /** Optional cost tracker for API cost estimation. */
  costTracker?: CostTracker;
  /** Maximum API cost budget (stops agent when exceeded). */
  maxBudget?: number;
  /** Typed EventBus with lifecycle and control hooks. */
  readonly eventBus: EventBus = new EventBus();
  /** Typed tool dispatch — extracted from the old executeAgentTool switch. */
  readonly executor: ActionExecutor;
  /** Filesystem and process abstraction — swappable for testing/sandboxing. */
  readonly env: ExecutionEnv;
  /** Holographic memory — FTS5 semantic store, set externally. */
  memory: HolographicMemory | null = null;
  /** Recovery manager — applies recovery recipes on failure scenarios. */
  readonly recovery: RecoveryManager = new RecoveryManager();
  /** Track whether session_start has been emitted. */
  private _sessionStarted = false;

  constructor(options: {
    repoRoot: string;
    client: AgentClient;
    mode?: RunMode;
    maxToolCalls?: number;
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
  }) {
    this.repoRoot = options.repoRoot;
    this.client = options.client;
    this.mode = options.mode ?? 'patch';
    this.maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    this.bashEnabled = options.bashEnabled ?? true;
    this.env = options.env ?? new NodeExecutionEnv();
    this.onActivity = options.onActivity;
    this.onEvent = options.onEvent;
    this.onBudget = options.onBudget;
    this.approvePatch = options.approvePatch;
    this.ensureCheckpoint = options.ensureCheckpoint;
    this.logger = options.logger;
    this.tracer = options.tracer;
    this.tokenCounter = options.tokenCounter;
    this.costTracker = options.costTracker;
    this.maxBudget = options.maxBudget;

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
    return buildModelFacingTools({ bashEnabled: this.bashEnabled, mode: this.mode });
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

  // ── Recovery-aware turn ────────────────────────────────────────────────

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

      // Apply the injected nudge and retry the turn
      result = await this.startTurn(task);
      recoveryAttempt++;
    }

    return result;
  }

  // ── Core turn loop ──────────────────────────────────────────────────────

  /**
   * Execute one agent turn: take a task, run the model ↔ tool loop until
   * completion, error, or budget exhaustion.
   */
  async startTurn(task: string): Promise<AgentTurnResult> {
    const conversation = this.conversation;
    const registry = this.registry;
    const mode = this.mode;
    const bashEnabled = this.bashEnabled;
    const maxToolCalls = this.maxToolCalls;
    const changedFiles: string[] = [];
    const toolCalls: AgentTurnResult['toolCalls'] = [];
    const readCache = new Map<string, ToolResult>();
    const identicalReadCounts = new Map<string, number>();
    const identicalBashCounts = new Map<string, number>();
    let totalReadCalls = 0;
    let totalReadResultTokens = 0;
    const contextBudget = this.contextBudget;
    let consecutiveRecoverableToolErrors = 0;

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

    // Start a turn-level span for this agent run.
    const turnSpan = this.tracer?.startSpan({ kind: 'turn', metadata: { task: task.slice(0, 120) } });

    // Lifecycle: emit turn_start
    const turnIndex = conversation.messages.filter((m) => m.role === 'user').length;

    // Memory: store user message (fire-and-forget)
    const memSessionId = `mem-${Date.now()}`;
    this.memory?.store({
      sessionId: memSessionId,
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
        for (let step = 1; ; step += 1) {
          let response: ChatResponse;
          let modelSpan: ReturnType<SpanTracer['startSpan']> | undefined;
          try {
            this.onActivity?.({ kind: 'model', message: `model step ${step}` });
            this.onEvent?.({
              type: 'model_step_started',
              timestamp: eventNow(),
              stepIndex: step,
            });

            // Span: model call
            modelSpan =
              this.tracer && turnSpan ? this.tracer.startChildSpan(turnSpan, 'model_call', { step }) : undefined;

            // Preflight budget guard
            const effectiveInputLimit = contextBudget.contextWindowTokens - contextBudget.reservedOutputTokens;
            const estimatedInputTokens = estimateIncrementalTokens(conversation.messages, conversation.tokenLedger);

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

              const assembled = buildModelRequest(conversation, contextBudget, identicalReadCounts, totalReadCalls);

              response = await this.client.chat({
                messages: assembled,
                tools,
                temperature: 0,
                maxTokens: 2048,
                onDelta: (delta) => emitAssistantDelta(this, delta),
              });
            } else {
              const assembled = buildModelRequest(conversation, contextBudget, identicalReadCounts, totalReadCalls);
              response = await this.client.chat({
                messages: assembled,
                tools,
                temperature: 0,
                maxTokens: 2048,
                onDelta: (delta) => emitAssistantDelta(this, delta),
              });
            }
          } catch (error) {
            // End model call span on error
            if (this.tracer && modelSpan) {
              this.tracer.addEvent(modelSpan, 'error', { message: errorMessage(error) });
              this.tracer.endSpan(modelSpan);
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

          // End model call span
          if (this.tracer && modelSpan) {
            this.tracer.addEvent(modelSpan, 'response_received', {
              toolCallCount: response.toolCalls.length,
              contentLength: response.content.length,
            });
            this.tracer.endSpan(modelSpan);
          }

          // ── Token counting and cost tracking ──
          let turnTokenStats: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
          if (this.tokenCounter) {
            const assembled = buildModelRequest(conversation, contextBudget, identicalReadCounts, totalReadCalls);
            const inputTokens = this.tokenCounter.countInput(assembled);
            const outputTokens = this.tokenCounter.countOutput({
              content: response.content,
              reasoningContent: response.reasoningContent,
              toolCalls: response.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
            });
            turnTokenStats = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
            this.tokenCounter.recordTurn(turnTokenStats);

            // Estimate cost
            if (this.costTracker) {
              const cost = this.costTracker.recordTurn(turnTokenStats);
              this.onEvent?.({
                type: 'token_usage',
                timestamp: eventNow(),
                stepIndex: step,
                inputTokens: turnTokenStats.inputTokens,
                outputTokens: turnTokenStats.outputTokens,
                estimatedCost: cost.totalCost,
              } as AgentEvent);

              // Budget check
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

          // Span: tool parsing
          const toolParseSpan =
            this.tracer && turnSpan
              ? this.tracer.startChildSpan(turnSpan, 'tool_parse', { toolCallCount: response.toolCalls.length })
              : undefined;

          this.onActivity?.(formatModelResponseActivity(response, step));

          conversation.messages.push(assistantMessage(response, contextBudget));

          // Memory: store assistant response (fire-and-forget)
          this.memory?.store({
            sessionId: memSessionId,
            turnId: turnIndex,
            role: 'assistant',
            content: response.content.slice(0, 8000),
          });

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

          if (response.toolCalls.length === 0) {
            // End tool parse span (no tool calls to execute)
            if (this.tracer && toolParseSpan) {
              this.tracer.endSpan(toolParseSpan);
            }

            if (mode === 'patch' && changedFiles.length === 0 && isPrematureCompletionClaim(response.content)) {
              conversation.messages.push({
                role: 'user',
                content:
                  'You claimed completion without taking action. ' +
                  'Use available tools (bash for git/commands, edit for file changes, write for new files) to complete the task. ' +
                  'If no action is needed, explain specifically why. Do not just say "verified" or "passed" — show evidence.',
              });
              continue;
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

          // End tool parse span (after parsing checks, before tool loop)
          if (this.tracer && toolParseSpan) {
            this.tracer.endSpan(toolParseSpan);
          }

          const contentToolResults: Array<{ id: string; content: string }> = [];
          for (const call of response.toolCalls) {
            // Span: tool execution
            const toolExecSpan =
              this.tracer && turnSpan
                ? this.tracer.startChildSpan(turnSpan, 'tool_execution', {
                    toolName: call.name,
                  })
                : undefined;
            if (toolCalls.length >= maxToolCalls) {
              // End tool execution span before returning
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
            this.onEvent?.({
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

            // Control hook: pre_tool_use — can block dangerous tool calls
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
              // End tool execution span if started
              if (this.tracer && toolExecSpan) {
                this.tracer.addEvent(toolExecSpan, 'tool_blocked', { reason: preToolDecision.reason });
                this.tracer.endSpan(toolExecSpan);
              }
              // Emit tool_execution_end as blocked
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
                  this.onEvent?.({
                    type: 'patch_preview',
                    timestamp: eventNow(),
                    stepIndex: step,
                    toolCallId: call.id,
                    toolName: call.name,
                    ...preview,
                  });
                },
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
            // Memory: store tool result (fire-and-forget)
            this.memory?.store({
              sessionId: memSessionId,
              turnId: turnIndex,
              role: 'tool',
              toolName: call.name,
              filePaths: result.changedFile ? [result.changedFile] : undefined,
              content: JSON.stringify(result.toolResult).slice(0, 8000),
            });
            this.onEvent?.({
              type: 'tool_finished',
              timestamp: eventNow(),
              stepIndex: step,
              toolCallId: call.id,
              toolName: call.name,
              status: result.success ? 'ok' : 'error',
              summary: result.success ? 'completed' : (result.error ?? 'failed'),
              detail: formatToolResultDetail(result.toolResult),
            });
            // Lifecycle: tool_execution_end
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

            // End tool execution span
            if (this.tracer && toolExecSpan) {
              this.tracer.addEvent(toolExecSpan, 'tool_finished', {
                success: result.success,
                error: result.error,
              });
              this.tracer.endSpan(toolExecSpan);
            }

            const afterToolMessages = buildModelRequest(
              conversation,
              contextBudget,
              identicalReadCounts,
              totalReadCalls,
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
        }
      })();
      return turnResult;
    } finally {
      // Lifecycle: emit turn_end
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
}

// ─── Model-facing tool definitions ───────────────────────────────────────────

function buildModelFacingTools(options: ModelToolSurfaceOptions = {}): ToolDefinition[] {
  const bashEnabled = options.bashEnabled ?? true;
  const allowedNames = getAllowedModelTools(options.mode ?? 'patch', bashEnabled);
  const tools: ToolDefinition[] = [
    {
      name: 'read',
      description:
        'Inspect repository files. ALWAYS use startLine/endLine (50-200 line ranges preferred). Omit path to list files. Pass query to search text.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Optional repo-relative file or directory path.',
          },
          startLine: {
            type: 'number',
            description: '1-based first line. ALWAYS set this for file reads — never read entire large files.',
          },
          endLine: {
            type: 'number',
            description: '1-based final line. Set with startLine for a 50-200 line window.',
          },
          query: {
            type: 'string',
            description: 'Literal text to search for.',
          },
          maxFiles: {
            type: 'number',
            description: 'Maximum listed files.',
          },
          maxMatches: {
            type: 'number',
            description: 'Maximum search matches.',
          },
        },
        additionalProperties: false,
      },
      safetyPolicy: {
        readOnly: true,
        rejectsUnsafePaths: true,
        boundedOutput: true,
      },
      ledgerBehavior: 'records-file-range',
      async execute() {
        return {
          success: false,
          toolName: 'read',
          error: 'handled by the agent runner',
        };
      },
    },
    {
      name: 'write',
      description: 'Create one new repo-local text file. Fails if the file already exists.',
      inputSchema: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: {
            type: 'string',
            description: 'Repo-relative path for the new file.',
          },
          content: {
            type: 'string',
            description: 'Full file content to write.',
          },
        },
        additionalProperties: false,
      },
      safetyPolicy: {
        readOnly: false,
        rejectsUnsafePaths: true,
        boundedOutput: true,
      },
      ledgerBehavior: 'none',
      async execute() {
        return {
          success: false,
          toolName: 'write',
          error: 'handled by the agent runner',
        };
      },
    },
    {
      name: 'edit',
      description:
        'Replace exactly one string in one repo-local file. The target file must already have been read. oldStr must match exactly once.',
      inputSchema: {
        type: 'object',
        required: ['path', 'oldStr', 'newStr'],
        properties: {
          path: { type: 'string', description: 'Repo-relative file path.' },
          oldStr: {
            type: 'string',
            description: 'Exact text copied from a prior file read.',
          },
          newStr: { type: 'string', description: 'Replacement text.' },
        },
        additionalProperties: false,
      },
      safetyPolicy: {
        readOnly: false,
        rejectsUnsafePaths: true,
        boundedOutput: true,
      },
      ledgerBehavior: 'none',
      async execute() {
        return {
          success: false,
          toolName: 'edit',
          error: 'handled by the agent runner',
        };
      },
    },
  ];

  if (bashEnabled) {
    tools.push({
      name: 'bash',
      description: 'Execute a shell command in the repository root. Use for git workflows and verification commands.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to run when enabled.',
          },
        },
        additionalProperties: false,
      },
      safetyPolicy: {
        readOnly: false,
        rejectsUnsafePaths: true,
        boundedOutput: true,
      },
      ledgerBehavior: 'none',
      async execute() {
        return {
          success: false,
          toolName: 'bash',
          error: 'handled by the agent runner',
        };
      },
    });
  }

  return tools.filter((tool) => allowedNames.includes(tool.name));
}

// ─── Inline helpers (moved from runner.ts) ───────────────────────────────────

function emitAssistantDelta(session: Session, delta: { content?: string; reasoningContent?: string }): void {
  if (!delta.content && !delta.reasoningContent) return;
  const event = {
    type: 'assistant_delta' as const,
    timestamp: eventNow(),
    content: delta.content,
    reasoningContent: delta.reasoningContent,
  };
  session.eventBus.emit(event);
  session.onEvent?.(event);
}

function assistantMessage(response: ChatResponse, settings?: ContextBudgetSettings): AgentMessage {
  const maxOutputTokens = settings?.reservedOutputTokens ?? 8192;
  const maxOutputChars = Math.max(200, Math.floor(maxOutputTokens * 3));
  let content = response.content;
  if (content.length > maxOutputChars) {
    content = content.slice(0, maxOutputChars) + '\n[response truncated]';
  }
  const reasoningContent = response.reasoningContent?.trim();
  const reasoningFields = reasoningContent ? { reasoning_content: reasoningContent } : {};

  if (toolCallFormat(response) === 'content_xml') {
    return {
      role: 'assistant',
      content,
      ...reasoningFields,
      _tool_call_ids: response.toolCalls.map((c) => c.id),
    };
  }

  const message: AgentMessage = {
    role: 'assistant',
    content,
    ...reasoningFields,
  };
  if (response.toolCalls.length > 0) {
    message.tool_calls = response.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
  }
  return message;
}

function isRecoverableToolError(call: ParsedToolCall, result: { success: boolean; error?: string }): boolean {
  if (result.success) return false;
  if (call.name === 'bash') return !isBashLoopError(result.error);
  if (call.name === 'edit' || call.name === 'replace_in_file') return isEditRecoverableError(result.error);
  if (call.name !== 'read') return false;
  return isEnoentError(result.error) || isReadPolicyLimitError(result.error);
}

function isEnoentError(error: string | undefined): boolean {
  return error !== undefined && /\bENOENT\b/.test(error);
}

function isReadPolicyLimitError(error: string | undefined): boolean {
  if (error === undefined) return false;
  return error.includes('total read limit reached') || error.includes('Read loop detected');
}

function isBashLoopError(error: string | undefined): boolean {
  return error !== undefined && error.includes('Bash loop detected');
}

function isEditRecoverableError(error: string | undefined): boolean {
  if (error === undefined) return false;
  return error.includes('oldStr no longer matches') || error.includes('oldStr must match exactly once');
}

function toolResultMessage(call: ParsedToolCall, content: string): AgentMessage {
  return {
    role: 'tool',
    tool_call_id: call.id,
    name: call.name,
    content,
  };
}

function contentToolResultMessage(entries: Array<{ id: string; content: string }>): AgentMessage {
  return {
    role: 'user',
    content: entries.map((e) => `<tool_response>\n${e.content}\n</tool_response>`).join('\n'),
    _tool_result_ids: entries.map((e) => e.id),
  };
}

function appendToolResult(
  conversation: AgentConversation,
  response: ChatResponse,
  call: ParsedToolCall,
  toolResult: ToolResult,
  contentToolResults: Array<{ id: string; content: string }>,
  settings: ContextBudgetSettings,
): void {
  let content = JSON.stringify(toolResult);
  const estimated = estimateTokens(content);
  if (estimated > settings.maxSingleReadResultTokens) {
    const truncated = truncateForTokenBudget(content, settings.maxSingleReadResultTokens);
    content = truncated.text;
  }

  if (toolCallFormat(response) === 'content_xml') {
    contentToolResults.push({ id: call.id, content });
    flushContentToolResults(conversation, response, contentToolResults);
    return;
  }
  conversation.messages.push(toolResultMessage(call, content));
}

function flushContentToolResults(
  conversation: AgentConversation,
  response: ChatResponse,
  contentToolResults: Array<{ id: string; content: string }>,
): void {
  if (toolCallFormat(response) !== 'content_xml' || contentToolResults.length === 0) return;
  conversation.messages.push(contentToolResultMessage(contentToolResults));
  contentToolResults.splice(0, contentToolResults.length);
}

function toolCallFormat(response: ChatResponse): NonNullable<ChatResponse['toolCallFormat']> {
  return response.toolCallFormat ?? 'openai';
}

function formatToolResultDetail(toolResult: ToolResult): string {
  const output = toolResult.output;
  if (!output || typeof output !== 'object') {
    return toolResult.error ?? JSON.stringify(toolResult);
  }
  const record = output as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof record.command === 'string') lines.push(`command: ${record.command}`);
  if (Array.isArray(record.safetyWarnings) && record.safetyWarnings.length > 0) {
    lines.push(`warnings: ${record.safetyWarnings.join(', ')}`);
  }
  if (typeof record.stdout === 'string' && record.stdout.length > 0) {
    lines.push(`stdout:\n${record.stdout.trimEnd()}`);
  }
  if (typeof record.stderr === 'string' && record.stderr.length > 0) {
    lines.push(`stderr:\n${record.stderr.trimEnd()}`);
  }
  if (typeof record.exitCode === 'number') lines.push(`exitCode: ${record.exitCode}`);
  if (lines.length > 0) return lines.join('\n');
  return toolResult.error ?? JSON.stringify(toolResult, null, 2);
}

function guardModelRequestMultiStage(
  messages: AgentMessage[],
  settings: ContextBudgetSettings,
  conversation: AgentConversation,
): {
  messages: AgentMessage[];
  compaction: CompactionRecord | null;
  error?: string;
} {
  const effectiveInputLimit = settings.contextWindowTokens - settings.reservedOutputTokens;
  const result = compactMessagesMultiStage(messages, settings);

  if (result.stage >= 4 || result.tokensAfter > effectiveInputLimit) {
    return {
      messages: result.activeMessages,
      compaction: result.compaction,
      error: formatContextBudgetError({
        estimatedInputTokens: result.tokensAfter,
        contextWindowTokens: settings.contextWindowTokens,
        reservedOutputTokens: settings.reservedOutputTokens,
        effectiveInputLimit,
        largestContributors: summarizeLargestContributors(result.activeMessages),
        compactionStage: result.stage,
      }),
    };
  }

  if (result.compaction) {
    conversation.messages.splice(0, conversation.messages.length, ...result.activeMessages);
  }

  return {
    messages: result.activeMessages,
    compaction: result.compaction,
  };
}

function isPrematureCompletionClaim(text: string): boolean {
  const normalized = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim()
    .toLowerCase();

  if (normalized.length < 10) return false;

  const prematurePhrases = [
    'verified passed',
    'verification passed',
    'all tests pass',
    'completed successfully',
    'task complete',
    'work is complete',
  ];

  if (normalized.length < 60) {
    return prematurePhrases.some((phrase) => normalized.includes(phrase));
  }

  const tailStart = Math.floor(normalized.length * 0.6);
  const tail = normalized.slice(tailStart);
  return prematurePhrases.some((phrase) => tail.includes(phrase));
}

function isSafeToolPreamble(text: string): boolean {
  const normalized = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();

  if (!normalized) return true;
  const joined = normalized.toLowerCase();

  const forbiddenPhrases = [
    'answer is',
    'final answer',
    'in summary',
    'in conclusion',
    'to summarize',
    'here is the answer',
  ];

  return !forbiddenPhrases.some((phrase) => joined.includes(phrase));
}

/** The canonical Synax system prompt. Exported for reuse by delegation layers. */
export function systemPrompt(): string {
  return [
    'You are Synax, a disciplined local coding agent.',
    'Tools: read, write, edit, bash.',
    'Use bash for terminal commands, including git and verification.',
    'Use read for local file inspection: list files, search text, or read bounded line ranges.',
    'Use write for new text files and edit for exact replacements in files you have already read.',
    'Keep working until the task is done, then stop and summarize.',
    'Be concise. Show file paths clearly when working with files.',
    'When calling a tool, emit only tool calls. Do not mix final-answer prose with tool calls.',
  ].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatModelResponseActivity(response: ChatResponse, _step: number): AgentActivity {
  const lines: string[] = [];
  const reasoningContent = response.reasoningContent?.trim();
  const trimmedContent = response.content.trim();

  if (reasoningContent && !trimmedContent.includes(reasoningContent)) {
    lines.push(`<thinking>\n${reasoningContent}\n</thinking>`);
  }

  if (trimmedContent.length > 0) {
    lines.push(trimmedContent);
  }

  if (response.toolCalls.length > 0) {
    const toolNames = response.toolCalls.map((c) => c.name).join(', ');
    lines.push(`→ ${response.toolCalls.length} tool call(s): ${toolNames}`);
  }

  return {
    kind: 'model_response',
    message: lines.join('\n') || '(empty response)',
    modelOutput: lines.join('\n'),
    toolCallCount: response.toolCalls.length,
  };
}

function injectOrientation(
  messages: AgentMessage[],
  ledger: InspectionLedger,
  readCounts?: Map<string, number>,
  compactedFilePaths?: string[],
): AgentMessage[] {
  const orientation = ledger.getOrientation(readCounts, compactedFilePaths);
  if (!orientation.includes('(nothing inspected yet)')) {
    return [{ role: 'system', content: orientation }, ...messages];
  }
  return messages;
}

function buildModelRequest(
  conversation: AgentConversation,
  settings: ContextBudgetSettings,
  readCounts: Map<string, number>,
  totalReadCalls?: number,
): AgentMessage[] {
  const baseMessages = conversation.messages;

  const effectiveLimit = settings.contextWindowTokens - settings.reservedOutputTokens;
  const estimatedTokens = estimateRequestTokens(baseMessages);
  const threshold = settings.assemblyCompactionThreshold ?? 0.8;
  const nearBudget = estimatedTokens > effectiveLimit * threshold;

  let assembled: AgentMessage[];
  let stats: AssemblyStats;
  if (nearBudget) {
    const result = assembleModelMessages(baseMessages, settings, conversation.inspectionLedger, readCounts);
    assembled = result.messages;
    stats = result.stats;
  } else {
    assembled = baseMessages;
    stats = {
      totalMessagesIn: baseMessages.length,
      totalMessagesOut: baseMessages.length,
      estimatedTokensIn: estimatedTokens,
      estimatedTokensOut: estimatedTokens,
      compactedToolResults: 0,
      keptRecentTurns: 0,
      droppedDuplicateReadResults: 0,
      compactedFilePaths: [],
    };
  }

  conversation.assemblyStats = stats;

  const withOrientation = injectOrientation(
    assembled,
    conversation.inspectionLedger,
    readCounts,
    stats.compactedFilePaths,
  );

  const READ_BUDGET_WARNING_THRESHOLD = Math.floor(MAX_TOTAL_READS_PER_TURN * 0.5);
  const hasReadBudgetPressure =
    totalReadCalls !== undefined &&
    totalReadCalls >= READ_BUDGET_WARNING_THRESHOLD &&
    totalReadCalls < MAX_TOTAL_READS_PER_TURN;

  const hasRepetitionPressure = readCounts !== undefined && [...readCounts.values()].some((count) => count >= 3);

  if (hasReadBudgetPressure || hasRepetitionPressure) {
    const remaining =
      totalReadCalls !== undefined ? MAX_TOTAL_READS_PER_TURN - totalReadCalls : MAX_TOTAL_READS_PER_TURN;
    const warning: AgentMessage = {
      role: 'user',
      content: [
        `⛔ STOP READING. ${remaining} read(s) remain before hard stop.`,
        'You have enough context. Use non-read tools (bash, edit, write) to act now.',
        'Do not call any more read or inspect tools. Take action with what you have.',
      ].join('\n'),
    };
    const finalMessages = [...withOrientation, warning];
    stats.totalMessagesOut = finalMessages.length;
    stats.estimatedTokensOut = estimateRequestTokens(finalMessages);
    resetTokenLedger(conversation.tokenLedger);
    estimateIncrementalTokens(finalMessages, conversation.tokenLedger);
    return finalMessages;
  }

  stats.totalMessagesOut = withOrientation.length;
  stats.estimatedTokensOut = estimateRequestTokens(withOrientation);
  resetTokenLedger(conversation.tokenLedger);
  estimateIncrementalTokens(withOrientation, conversation.tokenLedger);
  return withOrientation;
}

/**
 * Classify a turn result for recovery eligibility.
 * Returns the failure scenario if the result indicates a recoverable failure.
 */
function classifyResultForRecovery(result: AgentTurnResult): import('../recovery/types').FailureScenario | null {
  // Empty or near-empty model response with error
  if (
    result.terminalState === 'model_error' &&
    result.error &&
    (result.error.toLowerCase().includes('empty') ||
      result.error.toLowerCase().includes('no content') ||
      result.error.toLowerCase().includes('no response'))
  ) {
    return 'empty_response';
  }

  // Bash failure with stderr
  if (
    result.terminalState === 'tool_error' &&
    result.error &&
    result.toolCalls.some((tc) => tc.name === 'bash' && !tc.success && tc.error?.includes('exit code'))
  ) {
    return 'bash_failure';
  }

  // Budget exhaustion
  if (result.terminalState === 'budget_exhausted') {
    return 'context_exhaustion';
  }

  // Tool error with possible loop
  if (result.terminalState === 'tool_error' && result.error?.includes('too many consecutive')) {
    return 'infinite_loop';
  }

  return null;
}
