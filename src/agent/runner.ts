import { existsSync } from 'fs';
import { mkdir, readFile } from 'fs/promises';
import { dirname } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

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
} from './patch';
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
} from './context-budget';
import { atomicWriteFile, writeLastEditRecord } from './safety';
import { eventNow, type AgentEvent, type TerminalState } from './events';
import {
  canMutatePath,
  describeToolCall,
  guardBroadTask,
  guardUnsupportedTask,
  getAllowedModelTools,
  type RunMode,
} from './task-policy';

export type AgentTerminalState = TerminalState;

export interface AgentMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: unknown;
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
  contextBudget?: Partial<ContextBudgetSettings> & { contextBudgetTokens?: number };
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

const DEFAULT_MAX_STEPS = 64;
const DEFAULT_MAX_TOOL_CALLS = 192;
const MAX_CONSECUTIVE_RECOVERABLE_TOOL_ERRORS = 3;
const MAX_IDENTICAL_READS_PER_TURN = 3;
const MAX_TOTAL_READS_PER_TURN = 24;
const MAX_IDENTICAL_BASH_COMMANDS_PER_TURN = 3;
const execFileAsync = promisify(execFile);

interface AgentToolExecutionResult {
  success: boolean;
  toolResult: ToolResult;
  changedFile?: string;
  completedAction?: string;
  error?: string;
  terminalState?: AgentTerminalState;
}

export function createAgentConversation(): AgentConversation {
  return {
    messages: [{ role: 'system', content: systemPrompt() }],
    inspectionLedger: createInspectionLedger(),
    latestCompaction: null,
    tokenLedger: createTokenLedger(),
    assemblyStats: null,
  };
}

export function resetAgentConversation(conversation: AgentConversation): void {
  conversation.messages.splice(0, conversation.messages.length, { role: 'system', content: systemPrompt() });
  conversation.inspectionLedger = createInspectionLedger();
  conversation.latestCompaction = null;
  conversation.assemblyStats = null;
  resetTokenLedger(conversation.tokenLedger);
}

