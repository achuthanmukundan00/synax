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
  estimateIncrementalTokens,
  estimateRequestTokens,
  formatContextBudgetError,
  resetTokenLedger,
  summarizeLargestContributors,
  type AssemblyStats,
  type CompactionRecord,
  type ContextBudgetSettings,
} from '../agent/context-budget';
import type { AgentMessage, AgentConversation, AgentTurnResult } from './types';

// ─── Constants ───────────────────────────────────────────────────────────────

export const MAX_TOTAL_READS_PER_TURN = 24;

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

// ─── Model request builder ───────────────────────────────────────────────────

export function buildModelRequest(
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
