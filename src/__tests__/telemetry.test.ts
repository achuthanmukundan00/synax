import { tuiStats, formatCost, formatPricePer1M } from '../tui/telemetry';
import { CostTracker } from '../metrics/CostTracker';
import { TokenCounter } from '../metrics/TokenCounter';

describe('TUI telemetry', () => {
  beforeEach(() => {
    tuiStats.reset();
  });

  it('starts at zero', () => {
    const stats = tuiStats.getStats();
    expect(stats.cardsRendered).toBe(0);
    expect(stats.repaintCount).toBe(0);
    expect(stats.expandEvents).toBe(0);
  });

  it('records card renders and tracks largest card', () => {
    tuiStats.recordCardRendered(10);
    tuiStats.recordCardRendered(5);
    const stats = tuiStats.getStats();
    expect(stats.cardsRendered).toBe(2);
    expect(stats.largestCardLineCount).toBe(10);
    expect(stats.totalCardLines).toBe(15);
  });

  it('records peak card lines', () => {
    tuiStats.recordCardRendered(3);
    tuiStats.recordCardRendered(20);
    tuiStats.recordCardRendered(7);
    const stats = tuiStats.getStats();
    expect(stats.peakCardLines).toBe(20);
  });

  it('records repaints', () => {
    tuiStats.recordRepaint();
    tuiStats.recordRepaint();
    expect(tuiStats.getStats().repaintCount).toBe(2);
  });

  it('records expand toggles', () => {
    tuiStats.recordExpandToggle();
    tuiStats.recordExpandToggle();
    expect(tuiStats.getStats().expandEvents).toBe(2);
  });

  it('reset clears all stats', () => {
    tuiStats.recordCardRendered(99);
    tuiStats.recordRepaint();
    tuiStats.reset();
    const stats = tuiStats.getStats();
    expect(stats.cardsRendered).toBe(0);
    expect(stats.repaintCount).toBe(0);
    expect(stats.largestCardLineCount).toBe(0);
  });

  it('formatReport returns string with all fields', () => {
    tuiStats.recordCardRendered(5);
    tuiStats.recordRepaint();
    const report = tuiStats.formatReport();
    expect(report).toContain('Cards rendered');
    expect(report).toContain('Repaints');
    expect(report).toContain('Largest card');
  });
});

// ─── Cost formatting ────────────────────────────────────────────────────────