export async function runAgentTurn(options: AgentRunnerOptions & { task: string }): Promise<AgentTurnResult> {
  const conversation = options.conversation ?? createAgentConversation();
  const registry =
    options.registry ??
    createToolRegistry({
      repoRoot: options.repoRoot,
      ledger: conversation.inspectionLedger,
    });
  const mode = options.mode ?? 'patch';
  const bashEnabled = options.tools?.bashEnabled ?? true;
  const tools = buildModelFacingTools({ ...options.tools, bashEnabled, mode });
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const changedFiles: string[] = [];
  const completedActions: string[] = [];
  const toolCalls: AgentTurnResult['toolCalls'] = [];
  const readCache = new Map<string, ToolResult>();
  const identicalReadCounts = new Map<string, number>();
  const identicalBashCounts = new Map<string, number>();
  let totalReadCalls = 0;
  let totalReadResultTokens = 0;
  const contextBudget = resolveContextBudgetSettings(options.contextBudget ?? {});
  let consecutiveRecoverableToolErrors = 0;

  const broadTask = guardBroadTask(options.task);
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

  const unsupportedTask = guardUnsupportedTask(options.task, bashEnabled);
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

  conversation.messages.push({ role: 'user', content: options.task });

  for (let step = 1; step <= maxSteps; step += 1) {
    let response: ChatResponse;
    const isFinalStep = step === maxSteps;
    try {
      options.onActivity?.({ kind: 'model', message: `model step ${step}` });
      options.onEvent?.({
        type: 'model_step_started',
        timestamp: eventNow(),
        stepIndex: step,
      });

      // Preflight budget guard (item 7): runs before EVERY model call.
      const effectiveInputLimit = contextBudget.contextWindowTokens - contextBudget.reservedOutputTokens;
      const estimatedInputTokens = estimateIncrementalTokens(conversation.messages, conversation.tokenLedger);

      options.onBudget?.({
        estimatedInputTokens,
        inputLimit: effectiveInputLimit,
        contextWindowTokens: contextBudget.contextWindowTokens,
        reservedOutputTokens: contextBudget.reservedOutputTokens,
        step,
      });

      // Check if we're already over budget before attempting compaction
      if (estimatedInputTokens > effectiveInputLimit) {
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
        }

        // Post-compaction budget verification
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

        // Build model request with assembly, orientation, and token ledger update
        const assembled = buildModelRequest(
          conversation,
          contextBudget,
          identicalReadCounts,
          isFinalStep,
          totalReadCalls,
        );

        // Final belt-and-suspenders check on assembled messages
        if (isFinalStep) {
          const finalTokens = estimateRequestTokens(assembled);
          if (finalTokens > effectiveInputLimit) {
            return {
              terminalState: 'budget_exhausted',
              finalAnswer: '',
              steps: step,
              toolCalls,
              changedFiles,
              conversation,
              error: formatContextBudgetError({
                estimatedInputTokens: finalTokens,
                contextWindowTokens: contextBudget.contextWindowTokens,
                reservedOutputTokens: contextBudget.reservedOutputTokens,
                effectiveInputLimit,
                largestContributors: summarizeLargestContributors(assembled),
                compactionStage: 4,
              }),
            };
          }
        }

        response = await options.client.chat({
          messages: assembled,
          tools,
          temperature: 0,
          maxTokens: 2048,
        });
      } else {
        // Within budget: build assembled model request proactively
        const assembled = buildModelRequest(
          conversation,
          contextBudget,
          identicalReadCounts,
          isFinalStep,
          totalReadCalls,
        );

        // Extra budget check for final step
        if (isFinalStep) {
          const finalTokens = estimateRequestTokens(assembled);
          if (finalTokens > effectiveInputLimit) {
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
            // Rebuild from freshly compacted messages
            const fallbackAssembled = buildModelRequest(
              conversation,
              contextBudget,
              identicalReadCounts,
              isFinalStep,
              totalReadCalls,
            );
            const fallbackTokens = estimateRequestTokens(fallbackAssembled);
            if (fallbackTokens > effectiveInputLimit) {
              return {
                terminalState: 'budget_exhausted',
                finalAnswer: '',
                steps: step,
                toolCalls,
                changedFiles,
                conversation,
                error: formatContextBudgetError({
                  estimatedInputTokens: fallbackTokens,
                  contextWindowTokens: contextBudget.contextWindowTokens,
                  reservedOutputTokens: contextBudget.reservedOutputTokens,
                  effectiveInputLimit,
                  largestContributors: summarizeLargestContributors(fallbackAssembled),
                  compactionStage: 4,
                }),
              };
            }
            response = await options.client.chat({
              messages: fallbackAssembled,
              tools,
              temperature: 0,
              maxTokens: 2048,
            });
          } else {
            response = await options.client.chat({
              messages: assembled,
              tools,
              temperature: 0,
              maxTokens: 2048,
            });
          }
        } else {
          response = await options.client.chat({
            messages: assembled,
            tools,
            temperature: 0,
            maxTokens: 2048,
          });
        }
      }
    } catch (error) {
      const message = errorMessage(error);
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

    // Emit model response activity so the CLI can surface model thoughts/output.
    options.onActivity?.(formatModelResponseActivity(response, step));

    conversation.messages.push(assistantMessage(response, contextBudget));

    if (isFinalStep && response.toolCalls.length > 0) {
      return {
        terminalState: 'budget_exhausted',
        finalAnswer: response.content.trim(),
        steps: step,
        toolCalls,
        changedFiles,
        conversation,
        error: `max steps exceeded: ${maxSteps}`,
      };
    }

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
        conversation.messages[conversation.messages.length - 1] = assistantMessage({
          ...response,
          content: '',
        });
      }
    }

    if (response.toolCalls.length === 0) {
      // Gate: prevent premature completion when the model claims success
      // without making any changes in patch mode. Read-only and verify
      // modes are exempt since they legitimately don't make changes.
      if (
        mode === 'patch' &&
        changedFiles.length === 0 &&
        completedActions.length === 0 &&
        isPrematureCompletionClaim(response.content)
      ) {
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

    const contentToolResults: Array<{ id: string; content: string }> = [];
    for (const call of response.toolCalls) {
      const callIndex = toolCalls.length;
      if (toolCalls.length >= maxToolCalls) {
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
      options.onActivity?.({
        kind: 'tool',
        message: describeToolCall(call.name, call.arguments as Record<string, unknown>),
      });
      options.onEvent?.({
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
          repoRoot: options.repoRoot,
          registry,
          ledger: conversation.inspectionLedger,
          mode,
          readCache,
          identicalReadCounts,
          totalReadCalls,
          totalReadResultTokens,
          readResultBudget: contextBudget,
          ensureCheckpoint: options.ensureCheckpoint,
          approvePatch: options.approvePatch,
          onPatchPreview: (preview) => {
            options.onEvent?.({
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
      options.onEvent?.({
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
      if (result.completedAction) {
        completedActions.push(result.completedAction);
        // Only auto-complete when this is the last tool call in the
        // current model response. If the model queued multiple tool
        // calls (e.g. commit → push → pr create), wait until all
        // have been processed before deciding terminal state.
        const isCurrentBatchLast = callIndex >= response.toolCalls.length - 1;
        if (isCurrentBatchLast) {
          flushContentToolResults(conversation, response, contentToolResults);
          return {
            terminalState: 'completed',
            finalAnswer: formatCompletedActionFinalAnswer(result.completedAction, result.toolResult),
            steps: step,
            toolCalls,
            changedFiles,
            conversation,
          };
        }
        // Otherwise: let remaining tool calls execute first.
      }

      // Item 7: Budget check after EVERY tool result is appended.
      // Check the model-facing assembled request, not the unpruned
      // canonical transcript. Large shell/read results may be safely
      // compacted before the next model call.
      const afterToolMessages = buildModelRequest(
        conversation,
        contextBudget,
        identicalReadCounts,
        false,
        totalReadCalls,
      );
      const afterToolTokens = estimateRequestTokens(afterToolMessages);
      const effectiveLimit = contextBudget.contextWindowTokens - contextBudget.reservedOutputTokens;
      if (afterToolTokens > effectiveLimit) {
        flushContentToolResults(conversation, response, contentToolResults);
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
            compactionStage: 0, // overflow within a step, not compaction
          }),
        };
      }

      if (result.success) {
        consecutiveRecoverableToolErrors = 0;
      } else if (isRecoverableToolError(call, result)) {
        consecutiveRecoverableToolErrors += 1;
        // Surface recoverable errors so users can debug local-model behavior.
        options.onActivity?.({
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

  return {
    terminalState: 'budget_exhausted',
    finalAnswer: '',
    steps: maxSteps,
    toolCalls,
    changedFiles,
    conversation,
    error: `max steps exceeded: ${maxSteps}`,
  };
}

function assistantMessage(response: ChatResponse, settings?: ContextBudgetSettings): AgentMessage {
  // P6: Guard against local models that ignore max_tokens and emit
  // excessively long completions. Truncate before appending to conversation.
  const maxOutputTokens = settings?.reservedOutputTokens ?? 8192;
  const maxOutputChars = Math.max(200, Math.floor(maxOutputTokens * 3));
  let content = response.content;
  if (content.length > maxOutputChars) {
    content = content.slice(0, maxOutputChars) + '\n[response truncated]';
  }

  if (toolCallFormat(response) === 'content_xml') {
    return {
      role: 'assistant',
      content,
      // P2: Marker so compaction integrity can match XML tool-call pairs.
      // Not serialized by serializeMessage — model never sees it.
      _tool_call_ids: response.toolCalls.map((c) => c.id),
    };
  }

  return {
    role: 'assistant',
    content,
    tool_calls: response.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })),
  };
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

  // Progressive loop resistance:
  //   seenCount 0 -> first read, proceed normally
  //   seenCount 1 -> first duplicate, return cached silently
  //   seenCount 2 -> second duplicate, return cached with strong nudge
  //   seenCount 3 -> third duplicate, HARD FAIL to break the loop
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
    ledger: context.ledger,
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
    ledger: context.ledger,
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

export function buildModelFacingTools(options: ModelToolSurfaceOptions = {}): ToolDefinition[] {
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

  // Block obviously catastrophic commands outright rather than just warning.
  const blockReason = detectBlockedCommand(command);
  if (blockReason) {
    return toolFailure('bash', `Blocked: ${blockReason}`);
  }

  const safetyWarnings = detectDangerousCommandWarnings(command);

  try {
    const { stdout, stderr } = await execFileAsync('/bin/bash', ['-lc', command], {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
      timeout: 30_000,
    });
    return {
      success: true,
      completedAction: completedShellAction(command),
      toolResult: {
        success: true,
        toolName: 'bash',
        output: {
          command,
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
          command,
          safetyWarnings,
          stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf-8') ?? ''),
          stderr: typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf-8') ?? ''),
          exitCode: typeof e.code === 'number' ? e.code : 1,
        },
      },
    };
  }
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

function completedShellAction(command: string): string | undefined {
  if (/(^|[;&|(){}\s])git\s+commit(?=\s|$)/.test(command)) return 'git commit';
  if (/(^|[;&|(){}\s])git\s+push(?=\s|$)/.test(command)) return 'git push';
  if (/(^|[;&|(){}\s])gh\s+pr\s+create(?=\s|$)/.test(command)) return 'gh pr create';
  if (/(^|[;&|(){}\s])gh\s+pr\s+merge(?=\s|$)/.test(command)) return 'gh pr merge';
  if (/(^|[;&|(){}\s])gh\s+issue\s+create(?=\s|$)/.test(command)) return 'gh issue create';
  if (/(^|[;&|(){}\s])gh\s+release\s+create(?=\s|$)/.test(command)) return 'gh release create';
  return undefined;
}

function formatCompletedActionFinalAnswer(action: string, toolResult: ToolResult): string {
  const output = toolResult.output;
  const command =
    output && typeof output === 'object' && typeof (output as { command?: unknown }).command === 'string'
      ? (output as { command: string }).command
      : undefined;
  const stdout =
    output && typeof output === 'object' && typeof (output as { stdout?: unknown }).stdout === 'string'
      ? (output as { stdout: string }).stdout.trim() || undefined
      : undefined;
  const stderr =
    output && typeof output === 'object' && typeof (output as { stderr?: unknown }).stderr === 'string'
      ? (output as { stderr: string }).stderr.trim() || undefined
      : undefined;
  const evidence = stdout ?? stderr;
  const lines = [`Completed ${action}.`];
  if (command) lines.push(`Command: \`${command}\``);
  if (evidence) lines.push(evidence);
  return lines.join('\n');
}

function detectBlockedCommand(command: string): string | null {
  const normalized = command.toLowerCase().replace(/\s+/g, ' ').trim();

  // Remote code execution via pipe-to-shell
  if (/\bcurl\b.*\|\s*(bash|sh)\b/.test(normalized)) return 'remote script execution via curl|bash is blocked';
  if (/\bwget\b.*\|\s*(bash|sh)\b/.test(normalized)) return 'remote script execution via wget|bash is blocked';

  // Destructive root operations
  if (/\brm\s+-rf\s+\/(?=[\s;|&)"']|$)/.test(normalized)) return 'destructive delete of root (rm -rf /) is blocked';
  if (/\brm\s+-rf\s+~(?=[\s;|&)"']|$)/.test(normalized)) return 'destructive delete of home (rm -rf ~) is blocked';

  // Filesystem and block device destruction
  if (/\bmkfs(\.| )/.test(normalized)) return 'filesystem formatting (mkfs) is blocked';
  if (/\bdd\s+if=.*\s+of=\/dev\//.test(normalized)) return 'raw block device write (dd to /dev) is blocked';

  // System power state
  if (/\bshutdown\b|\breboot\b|\bhalt\b/.test(normalized)) return 'system power-state command is blocked';

  return null;
}

function detectDangerousCommandWarnings(command: string): string[] {
  const normalized = command.toLowerCase().replace(/\s+/g, ' ').trim();
  const warnings: string[] = [];
  // Patterns that warrant a warning but not outright blocking.
  // Catastrophic patterns (curl|bash, rm -rf /, mkfs, dd to /dev, shutdown)
  // are blocked upstream by detectBlockedCommand.
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
    // P2: Marker so compaction integrity can match XML tool results to calls.
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

  // P4: Pre-insertion size guard — truncate oversized single tool results
  // before they enter conversation.messages. Uses the same per-read cap.
  const estimated = estimateTokens(content);
  if (estimated > settings.maxSingleReadResultTokens) {
    const truncated = truncateForTokenBudget(content, settings.maxSingleReadResultTokens);
    content = truncated.text;
  }

  if (toolCallFormat(response) === 'content_xml') {
    // P1+P3: Flush immediately after accumulating so the per-tool
    // budget check below sees every result. Buffer stays empty (0-1 items).
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
    // Include line ranges in the key: reading different sections of
    // the same file are different operations, not repetition.
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

/**
 * Multi-stage compaction guard (items 1, 2, 5, 6, 8).
 *
 * Tries stages 1-3 of compaction. Returns error on stage 4 (fail-closed)
 * with full diagnostic info.
 */
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

  // Stage 4: fail-closed
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
    // Update conversation messages in-place
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

  // Item 3: Hard read omission — if adding this read would exceed per-turn
  // token budget, omit the read entirely instead of truncating.
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

  // Truncate if exceeds the individual cap
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
    return 0; // Omitted reads consume no tokens
  }
  return estimateTokens(JSON.stringify(toolResult.output));
}

function readPathFromOutput(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const path = (output as { path?: unknown }).path;
  return typeof path === 'string' ? path : undefined;
}

/**
 * Detect when a model claims completion/success without actually doing work.
 * For short responses (< 60 chars), checks the full text. For longer responses,
 * only checks the trailing 40% to avoid false positives from mid-response
 * mentions like "no issues found in the diff, proceeding with edit".
 */
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

  // For short responses, check the full text.
  if (normalized.length < 60) {
    return prematurePhrases.some((phrase) => normalized.includes(phrase));
  }

  // For longer responses, only check the trailing portion.
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
    'therefore',
    'in summary',
    'done',
    'completed',
    'i found',
    'the result',
    'conclusion',
    'here is the answer',
    'this means',
  ];

  return !forbiddenPhrases.some((phrase) => joined.includes(phrase));
}

function finalAnswerNowMessage(): AgentMessage {
  return {
    role: 'system',
    content: [
      'Final step: answer now using only the context already gathered.',
      'Do not call tools, inspect more files, or request more information.',
      'If the context is incomplete, give the best concise answer possible and state the uncertainty.',
    ].join('\n'),
  };
}

function systemPrompt(): string {
  return [
    'You are Synax, a disciplined local coding agent.',
    'Tools: read, write, edit, bash.',
    'Use bash for terminal commands, including git and verification.',
    'Use read only for repository inspection: list files, search text, or read bounded line ranges.',
    'Use write for new text files and edit for exact replacements in files you have already read.',
    'Do the smallest useful action, then stop and summarize changed files plus verification.',
    'When calling a tool, emit only tool calls. Do not mix final-answer prose with tool calls.',
  ].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Format a human-readable summary of the model's response for CLI display.
 * Shows text content (model "thoughts") and tool call intentions.
 */
function formatModelResponseActivity(response: ChatResponse, _step: number): AgentActivity {
  const lines: string[] = [];
  const trimmedContent = response.content.trim();

  if (trimmedContent.length > 0) {
    // Show substantially more model output so users can see what the model is thinking.
    // 1200 chars is enough to surface reasoning, thinking tags, and tool-call intent
    // without flooding the terminal.
    const preview = trimmedContent.length > 1200 ? trimmedContent.slice(0, 1200) + '…' : trimmedContent;
    lines.push(preview);
  }

  if (response.toolCalls.length > 0) {
    const toolNames = response.toolCalls.map((c) => c.name).join(', ');
    lines.push(`→ ${response.toolCalls.length} tool call(s): ${toolNames}`);
  }

  return {
    kind: 'model_response',
    message: lines.join('\n') || '(empty response)',
    modelOutput: response.content,
    toolCallCount: response.toolCalls.length,
  };
}

/**
 * Prepend a compact working-context orientation system message before
 * sending to the model. Not stored in conversation.messages permanently.
 */
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

/**
 * Build the messages sent to the model by assembling (compacting old tool
 * results) and injecting the working context orientation.
 *
 * This is the context-management bridge: every model call goes through here.
 */
function buildModelRequest(
  conversation: AgentConversation,
  settings: ContextBudgetSettings,
  readCounts: Map<string, number>,
  isFinalStep: boolean,
  totalReadCalls?: number,
): AgentMessage[] {
  // Start with conversation messages
  const baseMessages = isFinalStep ? [...conversation.messages, finalAnswerNowMessage()] : conversation.messages;

  // Proactive compaction: compact old tool results
  const { messages: assembled, stats } = assembleModelMessages(
    baseMessages,
    settings,
    conversation.inspectionLedger,
    readCounts,
  );

  // Store stats for debug visibility
  conversation.assemblyStats = stats;

  // Inject working context orientation with compacted-file awareness
  const withOrientation = injectOrientation(
    assembled,
    conversation.inspectionLedger,
    readCounts,
    stats.compactedFilePaths,
  );
  // Read budget warning: fire when approaching the total read limit OR
  // when the model is re-reading files excessively.
  // Placed LAST in the message list for maximum influence on local models.
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
