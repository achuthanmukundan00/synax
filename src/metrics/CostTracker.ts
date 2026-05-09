/**
 * CostTracker — estimates API costs from token usage and provider pricing.
 *
 * Uses the TokenCounter for token counts and provider-pricing.ts for rates.
 * Local models always report $0.00.
 */

import { resolvePricing } from './provider-pricing';
import type { TokenCounter, TurnTokenStats } from './TokenCounter';

export interface TurnCost {
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

export class CostTracker {
  private tokenCounter: TokenCounter;
  private model: string;
  private cumulativeCost = 0;

  constructor(tokenCounter: TokenCounter, model: string) {
    this.tokenCounter = tokenCounter;
    this.model = model;
  }

  /** Estimate the cost of a single turn. */
  estimateTurnCost(stats: TurnTokenStats): TurnCost {
    const pricing = resolvePricing(this.model);
    const inputCost = (stats.inputTokens / 1_000_000) * pricing.inputPer1M;
    const outputCost = (stats.outputTokens / 1_000_000) * pricing.outputPer1M;
    return {
      inputCost: roundCost(inputCost),
      outputCost: roundCost(outputCost),
      totalCost: roundCost(inputCost + outputCost),
    };
  }

  /** Record a turn and accumulate cost. */
  recordTurn(stats: TurnTokenStats): TurnCost {
    this.tokenCounter.recordTurn(stats);
    const cost = this.estimateTurnCost(stats);
    this.cumulativeCost += cost.totalCost;
    return cost;
  }

  /** Get the cumulative cost across all recorded turns. */
  getCumulativeCost(): number {
    return roundCost(this.cumulativeCost);
  }

  /** Get pricing info for the current model. */
  getPricing(): { inputPer1M: number; outputPer1M: number } {
    return resolvePricing(this.model);
  }

  /** Check whether a budget limit has been exceeded. */
  isOverBudget(maxBudget: number): boolean {
    return this.cumulativeCost > maxBudget;
  }
}

function roundCost(value: number): number {
  return Math.round(value * 10000) / 10000;
}
