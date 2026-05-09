import { existsSync } from 'fs';
import { mkdir, readFile } from 'fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';

import { type Logger } from '../logging/index.js';
import type { SpanTracer } from '../telemetry/SpanTracer';
import { type ChatOptions, type ChatResponse } from '../llm/types';
import { type ParsedToolCall } from '../llm/tool-calls';
import { createInspectionLedger, createToolRegistry, type InspectionLedger } from '../tools';
import { normalizeRepoPath } from '../tools/policy';
import { type ToolDefinition, type ToolRegistry, type ToolResult } from '../tools/types';
import {
  applyReplaceInFile,
  createPatchPreview,
  validateReplaceInFile,
  type PatchPreview,
  type ReplaceInFilePatch,
} from '../agent/patch';
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
import { atomicWriteFile, writeLastEditRecord } from '../agent/safety';
import { eventNow, type AgentEvent, type TerminalState } from '../agent/events';
import {
  canMutatePath,
  describeToolCall,
  guardBroadTask,
  guardUnsupportedTask,
  getAllowedModelTools,
  type RunMode,
} from '../agent/task-policy';

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
const MAX_IDENTICAL_READS_PER_TURN = 3;
const MAX_TOTAL_READS_PER_TURN = 24;
const MAX_IDENTICAL_BASH_COMMANDS_PER_TURN = 3;
const execFileAsync = promisify(execFile);

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
  /** Simple event bus — will be swapped for typed EventBus in M1 #04. */
  readonly eventBus: EventEmitter = new EventEmitter();
  /** Holographic memory — null until M4 #12. */
  readonly memory: null = null;

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
  }) {
    this.repoRoot = options.repoRoot;
    this.client = options.client;
    this.mode = options.mode ?? 'patch';
    this.maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    this.bashEnabled = options.bashEnabled ?? true;
    this.onActivity = options.onActivity;
    this.onEvent = options.onEvent;
    this.onBudget = options.onBudget;
    this.approvePatch = options.approvePatch;
    this.ensureCheckpoint = options.ensureCheckpoint;
    this.logger = options.logger;
    this.tracer = options.tracer;

    this.conversation = options.conversation ?? Session.createConversation({ skillMessages: options.skillMessages });
    this.registry =
      options.registry ??
      createToolRegistry({
        repoRoot: options.repoRoot,
        ledger: this.conversation.inspectionLedger,
      });
    this.contextBudget = resolveContextBudgetSettings(options.contextBudget ?? {});
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

  /** No-op shutdown — placeholder for future lifecycle hooks. */
  shutdown(): void {
    this.eventBus.removeAllListeners();
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

    try {
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

        // Span: tool parsing
        const toolParseSpan =
          this.tracer && turnSpan
            ? this.tracer.startChildSpan(turnSpan, 'tool_parse', { toolCallCount: response.toolCalls.length })
            : undefined;

        this.onActivity?.(formatModelResponseActivity(response, step));

        conversation.messages.push(assistantMessage(response, contextBudget));

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

          const result =
            detectRepeatedBashCommand(call, identicalBashCounts) ??
            (await executeAgentTool(call, {
              repoRoot: this.repoRoot,
              registry,
              ledger: conversation.inspectionLedger,
              mode,
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
            }));

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
          if (result.changedFile) changedFiles.push(result.changedFile);

          // End tool execution span
          if (this.tracer && toolExecSpan) {
            this.tracer.addEvent(toolExecSpan, 'tool_finished', {
              success: result.success,
              error: result.error,
            });
            this.tracer.endSpan(toolExecSpan);
          }

          const afterToolMessages = buildModelRequest(conversation, contextBudget, identicalReadCounts, totalReadCalls);
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
    } finally {
      if (this.tracer && turnSpan) {
        this.tracer.endSpan(turnSpan);
      }
    }
  }
}

// ─── Internal Tool Execution (moved from runner.ts) ──────────────────────────

interface AgentToolExecutionResult {
  success: boolean;
  toolResult: ToolResult;
  changedFile?: string;
  error?: string;
  terminalState?: AgentTerminalState;
}

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
  session.eventBus.emit('assistant_delta', {
    type: 'assistant_delta',
    timestamp: eventNow(),
    content: delta.content,
    reasoningContent: delta.reasoningContent,
  });
  session.onEvent?.({
    type: 'assistant_delta',
    timestamp: eventNow(),
    content: delta.content,
    reasoningContent: delta.reasoningContent,
  });
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

