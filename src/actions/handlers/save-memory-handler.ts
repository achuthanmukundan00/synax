/**
 * save_memory handler — explicit memory persistence.
 *
 * The agent calls this tool to persist notes, preferences, decisions,
 * or findings for future retrieval via search_memory.
 *
 * Generic — not product-specific. Works with any MemoryAdapter
 * (HolographicMemory, or external adapters like AutoCareerMemoryAdapter).
 */

import type { ActionHandler, AgentToolExecutionResult } from '../types';
import type { HolographicMemory } from '../../memory/HolographicMemory';
import { toolFailure } from '../types';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SaveMemoryAction {
  kind: 'save_memory';
  content: string;
  domainTags?: string[];
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export const handleSaveMemory: ActionHandler = async (
  action,
  context,
): Promise<AgentToolExecutionResult> => {
  const input = action as unknown as SaveMemoryAction;
  const memory = context.memory as HolographicMemory | undefined;

  const content = input.content?.trim();
  if (!content) {
    return toolFailure('save_memory', 'content is required — provide the text to persist');
  }

  if (!memory) {
    return {
      success: true,
      toolResult: {
        success: true,
        toolName: 'save_memory',
        output: {
          saved: false,
          note: 'Memory persistence is not available (no memory adapter wired). Content was not saved.',
          content,
        },
      },
    };
  }

  if (!memory.isAvailable) {
    return {
      success: true,
      toolResult: {
        success: true,
        toolName: 'save_memory',
        output: {
          saved: false,
          note: 'Memory is currently unavailable (persistence errors). Content was not saved.',
          content,
        },
      },
    };
  }

  try {
    memory.store({
      sessionId: '', // cross-session entry
      turnId: 0,
      role: 'user',
      content: content.slice(0, 8000),
      domainTags: input.domainTags,
    });

    return {
      success: true,
      toolResult: {
        success: true,
        toolName: 'save_memory',
        output: {
          saved: true,
          content: content.slice(0, 500),
          domainTags: input.domainTags,
        },
      },
    };
  } catch (err) {
    return toolFailure(
      'save_memory',
      `Failed to persist: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};
