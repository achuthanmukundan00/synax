/**
 * Read tool handler — extracted from Session.ts.
 *
 * Handles: file reads, text search, directory listing, with read cache,
 * repetition detection, read budget limits, and result truncation.
 */

import type { ReadAction, ExecutionContext, AgentToolExecutionResult } from '../types';
import { toolFailure } from '../types';
import type { ToolResult } from '../../tools/types';
import { estimateTokens, truncateForTokenBudget } from '../../agent/context-budget';

// ─── Constants ────────────────────────────────────────────

const MAX_TOTAL_READS_PER_TURN = 64;
const MAX_IDENTICAL_READS_PER_TURN = 3;

// ─── Public handler ───────────────────────────────────────

export async function handleRead(action: ReadAction, context: ExecutionContext): Promise<AgentToolExecutionResult> {
  if (context.totalReadCalls >= MAX_TOTAL_READS_PER_TURN) {
    return toolFailure('read', `total read limit reached for this turn: ${MAX_TOTAL_READS_PER_TURN}`);
  }

  const repetitionKey = readRepetitionKey(action);
  const seenCount = context.identicalReadCounts.get(repetitionKey) ?? 0;

  if (seenCount >= MAX_IDENTICAL_READS_PER_TURN) {
    const orientation = context.ledger.getOrientation();
    return toolFailure(
      'read',
      `Read loop detected: same file/query read ${seenCount + 1} times. ` +
        `Use targeted reads or search instead.\n\n${orientation}`,
    );
  }
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

function readPathFromOutput(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const path = (output as { path?: unknown }).path;
  return typeof path === 'string' ? path : undefined;
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