async function executeAgentTool(
  call: ParsedToolCall,
  context: {
    repoRoot: string;
    registry: ToolRegistry;
    ledger: InspectionLedger;
    mode: RunMode;
    readCache: Map<string, ToolResult>;
    identicalReadCounts: Map<string, number>;
    totalReadCalls: number;
    totalReadResultTokens: number;
    readResultBudget: ContextBudgetSettings;
    ensureCheckpoint?: () => Promise<unknown>;
    approvePatch?: (preview: PatchPreview) => PatchApprovalDecision | Promise<PatchApprovalDecision>;
    onPatchPreview?: (preview: PatchPreview) => void;
  },
): Promise<AgentToolExecutionResult> {
  if (call.name === 'read') {
    return executeReadTool(
      call.arguments,
      context.registry,
      context.ledger,
      context.readCache,
      context.identicalReadCounts,
      context.totalReadCalls,
      context.totalReadResultTokens,
      context.readResultBudget,
    );
  }

  if (call.name === 'edit' || call.name === 'replace_in_file') {
    return executeReplaceInFile(call.arguments, context, call.name);
  }

  if (call.name === 'write' || call.name === 'create_file') {
    return executeCreateFile(call.arguments, context, call.name);
  }

  if (call.name === 'bash') {
    return executeBashTool(call.arguments, context.repoRoot);
  }

  const toolResult = await context.registry.execute(call.name, call.arguments);
  return {
    success: toolResult.success,
    toolResult,
    error: toolResult.error,
  };
}

async function executeReadTool(
  input: Record<string, unknown>,
  registry: ToolRegistry,
  ledger: InspectionLedger,
  readCache: Map<string, ToolResult>,
  identicalReadCounts: Map<string, number>,
  totalReadCalls: number,
  totalReadResultTokens: number,
  readResultBudget: ContextBudgetSettings,
): Promise<AgentToolExecutionResult> {
  if (totalReadCalls >= MAX_TOTAL_READS_PER_TURN) {
    return toolFailure('read', `total read limit reached for this turn: ${MAX_TOTAL_READS_PER_TURN}`);
  }

  const repetitionKey = readRepetitionKey(input);
  const seenCount = identicalReadCounts.get(repetitionKey) ?? 0;

  if (seenCount >= MAX_IDENTICAL_READS_PER_TURN) {
    const orientation = ledger.getOrientation();
    return toolFailure(
      'read',
      `Read loop detected: same file/query read ${seenCount + 1} times. ` +
        `Use targeted reads or search instead.\n\n${orientation}`,
    );
  }
  identicalReadCounts.set(repetitionKey, seenCount + 1);

  const showNudge = seenCount >= 2;

  const signature = readSignature(input);
  const cached = readCache.get(signature);
  if (cached) {
    if (showNudge && cached.success && typeof cached.output === 'object' && cached.output !== null) {
      const nudged = {
        ...cached,
        output: {
          ...(cached.output as Record<string, unknown>),
          guidance:
            'Already read this file. Use search (query) or targeted line ranges (startLine/endLine) to inspect specific sections.',
        },
      };
      return publicToolResult('read', nudged);
    }
    return publicToolResult('read', cached);
  }

  if (typeof input.query === 'string' && input.query.trim().length > 0) {
    const result = await registry.execute('search_text', input);
    const normalized = normalizeReadToolResult(result, readResultBudget, totalReadResultTokens, ledger);
    readCache.set(signature, normalized);
    return publicToolResult('read', normalized);
  }
  if (typeof input.path === 'string' && input.path.trim().length > 0) {
    const result = await registry.execute('read_file_range', input);
    const normalized = normalizeReadToolResult(result, readResultBudget, totalReadResultTokens, ledger);
    if (showNudge && normalized.success && typeof normalized.output === 'object' && normalized.output !== null) {
      (normalized.output as Record<string, unknown>).guidance =
        'Already read this file. Use search (query) or targeted line ranges (startLine/endLine) to inspect specific sections.';
    }
    readCache.set(signature, normalized);
    return publicToolResult('read', normalized);
  }
  const result = await registry.execute('list_files', input);
  const normalized = normalizeReadToolResult(result, readResultBudget, totalReadResultTokens, ledger);
  readCache.set(signature, normalized);
  return publicToolResult('read', normalized);
}

