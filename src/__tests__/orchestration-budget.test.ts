/**
 * Tests for orchestration budget estimation (spec 021 phase 1).
 *
 * Covers:
 * - BudgetEstimate type and estimateTaskBudget() function
 * - Strategy classification thresholds (inline, orchestrate, decompose)
 * - Small/medium/large repo scenarios at known context window sizes
 * - Fallback token estimation when no TokenCounter available
 * - Component breakdown accuracy
 */

import { estimateTaskBudget, type RepoMetadata } from '../agent/context-budget';
import { TokenCounter } from '../metrics/TokenCounter';

// ─── Test helpers ────────────────────────────────────────────────────────────

function smallRepo(): RepoMetadata {
  return { fileCount: 20, totalKB: 200, sourceKB: 150 };
}

function mediumRepo(): RepoMetadata {
  return { fileCount: 200, totalKB: 5000, sourceKB: 3000 };
}

function largeRepo(): RepoMetadata {
  return { fileCount: 2000, totalKB: 50000, sourceKB: 30000 };
}

function tinyTask(): string {
  return 'add a comment to the main function';
}

function mediumTask(): string {
  return (
    'refactor the authentication module to use a strategy pattern. ' +
    'Split the current monolithic auth.ts into separate provider files, ' +
    'add proper error handling for each provider, and update all callers. ' +
    'Write tests for the new structure. Update the README with the new API.'
  );
}

function largeTask(): string {
  return (
    'Migrate the entire codebase from CommonJS to ES modules. '.repeat(20) +
    'This includes updating all import/export statements, updating the ' +
    'build configuration, fixing all circular dependencies, updating test ' +
    'configurations, and ensuring all tooling works correctly. '.repeat(20)
  );
}

// ─── 1. Strategy classification thresholds ───────────────────────────────────

describe('strategy classification thresholds', () => {
  it('classifies small task in large context window as inline', () => {
    const result = estimateTaskBudget({
      task: tinyTask(),
      repoMetadata: smallRepo(),
      contextWindow: 131072, // 128K
    });

    expect(result.strategy).toBe('inline');
    expect(result.utilization).toBeLessThan(0.5);
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.safetyMargin).toBeGreaterThan(0);
  });

  it('classifies medium task in 32K context as orchestrate', () => {
    // Medium task + medium repo should push utilization into 50-90% range for 32K
    const result = estimateTaskBudget({
      task: mediumTask(),
      repoMetadata: mediumRepo(),
      contextWindow: 32768, // 32K
    });

    // Should be at least 'orchestrate' (may be 'decompose' if task is very large)
    expect(['orchestrate', 'decompose']).toContain(result.strategy);
    // Utilization should be significant
    expect(result.utilization).toBeGreaterThan(0.3);
  });

  it('classifies large task in 32K context as decompose', () => {
    const result = estimateTaskBudget({
      task: largeTask(),
      repoMetadata: largeRepo(),
      contextWindow: 32768, // 32K
    });

    expect(result.strategy).toBe('decompose');
    // Utilization should be near or at 1.0 (capped)
    expect(result.utilization).toBeGreaterThanOrEqual(0.9);
  });

  it('classifies large task in 128K context as orchestrate or decompose', () => {
    const result = estimateTaskBudget({
      task: largeTask(),
      repoMetadata: largeRepo(),
      contextWindow: 131072, // 128K
    });

    expect(['orchestrate', 'decompose']).toContain(result.strategy);
  });

  it('classifies everything as inline for 1M context window', () => {
    const result = estimateTaskBudget({
      task: largeTask(),
      repoMetadata: largeRepo(),
      contextWindow: 1048576, // 1M
    });

    expect(result.strategy).toBe('inline');
    expect(result.utilization).toBeLessThan(0.5);
  });
});

// ─── 2. Small/medium/large repo scenarios ─────────────────────────────────────