describe('formatCost', () => {
  it('returns $0.00 for zero', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('handles negative values by flipping sign', () => {
    // -0 is treated as 0
    expect(formatCost(-0)).toBe('$0.00');
    expect(formatCost(-1.5)).toBe('-$1.5000');
    expect(formatCost(-0.0005)).toBe('-$0.000500');
  });

  it('uses up to 10 decimal places for sub-cent values (no $0.00 for real API calls)', () => {
    expect(formatCost(0.000001)).toBe('$0.000001');
    expect(formatCost(0.000342)).toBe('$0.000342');
    expect(formatCost(0.009)).toBe('$0.009');
    expect(formatCost(0.00001)).toBe('$0.00001');
    expect(formatCost(Number.EPSILON)).not.toBe('$0.00');
  });

  it('uses 4 decimal places for values ≥ $0.0001 and < $100', () => {
    expect(formatCost(0.0001)).toBe('$0.0001');
    expect(formatCost(0.001)).toBe('$0.0010');
    expect(formatCost(0.01)).toBe('$0.0100');
    expect(formatCost(0.0123)).toBe('$0.0123');
    expect(formatCost(1)).toBe('$1.0000');
    expect(formatCost(1.2345)).toBe('$1.2345');
    expect(formatCost(50.5)).toBe('$50.5000');
    expect(formatCost(99.9999)).toBe('$99.9999');
  });

  it('uses 2 decimal places for values ≥ $100', () => {
    expect(formatCost(100)).toBe('$100.00');
    expect(formatCost(123.45)).toBe('$123.45');
    expect(formatCost(123.456)).toBe('$123.46');
    expect(formatCost(1000.5)).toBe('$1000.50');
  });

  it('handles edge case: exactly at thresholds', () => {
    expect(formatCost(0.0001)).toBe('$0.0001');
    expect(formatCost(100)).toBe('$100.00');
    expect(formatCost(99.9999)).toBe('$99.9999');
  });
});

describe('formatPricePer1M', () => {
  it('strips trailing zeros', () => {
    expect(formatPricePer1M(2.5)).toBe('$2.5/M');
    expect(formatPricePer1M(10.0)).toBe('$10/M');
    expect(formatPricePer1M(0.15)).toBe('$0.15/M');
  });

  it('preserves significant decimal digits', () => {
    expect(formatPricePer1M(0.14)).toBe('$0.14/M');
    expect(formatPricePer1M(1.25)).toBe('$1.25/M');
    expect(formatPricePer1M(2.19)).toBe('$2.19/M');
  });

  it('handles zero pricing (local models)', () => {
    expect(formatPricePer1M(0)).toBe('$0/M');
  });

  it('handles sub-cent per-1M pricing', () => {
    expect(formatPricePer1M(0.0005)).toBe('$0.0005/M');
  });

  it('handles whole-dollar per-1M pricing', () => {
    expect(formatPricePer1M(15)).toBe('$15/M');
    expect(formatPricePer1M(3.0)).toBe('$3/M');
  });
});

describe('CostTracker cost precision', () => {
  /** Create a minimal TokenCounter stub that satisfies the interface. */
  function stubTokenCounter(): TokenCounter {
    return {
      recordTurn: jest.fn(),
      getCumulativeTokens: jest.fn(() => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })),
    } as unknown as TokenCounter;
  }

  it('estimateTurnCost returns precise sub-cent values', () => {
    // gpt-4o-mini: $0.15/M input, $0.60/M output
    const tracker = new CostTracker(stubTokenCounter(), 'openai/gpt-4o-mini');
    const cost = tracker.estimateTurnCost({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    // 100 * 0.15 / 1M = 0.000015, roundCost -> 0.0000 (4dp rounding)
    // 50 * 0.60 / 1M = 0.000030, roundCost -> 0.0000
    expect(cost.inputCost).toBeGreaterThan(0);
    expect(cost.outputCost).toBeGreaterThan(0);
    expect(cost.totalCost).toBeGreaterThan(0);
    // All should be non-zero for real token counts
    expect(cost.inputCost).not.toBe(0);
    expect(cost.outputCost).not.toBe(0);
    expect(cost.totalCost).not.toBe(0);
  });

  it('estimateTurnCost handles larger calls with precision', () => {
    const tracker = new CostTracker(stubTokenCounter(), 'openai/gpt-4o');
    // 5000 input, 2000 output at $2.50/M in, $10.00/M out
    const cost = tracker.estimateTurnCost({ inputTokens: 5000, outputTokens: 2000, totalTokens: 7000 });
    // 5000 * 2.50 / 1M = 0.0125
    // 2000 * 10.0 / 1M = 0.0200
    // total = 0.0325
    expect(cost.inputCost).toBeCloseTo(0.0125, 4);
    expect(cost.outputCost).toBeCloseTo(0.02, 4);
    expect(cost.totalCost).toBeCloseTo(0.0325, 4);
  });

  it('cumulative cost accumulates without intermediate rounding loss', () => {
    const tracker = new CostTracker(stubTokenCounter(), 'openai/gpt-4o-mini');
    // Many small turns that might individually round to zero
    let totalRaw = 0;
    for (let i = 0; i < 100; i++) {
      const inputTokens = 50 + (i % 50);
      const outputTokens = 25 + (i % 25);
      const cost = tracker.recordTurn({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });
      totalRaw += cost.totalCost;
      expect(cost.totalCost).toBeGreaterThanOrEqual(0);
    }
    const cumulative = tracker.getCumulativeCost();
    // After 100 small turns, cumulative should be non-trivial
    expect(cumulative).toBeGreaterThan(0);
    // Cumulative should reflect the sum, not be zero because individual turns rounded down
    expect(cumulative).toBeGreaterThan(0.0001);
  });

  it('free / local models always report zero cost', () => {
    const tracker = new CostTracker(stubTokenCounter(), 'qwen');
    const cost = tracker.estimateTurnCost({ inputTokens: 10000, outputTokens: 5000, totalTokens: 15000 });
    expect(cost.inputCost).toBe(0);
    expect(cost.outputCost).toBe(0);
    expect(cost.totalCost).toBe(0);
    expect(tracker.getCumulativeCost()).toBe(0);
  });

  it('getPricing returns correct pricing for known model', () => {
    const tracker = new CostTracker(stubTokenCounter(), 'openai/gpt-4o-mini');
    const pricing = tracker.getPricing();
    expect(pricing.inputPer1M).toBe(0.15);
    expect(pricing.outputPer1M).toBe(0.6);
  });

  it('isOverBudget compares raw cumulative against budget', () => {
    const tracker = new CostTracker(stubTokenCounter(), 'openai/gpt-4o');
    // A large turn that puts us near budget
    tracker.recordTurn({ inputTokens: 100_000, outputTokens: 40_000, totalTokens: 140_000 });
    // 100k * 2.5 / 1M = 0.25, 40k * 10 / 1M = 0.40, total = 0.65
    expect(tracker.isOverBudget(1.0)).toBe(false);
    expect(tracker.isOverBudget(0.5)).toBe(true);
  });
});
