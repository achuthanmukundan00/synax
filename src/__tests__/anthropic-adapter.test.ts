/**
 * Tests for the Anthropic Messages adapter.
 * Covers: request construction, message mapping, system prompt handling,
 * response mapping, error handling, tool rejection.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createAnthropicAdapter } from '../llm/anthropic-adapter';

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

describe('Anthropic adapter — basic chat', () => {
  let srv: Server;
  let captured: MockRequest | null = null;

  beforeEach(async () => {
    srv = await createMockServer((req, res) => {
      captured = req;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_test123',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5-20250929',
          content: [{ type: 'text', text: 'Hello from Claude' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 15, output_tokens: 8 },
        }),
      );
    });
  });

  afterEach(() => {
    srv.close();
    captured = null;
  });

  it('POSTs to /v1/messages with correct headers', async () => {
    const adapter = createAnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5-20250929',
      baseUrl: getServerUrl(srv),
    });

    await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });

    const req = captured;
    if (!req) throw new Error('No request captured');
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/messages');
    expect(req.headers['x-api-key']).toBe('sk-ant-test');
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.headers['content-type']).toBe('application/json');
  });

  it('maps user messages to Anthropic format', async () => {
    const adapter = createAnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5-20250929',
      baseUrl: getServerUrl(srv),
    });

    await adapter.chat({ messages: [{ role: 'user', content: 'Hello' }] });

    if (!captured) throw new Error('No request captured');
    const body = JSON.parse(captured.body);
    expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('maps assistant messages correctly', async () => {
    const adapter = createAnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5-20250929',
      baseUrl: getServerUrl(srv),
    });

    await adapter.chat({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'again' },
      ],
    });

    if (!captured) throw new Error('No request captured');
    const body = JSON.parse(captured.body);
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1]).toEqual({ role: 'assistant', content: 'hello' });
  });

  it('maps system prompt to top-level system field', async () => {
    const adapter = createAnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5-20250929',
      baseUrl: getServerUrl(srv),
    });

    await adapter.chat({
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'hi' },
      ],
    });

    if (!captured) throw new Error('No request captured');
    const body = JSON.parse(captured.body);
    expect(body.system).toBe('You are a helpful assistant.');
    expect(body.messages).toHaveLength(1); // system extracted, only user remains
    expect(body.messages[0].role).toBe('user');
  });

  it('joins multiple system messages', async () => {
    const adapter = createAnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5-20250929',
      baseUrl: getServerUrl(srv),
    });

    await adapter.chat({
      messages: [
        { role: 'system', content: 'Rule 1.' },
        { role: 'system', content: 'Rule 2.' },
        { role: 'user', content: 'hi' },
      ],
    });

    if (!captured) throw new Error('No request captured');
    const body = JSON.parse(captured.body);
    expect(body.system).toBe('Rule 1.\n\nRule 2.');
  });

  it('sets max_tokens and temperature', async () => {
    const adapter = createAnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5-20250929',
      baseUrl: getServerUrl(srv),
    });

    await adapter.chat({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 256,
      temperature: 0.7,
    });

    if (!captured) throw new Error('No request captured');
    const body = JSON.parse(captured.body);
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.7);
  });

  it('defaults max_tokens to 4096 when not specified', async () => {
    const adapter = createAnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5-20250929',
      baseUrl: getServerUrl(srv),
    });

    await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });

    if (!captured) throw new Error('No request captured');
    const body = JSON.parse(captured.body);
    expect(body.max_tokens).toBe(4096);
  });
});

describe('Anthropic adapter — response mapping', () => {
  let srv: Server;

  beforeEach(async () => {
    srv = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_test123',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5-20250929',
          content: [{ type: 'text', text: 'Hello from Claude' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
    });
  });

  afterEach(() => {
    srv.close();
  });

  it('maps content to ChatResponse.content', async () => {
    const adapter = createAnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5-20250929',
      baseUrl: getServerUrl(srv),
    });

    const resp = await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(resp.content).toBe('Hello from Claude');
  });

  it('maps stop_reason end_turn to stop', async () => {
    const adapter = createAnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5-20250929',
      baseUrl: getServerUrl(srv),
    });

    const resp = await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(resp.finishReason).toBe('stop');
  });

  it('maps usage tokens', async () => {
    const adapter = createAnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5-20250929',
      baseUrl: getServerUrl(srv),
    });

    const resp = await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(resp.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it('maps model from response', async () => {
    const adapter = createAnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5-20250929',
      baseUrl: getServerUrl(srv),
    });

    const resp = await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(resp.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('returns empty toolCalls', async () => {
    const adapter = createAnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5-20250929',
      baseUrl: getServerUrl(srv),
    });

    const resp = await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(resp.toolCalls).toEqual([]);
    expect(resp.toolCallFormat).toBe('none');
  });

  it('maps max_tokens stop reason to length', async () => {
    srv.close();
    srv = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5-20250929',
          content: [{ type: 'text', text: 'truncated' }],
          stop_reason: 'max_tokens',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 5 },
        }),
      );
    });

    const adapter = createAnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5-20250929',
      baseUrl: getServerUrl(srv),
    });

    const resp = await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(resp.finishReason).toBe('length');
  });
});

describe('Anthropic adapter — error handling', () => {
  let srv: Server;

  afterEach(() => {
    srv?.close();
  });

  it('throws for non-2xx responses with Anthropic error format', async () => {
    srv = await createMockServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid API key' },
        }),
      );
    });

    const adapter = createAnthropicAdapter({
      apiKey: 'bad-key',
      model: 'claude-sonnet-4-5-20250929',
      baseUrl: getServerUrl(srv),
    });

    await expect(adapter.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      type: 'auth',
      statusCode: 401,
      retryable: false,
    });
  });

  it('throws for server errors as retryable', async () => {
    srv = await createMockServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    });

    const adapter = createAnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5-20250929',
      baseUrl: getServerUrl(srv),
    });

    await expect(adapter.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      type: 'serverError',
      statusCode: 500,
      retryable: true,
    });
  });

  it('throws clear error when tools are requested', async () => {
    const adapter = createAnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5-20250929',
      baseUrl: 'http://127.0.0.1:1',
    });

    await expect(
      adapter.chat({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'read', description: 'read a file', inputSchema: { type: 'object', properties: {} } }],
      }),
    ).rejects.toThrow(/Anthropic tool use is not yet supported/);
  });

  it('throws when no valid messages remain', async () => {
    const adapter = createAnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5-20250929',
      baseUrl: 'http://127.0.0.1:1',
    });

    await expect(adapter.chat({ messages: [{ role: 'system', content: 'only system' }] })).rejects.toThrow(
      /No valid user or assistant messages/,
    );
  });
});
