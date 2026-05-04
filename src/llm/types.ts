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
}