describe('repo size scenarios', () => {
  it('small repo + small task in 32K is inline', () => {
    const result = estimateTaskBudget({
      task: tinyTask(),
      repoMetadata: smallRepo(),
      contextWindow: 32768,
    });

    expect(result.strategy).toBe('inline');
    // Task is tiny, repo is small → utilization should be low
    expect(result.utilization).toBeLessThan(0.2);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('large repo alone pushes utilization up even for small task', () => {
    const result = estimateTaskBudget({
      task: tinyTask(),
      repoMetadata: largeRepo(),
      contextWindow: 32768,
    });

    // Large repo overhead may push utilization into orchestrate range
    expect(result.estimatedTokens).toBeGreaterThan(result.breakdown.taskTokens);
    expect(result.breakdown.repoOverheadTokens).toBeGreaterThan(result.breakdown.taskTokens);
  });

  it('empty repo metadata works', () => {
    const result = estimateTaskBudget({
      task: tinyTask(),
      repoMetadata: { fileCount: 0, totalKB: 0, sourceKB: 0 },
      contextWindow: 32768,
    });

    expect(result.strategy).toBe('inline');
    expect(result.breakdown.repoOverheadTokens).toBe(0);
    expect(result.breakdown.taskTokens).toBeGreaterThan(0);
  });
});

// ─── 3. Component breakdown tests ─────────────────────────────────────────────

describe('component breakdown', () => {
  it('includes taskTokens, repoOverheadTokens, and systemOverheadTokens', () => {
    const result = estimateTaskBudget({
      task: mediumTask(),
      repoMetadata: mediumRepo(),
      contextWindow: 131072,
    });

    expect(result.breakdown).toBeDefined();
    expect(result.breakdown.taskTokens).toBeGreaterThan(0);
    expect(result.breakdown.repoOverheadTokens).toBeGreaterThan(0);
    expect(result.breakdown.systemOverheadTokens).toBeGreaterThan(0);
    expect(result.estimatedTokens).toBe(
      result.breakdown.taskTokens + result.breakdown.repoOverheadTokens + result.breakdown.systemOverheadTokens,
    );
  });

  it('repo overhead scales with fileCount and sourceKB', () => {
    const small = estimateTaskBudget({
      task: tinyTask(),
      repoMetadata: smallRepo(),
      contextWindow: 131072,
    });
    const large = estimateTaskBudget({
      task: tinyTask(),
      repoMetadata: largeRepo(),
      contextWindow: 131072,
    });

    // Large repo should have more overhead than small repo for same task
    expect(large.breakdown.repoOverheadTokens).toBeGreaterThan(small.breakdown.repoOverheadTokens);
    // Task tokens should be identical since the task is the same
    expect(large.breakdown.taskTokens).toBe(small.breakdown.taskTokens);
  });

  it('safetyMargin equals effectiveWindow minus estimatedTokens', () => {
    const result = estimateTaskBudget({
      task: mediumTask(),
      repoMetadata: mediumRepo(),
      contextWindow: 32768,
    });

    // Reserved output for 32K is 8192, so effective = 32768 - 8192 = 24576
    const expectedEffectiveWindow = 32768 - 8192;
    expect(result.safetyMargin).toBe(Math.max(0, expectedEffectiveWindow - result.estimatedTokens));
  });
});

// ─── 4. TokenCounter vs fallback estimation ───────────────────────────────────

describe('token counter integration', () => {
  it('uses TokenCounter when provided', () => {
    const counter = new TokenCounter();
    const withCounter = estimateTaskBudget({
      task: mediumTask(),
      repoMetadata: mediumRepo(),
      contextWindow: 131072,
      tokenCounter: counter,
    });

    const withoutCounter = estimateTaskBudget({
      task: mediumTask(),
      repoMetadata: mediumRepo(),
      contextWindow: 131072,
    });

    // TokenCounter serializes the message while fallback counts the raw task,
    // so they should still differ even when both use the shared estimator.
    expect(withCounter.breakdown.taskTokens).not.toBe(withoutCounter.breakdown.taskTokens);
  });

  it('TokenCounter-based estimation uses the shared estimator for consistency with existing system', () => {
    const counter = new TokenCounter();
    const task = 'hello world';
    const result = estimateTaskBudget({
      task,
      repoMetadata: { fileCount: 0, totalKB: 0, sourceKB: 0 },
      contextWindow: 32768,
      tokenCounter: counter,
    });

    // TokenCounter serializes the message as JSON before counting.
    const expectedTokens = counter.countInput([{ role: 'user', content: task }]);
    expect(result.breakdown.taskTokens).toBe(expectedTokens);
    expect(result.breakdown.taskTokens).toBeGreaterThan(0);
  });

  it('fallback estimation uses chars/4 when no TokenCounter', () => {
    const task = 'hello world';
    const result = estimateTaskBudget({
      task,
      repoMetadata: { fileCount: 0, totalKB: 0, sourceKB: 0 },
      contextWindow: 32768,
    });

    // Fallback uses Math.ceil(text.length / 4)
    // For "hello world" (11 chars) → ceil(11/4) = 3
    expect(result.breakdown.taskTokens).toBe(Math.ceil(task.length / 4));
  });
});

// ─── 5. Edge cases ────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles zero context window gracefully', () => {
    const result = estimateTaskBudget({
      task: tinyTask(),
      repoMetadata: smallRepo(),
      contextWindow: 0,
    });

    expect(result.strategy).toBe('decompose');
    expect(result.utilization).toBe(1);
    expect(result.safetyMargin).toBe(0);
  });

  it('handles very small context window (1 token)', () => {
    const result = estimateTaskBudget({
      task: tinyTask(),
      repoMetadata: smallRepo(),
      contextWindow: 1,
    });

    expect(result.strategy).toBe('decompose');
  });

  it('handles empty task string', () => {
    const result = estimateTaskBudget({
      task: '',
      repoMetadata: smallRepo(),
      contextWindow: 32768,
    });

    expect(result.breakdown.taskTokens).toBe(0);
    expect(result.estimatedTokens).toBe(result.breakdown.repoOverheadTokens + result.breakdown.systemOverheadTokens);
  });

  it('utilization is capped at 1.0', () => {
    const result = estimateTaskBudget({
      task: largeTask(),
      repoMetadata: largeRepo(),
      contextWindow: 1000, // Very tight window
    });

    expect(result.utilization).toBeLessThanOrEqual(1);
  });

  it('contextWindowTokens is preserved in the result', () => {
    const cw = 65536;
    const result = estimateTaskBudget({
      task: tinyTask(),
      repoMetadata: smallRepo(),
      contextWindow: cw,
    });

    expect(result.contextWindowTokens).toBe(cw);
  });
});

