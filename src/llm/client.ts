/**
 * OpenAI-compatible chat client for local providers (e.g. Relay).
 *
 * Posts Chat Completions requests to any OpenAI-compatible endpoint.
 * Supports structured provider errors for `synax doctor`.
 */

import { type NormalizedProviderConfig, type ChatOptions, type ChatResponse, type LlmError } from './types';
import { type ContextLedger } from '../tools';
import { parseOpenAIToolCalls, parseToolCallsFromContent, toOpenAIToolDefinition } from './tool-calls';

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// HTTP dispatch (uses global fetch if available, falls back to http/https)
// ---------------------------------------------------------------------------

async function dispatchRequest(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; bodyText: string; headers: Record<string, string> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const bodyText = await res.text();
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    return { status: res.status, bodyText, headers: respHeaders };
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

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseErrorResponse(status: number, bodyText: string): LlmError {
  let detail: string | undefined;
  let parsed: unknown;

  try {
    parsed = JSON.parse(bodyText);
    // OpenAI-style: { error: { message: "..." } }
    const errObj = parsed as Record<string, unknown>;
    if (errObj.error && typeof errObj.error === 'object' && 'message' in errObj.error) {
      detail = String((errObj.error as Record<string, unknown>).message);
    } else if (parsed && typeof parsed === 'object' && 'message' in parsed) {
      detail = String((parsed as Record<string, unknown>).message);
    } else if (
      parsed &&
      typeof parsed === 'object' &&
      'error' in parsed &&
      typeof (parsed as Record<string, unknown>).error === 'string'
    ) {
      detail = String((parsed as Record<string, unknown>).error);
    }
  } catch {
    // Not JSON — use raw body (truncated)
    detail = bodyText.trim().slice(0, 500) || undefined;
  }

  const type = classifyStatus(status);
  const msg = detail ? `Provider error (${status}): ${detail}` : `Provider error (${status})`;

  return providerError(type, msg, { statusCode: status, detail, retryable: status >= 500 || status === 429 });
}

// ---------------------------------------------------------------------------
// Success response parsing
// ---------------------------------------------------------------------------

function parseSuccessResponse(bodyText: string): ChatResponse {
  const json = JSON.parse(bodyText) as {
    model?: string;
    choices?: Array<{
      message?: { content?: string; role?: string; tool_calls?: unknown };
      finish_reason?: string | null;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const choice = json.choices?.[0];
  const content = choice?.message?.content ?? '';
  const finishReason = choice?.finish_reason ?? null;
  const standardToolCalls = parseOpenAIToolCalls(choice?.message?.tool_calls);
  const fallbackToolCalls = standardToolCalls.length > 0 ? [] : parseToolCallsFromContent(content);

  return {
    content,
    model: json.model ?? '',
    finishReason: finishReason ?? 'stop',
    toolCalls: [...standardToolCalls, ...fallbackToolCalls],
    usage: json.usage
      ? {
          promptTokens: json.usage.prompt_tokens ?? 0,
          completionTokens: json.usage.completion_tokens ?? 0,
          totalTokens: json.usage.total_tokens ?? 0,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Options for budget enforcement when the ledger is provided.
 */
export interface BudgetPolicy {
  /** Hard stop when remaining budget falls at or below this threshold. */
  hardStopThreshold?: number;
  /** Emit a warning when remaining budget falls at or below this threshold. */
  warnThreshold?: number;
}

export function createOpenAICompatibleClient(
  cfg: NormalizedProviderConfig,
  opts?: { ledger?: ContextLedger; budgetPolicy?: BudgetPolicy },
) {
  const ledger = opts?.ledger ?? null;
  const budgetPolicy = opts?.budgetPolicy ?? {};
  const timeoutMs = cfg.timeoutMs ?? 120000;
  const model = cfg.model ?? '';
  const baseUrl = (cfg.baseUrl ?? 'http://127.0.0.1:1234/v1').replace(/\/+$/, '');
  const endpoint = baseUrl + '/chat/completions';

  // Build base headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  // Authorization only when apiKey is a non-empty string
  if (cfg.apiKey && typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0) {
    headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  }

  // Merge custom headers (custom headers take precedence)
  if (cfg.customHeaders && typeof cfg.customHeaders === 'object') {
    for (const [k, v] of Object.entries(cfg.customHeaders)) {
      headers[k] = v;
    }
  }

  return {
    /**
     * Send a chat request.
     *
     * When a ledger is provided, this method:
     * 1. Records token usage from the response (prompt + completion tokens).
     * 2. Updates the budget state (used / remaining).
     * 3. Enforces budget policy (warn or hard-stop).
     */
    async chat(opts: ChatOptions): Promise<ChatResponse> {
      const body = {
        model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0,
        stream: false,
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.tools && opts.tools.length > 0
          ? { tools: opts.tools.map(toOpenAIToolDefinition), tool_choice: 'auto' }
          : {}),
      };

      const result = await dispatchRequest(endpoint, body, headers, timeoutMs);

      if (result.status >= 200 && result.status < 300) {
        const response = parseSuccessResponse(result.bodyText);

        // Record token usage from the response when a ledger is present.
        if (ledger && response.usage) {
          const used = (response.usage.promptTokens ?? 0) + (response.usage.completionTokens ?? 0);
          ledger.recordTokenUsage(used);
        }

        // Enforce budget policy when a ledger is present.
        if (ledger) {
          const remaining = budgetPolicy.hardStopThreshold ?? 0;
          const warnRemaining = budgetPolicy.warnThreshold ?? 1000;
          const safe = ledger.isSafe();

          if (!safe) {
            throw new Error(
              `Context budget exhausted: ${ledger.getExpanded().budget.used}/${ledger.getExpanded().budget.total} tokens used.\n${ledger.getCompact()}`,
            );
          }

          if (ledger.getExpanded().budget.remaining <= remaining) {
            throw new Error(
              `Context budget hard-stop: ${ledger.getExpanded().budget.remaining} tokens remaining (threshold: ${remaining}).\n${ledger.getCompact()}`,
            );
          }

          if (ledger.getExpanded().budget.remaining <= warnRemaining) {
            process.stderr.write(
              `[synax] ⚠️ Context budget low: ${ledger.getExpanded().budget.remaining} tokens remaining (warn threshold: ${warnRemaining}).\n${ledger.getCompact()}\n`,
            );
          }
        }

        return response;
      }

      throw parseErrorResponse(result.status, result.bodyText);
    },
  };
}

export { providerError, classifyStatus, parseErrorResponse, parseSuccessResponse };
