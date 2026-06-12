/**
 * Provider factory — creates the correct LLM client for a given provider config.
 *
 * Protocol routing:
 *  - openai-compatible → shared OpenAI-compatible client (createOpenAICompatibleClient)
 *  - anthropic-messages → Anthropic Messages adapter (createAnthropicAdapter)
 *
 * The factory normalizes config, applies presets, resolves API keys,
 * merges custom headers, and exposes provider metadata.
 */

import { createOpenAICompatibleClient } from './client';
import { createAnthropicAdapter } from './anthropic-adapter';
import { getAllProviderPresets, getProviderPreset, isKnownProviderId, resolveContextWindow } from './provider-presets';
import type { AgentClient } from '../session/Session';
import type { NormalizedProviderConfig, ProviderMetadata, ProviderPreset, ProviderProtocol } from './types';
import type { ContextLedger } from '../tools';

// ─── Config input (what callers pass) ──────────────────

export interface ProviderFactoryInput {
  provider?: string; // provider ID (e.g., 'deepseek', 'anthropic', 'relay')
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  customHeaders?: Record<string, string>;
  timeoutMs?: number;
  contextWindow?: number;
  /** Legacy: preset field from old config format */
  preset?: string;
  /** Legacy: kind from old format */
  kind?: string;
  /** Price per 1M input tokens in USD (overrides preset default). */
  inputPricePer1MTokens?: number;
  /** Price per 1M output tokens in USD (overrides preset default). */
  outputPricePer1MTokens?: number;
  /** Thinking level for providers that support extended reasoning (e.g. DeepSeek). */
  thinkingLevel?: import('../config/schema').ThinkingLevel;
  /** Per-provider max output token limit. */
  maxOutputTokens?: number;
}

// ─── Factory result ────────────────────────────────────

export interface ProviderFactoryResult {
  client: AgentClient;
  metadata: ProviderMetadata;
  normalizedConfig: NormalizedProviderConfig;
}

interface ResolvedProviderFactoryConfig {
  preset: ProviderPreset;
  metadata: ProviderMetadata;
  normalizedConfig: NormalizedProviderConfig;
  apiKey?: string;
}

// ─── Normalization ─────────────────────────────────────

function resolveProviderId(input: ProviderFactoryInput): string {
  // Explicit provider id takes precedence
  if (input.provider && input.provider.trim().length > 0) {
    return input.provider.trim().toLowerCase();
  }
  // Legacy: preset or kind
  if (input.preset && isKnownProviderId(input.preset)) {
    return input.preset;
  }
  if (input.kind === 'anthropic-messages') {
    return 'anthropic';
  }
  if (input.kind === 'openai-compatible') {
    return 'custom';
  }
  return 'relay';
}

function resolveApiKey(input: ProviderFactoryInput, presetApiKeyEnv?: string): string | undefined {
  // Explicit apiKey wins
  if (input.apiKey && input.apiKey.trim().length > 0) {
    return input.apiKey.trim();
  }
  // apiKeyEnv
  const envVar = input.apiKeyEnv ?? presetApiKeyEnv;
  if (envVar) {
    const fromEnv = process.env[envVar];
    if (fromEnv && fromEnv.trim().length > 0) {
      return fromEnv.trim();
    }
  }
  return undefined;
}

// ─── Factory ───────────────────────────────────────────

export function describeLLMProvider(
  input: ProviderFactoryInput,
): Pick<ProviderFactoryResult, 'metadata' | 'normalizedConfig'> {
  const { metadata, normalizedConfig } = resolveProviderConfig(input);
  return { metadata, normalizedConfig };
}

