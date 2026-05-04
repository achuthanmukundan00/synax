import https from 'https'
import {
  ChatMessage,
  ChatCompletionResponse,
  LlmError,
  LlmErrorType,
  LlmClientConfig,
} from './types'

export class LlmClient {
  private readonly config: LlmClientConfig

  constructor(config: LlmClientConfig) {
    this.config = config
  }

  async chat(messages: ChatMessage[]): Promise<ChatCompletionResponse> {
    const model = this.config.model || 'gpt-4o'
    const url = new URL(this.config.baseUrl)
    const estimatedPromptTokens = this.estimatePromptTokens(messages)
    const budget = this.config.contextBudgetTokens
    if (
      budget !== undefined &&
      estimatedPromptTokens > budget
    ) {
      throw this.createError(
        'contextBudget',
        `Estimated prompt tokens (${estimatedPromptTokens}) exceed context budget (${budget})`,
        false,
      )
    }
    return new Promise<ChatCompletionResponse>((resolve, reject) => {
      const options: https.RequestOptions = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
          ...this.config.customHeaders,
        },
        timeout: (this.config.timeoutSeconds ?? 120) * 1000,
      }
      const payload = JSON.stringify({ model, messages, temperature: 0, stream: false })
      const req = https.request(url.toString(), options, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8')
          try {
            const json = JSON.parse(body)
            if (res.statusCode !== 200) {
              const errStatusCode = res.statusCode ?? -1
              const errType = this.classifyError(errStatusCode, json)
              reject(
                this.createError(
                  errType,
                  `API error ${res.statusCode}: ${json.error?.message || json.message || 'Unknown error'}`,
                  this.isRetryable(errStatusCode, errType),
                ),
              )
              return
            }
            const choice = json.choices?.[0]
            if (!choice) {
              reject(
                this.createError('unknown', 'Unexpected response format: no choices', false),
              )
              return
            }
            resolve({
              content: choice.message?.content || '',
              model: json.model || model,
              finishReason: choice.finish_reason || null,
              usage: json.usage
                ? {
                    promptTokens: json.usage.prompt_tokens || 0,
                    completionTokens: json.usage.completion_tokens || 0,
                    totalTokens: json.usage.total_tokens || 0,
                  }
                : null,
            })
          } catch (e) {
            reject(
              this.createError('unknown', `Failed to parse response: ${(e as Error).message}`, false),
            )
          }
        })
        res.on('error', (e) => reject(this.createError('connection', String(e), true)))
      })
      req.on('error', (e) => reject(this.createError('connection', String(e), true)))
      req.on('timeout', () => {
        req.destroy()
        reject(
          this.createError(
            'timeout',
            `Request timed out after ${(this.config.timeoutSeconds ?? 120)}s`,
            true,
          ),
        )
      })
      req.write(payload)
      req.end()
    })
  }

  async *chatStream(
    messages: ChatMessage[],
  ): AsyncIterable<ChatCompletionResponse> {
    const model = this.config.model || 'gpt-4o'
    const url = new URL(this.config.baseUrl)
    const estimatedPromptTokens = this.estimatePromptTokens(messages)
    if (
      this.config.contextBudgetTokens !== undefined &&
      estimatedPromptTokens > this.config.contextBudgetTokens
    ) {
      throw this.createError(
        'contextBudget',
        `Estimated prompt tokens (${estimatedPromptTokens}) exceed context budget (${this.config.contextBudgetTokens})`,
        false,
      )
    }
    let currentContent = ''
    let currentModel = model
    const response = await new Promise<ChatCompletionResponse>(
      (resolve, reject) => {
        const options: https.RequestOptions = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...(this.config.apiKey
              ? { Authorization: `Bearer ${this.config.apiKey}` }
              : {}),
            ...this.config.customHeaders,
          },
          timeout: (this.config.timeoutSeconds ?? 120) * 1000,
        }
        const payload = JSON.stringify({
          model,
          messages,
          temperature: 0,
          stream: true,
        })
        const req = https.request(url.toString(), options, (res) => {
          let buffer = ''
          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf-8')
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''
            for (const line of lines) {
              const trimmed = line.trim()
              if (
                trimmed === 'data: [DONE]' ||
                !trimmed.startsWith('data: ')
              ) {
                continue
              }
              try {
                const data = JSON.parse(trimmed.slice(6))
                if (data.model) currentModel = data.model
                const delta = data.choices?.[0]?.delta?.content
                if (delta) currentContent += delta
              } catch {
                /* ignore parse errors */
              }
            }
          })
          res.on('end', () => {
            resolve({
              content: currentContent,
              model: currentModel,
              finishReason: 'stop',
              usage: null,
            })
          })
          res.on('error', (e) =>
            reject(this.createError('connection', String(e), true)),
          )
        })
        req.on('error', (e) =>
          reject(this.createError('connection', String(e), true)),
        )
        req.on('timeout', () => {
          req.destroy()
          reject(
            this.createError(
              'timeout',
              `Request timed out after ${(this.config.timeoutSeconds ?? 120)}s`,
              true,
            ),
          )
        })
        req.write(payload)
        req.end()
      },
    )
    yield response
  }

  async ping(): Promise<{ model: string; elapsedMs: number }> {
    const start = Date.now()
    const model = this.config.model || 'unknown'
    try {
      const response = await this.chat([{ role: 'user', content: 'Hi' }])
      return { model: response.model, elapsedMs: Date.now() - start }
    } catch (err) {
      const llmErr = err as LlmError
      if (llmErr.type === 'auth')
        return { model: `unauthorized (${model})`, elapsedMs: Date.now() - start }
      if (llmErr.type === 'timeout')
        return { model: `timeout (${model})`, elapsedMs: Date.now() - start }
      return {
        model: `error (${model}): ${llmErr.message}`,
        elapsedMs: Date.now() - start,
      }
    }
  }

  private estimatePromptTokens(messages: ChatMessage[]): number {
    let totalChars = 0
    for (const msg of messages) {
      totalChars += msg.role.length + msg.content.length
    }
    return Math.max(1, Math.ceil(totalChars / 4))
  }

  private classifyError(
    statusCode: number | null,
    body: unknown,
  ): LlmErrorType {
    if (statusCode === 401 || statusCode === 403) return 'auth'
    if (statusCode === 429) return 'rateLimit'
    if (statusCode === 400 || statusCode === 404) return 'invalidRequest'
    if (statusCode && statusCode >= 500) return 'serverError'
    if (statusCode) return 'unknown'
    if (body && typeof body === 'object') {
      const obj = body as Record<string, unknown>
      const errMsg = (
        (obj.error as { message?: string })?.message || ''
      ).toLowerCase()
      if (errMsg.includes('token') || errMsg.includes('context')) return 'contextBudget'
      if (errMsg.includes('auth') || errMsg.includes('key') || errMsg.includes('permission'))
        return 'auth'
      if (errMsg.includes('rate') || errMsg.includes('limit')) return 'rateLimit'
      if (errMsg.includes('server') || errMsg.includes('unavailable'))
        return 'serverError'
    }
    return 'unknown'
  }

  private createError(
    type: LlmErrorType,
    message: string,
    retryable: boolean,
  ): LlmError {
    const err = new Error(message) as LlmError
    err.type = type
    err.retryable = retryable
    return err
  }

  private isRetryable(statusCode: number | null, type: LlmErrorType): boolean {
    if (statusCode === 429 || (statusCode && statusCode >= 500)) return true
    return type === 'timeout' || type === 'connection' || type === 'rateLimit'
  }
}
