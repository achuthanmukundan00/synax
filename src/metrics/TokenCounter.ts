/**
 * TokenCounter — wraps existing token estimation for per-turn metrics.
 *
 * Uses the character-based estimator from context-budget.ts
 * for consistency. Counts input tokens (messages sent to model) and
 * output tokens (response content + tool call JSON).
 */

import { estimateMessageTokens, estimateTokens } from '../agent/context-budget';
import type { AgentMessage } from '../session/Session';

/** Approximate token count for a single model turn. */
export interface TurnTokenStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Per-session cumulative token counters. */
export class TokenCounter {
  private cumulativeInput = 0;
  private cumulativeOutput = 0;

  /** Estimate input tokens from the messages sent to the model. */
  countInput(messages: AgentMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += estimateMessageTokens(msg);
    }
    return total;
  }

  /** Estimate output tokens from the model response. */
  countOutput(response: {
    content: string;
    reasoningContent?: string;
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  }): number {
    let total = 0;
    total += estimateTokens(response.content);
    if (response.reasoningContent) {
      total += estimateTokens(response.reasoningContent);
    }
    if (response.toolCalls) {
      for (const call of response.toolCalls) {
        total += estimateTokens(JSON.stringify(call.arguments));
      }
    }
    return total;
  }

  /** Record a turn's token usage into cumulative counters. */
  recordTurn(stats: TurnTokenStats): void {
    this.cumulativeInput += stats.inputTokens;
    this.cumulativeOutput += stats.outputTokens;
  }

  /** Get cumulative stats across all turns tracked by this counter. */
  getCumulative(): { inputTokens: number; outputTokens: number; totalTokens: number } {
    return {
      inputTokens: this.cumulativeInput,
      outputTokens: this.cumulativeOutput,
      totalTokens: this.cumulativeInput + this.cumulativeOutput,
    };
  }
}
