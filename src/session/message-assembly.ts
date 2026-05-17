/**
 * Message assembly — build model-facing message arrays from conversation state.
 *
 * Extracted from Session.ts. Handles:
 *   - Proactive compaction (assembleModelMessages)
 *   - Orientation injection
 *   - Multi-stage budget guard
 *   - Recovery scenario classification
 */

import type { InspectionLedger } from '../tools';
import {
  assembleModelMessages,
  compactMessagesMultiStage,
  estimateRequestTokens,
  formatContextBudgetError,
  summarizeLargestContributors,
  type AssemblyStats,
  type CompactionRecord,
  type ContextBudgetSettings,
} from '../agent/context-budget';
import type { AgentMessage, AgentConversation, AgentTurnResult } from './types';

// ─── Constants ───────────────────────────────────────────────────────────────

export const MAX_TOTAL_READS_PER_TURN = 64;

// ─── Orientation injection ───────────────────────────────────────────────────

export function injectOrientation(
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

// ─── Memory index injection ──────────────────────────────────────────────────

/**
 * Inject a compact FTS5 memory index as a system message.
 * Tells the model what's searchable in memory without burning context on content.
 * Returns the messages unchanged if the index is null/empty.
 */
export function injectMemoryIndex(messages: AgentMessage[], index: string | null): AgentMessage[] {
  if (!index) return messages;
  // Inject after the first system message (main prompt), before rest
  const result = [...messages];
  const sysIdx = result.findIndex((m) => m.role === 'system');
  const insertAt = sysIdx >= 0 ? sysIdx + 1 : 0;
  result.splice(insertAt, 0, { role: 'system', content: index });
  return result;
}

// ─── Model request builder ───────────────────────────────────────────────────

export function buildModelRequest(
  conversation: AgentConversation,
  settings: ContextBudgetSettings,
  readCounts: Map<string, number>,
  totalReadCalls?: number,
  memoryIndex?: string | null,
): AgentMessage[] {
  const baseMessages = conversation.messages;

  const effectiveLimit = settings.contextWindowTokens - settings.reservedOutputTokens;
  const estimatedTokens = estimateRequestTokens(baseMessages);

  // Strategy-aware compaction threshold:
  // - 'none'/'off': never compact proactively (threshold = 1.0)
  // - 'light': rarely compact proactively (threshold = 0.95)
  // - default: existing behavior (threshold = 0.8)
  const baseThreshold = settings.assemblyCompactionThreshold ?? 0.8;
  const threshold =
    settings.strategyMode === 'none' || settings.strategyMode === 'off'
      ? 1.0
      : settings.strategyMode === 'light'
        ? 0.95
        : baseThreshold;
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

  // When tool results were compacted, add an explanatory system message
  // so the model understands the compacted format and treats metadata as authoritative.
  const withCompactionNote: AgentMessage[] =
    stats.compactedToolResults > 0
      ? [
          {
            role: 'system',
            content: `Note: ${stats.compactedToolResults} older tool result(s) have been summarized to save context space. The metadata is complete — each compacted result includes a "summary" field describing what was originally returned. Use the appropriate tool (read, bash, etc.) to fetch full content if needed. Treat all metadata (paths, line ranges, counts) as authoritative.`,
          },
          ...withOrientation,
        ]
      : withOrientation;

  const withMemory = injectMemoryIndex(withCompactionNote, memoryIndex ?? null);

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
    const finalMessages = [...withMemory, warning];
    stats.totalMessagesOut = finalMessages.length;
    stats.estimatedTokensOut = estimateRequestTokens(finalMessages);
    return finalMessages;
  }

  stats.totalMessagesOut = withMemory.length;
  stats.estimatedTokensOut = estimateRequestTokens(withMemory);
  return withMemory;
}

// ─── Budget guard ────────────────────────────────────────────────────────────

export function guardModelRequestMultiStage(
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

// ─── Recovery classification ─────────────────────────────────────────────────

/**
 * Classify a turn result for recovery eligibility.
 * Returns the failure scenario if the result indicates a recoverable failure.
 */
export function classifyResultForRecovery(result: AgentTurnResult): import('../recovery/types').FailureScenario | null {
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

  // Tool error with possible loop
  if (result.terminalState === 'tool_error' && result.error?.includes('too many consecutive')) {
    return 'infinite_loop';
  }

  // Bash failures: treat non-zero exits, timeouts, and signal kills as
  // recoverable. Skip tool-level errors (e.g., ENOENT on bash itself) —
  // those are infrastructure failures, not recoverable command issues.
  if (
    result.terminalState === 'tool_error' &&
    result.toolCalls.some((tc) => tc.name === 'bash' && !tc.success) &&
    result.error &&
    /(?:error|exit|status|signal|killed|timeout|terminated)/i.test(result.error)
  ) {
    return 'bash_failure';
  }

  // Malformed tool call from model
  if (
    result.terminalState === 'model_error' &&
    result.error &&
    (result.error.toLowerCase().includes('malformed tool call') ||
      result.error.toLowerCase().includes('tool_call block missing') ||
      result.error.toLowerCase().includes('tool_call block contained malformed'))
  ) {
    return 'malformed_tool_call';
  }

  // Budget exhaustion
  if (result.terminalState === 'budget_exhausted') {
    return 'context_exhaustion';
  }

  return null;
}
