export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatCompletionRequest {
  messages: ChatMessage[]
  model?: string
  baseUrl: string
  apiKey?: string
  timeoutSeconds?: number
  customHeaders?: Record<string, string>
  streaming?: boolean
}

export interface ChatCompletionChunk {
  index: number
  text: string
}

export interface ChatCompletionResponse {
  content: string
  model: string
  finishReason: string | null
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null
}

export interface LlmClientConfig {
  baseUrl: string
  model?: string
  apiKey?: string
  timeoutSeconds?: number
  customHeaders?: Record<string, string>
  contextBudgetTokens?: number
}

export type LlmErrorType =
  | 'connection'
  | 'timeout'
  | 'rateLimit'
  | 'auth'
  | 'invalidRequest'
  | 'serverError'
  | 'contextBudget'
  | 'unknown'

export interface LlmError extends Error {
  type: LlmErrorType
  statusCode?: number
  retryable: boolean
  detail?: string
}

export interface ProviderError {
  type: string
  message: string
  retryable: boolean
  statusCode?: number
  response?: string
}

export interface AgentConfig {
  systemPrompt?: string
  developerPrompt?: string
  taskPrompt?: string
  contextBudgetTokens?: number
  provider?: Record<string, unknown>
  subagents?: {
    enabled?: boolean
    mode?: string
  }
  verification?: {
    defaultCommand?: string
  }
}

export interface NormalizedProviderConfig {
  kind: string
  baseUrl: string
  model: string
  apiKey?: string
  customHeaders?: Record<string, string>
  timeoutMs?: number
}

export interface ChatResponse {
  content: string
  model: string
  finishReason: string
  usage: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  } | null
}

export interface ChatOptions {
  messages: Array<{ role: string; content: string }>
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}