async function executeReplaceInFile(
  input: Record<string, unknown>,
  context: {
    repoRoot: string;
    ledger: InspectionLedger;
    mode: RunMode;
    ensureCheckpoint?: () => Promise<unknown>;
    approvePatch?: (preview: PatchPreview) => PatchApprovalDecision | Promise<PatchApprovalDecision>;
    onPatchPreview?: (preview: PatchPreview) => void;
  },
  toolName = 'replace_in_file',
): Promise<AgentToolExecutionResult> {
  const patch = coercePatch(input);
  if (!patch) {
    return toolFailure(toolName, 'path, oldStr, and newStr are required');
  }

  if (context.mode === 'read-only' || context.mode === 'verify') {
    return toolFailure(toolName, `${context.mode} mode does not allow edits`);
  }

  const mutationPath = canMutatePath(context.mode, context.repoRoot, patch.path);
  if (!mutationPath.ok) {
    return toolFailure(toolName, mutationPath.reason ?? 'mutation path rejected');
  }

  await context.ensureCheckpoint?.();

  const validation = await validateReplaceInFile(patch, {
    repoRoot: context.repoRoot,
  });
  if (!validation.ok) {
    return toolFailure(toolName, validation.message);
  }

  const preview = createPatchPreview(validation);
  context.onPatchPreview?.(preview);
  const decision = context.approvePatch ? await context.approvePatch(preview) : 'accept';
  if (decision === 'reject') {
    const error = `patch rejected for ${preview.path}`;
    return {
      success: false,
      error,
      terminalState: 'user_input_required',
      toolResult: {
        success: false,
        toolName,
        error,
        output: { path: preview.path, diff: preview.diff, decision },
      },
    };
  }

  const applied = await applyReplaceInFile(patch, {
    repoRoot: context.repoRoot,
  });
  if (!applied.ok) {
    return toolFailure(toolName, applied.message);
  }
  await writeLastEditRecord(context.repoRoot, {
    path: applied.path,
    before: applied.before,
    after: applied.after,
    timestamp: new Date().toISOString(),
  });

  return {
    success: true,
    changedFile: applied.path,
    toolResult: {
      success: true,
      toolName,
      output: {
        path: applied.path,
        diff: preview.diff,
      },
    },
  };
}

async function executeCreateFile(
  input: Record<string, unknown>,
  context: {
    repoRoot: string;
    mode: RunMode;
    ensureCheckpoint?: () => Promise<unknown>;
  },
  toolName = 'create_file',
): Promise<AgentToolExecutionResult> {
  if (typeof input.path !== 'string' || typeof input.content !== 'string') {
    return toolFailure(toolName, 'path and content are required');
  }

  if (context.mode === 'read-only' || context.mode === 'verify') {
    return toolFailure(toolName, `${context.mode} mode does not allow writes`);
  }

  const target = normalizeRepoPath(context.repoRoot, input.path);
  if (!target.ok || !target.absolutePath || target.path === undefined) {
    return toolFailure(toolName, target.reason ?? 'invalid path');
  }
  const mutationPath = canMutatePath(context.mode, context.repoRoot, target.path);
  if (!mutationPath.ok) {
    return toolFailure(toolName, mutationPath.reason ?? 'mutation path rejected');
  }
  if (existsSync(target.absolutePath)) {
    return toolFailure(toolName, `file already exists: ${target.path}`);
  }

  if (Buffer.byteLength(input.content, 'utf-8') > 16 * 1024) {
    return toolFailure(toolName, 'create_file content is too large; write a smaller text file');
  }

  await context.ensureCheckpoint?.();
  await mkdir(dirname(target.absolutePath), { recursive: true });
  await atomicWriteFile(target.absolutePath, input.content);
  const written = await readFile(target.absolutePath, 'utf-8');
  return {
    success: true,
    changedFile: target.path,
    toolResult: {
      success: true,
      toolName,
      output: {
        path: target.path,
        bytes: Buffer.byteLength(written, 'utf-8'),
      },
    },
  };
}

function publicToolResult(toolName: string, result: ToolResult): AgentToolExecutionResult {
  return {
    success: result.success,
    toolResult: { ...result, toolName },
    error: result.error,
  };
}

