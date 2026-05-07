/**
 * Anthropic Messages API adapter.
 *
 * Maps Synax internal ChatOptions → Anthropic Messages request format
 * and Anthropic response → Synax ChatResponse.
 *
 * Supports:
 *  - Non-streaming requests via POST /v1/messages
 *  - System prompts (text only)
 *  - User and assistant messages
 *  - Text content blocks
 *  - Usage tokens
 *
 * Tool use is NOT implemented in this adapter — requesting tools
 * with the Anthropic protocol will throw a clear error.
 */

import type { ChatOptions, ChatResponse, LlmError } from './types';

// ─── Anthropic API types ───────────────────────────────

interface AnthropicTextContent {
  type: 'text';
  text: string;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicTextContent[];
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens: number;
  temperature?: number;
  stream?: boolean;
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicTextContent[];
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

interface AnthropicErrorResponse {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}

// ─── Error helpers ─────────────────────────────────────

function providerError(
  type: LlmError['type'],
  message: string,
  opts: { statusCode?: number; detail?: string; retryable?: boolean } = {},
): LlmError {
  const err = Object.assign(new Error(message), {
    type,
    statusCode: opts.statusCode,
    detail: opts.detail,
    retryable: opts.retryable ?? false,
    name: 'ProviderError',
  }) as LlmError;
  return err;
}

function classifyStatus(status: number): LlmError['type'] {
  if (status === 429) return 'rateLimit';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 400 && status < 500) return 'invalidRequest';
  if (status >= 500) return 'serverError';
  return 'unknown';
}

// ─── Message mapping ───────────────────────────────────

function extractSystemPrompt(messages: Array<{ role: string; content: string }>): string | undefined {
  const systemMessages = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .filter((c) => c.trim().length > 0);

  if (systemMessages.length === 0) return undefined;
  return systemMessages.join('\n\n');
}

function mapMessages(
  messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string; tool_calls?: unknown }>,
): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue; // handled by extractSystemPrompt

    if (msg.role === 'tool' && msg.tool_call_id) {
      // Tool results: map to user message with tool_result content block.
      // This is a simplification — full tool use mapping requires proper
      // content block sequencing and is deferred to a follow-up PR.
      result.push({
        role: 'user',
        content: msg.content,
      });
      continue;
    }

    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      result.push({ role: 'assistant', content: msg.content });
    }
    // Unknown roles are silently skipped.
  }

  return result;
}

// ─── Response mapping ──────────────────────────────────

function mapAnthropicStopReason(reason: string | null): string {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    default:
      return reason ?? 'stop';
  }
}

function mapAnthropicResponse(response: AnthropicResponse): ChatResponse {
  const textBlocks = response.content.filter((c): c is AnthropicTextContent => c.type === 'text');
  const content = textBlocks.map((b) => b.text).join('');

  return {
    content,
    model: response.model,
    finishReason: mapAnthropicStopReason(response.stop_reason),
    toolCallFormat: 'none',
    toolCalls: [],
    usage: response.usage
      ? {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        }
      : null,
  };
}

// ─── HTTP dispatch ─────────────────────────────────────

async function dispatchRequest(
  url: string,
  apiKey: string,
  body: AnthropicRequest,
  timeoutMs: number,
): Promise<{ status: number; bodyText: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const bodyText = await res.text();
    return { status: res.status, bodyText };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw providerError('timeout', `Request timed out after ${timeoutMs}ms`, { detail: msg });
    }
    if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('connect ECONNREFUSED')) {
      throw providerError('connection', `Connection failed: ${msg}`, { retryable: true, detail: msg });
    }
    throw providerError('connection', `Network error: ${msg}`, { retryable: true, detail: msg });
  }
}

// ─── Error response parsing ────────────────────────────

function parseErrorResponse(status: number, bodyText: string): LlmError {
  let detail: string | undefined;

  try {
    const parsed = JSON.parse(bodyText) as AnthropicErrorResponse;
    if (parsed.error?.message) {
      detail = parsed.error.message;
    }
  } catch {
    detail = bodyText.trim().slice(0, 500) || undefined;
  }

  const type = classifyStatus(status);
  const msg = detail ? `Anthropic error (${status}): ${detail}` : `Anthropic error (${status})`;

  return providerError(type, msg, { statusCode: status, detail, retryable: status >= 500 || status === 429 });
}

// ─── Adapter factory ───────────────────────────────────

export interface AnthropicAdapterConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export function createAnthropicAdapter(config: AnthropicAdapterConfig) {
  const baseUrl = (config.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const endpoint = `${baseUrl}/v1/messages`;
  const timeoutMs = config.timeoutMs ?? 120000;

  return {
    async chat(opts: ChatOptions): Promise<ChatResponse> {
      // Reject tool calls — not implemented for Anthropic yet
      if (opts.tools && opts.tools.length > 0) {
        throw providerError(
          'invalidRequest',
          'Anthropic tool use is not yet supported in Synax. Remove tools from your request or use an OpenAI-compatible provider.',
          {
            retryable: false,
          },
        );
      }

      const system = extractSystemPrompt(opts.messages);
      const messages = mapMessages(opts.messages);

      if (messages.length === 0) {
        throw providerError('invalidRequest', 'No valid user or assistant messages to send to Anthropic', {
          retryable: false,
        });
      }

      const request: AnthropicRequest = {
        model: config.model,
        messages,
        max_tokens: opts.maxTokens ?? 4096,
        temperature: opts.temperature,
        stream: false, // streaming not implemented in this PR
      };

      if (system) {
        request.system = system;
      }

      const result = await dispatchRequest(endpoint, config.apiKey, request, timeoutMs);

      if (result.status >= 200 && result.status < 300) {
        const response = JSON.parse(result.bodyText) as AnthropicResponse;
        return mapAnthropicResponse(response);
      }

      throw parseErrorResponse(result.status, result.bodyText);
    },
  };
}