// ─── 6. Per-model context window size scenarios ───────────────────────────────

describe('per-model context window scenarios', () => {
  const task = mediumTask();
  const repo = mediumRepo();

  it('32K context window (Qwen GGUF default) tends toward orchestrate/decompose', () => {
    const result = estimateTaskBudget({ task, repoMetadata: repo, contextWindow: 32768 });
    // A medium task in medium repo on 32K should not be trivially inline
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.safetyMargin).toBeGreaterThanOrEqual(0);
    // Strategy should reflect the constrained window
    expect(['orchestrate', 'decompose']).toContain(result.strategy);
  });

  it('128K context window (GPT-4o, Llama API) tends toward inline', () => {
    const result = estimateTaskBudget({ task, repoMetadata: repo, contextWindow: 131072 });
    // A medium task + medium repo should fit well in 128K
    expect(result.strategy).toBe('inline');
    expect(result.utilization).toBeLessThan(0.5);
  });

  it('1M context window (DeepSeek) is always inline for normal repos', () => {
    const result = estimateTaskBudget({ task, repoMetadata: repo, contextWindow: 1048576 });
    expect(result.strategy).toBe('inline');
    expect(result.utilization).toBeLessThan(0.1);
  });

  it('8K context window (Llama GGUF default) is very constrained', () => {
    const result = estimateTaskBudget({ task, repoMetadata: repo, contextWindow: 8192 });
    // Even a medium task alone may push 8K into decompose territory
    expect(['orchestrate', 'decompose']).toContain(result.strategy);
    expect(result.safetyMargin).toBeLessThan(8192);
  });
});
