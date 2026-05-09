/**
 * search_memory handler — FTS5-powered conversation history search.
 *
 * The agent calls this tool to retrieve past context from holographic memory
 * instead of re-reading files or relying on degraded summaries.
 *
 * Results are formatted for model consumption with turn, role, tool, paths.
 */

import type { ActionHandler, AgentToolExecutionResult } from '../types';
import type { HolographicMemory } from '../../memory/HolographicMemory';
import { toolFailure } from '../types';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SearchMemoryAction {
  kind: 'search_memory';
  query: string;
  maxResults?: number;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export const handleSearchMemory: ActionHandler = async (action, context): Promise<AgentToolExecutionResult> => {
  const input = action as unknown as SearchMemoryAction;
  const memory = context.memory as HolographicMemory | undefined;

  if (!memory || !memory.isAvailable) {
    return {
      success: true,
      toolResult: {
        success: true,
        toolName: 'search_memory',
        output: { results: [], count: 0, note: 'Memory is not available (no SQLite persistence).' },
      },
    };
  }

  const query = input.query?.trim();
  if (!query) {
    return toolFailure('search_memory', 'query is required');
  }

  const maxResults = input.maxResults && input.maxResults > 0 ? Math.min(input.maxResults, 20) : 10;

  try {
    const results = memory.search(query, maxResults);

    // Format results for model consumption
    const formatted = results.map((r, i) => ({
      index: i + 1,
      turn: r.turnId,
      role: r.role,
      toolName: r.toolName || undefined,
      filePaths: r.filePaths ? r.filePaths.split(',').map((p) => p.trim()) : undefined,
      content: r.content.length > 500 ? r.content.slice(0, 500) + '...' : r.content,
      relevance: r.rank,
    }));

    return {
      success: true,
      toolResult: {
        success: true,
        toolName: 'search_memory',
        output: {
          query,
          results: formatted,
          count: formatted.length,
          note:
            formatted.length === 0
              ? 'No matching history found. Try different search terms.'
              : `Found ${formatted.length} result(s). Higher relevance = more specific match.`,
        },
      },
    };
  } catch (err) {
    return toolFailure('search_memory', `Search failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
