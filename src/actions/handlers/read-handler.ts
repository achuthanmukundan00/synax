/**
 * Read tool handler — extracted from Session.ts.
 *
 * Handles: file reads, text search, directory listing, with read cache,
 * repetition detection, read budget limits, and result truncation.
 */

import type { ReadAction, ExecutionContext, AgentToolExecutionResult } from '../types';
import type { ToolResult } from '../../tools/types';
import { estimateTokens } from '../../agent/context-budget';

// ─── Constants ────────────────────────────────────────────

// ─── Public handler ───────────────────────────────────────

export async function handleRead(action: ReadAction, context: ExecutionContext): Promise<AgentToolExecutionResult> {
  const repetitionKey = readRepetitionKey(action);
  const seenCount = context.identicalReadCounts.get(repetitionKey) ?? 0;
  context.identicalReadCounts.set(repetitionKey, seenCount + 1);

  const showNudge = seenCount >= 2;

  const signature = readSignature(action);
  const cached = context.readCache.get(signature);
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

  if (action.query && action.query.trim().length > 0) {
    const result = await context.registry.execute('search_text', { query: action.query, path: action.path });
    const normalized = normalizeReadToolResult(
      result,
      context.readResultBudget,
      context.totalReadResultTokens,
      context.ledger,
    );
    context.readCache.set(signature, normalized);
    return publicToolResult('read', normalized);
  }
  if (action.path && action.path.trim().length > 0) {
    const result = await context.registry.execute('read_file_range', {
      path: action.path,
      startLine: action.startLine,
      endLine: action.endLine,
    });
    const normalized = normalizeReadToolResult(
      result,
      context.readResultBudget,
      context.totalReadResultTokens,
      context.ledger,
    );
    if (showNudge && normalized.success && typeof normalized.output === 'object' && normalized.output !== null) {
      (normalized.output as Record<string, unknown>).guidance =
        'Already read this file. Use search (query) or targeted line ranges (startLine/endLine) to inspect specific sections.';
    }
    context.readCache.set(signature, normalized);
    return publicToolResult('read', normalized);
  }
  const result = await context.registry.execute('list_files', {
    path: action.path,
    maxFiles: action.maxFiles,
    maxMatches: action.maxMatches,
  });
  const normalized = normalizeReadToolResult(
    result,
    context.readResultBudget,
    context.totalReadResultTokens,
    context.ledger,
  );
  context.readCache.set(signature, normalized);
  return publicToolResult('read', normalized);
}

// ─── Cache & repetition helpers ───────────────────────────

function readSignature(action: ReadAction): string {
  return JSON.stringify({
    path: action.path,
    query: action.query,
    startLine: action.startLine,
    endLine: action.endLine,
    maxFiles: action.maxFiles,
    maxMatches: action.maxMatches,
  });
}

function readRepetitionKey(action: ReadAction): string {
  if (action.query && action.query.trim().length > 0) {
    return `query:${action.query.trim()}`;
  }
  if (action.path && action.path.trim().length > 0) {
    const start = action.startLine ?? 0;
    const end = action.endLine ?? 0;
    return `path:${action.path.trim()}:${start}-${end}`;
  }
  return 'list:.';
}

function publicToolResult(toolName: string, result: ToolResult): AgentToolExecutionResult {
  return {
    success: result.success,
    toolResult: { ...result, toolName },
    error: result.error,
  };
}

// ─── Read result normalization ────────────────────────────

function normalizeReadToolResult(
  result: ToolResult,
  settings: import('../../agent/context-budget').ContextBudgetSettings,
  totalReadResultTokens: number,
  ledger: import('../../tools').InspectionLedger,
): ToolResult {
  // Dogfooding mode: do not truncate read payloads here.
  // Keep full observability and leave context shaping to higher-level assembly.
  void settings;
  void totalReadResultTokens;
  void ledger;
  if (!result.success) return result;
  return result;
}

/**
 * Estimate the token count of a read result for budget tracking.
 */
export function estimateReadResultTokens(toolResult: ToolResult): number {
  if (!toolResult.success) return 0;
  const output = toolResult.output;
  if (output && typeof output === 'object' && (output as { omitted?: boolean }).omitted) {
    return 0;
  }
  return estimateTokens(JSON.stringify(toolResult.output));
}
