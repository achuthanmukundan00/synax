import type { ThinkingLevel } from '../config/schema';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ─── Provider protocol types ───────────────────────────

export type ProviderProtocol = 'openai-compatible' | 'anthropic-messages';

export type ProviderId =
  | 'relay'
  | 'custom'
  | 'openai'
  | 'deepseek'
  | 'openrouter'
  | 'groq'
  | 'anthropic'
  | 'mistral'
  | 'together';

export interface ProviderPreset {
  id: ProviderId;
  protocol: ProviderProtocol;
  displayName: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKeyRequired: boolean;
  cloud: boolean;
  defaultHeaders?: Record<string, string>;
  defaultModel?: string;
  contextWindow?: number;
  supportsStreaming?: boolean;
  supportsToolCalling?: boolean;
  /** Price per 1M input tokens in USD. */
  inputPricePer1MTokens?: number;
  /** Price per 1M output tokens in USD. */
  outputPricePer1MTokens?: number;
}

export interface ProviderMetadata {
  providerId: string;
  displayName: string;
  modelId: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  cloud: boolean;
  contextWindow: number;
  contextUsed?: number;
  streamingSupported: boolean;
  toolCallingSupported: boolean;
  apiKeyRequired: boolean;
  apiKeyConfigured: boolean;
  /** Price per 1M input tokens in USD. */
  inputPricePer1MTokens?: number;
  /** Price per 1M output tokens in USD. */
  outputPricePer1MTokens?: number;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  model?: string;
  baseUrl: string;
  apiKey?: string;
  timeoutSeconds?: number;
  customHeaders?: Record<string, string>;
  streaming?: boolean;
}

export interface ChatCompletionChunk {
  index: number;
  text: string;
}

export interface ChatCompletionResponse {
  content: string;
  model: string;
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

export interface LlmClientConfig {
  baseUrl: string;
  model?: string;
  apiKey?: string;
  timeoutSeconds?: number;
  customHeaders?: Record<string, string>;
  contextBudgetTokens?: number;
}

export type LlmErrorType =
  | 'connection'
  | 'timeout'
  | 'rateLimit'
  | 'auth'
  | 'invalidRequest'
  | 'serverError'
  | 'contextBudget'
  | 'unknown';

export interface LlmError extends Error {
  type: LlmErrorType;
  statusCode?: number;
  retryable: boolean;
  detail?: string;
}

export interface ProviderError {
  type: string;
  message: string;
  retryable: boolean;
  statusCode?: number;
  response?: string;
}

export interface AgentConfig {
  systemPrompt?: string;
  developerPrompt?: string;
  taskPrompt?: string;
  contextBudgetTokens?: number;
  provider?: Record<string, unknown>;
  subagents?: {
    enabled?: boolean;
    mode?: string;
  };
  verification?: {
    defaultCommand?: string;
  };
}

export interface NormalizedProviderConfig {
  kind: string;
  baseUrl: string;
  model: string;
  toolCallParser?: string;
  apiKey?: string;
  customHeaders?: Record<string, string>;
  timeoutMs?: number;
  /** Thinking level from active config. When not 'off', providers may enable extended reasoning. */
  thinkingLevel?: ThinkingLevel;
}

export interface ChatResponse {
  content: string;
  model: string;
  finishReason: string;
  /** DeepSeek thinking mode: reasoning_content that must be passed back in subsequent requests. */
  reasoningContent?: string;
  toolCallFormat?: 'openai' | 'content_xml' | 'none';
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  } | null;
}

export interface ChatOptions {
  messages: Array<{
    role: string;
    content: string;
    tool_call_id?: string;
    name?: string;
    tool_calls?: unknown;
    /** DeepSeek thinking mode: must echo reasoning_content from prior assistant response. */
    reasoning_content?: string;
  }>;
  tools?: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta?: (delta: { content?: string; reasoningContent?: string }) => void;
}

// ─── Parsed model output ─────────────────────────────────

/** Warning produced during model output parsing. */
export interface ParseWarning {
  message: string;
  /** Where in the pipeline the warning was raised. */
  source: 'reasoning' | 'parser' | 'repair' | 'validation';
}

/**
 * Typed model output after parsing.
 *
 * Replaces the ad-hoc split between sanitized text, tool calls, and
 * reasoning that was previously done via global regex in tool-calls.ts.
 *
 * Each field is independently usable:
 * - assistantText: for display/transcript
 * - toolCalls: for the agent turn loop
 * - reasoning: extracted from provider-specific markers (<think>, reasoning_content)
 * - warnings: recoverable issues found during parsing
 */
export interface ParsedModelOutput {
  /** Assistant-visible prose (may include code blocks, explanations, etc.). */
  assistantText: string;
  /** Parsed tool calls ready for execution. */
  toolCalls: import('./tool-calls').ParsedToolCall[];
  /** Reasoning / thinking content extracted from model output. */
  reasoning?: string;
  /** Warnings raised during parsing (recoverable issues). */
  warnings: ParseWarning[];
}
