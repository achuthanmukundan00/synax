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

  // Cache hits are served BEFORE the per-turn budget check: they re-surface
  // content the model already paid for, so refusing them only strands the
  // model (it can neither re-read nor act). They are also marked fromCache
  // so the Session does not charge the read budget twice.
  const signature = readSignature(action);
  const cached = context.readCache.get(signature);
  if (cached) {
    if (showNudge && cached.success && typeof cached.output === 'object' && cached.output !== null) {
      // Return a shallow copy with the nudge appended — do NOT mutate the
      // cached object, which would stick to all future cache hits.
      const nudged = {
        ...cached,
        output: {
          ...(cached.output as Record<string, unknown>),
          guidance:
            'Already read this file. Use search (query) or targeted line ranges (startLine/endLine) to inspect specific sections.',
        },
      };
      return { ...publicToolResult('read', nudged), fromCache: true };
    }
    return { ...publicToolResult('read', cached), fromCache: true };
  }

  // Per-turn read token budget: once cumulative read output exceeds the cap,
  // refuse further uncached reads. The error message is classified as a
  // recoverable policy error (isReadPolicyLimitError), so the model gets a
  // clear signal to act on what it has instead of the turn dying.
  const totalCap = context.readResultBudget.maxTotalReadResultTokensPerTurn;
  if (totalCap > 0 && context.totalReadResultTokens >= totalCap) {
    return {
      success: false,
      error: `total read limit reached: ${context.totalReadResultTokens} tokens of read output this turn (cap ${totalCap}). Stop reading and act on the information you already have (use edit/write/bash), or use search_memory to recall earlier reads. Re-reading identical ranges is still allowed (served from cache).`,
      toolResult: {
        success: false,
        toolName: 'read',
        error: `total read limit reached (cap ${totalCap} tokens per turn)`,
        output: { omitted: true },
      },
    };
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
    let normalized = normalizeReadToolResult(
      result,
      context.readResultBudget,
      context.totalReadResultTokens,
      context.ledger,
    );
    if (showNudge && normalized.success && typeof normalized.output === 'object' && normalized.output !== null) {
      // Create a shallow copy so the nudge does not mutate the cached object
      normalized = {
        ...normalized,
        output: {
          ...(normalized.output as Record<string, unknown>),
          guidance:
            'Already read this file. Use search (query) or targeted line ranges (startLine/endLine) to inspect specific sections.',
        },
      };
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
  _totalReadResultTokens: number,
  _ledger: import('../../tools').InspectionLedger,
): ToolResult {
  if (!result.success) return result;
  // Enforce per-read size limit on the actual output shapes:
  //   read_file_range → { lines: [{lineNumber, text}], ... }
  //   search_text     → { matches: [{path, lineNumber, line}], ... }
  //   list_files      → { files: string[], ... }
  const maxSingle = settings.maxSingleReadResultTokens;
  if (!(maxSingle > 0) || !result.output || typeof result.output !== 'object') return result;

  const output = result.output as Record<string, unknown>;
  const estimatedTokens = estimateTokens(JSON.stringify(output));
  if (estimatedTokens <= maxSingle) return result;

  const truncateArray = <T>(items: T[], serialize: (item: T) => string): { kept: T[]; dropped: number } => {
    let used = 0;
    let cut = items.length;
    for (let i = 0; i < items.length; i += 1) {
      used += estimateTokens(serialize(items[i]));
      if (used > maxSingle) {
        cut = i;
        break;
      }
    }
    // Always keep at least one item so the model gets a usable sample.
    cut = Math.max(cut, 1);
    return { kept: items.slice(0, cut), dropped: items.length - cut };
  };

  if (Array.isArray(output.lines)) {
    const { kept, dropped } = truncateArray(output.lines as Array<{ lineNumber: number; text: string }>, (l) =>
      JSON.stringify(l),
    );
    if (dropped <= 0) return result;
    const lastLine = kept.length > 0 ? kept[kept.length - 1].lineNumber : 0;
    return {
      ...result,
      output: {
        ...output,
        lines: kept,
        endLine: lastLine,
        truncated: true,
        guidance: `Read result truncated (${estimatedTokens} > ${maxSingle} token budget): ${dropped} line(s) after line ${lastLine} omitted. Re-read with startLine=${lastLine + 1} and a bounded endLine to continue.`,
      },
    };
  }

  if (Array.isArray(output.matches)) {
    const { kept, dropped } = truncateArray(output.matches as unknown[], (m) => JSON.stringify(m));
    if (dropped <= 0) return result;
    return {
      ...result,
      output: {
        ...output,
        matches: kept,
        truncated: true,
        guidance: `Search result truncated (${estimatedTokens} > ${maxSingle} token budget): ${dropped} match(es) omitted. Narrow the query or pass a path to scope the search.`,
      },
    };
  }

  if (Array.isArray(output.files)) {
    const { kept, dropped } = truncateArray(output.files as string[], (f) => f);
    if (dropped <= 0) return result;
    return {
      ...result,
      output: {
        ...output,
        files: kept,
        truncated: true,
        guidance: `File listing truncated (${estimatedTokens} > ${maxSingle} token budget): ${dropped} file(s) omitted. Pass a subdirectory path or lower maxFiles.`,
      },
    };
  }

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
