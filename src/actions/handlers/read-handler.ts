/**
 * Read tool handler.
 *
 * Handles: file reads, text search, directory listing, with read cache
 * and per-read size truncation. No per-turn budget — the context window,
 * compaction, and subagent handoff are the natural budget.
 */

import type { ReadAction, ExecutionContext, AgentToolExecutionResult } from '../types';
import type { ToolResult } from '../../tools/types';
import { estimateTokens } from '../../agent/context-budget';

// ─── Public handler ───────────────────────────────────────

export async function handleRead(action: ReadAction, context: ExecutionContext): Promise<AgentToolExecutionResult> {
  const signature = readSignature(action);
  const cached = context.readCache.get(signature);
  if (cached) {
    return { ...publicToolResult('read', cached), fromCache: true };
  }

  if (action.query && action.query.trim().length > 0) {
    const result = await context.registry.execute('search_text', {
      query: action.query,
      path: action.path,
    });
    const normalized = normalizeReadResult(result, context.readResultBudget);
    context.readCache.set(signature, normalized);
    return publicToolResult('read', normalized);
  }

  if (action.path && action.path.trim().length > 0) {
    const result = await context.registry.execute('read_file_range', {
      path: action.path,
      startLine: action.startLine,
      endLine: action.endLine,
    });
    const normalized = normalizeReadResult(result, context.readResultBudget);
    context.readCache.set(signature, normalized);
    return publicToolResult('read', normalized);
  }

  const result = await context.registry.execute('list_files', {
    path: action.path,
    maxFiles: action.maxFiles,
    maxMatches: action.maxMatches,
  });
  const normalized = normalizeReadResult(result, context.readResultBudget);
  context.readCache.set(signature, normalized);
  return publicToolResult('read', normalized);
}

// ─── Cache helpers ────────────────────────────────────────

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

function publicToolResult(toolName: string, result: ToolResult): AgentToolExecutionResult {
  return {
    success: result.success,
    toolResult: { ...result, toolName },
    error: result.error,
  };
}

// ─── Per-read size truncation ─────────────────────────────

/**
 * Truncate oversized read results to stay under the per-read token ceiling.
 * Only the lines/matches/files arrays are truncated; metadata (totalLines,
 * startLine, endLine) passes through intact so the guidance message is accurate.
 */
function normalizeReadResult(
  result: ToolResult,
  settings: import('../../agent/context-budget').ContextBudgetSettings,
): ToolResult {
  if (!result.success) return result;

  const maxSingle = settings.maxSingleReadResultTokens;
  if (!(maxSingle > 0) || !result.output || typeof result.output !== 'object') return result;

  const output = result.output as Record<string, unknown>;
  const estimatedTokens = estimateTokens(JSON.stringify(output));
  if (estimatedTokens <= maxSingle) return result;

  // ── File read (lines array) ──
  if (Array.isArray(output.lines)) {
    const lines = output.lines as Array<{ lineNumber: number; text: string }>;
    const { kept, dropped } = truncateToBudget(lines, (l) => JSON.stringify(l), maxSingle);
    if (dropped <= 0) return result;

    const firstKept = kept[0].lineNumber;
    const lastLine = kept[kept.length - 1].lineNumber;
    const total = typeof output.totalLines === 'number' ? output.totalLines : kept.length + dropped;

    return {
      ...result,
      output: {
        ...output,
        lines: kept,
        endLine: lastLine,
        truncated: true,
        guidance: `Showing lines ${firstKept}-${lastLine} of ${total}. Use startLine=${lastLine + 1} to continue.`,
      },
    };
  }

  // ── Text search (matches array) ──
  if (Array.isArray(output.matches)) {
    const matches = output.matches as unknown[];
    const { kept, dropped } = truncateToBudget(matches, (m) => JSON.stringify(m), maxSingle);
    if (dropped <= 0) return result;

    return {
      ...result,
      output: {
        ...output,
        matches: kept,
        truncated: true,
        guidance: `${dropped} match(es) omitted — narrow the query or pass a path to scope the search.`,
      },
    };
  }

  // ── Directory listing (files array) ──
  if (Array.isArray(output.files)) {
    const files = output.files as string[];
    const { kept, dropped } = truncateToBudget(files, (f) => f, maxSingle);
    if (dropped <= 0) return result;

    return {
      ...result,
      output: {
        ...output,
        files: kept,
        truncated: true,
        guidance: `${dropped} file(s) omitted — pass a subdirectory path or lower maxFiles.`,
      },
    };
  }

  return result;
}

function truncateToBudget<T>(
  items: T[],
  serialize: (item: T) => string,
  budget: number,
): { kept: T[]; dropped: number } {
  let used = 0;
  let cut = items.length;
  for (let i = 0; i < items.length; i += 1) {
    used += estimateTokens(serialize(items[i]));
    if (used > budget) {
      cut = i;
      break;
    }
  }
  cut = Math.max(cut, 1);
  return { kept: items.slice(0, cut), dropped: items.length - cut };
}

/**
 * Estimate token count of a read result for context tracking.
 */
export function estimateReadResultTokens(toolResult: ToolResult): number {
  if (!toolResult.success) return 0;
  const output = toolResult.output;
  if (output && typeof output === 'object' && (output as { omitted?: boolean }).omitted) {
    return 0;
  }
  return estimateTokens(JSON.stringify(toolResult.output));
}