function resolveProviderConfig(input: ProviderFactoryInput): ResolvedProviderFactoryConfig {
  const providerId = resolveProviderId(input);
  const preset = getProviderPreset(providerId);

  if (!preset) {
    throw Object.assign(
      new Error(
        `Unknown provider: "${providerId}". Known providers: ${getAllProviderPresets()
          .map((p) => p.id)
          .join(', ')}`,
      ),
      { name: 'ProviderError', type: 'invalidRequest', statusCode: 400, retryable: false },
    );
  }

  const protocol: ProviderProtocol = preset.protocol;
  const baseUrl = input.baseUrl ?? preset.baseUrl ?? '';
  const apiKeyEnv = input.apiKeyEnv ?? preset.apiKeyEnv;
  const apiKey = resolveApiKey(input, preset.apiKeyEnv);

  const model = input.model ?? preset.defaultModel ?? '';
  // Context window: explicit input > per-model canonical > provider preset > fallback.
  // The config DEFAULTS (contextWindowTokens: 131072) should not override
  // known provider presets — that's handled by ensuring toProviderFactoryInput
  // only passes an explicit user setting. Here we trust the resolved value.
  const contextWindow = input.contextWindow ?? resolveContextWindow(providerId, model || undefined);

  // Merge default headers from preset with custom headers
  const mergedHeaders: Record<string, string> = {};
  if (preset.defaultHeaders) {
    Object.assign(mergedHeaders, preset.defaultHeaders);
  }
  if (input.customHeaders) {
    Object.assign(mergedHeaders, input.customHeaders);
  }

  // Custom headers take precedence over preset defaults.

  // Build normalized config for OpenAI-compatible path
  const normalizedConfig: NormalizedProviderConfig = {
    kind: protocol === 'openai-compatible' ? 'openai-compatible' : 'anthropic-messages',
    baseUrl,
    model,
    apiKey,
    customHeaders: Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
    timeoutMs: input.timeoutMs ?? 3600000,
    thinkingLevel: input.thinkingLevel,
    maxOutputTokens: input.maxOutputTokens,
  };

  // Build metadata for TUI/status display
  const metadata: ProviderMetadata = {
    providerId,
    displayName: preset.displayName,
    modelId: model,
    protocol,
    baseUrl: baseUrl || '(not set)',
    cloud: preset.cloud,
    contextWindow,
    streamingSupported: preset.supportsStreaming ?? false,
    toolCallingSupported: preset.supportsToolCalling ?? false,
    apiKeyRequired: preset.apiKeyRequired || Boolean(apiKeyEnv?.trim()),
    apiKeyConfigured: !!apiKey,
    inputPricePer1MTokens: input.inputPricePer1MTokens ?? preset.inputPricePer1MTokens,
    outputPricePer1MTokens: input.outputPricePer1MTokens ?? preset.outputPricePer1MTokens,
  };

  return { preset, metadata, normalizedConfig, apiKey };
}

export function createLLMClient(input: ProviderFactoryInput, opts?: { ledger?: ContextLedger }): ProviderFactoryResult {
  const { preset, metadata, normalizedConfig, apiKey } = resolveProviderConfig(input);
  const protocol: ProviderProtocol = preset.protocol;
  const model = normalizedConfig.model;
  const baseUrl = normalizedConfig.baseUrl;

  if (!baseUrl && protocol === 'openai-compatible' && metadata.providerId === 'custom') {
    throw Object.assign(new Error('baseUrl is required for custom provider. Set base_url in your config.'), {
      name: 'ProviderError',
      type: 'invalidRequest',
      statusCode: 400,
      retryable: false,
    });
  }

  if (!model) {
    throw Object.assign(new Error(`Model is required for ${preset.displayName}. Set model in your config.`), {
      name: 'ProviderError',
      type: 'invalidRequest',
      statusCode: 400,
      retryable: false,
    });
  }

  if (metadata.apiKeyRequired && !apiKey) {
    const envHint =
      (input.apiKeyEnv ?? preset.apiKeyEnv)
        ? ` Set the ${input.apiKeyEnv ?? preset.apiKeyEnv} environment variable or provide api_key in config.`
        : '';
    throw Object.assign(new Error(`API key is required for ${preset.displayName}.${envHint}`), {
      name: 'ProviderError',
      type: 'auth',
      statusCode: 401,
      retryable: false,
    });
  }

  // Route to correct protocol
  let client: AgentClient;

  if (protocol === 'anthropic-messages') {
    if (!apiKey) {
      throw Object.assign(new Error(`API key is required for Anthropic. Set ANTHROPIC_API_KEY.`), {
        name: 'ProviderError',
        type: 'auth',
        statusCode: 401,
        retryable: false,
      });
    }
    const anthropicAdapter = createAnthropicAdapter({
      apiKey,
      model,
      baseUrl,
      timeoutMs: input.timeoutMs,
    });
    client = anthropicAdapter;
  } else {
    // OpenAI-compatible — use shared client
    const openaiClient = createOpenAICompatibleClient(normalizedConfig, {
      ledger: opts?.ledger,
    });
    client = openaiClient;
  }

  return { client, metadata, normalizedConfig };
}
