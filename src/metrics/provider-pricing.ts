/**
 * Provider pricing table for token cost estimation.
 *
 * Prices are in USD per 1M tokens. Local models are free.
 * Values sourced from public pricing pages as of 2026-05.
 */

export interface ProviderPricing {
  inputPer1M: number;
  outputPer1M: number;
}

const PRICING: Record<string, ProviderPricing> = {
  // OpenAI
  'openai/gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0 },
  'openai/gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'openai/gpt-4-turbo': { inputPer1M: 10.0, outputPer1M: 30.0 },
  'openai/gpt-3.5-turbo': { inputPer1M: 0.5, outputPer1M: 1.5 },
  'openai/o3-mini': { inputPer1M: 1.1, outputPer1M: 4.4 },
  'openai/o1': { inputPer1M: 15.0, outputPer1M: 60.0 },
  'openai/o1-mini': { inputPer1M: 3.0, outputPer1M: 12.0 },

  // Anthropic
  'anthropic/frontier-sonnet-4-20250514': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'anthropic/frontier-3-5-sonnet': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'anthropic/frontier-3-5-haiku': { inputPer1M: 0.8, outputPer1M: 4.0 },
  'anthropic/frontier-3-opus': { inputPer1M: 15.0, outputPer1M: 75.0 },

  // DeepSeek
  'deepseek/deepseek-v4-pro': { inputPer1M: 0.14, outputPer1M: 0.28 },
  'deepseek/deepseek-v4-flash': { inputPer1M: 0.55, outputPer1M: 2.19 },

  // Google
  'google/gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10.0 },
  'google/gemini-2.5-flash': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'google/gemini-2.0-flash': { inputPer1M: 0.1, outputPer1M: 0.4 },

  // xAI
  'xai/grok-3': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'xai/grok-3-mini': { inputPer1M: 0.3, outputPer1M: 0.5 },

  // Qwen (local models via Relay — free)
  qwen: { inputPer1M: 0, outputPer1M: 0 },
};

/**
 * Resolve pricing for a model string.
 * Matches by prefix (e.g., 'openai/gpt-4o-2024-08-06' matches 'openai/gpt-4o').
 * Returns free pricing for unknown/local models.
 */
export function resolvePricing(model: string): ProviderPricing {
  // Exact match
  if (PRICING[model]) return PRICING[model];

  // Prefix match (longest key first)
  const keys = Object.keys(PRICING).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (model.startsWith(key)) return PRICING[key];
  }

  // Provider-only match (e.g., 'openai/anything' -> 'openai/gpt-4o-mini')
  const provider = model.split('/')[0]?.toLowerCase();
  if (provider) {
    for (const key of keys) {
      if (key.toLowerCase().startsWith(provider + '/')) return PRICING[key];
    }
  }

  // Local/unknown — free
  return { inputPer1M: 0, outputPer1M: 0 };
}

/**
 * Check if a model is a known paid API provider.
 * Local models (qwen, llama, mistral via Relay) return false.
 */
export function isLocalModel(model: string): boolean {
  return resolvePricing(model).inputPer1M === 0;
}
