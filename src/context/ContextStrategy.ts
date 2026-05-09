/**
 * Model-aware context strategy.
 *
 * Replaces the hardcoded 128K context window with an adaptive strategy
 * that calibrates context budget and compaction behavior to the model's
 * actual context window size.
 *
 * Strategy table:
 *   ≤32K    → aggressive  (deterministic + summarization + handoff, 8K reserve)
 *   32K–128K → moderate   (deterministic only, 16K reserve)
 *   128K–1M  → light      (dedup + strip noise, 32K reserve)
 *   1M+      → none       (no compaction, 64K reserve)
 *   unknown  → moderate   (safe default)
 */

// ─── Strategy type ───────────────────────────────────────────────────────────

export type ContextStrategyMode = 'aggressive' | 'moderate' | 'light' | 'none' | 'off';

export interface ContextStrategy {
  mode: ContextStrategyMode;
  /** Human-readable label for reporting. */
  label: string;
  /** Compaction approach. `false` means no compaction. */
  compact: 'deterministic+summarization+handoff' | 'deterministic' | 'dedup+strip' | false;
  /** Output tokens reserved for model responses. */
  reserveTokens: number;
  /** Override for contextWindowTokens (set only for 'off' mode). */
  contextWindowOverride?: number;
}

// ─── Strategy resolution ─────────────────────────────────────────────────────

/**
 * Resolve the context strategy for a given context window size.
 *
 * @param contextWindow - The model's context window in tokens.
 * @returns The resolved ContextStrategy.
 */
export function resolveStrategy(contextWindow: number): ContextStrategy {
  if (contextWindow <= 0) {
    return {
      ...STRATEGIES.moderate,
      mode: 'off' as const,
      label: 'Off (no budget enforcement)',
      compact: false as const,
      reserveTokens: 0,
      contextWindowOverride: Infinity,
    };
  }
  if (contextWindow <= 32_768) {
    return STRATEGIES.aggressive;
  }
  if (contextWindow <= 131_072) {
    return STRATEGIES.moderate;
  }
  if (contextWindow <= 1_000_000) {
    return STRATEGIES.light;
  }
  return STRATEGIES.none;
}

// ─── Strategy presets ────────────────────────────────────────────────────────

const STRATEGIES: Record<Exclude<ContextStrategyMode, 'off'>, ContextStrategy> = {
  aggressive: {
    mode: 'aggressive',
    label: 'Aggressive (≤32K window)',
    compact: 'deterministic+summarization+handoff',
    reserveTokens: 8192,
  },
  moderate: {
    mode: 'moderate',
    label: 'Moderate (32K–128K window)',
    compact: 'deterministic',
    reserveTokens: 16384,
  },
  light: {
    mode: 'light',
    label: 'Light (128K–1M window)',
    compact: 'dedup+strip',
    reserveTokens: 32768,
  },
  none: {
    mode: 'none',
    label: 'None (1M+ window)',
    compact: false,
    reserveTokens: 65536,
  },
};

/**
 * Strategy used when the context window is explicitly disabled.
 */
const OFF_STRATEGY: ContextStrategy & { mode: 'off' } = {
  mode: 'off',
  label: 'Off (no budget enforcement)',
  compact: false,
  reserveTokens: 0,
  contextWindowOverride: Infinity,
};

/**
 * Get the strategy by mode name. Returns undefined for unknown modes.
 */
export function getStrategy(mode: string): ContextStrategy | undefined {
  if (mode === 'off') return OFF_STRATEGY;
  return STRATEGIES[mode as Exclude<ContextStrategyMode, 'off'>];
}

/**
 * Default strategy when context window is unknown.
 */
export const DEFAULT_STRATEGY: ContextStrategy = STRATEGIES.moderate;
