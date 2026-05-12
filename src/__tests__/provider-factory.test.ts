/**
 * Tests for the provider factory (createLLMClient).
 * Covers: provider routing, API key resolution, config validation,
 * metadata exposure, error cases.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createLLMClient, describeLLMProvider, type ProviderFactoryInput } from '../llm/provider-factory';

interface MockRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

function createMockServer(handler: (req: MockRequest, res: ServerResponse<IncomingMessage>) => void): Promise<Server> {
  const srv = createServer((req, res) => {
    const chunks: string[] = [];
    req.on('data', (c) => chunks.push(String(c)));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
      handler(
        {
          method: req.method ?? '',
          path: new URL(req.url ?? '/', 'http://localhost').pathname,
          headers,
          body: chunks.join(''),
        },
        res,
      );
    });
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      srv.off('error', reject);
      resolve(srv);
    });
  });
}

function getServerUrl(srv: Server): string {
  const addr = srv.address();
  if (addr && typeof addr === 'object' && 'port' in addr) return `http://127.0.0.1:${addr.port}`;
  throw new Error('Could not get server port');
}

function makeInput(overrides: Partial<ProviderFactoryInput> = {}): ProviderFactoryInput {
  return {
    provider: 'relay',
    model: 'test-model',
    baseUrl: 'http://127.0.0.1:1234/v1',
    ...overrides,
  };
}

describe('Provider factory — relay (local)', () => {
  let srv: Server;
  let captured: MockRequest | null = null;

  beforeEach(async () => {
    srv = await createMockServer((req, res) => {
      captured = req;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'test-model',
          choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });

  afterEach(() => {
    srv.close();
    captured = null;
  });

  it('creates client and sends request to /chat/completions', async () => {
    const { client, metadata } = createLLMClient(makeInput({ baseUrl: getServerUrl(srv) }));
    const resp = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });

    const req = captured;
    if (!req) throw new Error('No request captured');
    expect(req.path).toBe('/chat/completions');
    expect(resp.content).toBe('Hello');
    expect(metadata.protocol).toBe('openai-compatible');
    expect(metadata.providerId).toBe('relay');
    expect(metadata.cloud).toBe(false);
  });

  it('exposes correct metadata for relay', () => {
    const { metadata } = createLLMClient(makeInput({ baseUrl: getServerUrl(srv) }));
    expect(metadata.displayName).toBe('Relay');
    expect(metadata.streamingSupported).toBe(true);
    expect(metadata.toolCallingSupported).toBe(true);
    expect(metadata.apiKeyConfigured).toBe(false);
  });
});

describe('Provider factory — deepseek preset', () => {
  it('applies deepseek base URL when not provided', () => {
    const originalKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    try {
      const { metadata } = createLLMClient(makeInput({ provider: 'deepseek', baseUrl: undefined }));
      expect(metadata.baseUrl).toBe('https://api.deepseek.com/v1');
      expect(metadata.protocol).toBe('openai-compatible');
      expect(metadata.cloud).toBe(true);
      expect(metadata.displayName).toBe('DeepSeek');
    } finally {
      process.env.DEEPSEEK_API_KEY = originalKey;
    }
  });

  it('throws when DEEPSEEK_API_KEY is missing', () => {
    const originalKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      expect(() => createLLMClient(makeInput({ provider: 'deepseek', baseUrl: undefined }))).toThrow(
        /API key is required for DeepSeek/,
      );
    } finally {
      process.env.DEEPSEEK_API_KEY = originalKey;
    }
  });

  it('uses explicit apiKey over env var', () => {
    const { metadata } = createLLMClient(makeInput({ provider: 'deepseek', apiKey: 'sk-explicit' }));
    expect(metadata.apiKeyConfigured).toBe(true);
  });
});

describe('Provider factory — openrouter preset', () => {
  it('applies openrouter base URL and default headers', () => {
    const originalKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    try {
      const { metadata, normalizedConfig } = createLLMClient(makeInput({ provider: 'openrouter', baseUrl: undefined }));
      expect(metadata.baseUrl).toBe('https://openrouter.ai/api/v1');
      expect(metadata.displayName).toBe('OpenRouter');
      expect(metadata.cloud).toBe(true);
      expect(normalizedConfig.customHeaders).toEqual({
        'HTTP-Referer': 'https://github.com/achuthanmukundan00/synax',
        'X-Title': 'Synax',
      });
    } finally {
      process.env.OPENROUTER_API_KEY = originalKey;
    }
  });

  it('merges custom headers with default headers', () => {
    const originalKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    try {
      const { normalizedConfig } = createLLMClient(
        makeInput({
          provider: 'openrouter',
          baseUrl: undefined,
          customHeaders: { 'X-Custom': 'value' },
        }),
      );
      expect(normalizedConfig.customHeaders).toMatchObject({
        'HTTP-Referer': 'https://github.com/achuthanmukundan00/synax',
        'X-Title': 'Synax',
        'X-Custom': 'value',
      });
    } finally {
      process.env.OPENROUTER_API_KEY = originalKey;
    }
  });

  it('throws when OPENROUTER_API_KEY is missing', () => {
    const originalKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(() => createLLMClient(makeInput({ provider: 'openrouter' }))).toThrow(
        /API key is required for OpenRouter/,
      );
    } finally {
      process.env.OPENROUTER_API_KEY = originalKey;
    }
  });
});

describe('Provider factory — groq preset', () => {
  it('applies groq base URL', () => {
    const originalKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = 'gsk-test';
    try {
      const { metadata } = createLLMClient(makeInput({ provider: 'groq', baseUrl: undefined }));
      expect(metadata.baseUrl).toBe('https://api.groq.com/openai/v1');
      expect(metadata.displayName).toBe('Groq');
      expect(metadata.contextWindow).toBe(128000);
    } finally {
      process.env.GROQ_API_KEY = originalKey;
    }
  });

  it('throws when GROQ_API_KEY is missing', () => {
    const originalKey = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    try {
      expect(() => createLLMClient(makeInput({ provider: 'groq' }))).toThrow(/API key is required for Groq/);
    } finally {
      process.env.GROQ_API_KEY = originalKey;
    }
  });
});

describe('Provider factory — anthropic preset', () => {
  it('describes provider metadata without requiring an API key', () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { metadata, normalizedConfig } = describeLLMProvider(
        makeInput({ provider: 'anthropic', baseUrl: undefined }),
      );
      expect(metadata.protocol).toBe('anthropic-messages');
      expect(metadata.displayName).toBe('Anthropic');
      expect(metadata.apiKeyRequired).toBe(true);
      expect(metadata.apiKeyConfigured).toBe(false);
      expect(normalizedConfig.kind).toBe('anthropic-messages');
    } finally {
      if (originalKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalKey;
      }
    }
  });

  it('creates an anthropic-messages client when key is present', () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    try {
      const { metadata } = createLLMClient(makeInput({ provider: 'anthropic', baseUrl: undefined }));
      expect(metadata.protocol).toBe('anthropic-messages');
      expect(metadata.baseUrl).toBe('https://api.anthropic.com');
      expect(metadata.displayName).toBe('Anthropic');
      expect(metadata.cloud).toBe(true);
      expect(metadata.toolCallingSupported).toBe(false);
    } finally {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it('throws when ANTHROPIC_API_KEY is missing', () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => createLLMClient(makeInput({ provider: 'anthropic' }))).toThrow(/API key is required for Anthropic/);
    } finally {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });
});

describe('Provider factory — custom preset', () => {
  it('throws when base URL is missing', () => {
    expect(() => createLLMClient(makeInput({ provider: 'custom', baseUrl: undefined }))).toThrow(
      /baseUrl is required for custom provider/,
    );
  });

  it('works when base URL is provided', () => {
    const { metadata } = createLLMClient(makeInput({ provider: 'custom', baseUrl: 'http://127.0.0.1:1234/v1' }));
    expect(metadata.baseUrl).toBe('http://127.0.0.1:1234/v1');
    expect(metadata.protocol).toBe('openai-compatible');
    expect(metadata.apiKeyConfigured).toBe(false);
  });
});

describe('Provider factory — error cases', () => {
  it('throws for unknown provider ID', () => {
    expect(() => createLLMClient(makeInput({ provider: 'gemini' }))).toThrow(/Unknown provider/);
  });

  it('throws with helpful message listing known providers', () => {
    expect(() => createLLMClient(makeInput({ provider: 'nonexistent' }))).toThrow(
      /Known providers: relay, custom, openai, deepseek/,
    );
  });

  it('falls back to relay when no provider specified', () => {
    const { metadata } = createLLMClient(makeInput({ provider: undefined }));
    expect(metadata.providerId).toBe('relay');
  });
});

describe('Provider factory — API key resolution', () => {
  it('resolves apiKey from env var when apiKeyEnv is set', () => {
    const originalKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'sk-from-env';
    try {
      const { metadata } = createLLMClient(makeInput({ provider: 'deepseek', baseUrl: undefined, apiKey: undefined }));
      expect(metadata.apiKeyConfigured).toBe(true);
    } finally {
      process.env.DEEPSEEK_API_KEY = originalKey;
    }
  });

  it('prefers explicit apiKey over env var', () => {
    const originalKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'sk-from-env';
    try {
      const { metadata } = createLLMClient(makeInput({ provider: 'deepseek', apiKey: 'sk-explicit' }));
      expect(metadata.apiKeyConfigured).toBe(true);
    } finally {
      process.env.DEEPSEEK_API_KEY = originalKey;
    }
  });
});

describe('Provider factory — model validation', () => {
  it('uses default model when none provided', () => {
    const originalKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    try {
      const { metadata } = createLLMClient(makeInput({ provider: 'deepseek', baseUrl: undefined, model: undefined }));
      expect(metadata.modelId).toBe('deepseek-chat');
    } finally {
      process.env.DEEPSEEK_API_KEY = originalKey;
    }
  });

  it('uses explicit model over default', () => {
    const originalKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    try {
      const { metadata } = createLLMClient(makeInput({ provider: 'deepseek', model: 'deepseek-reasoner' }));
      expect(metadata.modelId).toBe('deepseek-reasoner');
    } finally {
      process.env.DEEPSEEK_API_KEY = originalKey;
    }
  });
});
