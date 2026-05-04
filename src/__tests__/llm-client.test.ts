/**
 * Tests for the OpenAI-compatible LLM client.
 * Covers: basic chat, empty API key, custom headers,
 * provider errors (JSON + plain text), config validation.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { classifyStatus, createOpenAICompatibleClient } from '../llm/client';
import { normalizeProviderConfig, validateConfig, type ProviderConfig } from '../config/project';
import type { NormalizedProviderConfig } from '../llm/types';

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

function makeConfig(overrides: Record<string, unknown> = {}): NormalizedProviderConfig {
  return normalizeProviderConfig({
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:0',
    model: 'test-model',
    ...overrides,
  } as ProviderConfig);
}

// Test 1: Basic chat
describe('LLM client — basic chat', () => {
  let srv: Server;
  let captured: MockRequest | null = null;

  beforeEach(async () => {
    srv = await createMockServer((_req, res) => {
      captured = _req;
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

  test('POSTs to /chat/completions and returns content', async () => {
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }));
    const resp = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(captured!.method).toBe('POST');
    expect(captured!.path).toBe('/chat/completions');
    expect(resp.content).toBe('Hello');
    expect(resp.model).toBe('test-model');
    expect(resp.finishReason).toBe('stop');
    expect(resp.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });
});

// Test 2: Empty API key
describe('LLM client — empty API key', () => {
  let srv: Server;
  let captured: MockRequest | null = null;

  beforeEach(async () => {
    srv = await createMockServer((_req, res) => {
      captured = _req;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 't',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }),
      );
    });
  });

  afterEach(() => {
    srv.close();
    captured = null;
  });

  test('does not send Authorization when api_key is empty', async () => {
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv), apiKey: '' }));
    await client.chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(captured!.headers['authorization']).toBeUndefined();
  });
});

// Test 3: Custom headers
describe('LLM client — custom headers', () => {
  let srv: Server;
  let captured: MockRequest | null = null;

  beforeEach(async () => {
    srv = await createMockServer((_req, res) => {
      captured = _req;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 't',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }),
      );
    });
  });

  afterEach(() => {
    srv.close();
    captured = null;
  });

  test('sends custom headers', async () => {
    const client = createOpenAICompatibleClient(
      makeConfig({ baseUrl: getServerUrl(srv), customHeaders: { 'X-Test-Header': 'abc' } }),
    );
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(captured!.headers['x-test-header']).toBe('abc');
  });
});

// Test 4: Provider error JSON
describe('LLM client — provider error JSON', () => {
  let srv: Server;

  beforeEach(async () => {
    srv = await createMockServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream failed' } }));
    });
  });

  afterEach(() => {
    srv.close();
  });

  test('throws structured error with statusCode 500', async () => {
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }));
    await expect(client.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      statusCode: 500,
      retryable: true,
      type: 'serverError',
    });
  });
});

describe('LLM client — provider auth and rate limit errors', () => {
  test.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rateLimit'],
  ])('classifies %i as %s', (statusCode, type) => {
    expect(classifyStatus(statusCode)).toBe(type);
  });
});

// Test 5: Provider error plain text
describe('LLM client — provider error plain text', () => {
  let srv: Server;

  beforeEach(async () => {
    srv = await createMockServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('bad request detail');
    });
  });

  afterEach(() => {
    srv.close();
  });

  test('throws structured error preserving body detail', async () => {
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }));
    await expect(client.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      statusCode: 400,
      retryable: false,
      type: 'invalidRequest',
    });
  });
});

// Test 6: Config validation — missing provider kind
describe('Config validation — missing kind', () => {
  test('missing provider.kind produces error', () => {
    const errors = validateConfig({ provider: {} as any });
    expect(errors.some((e) => e.path === 'provider.kind')).toBeTruthy();
  });
});

// Test 7: Config validation — unsupported kind
describe('Config validation — unsupported kind', () => {
  test('anthropic kind produces unsupported-provider error', () => {
    const errors = validateConfig({
      provider: { kind: 'anthropic' as unknown as 'openai-compatible', base_url: 'http://x' },
    } as any);
    expect(errors.some((e) => e.path === 'provider.kind' && e.message.includes('unsupported-provider'))).toBeTruthy();
  });
});
