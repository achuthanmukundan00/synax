/**
 * Tests for the OpenAI-compatible LLM client.
 * Covers: basic chat, empty API key, custom headers,
 * provider errors (JSON + plain text), config validation.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { classifyStatus, createOpenAICompatibleClient, parseSuccessResponse } from '../llm/client';
import { ensureParsersRegistered } from '../llm/tool-calls';
import { createContextLedger } from '../tools';
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
    const resp = await client.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 32 });
    if (!captured) throw new Error('No request captured');
    expect(captured.method).toBe('POST');
    expect(captured.path).toBe('/chat/completions');
    expect(JSON.parse(captured.body).max_tokens).toBe(32);
    expect(JSON.parse(captured.body).max_completion_tokens).toBe(32);
    expect(resp.content).toBe('Hello');
    expect(resp.model).toBe('test-model');
    expect(resp.finishReason).toBe('stop');
    expect(resp.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  test('omits empty assistant tool_calls from provider requests', async () => {
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }));

    await client.chat({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'final answer', tool_calls: [] },
        { role: 'user', content: 'next' },
      ],
    });

    if (!captured) throw new Error('No request captured');
    const body = JSON.parse(captured.body) as {
      messages: Array<{ role: string; content: string; tool_calls?: unknown }>;
    };
    expect(body.messages[1]).toEqual({ role: 'assistant', content: 'final answer' });
  });

  test('preserves reasoning/thinking tags in content for Qwen context echo', async () => {
    srv.close();
    srv = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'test-model',
          choices: [{ message: { role: 'assistant', content: '<think>secret</think>Hello' }, finish_reason: 'stop' }],
        }),
      );
    });
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }));
    const resp = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    // Content retains thinking tags so Qwen models get their reasoning echoed back.
    // The transcript display layer now surfaces thinking text for observability.
    expect(resp.content).toBe('<think>secret</think>Hello');
  });

  test('streams reasoning and content deltas while returning the final response', async () => {
    srv.close();
    srv = await createMockServer((_req, res) => {
      captured = _req;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          model: 'test-model',
          choices: [{ delta: { reasoning_content: 'think ' } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          model: 'test-model',
          choices: [{ delta: { reasoning_content: 'more', content: 'Hel' } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          model: 'test-model',
          choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }],
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
    const deltas: Array<{ content?: string; reasoningContent?: string }> = [];
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }));
    const resp = await client.chat({
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (delta) => deltas.push(delta),
    });

    if (!captured) throw new Error('No request captured');
    expect(JSON.parse(captured.body).stream).toBe(true);
    expect(deltas).toEqual([
      { reasoningContent: 'think ' },
      { reasoningContent: 'more' },
      { content: 'Hel' },
      { content: 'lo' },
    ]);
    expect(resp.reasoningContent).toBe('think more');
    expect(resp.content).toBe('Hello');
  });

  test('parses provider reasoning fields separately from visible content', async () => {
    srv.close();
    srv = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'test-model',
          choices: [{ message: { role: 'assistant', content: 'Hello', reasoning: 'hidden chain' } }],
        }),
      );
    });
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }));
    const resp = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });

    expect(resp.content).toBe('Hello');
    expect(resp.reasoningContent).toBe('hidden chain');
  });

  test('echoes DeepSeek reasoning metadata and thinking parameters only for DeepSeek-like providers', async () => {
    srv.close();
    srv = await createMockServer((_req, res) => {
      captured = _req;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'deepseek-reasoner', choices: [{ message: { content: 'ok' } }] }));
    });
    const client = createOpenAICompatibleClient({
      ...makeConfig({ baseUrl: getServerUrl(srv), model: 'deepseek-reasoner' }),
      thinkingLevel: 'high',
    });

    await client.chat({
      messages: [
        { role: 'assistant', content: 'prior', reasoning_content: 'must echo' },
        { role: 'assistant', content: 'older assistant' },
        { role: 'user', content: 'continue' },
      ],
    });

    if (!captured) throw new Error('No request captured');
    const body = JSON.parse(captured.body);
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('high');
    expect(body.messages[0].reasoning_content).toBe('must echo');
    expect(body.messages[1].reasoning_content).toBe('');
  });

  test('sends system thinking fields and reasoning metadata to local Relay models when thinking is enabled', async () => {
    srv.close();
    srv = await createMockServer((_req, res) => {
      captured = _req;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'qwen-local', choices: [{ message: { content: 'ok' } }] }));
    });
    const client = createOpenAICompatibleClient({
      ...makeConfig({ baseUrl: getServerUrl(srv), model: 'Qwen3.6-local.gguf' }),
      thinkingLevel: 'high',
    });

    await client.chat({
      messages: [{ role: 'assistant', content: 'prior', reasoning_content: 'thinking-metadata' }],
    });

    if (!captured) throw new Error('No request captured');
    const body = JSON.parse(captured.body);
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('high');
    expect(body.messages[0].reasoning_content).toBe('thinking-metadata');
  });

  test('sends tools and parses OpenAI-compatible tool calls', async () => {
    srv.close();
    srv = await createMockServer((_req, res) => {
      captured = _req;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'test-model',
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_read',
                    type: 'function',
                    function: { name: 'read_file_range', arguments: '{"path":"src/a.ts"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      );
    });
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }));
    const resp = await client.chat({
      messages: [{ role: 'user', content: 'read a file' }],
      tools: [
        {
          name: 'read_file_range',
          description: 'Read file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    });
    if (!captured) throw new Error('No request captured');
    const body = JSON.parse(captured.body) as Record<string, unknown>;

    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file_range',
          description: 'Read file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ]);
    expect(body.tool_choice).toBe('auto');
    expect(resp.toolCalls).toEqual([{ id: 'call_read', name: 'read_file_range', arguments: { path: 'src/a.ts' } }]);
    expect(resp.toolCallFormat).toBe('openai');
  });

  test('skips malformed OpenAI-compatible tool call arguments gracefully', async () => {
    srv.close();
    srv = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'test-model',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'I should read the file.',
                tool_calls: [
                  {
                    id: 'call_read',
                    type: 'function',
                    function: { name: 'read_file_range', arguments: '{"path":' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      );
    });
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }));

    // Malformed calls are silently skipped — the response completes with content
    const response = await client.chat({ messages: [{ role: 'user', content: 'read a file' }] });
    expect(response.content).toBe('I should read the file.');
    expect(response.toolCalls).toHaveLength(0);
  });

  test('auto-selects Qwen parser for Qwen3.6 models and parses XML-style tool calls', async () => {
    srv.close();
    srv = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'Qwen3.6-35B-A3B',
          choices: [
            {
              message: {
                role: 'assistant',
                content:
                  'Let me inspect that.\n<tool_call>\n<function=read>\n<parameter=path>README.md</parameter>\n</function>\n</tool_call>',
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      );
    });
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv), model: 'Qwen3.6-35B-A3B' }));
    const resp = await client.chat({ messages: [{ role: 'user', content: 'inspect' }] });
    expect(resp.toolCalls).toMatchObject([{ id: 'call_1', name: 'read', arguments: { path: 'README.md' } }]);
    expect(resp.toolCallFormat).toBe('content_xml');
  });

  test('accepts markdown final answers that mention <tool_call> literally', async () => {
    srv.close();
    srv = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'test-model',
          choices: [
            {
              message: {
                role: 'assistant',
                content: '## Report\nThis references `src/llm/tool-calls.ts` and literal `<tool_call>` text.',
              },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    });
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }));
    const resp = await client.chat({ messages: [{ role: 'user', content: 'report' }] });
    expect(resp.toolCalls).toEqual([]);
    expect(resp.toolCallFormat).toBe('none');
  });

  test('accepts fenced code blocks containing literal <tool_call> text', async () => {
    srv.close();
    srv = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'test-model',
          choices: [
            {
              message: {
                role: 'assistant',
                content: '```md\nUse <tool_call> ... </tool_call> only as documentation.\n```',
              },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    });
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }));
    const resp = await client.chat({ messages: [{ role: 'user', content: 'report' }] });
    expect(resp.toolCalls).toEqual([]);
    expect(resp.toolCallFormat).toBe('none');
  });

  test('supports explicit qwen3_xml parser override alias', async () => {
    srv.close();
    srv = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'custom-model',
          choices: [
            {
              message: {
                role: 'assistant',
                content: '<tool_call><function=read><parameter=path>README.md</parameter></function></tool_call>',
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      );
    });
    const client = createOpenAICompatibleClient(
      makeConfig({ baseUrl: getServerUrl(srv), model: 'custom-model', tool_call_parser: 'qwen3_xml' }),
    );
    const resp = await client.chat({ messages: [{ role: 'user', content: 'inspect' }] });
    expect(resp.toolCalls).toMatchObject([{ id: 'call_1', name: 'read', arguments: { path: 'README.md' } }]);
    expect(resp.toolCallFormat).toBe('content_xml');
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
    if (!captured) throw new Error('No request captured');
    expect(captured.headers['authorization']).toBeUndefined();
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
    if (!captured) throw new Error('No request captured');
    expect(captured.headers['x-test-header']).toBe('abc');
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

describe('LLM client — network errors', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('classifies Node fetch failed errors using the underlying cause', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), { code: 'ECONNREFUSED' });
    global.fetch = jest.fn(async () => {
      throw Object.assign(new Error('fetch failed'), { cause });
    }) as unknown as typeof global.fetch;

    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: 'http://127.0.0.1:1234/v1' }));

    await expect(client.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      type: 'connection',
      retryable: true,
      message: expect.stringContaining('ECONNREFUSED'),
    });
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
  test('missing provider.kind is allowed and inferred by preset/defaults', () => {
    const errors = validateConfig({ provider: {} } as unknown as Parameters<typeof validateConfig>[0]);
    expect(errors.some((e) => e.path === 'provider.kind')).toBeFalsy();
  });
});

// Test 7: Config validation — unsupported kind
describe('Config validation — unsupported kind', () => {
  test('anthropic kind produces unsupported-provider error', () => {
    const errors = validateConfig({
      provider: { kind: 'anthropic' as unknown as 'openai-compatible', base_url: 'http://x' },
    } as unknown as Parameters<typeof validateConfig>[0]);
    expect(errors.some((e) => e.path === 'provider.kind' && e.message.includes('unsupported-provider'))).toBeTruthy();
  });
});

// Test 8: Ledger integration — records token usage
describe('LLM client — ledger records token usage', () => {
  let srv: Server;

  beforeEach(async () => {
    srv = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'test-model',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      );
    });
  });

  afterEach(() => {
    srv.close();
  });

  test('records token usage when ledger is provided', async () => {
    const ledger = createContextLedger();
    ledger.setBudget(16000);
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }), { ledger });

    await client.chat({ messages: [{ role: 'user', content: 'hi' }] });

    const expanded = ledger.getExpanded();
    expect(expanded.budget.used).toBe(150);
    expect(expanded.budget.remaining).toBe(16000 - 150);
    expect(ledger.isSafe()).toBe(true);
  });

  test('records no usage when no ledger is provided', async () => {
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }));
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    // No error — silently ignores missing ledger
  });

  test('records no usage when response has no usage data', async () => {
    srv.close();
    srv = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 't',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          // No usage field
        }),
      );
    });
    const ledger = createContextLedger();
    ledger.setBudget(16000);
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }), { ledger });
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    const expanded = ledger.getExpanded();
    expect(expanded.budget.used).toBe(0);
  });
});

// Test 9: Ledger budget enforcement — hard stop and warn
describe('LLM client — budget policy enforcement', () => {
  // Already initialized with safe response for all tests in this block
  let srv: Server;

  beforeEach(async () => {
    srv = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 't',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10000, completion_tokens: 5000, total_tokens: 15000 },
        }),
      );
    });
  });

  afterEach(() => {
    srv.close();
  });

  test('throws when budget is exhausted after call', async () => {
    const ledger = createContextLedger();
    ledger.setBudget(1000); // total budget is smaller than usage
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }), {
      ledger,
      budgetPolicy: { hardStopThreshold: -1 },
    });

    await expect(client.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      'Context budget exhausted',
    );
  });

  test('throws when remaining budget falls at or below hard-stop threshold', async () => {
    const ledger = createContextLedger();
    ledger.setBudget(5000);
    const client = createOpenAICompatibleClient(
      makeConfig({ baseUrl: getServerUrl(srv) }),
      { ledger, budgetPolicy: { hardStopThreshold: 100 } }, // remaining will be -10000, which is <= 100
    );

    await expect(client.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
  });
});

// Test 10: Image content blocks in chat requests
describe('LLM client — image content blocks', () => {
  let srv: Server;
  let captured: MockRequest | null = null;

  beforeEach(async () => {
    srv = await createMockServer((_req, res) => {
      captured = _req;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'gpt-4o',
          choices: [{ message: { role: 'assistant', content: 'I see an image' }, finish_reason: 'stop' }],
        }),
      );
    });
  });

  afterEach(() => {
    srv.close();
    captured = null;
  });

  test('sends image content blocks in OpenAI vision format', async () => {
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv), model: 'gpt-4o' }));

    await client.chat({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'auto' },
            },
          ],
        },
      ],
    });

    if (!captured) throw new Error('No request captured');
    const body = JSON.parse(captured.body) as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[0].role).toBe('user');
    expect(Array.isArray(body.messages[0].content)).toBe(true);
    const content = body.messages[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'text', text: 'What is in this image?' });
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'auto' },
    });
  });

  test('passes plain text content through unchanged', async () => {
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }));

    await client.chat({
      messages: [{ role: 'user', content: 'plain text message' }],
    });

    if (!captured) throw new Error('No request captured');
    const body = JSON.parse(captured.body) as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[0].content).toBe('plain text message');
  });

  test('warns on stderr when image content sent to non-vision model', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv), model: 'codestral' }));

      await client.chat({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in this image?' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ],
          },
        ],
      });

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('does not match known vision-capable patterns'));
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test('does not warn for text-only messages on non-vision model', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv), model: 'codestral' }));

      await client.chat({
        messages: [{ role: 'user', content: 'plain text' }],
      });

      const visionWarnings = stderrSpy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('vision'),
      );
      expect(visionWarnings).toHaveLength(0);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ─── Reasoning-content tool-call extraction ─────────────────────────────────

describe('parseSuccessResponse — tool calls from reasoning_content', () => {
  beforeAll(() => {
    ensureParsersRegistered();
  });

  test('extracts Qwen3 XML tool calls from reasoning_content when content is empty', () => {
    const body = JSON.stringify({
      model: 'qwen-test',
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            reasoning_content:
              'I need to read the package.json file.\n</think>\n<tool_call>\n<function=read>\n<parameter=path>./src/agent/dispatch-intent.ts</parameter>\n</function>\n</tool_call>',
          },
          finish_reason: 'stop',
        },
      ],
    });

    const result = parseSuccessResponse(body, 'generic');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('read');
    expect(result.toolCalls[0].arguments).toEqual({ path: './src/agent/dispatch-intent.ts' });
    expect(result.reasoningContent).toContain('package.json');
  });

  test('extracts Hermes-style JSON tool calls from reasoning_content', () => {
    const body = JSON.stringify({
      model: 'test-model',
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            reasoning_content:
              'I should read the file.\n<tool_call>{"name":"read","arguments":{"path":"package.json"}}</tool_call>',
          },
          finish_reason: 'stop',
        },
      ],
    });

    const result = parseSuccessResponse(body, 'generic');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('read');
    expect(result.toolCalls[0].arguments).toEqual({ path: 'package.json' });
  });

  test('extracts tool calls when content has stray </think> and Qwen3 XML', () => {
    const body = JSON.stringify({
      model: 'qwen-test',
      choices: [
        {
          message: {
            role: 'assistant',
            content:
              '</think> <tool_call> <function=read> <parameter=path>./src/agent/dispatch-intent.ts</parameter> </function> </tool_call>',
            reasoning_content: 'Let me think about the best approach...\n</think>',
          },
          finish_reason: 'stop',
        },
      ],
    });

    const result = parseSuccessResponse(body, 'generic');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('read');
  });

  test('does not extract tool calls from reasoning_content when none are present', () => {
    const body = JSON.stringify({
      model: 'test-model',
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: 'Just some regular reasoning without tool calls.',
          },
          finish_reason: 'stop',
        },
      ],
    });

    const result = parseSuccessResponse(body, 'generic');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.toolCallFormat).toBe('none');
  });

  test('returns empty toolCalls when content has tool-call XML but reasoning does not', () => {
    // This tests the case where content has no tool calls (just prose) and
    // reasoning is also clean — normal completion path.
    const body = JSON.stringify({
      model: 'test-model',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'I have completed the task. Here is a summary of the changes I made.',
            reasoning_content: 'Let me summarize the work done...',
          },
          finish_reason: 'stop',
        },
      ],
    });

    const result = parseSuccessResponse(body, 'generic');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.toolCallFormat).toBe('none');
  });

  test('throws ModelToolCallParseError for malformed tool-call XML that cannot be repaired', () => {
    const body = JSON.stringify({
      model: 'qwen-test',
      choices: [
        {
          message: {
            role: 'assistant',
            content: '<tool_call><garbage nope="x"><broken></tool_call>',
          },
          finish_reason: 'stop',
        },
      ],
    });

    expect(() => parseSuccessResponse(body, 'generic')).toThrow('model emitted malformed tool call output');
  });
});