async function executeBashTool(input: Record<string, unknown>, repoRoot: string): Promise<AgentToolExecutionResult> {
  const command = resolveShellCommand(input);
  if (!command) {
    return toolFailure('bash', 'command is required');
  }

  const blockReason = detectBlockedCommand(command);
  if (blockReason) {
    return toolFailure('bash', `Blocked: ${blockReason}`);
  }

  const plan = planBashCommand(command, repoRoot);
  const safetyWarnings = detectDangerousCommandWarnings(plan.command);

  try {
    const { stdout, stderr } = await execFileAsync('/bin/bash', ['-lc', plan.command], {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
      timeout: 30_000,
    });
    return {
      success: true,
      toolResult: {
        success: true,
        toolName: 'bash',
        output: {
          command: plan.command,
          ...(plan.originalCommand !== plan.command ? { originalCommand: plan.originalCommand } : {}),
          ...(plan.cwdRecovery ? { cwdRecovery: plan.cwdRecovery } : {}),
          safetyWarnings,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          exitCode: 0,
        },
      },
    };
  } catch (error) {
    const e = error as { stdout?: string | Buffer; stderr?: string | Buffer; code?: number };
    return {
      success: false,
      error: errorMessage(error),
      toolResult: {
        success: false,
        toolName: 'bash',
        error: errorMessage(error),
        output: {
          command: plan.command,
          ...(plan.originalCommand !== plan.command ? { originalCommand: plan.originalCommand } : {}),
          ...(plan.cwdRecovery ? { cwdRecovery: plan.cwdRecovery } : {}),
          safetyWarnings,
          stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf-8') ?? ''),
          stderr: typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf-8') ?? ''),
          exitCode: typeof e.code === 'number' ? e.code : 1,
        },
      },
    };
  }
}

interface BashCommandPlan {
  command: string;
  originalCommand: string;
  cwdRecovery?: string;
}

function planBashCommand(command: string, repoRoot: string): BashCommandPlan {
  const parsed = parseLeadingAbsoluteCd(command);
  if (!parsed || !parsed.rest.trim()) return { command, originalCommand: command };

  const root = resolve(repoRoot);
  const target = resolve(parsed.target);
  if (!isAbsolute(parsed.target)) return { command, originalCommand: command };

  if (!existsSync(target)) {
    return {
      command: parsed.rest.trim(),
      originalCommand: command,
      cwdRecovery: `stale leading cd target did not exist: ${target}; running command body from ${root}`,
    };
  }

  if (!isPathInside(root, target)) {
    return {
      command: parsed.rest.trim(),
      originalCommand: command,
      cwdRecovery: `stale leading cd target was outside the repository root: ${target}; running command body from ${root}`,
    };
  }

  return { command, originalCommand: command };
}

function parseLeadingAbsoluteCd(command: string): { target: string; rest: string } | null {
  const match = /^\s*cd\s+((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^;&|]+?))\s*&&\s*([\s\S]+)$/u.exec(command);
  if (!match) return null;
  return { target: unquoteShellPath(match[1].trim()), rest: match[2] };
}

function unquoteShellPath(path: string): string {
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    return path.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  }
  if (path.length >= 2 && path.startsWith("'") && path.endsWith("'")) {
    return path.slice(1, -1);
  }
  return path;
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function detectRepeatedBashCommand(call: ParsedToolCall, counts: Map<string, number>): AgentToolExecutionResult | null {
  if (call.name !== 'bash') return null;
  const command = resolveShellCommand(call.arguments);
  if (!command) return null;
  const key = normalizeShellCommand(command);
  const seen = counts.get(key) ?? 0;
  counts.set(key, seen + 1);
  if (seen < MAX_IDENTICAL_BASH_COMMANDS_PER_TURN) return null;

  return toolFailure(
    'bash',
    `Bash loop detected: command repeated ${seen + 1} times without completing the task: ${command}`,
  );
}

function resolveShellCommand(input: Record<string, unknown>): string | null {
  if (typeof input.command === 'string' && input.command.trim().length > 0) {
    return input.command.trim();
  }
  return null;
}

function normalizeShellCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

