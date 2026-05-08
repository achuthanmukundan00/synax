/**
 * Provider presets registry — maps ProviderId to ProviderPreset.
 *
 * Each preset includes the protocol (openai-compatible or anthropic-messages),
 * default base URL, API key env var, optional headers, and capability flags.
 * OpenAI-compatible providers share one client; Anthropic uses a real adapter.
 */

import type { ProviderId, ProviderPreset } from './types';

// ─── Preset registry ────────────────────────────────────

const providerPresets: Record<ProviderId, ProviderPreset> = {
  relay: {
    id: 'relay',
    protocol: 'openai-compatible',
    displayName: 'Relay (local)',
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKeyRequired: false,
    cloud: false,
    defaultModel: 'Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf',
    contextWindow: 88000,
    supportsStreaming: true,
    supportsToolCalling: true,
  },

  custom: {
    id: 'custom',
    protocol: 'openai-compatible',
    displayName: 'Custom OpenAI-compatible',
    apiKeyRequired: false,
    cloud: false,
    contextWindow: 131072,
    supportsStreaming: true,
    supportsToolCalling: true,
  },

  deepseek: {
    id: 'deepseek',
    protocol: 'openai-compatible',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    apiKeyRequired: true,
    cloud: true,
    defaultModel: 'deepseek-chat',
    contextWindow: 1_000_000,
    supportsStreaming: true,
    supportsToolCalling: true,
    inputPricePer1MTokens: 0.27,
    outputPricePer1MTokens: 1.1,
  },

  openrouter: {
    id: 'openrouter',
    protocol: 'openai-compatible',
    displayName: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    apiKeyRequired: true,
    cloud: true,
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/achuthanmukundan00/synax',
      'X-Title': 'Synax',
    },
    contextWindow: 64000,
    supportsStreaming: true,
    supportsToolCalling: true,
  },

  groq: {
    id: 'groq',
    protocol: 'openai-compatible',
    displayName: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    apiKeyRequired: true,
    cloud: true,
    defaultModel: 'llama-3.3-70b-versatile',
    contextWindow: 128000,
    supportsStreaming: true,
    supportsToolCalling: true,
    inputPricePer1MTokens: 0.59,
    outputPricePer1MTokens: 0.79,
  },

  anthropic: {
    id: 'anthropic',
    protocol: 'anthropic-messages',
    displayName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    apiKeyRequired: true,
    cloud: true,
    defaultModel: 'claude-sonnet-4-5-20250929',
    contextWindow: 200000,
    supportsStreaming: true,
    supportsToolCalling: false, // tool use adapter not implemented yet in this PR
    inputPricePer1MTokens: 3.0,
    outputPricePer1MTokens: 15.0,
  },

  mistral: {
    id: 'mistral',
    protocol: 'openai-compatible',
    displayName: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    apiKeyRequired: true,
    cloud: true,
    defaultModel: 'mistral-large-latest',
    contextWindow: 128000,
    supportsStreaming: true,
    supportsToolCalling: true,
  },

  together: {
    id: 'together',
    protocol: 'openai-compatible',
    displayName: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
    apiKeyRequired: true,
    cloud: true,
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    contextWindow: 128000,
    supportsStreaming: true,
    supportsToolCalling: true,
  },
};

// ─── Export ─────────────────────────────────────────────

export function getProviderPreset(id: string): ProviderPreset | undefined {
  return providerPresets[id as ProviderId];
}

export function getAllProviderPresets(): ProviderPreset[] {
  return Object.values(providerPresets);
}

export function isKnownProviderId(id: string): id is ProviderId {
  return id in providerPresets;
}
