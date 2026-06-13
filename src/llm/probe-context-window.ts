/**
 * Probe an OpenAI-compatible relay to discover the loaded model's context window.
 *
 * Queries /v1/models and looks for context window metadata in the response.
 * Falls back to /v1/model (singular) if no match is found in the list.
 * Only used for non-cloud providers (relay, custom) where the context window
 * isn't known from a well-documented preset.
 */

// Common field names used by various OpenAI-compatible servers for context window.
// Order roughly by likelihood: llama.cpp forks (max_context_length), vLLM/SGLang
// (max_model_len), generic (context_length), and others.
const CONTEXT_WINDOW_FIELDS = [
  'max_context_length',
  'max_model_len',
  'context_length',
  'max_total_tokens',
  'total_tokens_capacity',
  'n_ctx',
  'max_position_embeddings',
  'model_max_length',
  'max_seq_len',
  'max_sequence_length',
];

function buildHeaders(apiKey?: string, customHeaders?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'synax/1.0',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (customHeaders) {
    for (const [key, value] of Object.entries(customHeaders)) {
      headers[key] = value;
    }
  }
  return headers;
}

function extractContextWindow(entry: Record<string, unknown>): number | undefined {
  for (const field of CONTEXT_WINDOW_FIELDS) {
    const value = entry[field];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = parseInt(value, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
  }
  return undefined;
}

/**
 * Try to extract context window from the /v1/models response.
 */
async function probeModelsEndpoint(
  cleanBaseUrl: string,
  modelId: string,
  headers: Record<string, string>,
): Promise<number | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${cleanBaseUrl}/models`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return undefined;

    const body = (await res.json()) as {
      data?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(body.data)) return undefined;

    // Find the matching model
    const modelEntry = body.data.find((entry: Record<string, unknown>) => entry.id === modelId);
    if (modelEntry) {
      const window = extractContextWindow(modelEntry);
      if (window !== undefined) return window;
    }

    // Fallback: if only one model is listed, return its context window
    if (body.data.length === 1) {
      const window = extractContextWindow(body.data[0]);
      if (window !== undefined) return window;
    }

    return undefined;
  } catch {
    clearTimeout(timeout);
    return undefined;
  }
}

/**
 * Some servers expose a /v1/model (singular) endpoint for the currently
 * loaded model with full metadata.
 */
async function probeModelEndpoint(cleanBaseUrl: string, headers: Record<string, string>): Promise<number | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${cleanBaseUrl}/model`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return undefined;

    const data = (await res.json()) as Record<string, unknown>;
    return extractContextWindow(data);
  } catch {
    clearTimeout(timeout);
    return undefined;
  }
}

export async function probeModelContextWindow(
  baseUrl: string,
  modelId: string,
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Promise<number | undefined> {
  const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
  const headers = buildHeaders(apiKey, customHeaders);

  // Try /v1/models first (standard OpenAI-compatible)
  const fromModels = await probeModelsEndpoint(cleanBaseUrl, modelId, headers);
  if (fromModels !== undefined) return fromModels;

  // Fallback: try /v1/model (singular) for servers that expose it
  return probeModelEndpoint(cleanBaseUrl, headers);
}
