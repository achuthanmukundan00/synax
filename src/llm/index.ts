/**
 * LLM module — types and utilities for `synax/llm` subpath.
 *
 * ```ts
 * import { type ChatResponse } from 'synax/llm';
 * ```
 */

export type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  LlmClientConfig,
  LlmError,
  LlmErrorType,
  ProviderPreset,
  ProviderId,
  ProviderProtocol,
  ProviderMetadata,
  ProviderError,
  AgentConfig,
  NormalizedProviderConfig,
  ParsedModelOutput,
  ParseWarning,
} from './types';

export type { ParsedToolCall } from './tool-calls';
export type { ToolCallParseResult, ToolCallParseFailureReason, ToolCallParserMode } from './tool-calls';

export { createLLMClient } from './provider-factory';
export type { ProviderFactoryInput, ProviderFactoryResult } from './provider-factory';