function detectBlockedCommand(command: string): string | null {
  const normalized = command.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/\bcurl\b.*\|\s*(bash|sh)\b/.test(normalized)) return 'remote script execution via curl|bash is blocked';
  if (/\bwget\b.*\|\s*(bash|sh)\b/.test(normalized)) return 'remote script execution via wget|bash is blocked';
  if (/\brm\s+-rf\s+\/(?=[\s;|&)"']|$)/.test(normalized)) return 'destructive delete of root (rm -rf /) is blocked';
  if (/\brm\s+-rf\s+~(?=[\s;|&)"']|$)/.test(normalized)) return 'destructive delete of home (rm -rf ~) is blocked';
  if (/\bmkfs(\.| )/.test(normalized)) return 'filesystem formatting (mkfs) is blocked';
  if (/\bdd\s+if=.*\s+of=\/dev\//.test(normalized)) return 'raw block device write (dd to /dev) is blocked';
  if (/\bshutdown\b|\breboot\b|\bhalt\b/.test(normalized)) return 'system power-state command is blocked';
  return null;
}

function detectDangerousCommandWarnings(command: string): string[] {
  const normalized = command.toLowerCase().replace(/\s+/g, ' ').trim();
  const warnings: string[] = [];
  const patterns: Array<{ pattern: RegExp; warning: string }> = [
    {
      pattern: /\brm\s+-rf\s+\.(?=[\s;|&)"']|$)/,
      warning: 'destructive delete of current directory (`rm -rf .`) detected',
    },
    { pattern: /\brm\s+-rf\s+\/etc(?=[\s;|&/)"']|$)/, warning: 'system directory deletion (`rm -rf /etc`) detected' },
    { pattern: /\bchmod\s+-r\s+0{0,2}\s+\//, warning: 'broad permission reset on root detected' },
    { pattern: /\bchown\s+-r\s+.+\s+\//, warning: 'recursive ownership change on root detected' },
    { pattern: /\brm\s+-rf\s+\/usr\b/, warning: 'system directory deletion (`rm -rf /usr`) detected' },
    { pattern: /\brm\s+-rf\s+\/var\b/, warning: 'system directory deletion (`rm -rf /var`) detected' },
  ];
  for (const entry of patterns) {
    if (entry.pattern.test(normalized)) warnings.push(entry.warning);
  }
  return warnings;
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

function coercePatch(input: Record<string, unknown>): ReplaceInFilePatch | null {
  if (typeof input.path !== 'string' || typeof input.oldStr !== 'string' || typeof input.newStr !== 'string') {
    return null;
  }
  return {
    path: input.path,
    oldStr: input.oldStr,
    newStr: input.newStr,
  };
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

function readSignature(input: Record<string, unknown>): string {
  return JSON.stringify({
    path: typeof input.path === 'string' ? input.path : undefined,
    query: typeof input.query === 'string' ? input.query : undefined,
    startLine: typeof input.startLine === 'number' ? input.startLine : undefined,
    endLine: typeof input.endLine === 'number' ? input.endLine : undefined,
    maxFiles: typeof input.maxFiles === 'number' ? input.maxFiles : undefined,
    maxMatches: typeof input.maxMatches === 'number' ? input.maxMatches : undefined,
  });
}

function readRepetitionKey(input: Record<string, unknown>): string {
  if (typeof input.query === 'string' && input.query.trim().length > 0) {
    return `query:${input.query.trim()}`;
  }
  if (typeof input.path === 'string' && input.path.trim().length > 0) {
    const start = typeof input.startLine === 'number' ? input.startLine : 0;
    const end = typeof input.endLine === 'number' ? input.endLine : 0;
    return `path:${input.path.trim()}:${start}-${end}`;
  }
  return 'list:.';
}

function toolFailure(toolName: string, error: string): { success: false; toolResult: ToolResult; error: string } {
  return {
    success: false,
    error,
    toolResult: { success: false, toolName, error },
  };
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

function normalizeReadToolResult(
  result: ToolResult,
  settings: ContextBudgetSettings,
  totalReadResultTokens: number,
  ledger: InspectionLedger,
): ToolResult {
  if (!result.success) return result;
  const serialized = JSON.stringify(result.output);
  const estimatedOriginalTokens = estimateTokens(serialized);
  const remaining = Math.max(0, settings.maxTotalReadResultTokensPerTurn - totalReadResultTokens);
  const cap = Math.min(settings.maxSingleReadResultTokens, remaining);

  if (cap <= 0) {
    const path = readPathFromOutput(result.output);
    return {
      success: true,
      toolName: result.toolName,
      output: {
        path,
        omitted: true,
        reason: 'turn token budget exceeded',
        guidance: 'use targeted read/search',
        estimatedOriginalTokens,
        estimatedReturnedTokens: 0,
      },
    };
  }

  const truncated = truncateForTokenBudget(serialized, cap);
  if (!truncated.truncated) {
    return result;
  }

  const path = readPathFromOutput(result.output);
  if (path) ledger.markPathAsTruncated(path);

  return {
    success: true,
    toolName: result.toolName,
    output: {
      path,
      estimatedOriginalTokens,
      estimatedReturnedTokens: estimateTokens(truncated.text),
      truncated: true,
      message: 'read result truncated to stay within context budget. Use targeted read/search for more.',
      content: truncated.text,
    },
  };
}

function estimateReadResultTokens(toolResult: ToolResult): number {
  if (!toolResult.success) return 0;
  const output = toolResult.output;
  if (output && typeof output === 'object' && (output as { omitted?: boolean }).omitted) {
    return 0;
  }
  return estimateTokens(JSON.stringify(toolResult.output));
}

function readPathFromOutput(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const path = (output as { path?: unknown }).path;
  return typeof path === 'string' ? path : undefined;
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
