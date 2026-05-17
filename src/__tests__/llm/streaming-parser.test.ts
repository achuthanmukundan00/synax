/**
 * Tests for the streaming parser (readOpenAIStream) and the reasoning_content
 * path in parseSuccessResponse.
 *
 * Streaming-specific scenarios are tested end-to-end through a mock HTTP server
 * that sends SSE chunks.  Non-streaming reasoned-content scenarios are tested
 * by calling parseSuccessResponse directly.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createOpenAICompatibleClient, parseSuccessResponse } from '../../llm/client';
import { ensureParsersRegistered } from '../../llm/tool-calls';
import { normalizeProviderConfig } from '../../config/project';
import type { NormalizedProviderConfig } from '../../llm/types';
import type { ProviderConfig } from '../../config/project';

// ─── Test infrastructure ────────────────────────────────────────────

interface MockRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

function createMockServer(
  handler: (req: MockRequest, res: ServerResponse<IncomingMessage>) => void,
): Promise<Server> {
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

// ─── Streaming parser — reasoning_content edge cases ────────────────

describe('streaming parser — reasoning_content edge cases', () => {
  let srv: Server;

  afterEach(() => {
    srv.close();
  });

  test('streams reasoning_content containing =read=path protocol residue', async () => {
    srv = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: '=read=path/to/file.json is the path I need\n' } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: '</think>\n<tool_call>\n<function=read>' } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: '<parameter=path>to/file.json</parameter>\n</function>\n</tool_call>' } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: ' File read.' }, finish_reason: 'stop' }],
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });

    const deltas: Array<{ content?: string; reasoningContent?: string }> = [];
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }));
    const resp = await client.chat({
      messages: [{ role: 'user', content: 'read it' }],
      onDelta: (delta) => deltas.push(delta),
    });

    // The protocol residue should flow through without causing errors
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    const reasoningDeltas = deltas.filter((d) => d.reasoningContent);
    expect(reasoningDeltas.length).toBeGreaterThanOrEqual(1);
    expect(resp.reasoningContent).toContain('=read=path/to/file.json');
  });

  test('empty reasoning_content produces no reasoning deltas', async () => {
    srv = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: 'Hello' } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: ' world', finish_reason: 'stop' } }],
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

    expect(deltas.filter((d) => d.reasoningContent)).toHaveLength(0);
    expect(resp.content).toBe('Hello world');
    expect(resp.reasoningContent).toBeUndefined();
  });

  test('interleaved tool_call deltas with reasoning_content and content', async () => {
    srv = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // First: reasoning
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: 'I need to read a file' } }],
        })}\n\n`,
      );
      // Second: content (XML tool call start) + reasoning together
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: ' so here goes', content: '<tool_call>' } }],
        })}\n\n`,
      );
      // Third: tool_call delta (native OpenAI format)
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_r1', function: { name: 'read', arguments: '' } }] } }],
        })}\n\n`,
      );
      // Fourth: content tool call body + tool_call args
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: '<function=read><parameter=path>file</parameter></function></tool_call>',
                tool_calls: [{ index: 0, function: { arguments: '{"path":"file"}' } }],
              },
            },
          ],
        })}\n\n`,
      );
      // Fifth: finish
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });

    const deltas: Array<{ content?: string; reasoningContent?: string }> = [];
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }));
    const resp = await client.chat({
      messages: [{ role: 'user', content: 'read file' }],
      onDelta: (delta) => deltas.push(delta),
    });

    // Reasoning deltas delivered
    const reasoningDeltas = deltas.filter((d) => d.reasoningContent);
    expect(reasoningDeltas.length).toBeGreaterThanOrEqual(2);
    expect(resp.reasoningContent).toBe('I need to read a file so here goes');
    // Content from text should be the XML tool call
    expect(resp.content).toContain('<tool_call>');
    // Native OpenAI tool calls should also be extracted
    expect(resp.toolCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('malformed SSE chunks are skipped gracefully', async () => {
    srv = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // Empty data line
      res.write('data: \n\n');
      // Valid chunk with content
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: 'Hello' } }],
        })}\n\n`,
      );
      // [DONE] marker
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const deltas: Array<{ content?: string; reasoningContent?: string }> = [];
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }));
    const resp = await client.chat({
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toHaveLength(1);
    expect(deltas[0].content).toBe('Hello');
    expect(resp.content).toBe('Hello');
  });

  test('non-JSON SSE data throws a parse error', async () => {
    srv = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {not valid json\n\n');
      res.end('data: [DONE]\n\n');
    });

    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }));

    await expect(
      client.chat({
        messages: [{ role: 'user', content: 'hi' }],
        onDelta: () => {},
      }),
    ).rejects.toThrow();
  });

  test('falls back to plain JSON parsing when server returns non-SSE response', async () => {
    srv = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'test-model',
          choices: [{ message: { role: 'assistant', content: 'JSON fallback content' }, finish_reason: 'stop' }],
        }),
      );
    });

    const deltas: Array<{ content?: string; reasoningContent?: string }> = [];
    const client = createOpenAICompatibleClient(makeConfig({ baseUrl: getServerUrl(srv) }));
    const resp = await client.chat({
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (delta) => deltas.push(delta),
    });

    // Non-SSE JSON response parsed via fallback — content should be correct
    expect(resp.content).toBe('JSON fallback content');
    expect(resp.model).toBe('test-model');
    // No streaming deltas since it wasn't SSE
    expect(deltas).toHaveLength(0);
  });
});

// ─── parseSuccessResponse — reasoning_content edge cases ────────────

describe('parseSuccessResponse — reasoning_content edge cases', () => {
  beforeAll(() => {
    ensureParsersRegistered();
  });

  test('extracts tool calls from reasoning_content that contains =read=path protocol residue', () => {
    const body = JSON.stringify({
      model: 'qwen-test',
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            reasoning_content:
              'Check =read=path/to/data.json\n</think>\n<tool_call>\n<function=read>\n<parameter=path>to/data.json</parameter>\n</function>\n</tool_call>',
          },
          finish_reason: 'stop',
        },
      ],
    });

    const result = parseSuccessResponse(body, 'generic');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('read');
    expect(result.toolCalls[0].arguments).toEqual({ path: 'to/data.json' });
    // reasoningContent should retain the protocol residue
    expect(result.reasoningContent).toContain('=read=path/to/data.json');
  });

  test('extracts tool calls from reasoning_content with mixed thinking tags and protocol residue', () => {
    const body = JSON.stringify({
      model: 'qwen-test',
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            reasoning_content:
              '<thinking>I should use =read=path/src/index.ts</thinking>\n<tool_call>\n<function=read>\n<parameter=path>src/index.ts</parameter>\n</function>\n</tool_call>',
          },
          finish_reason: 'stop',
        },
      ],
    });

    const result = parseSuccessResponse(body, 'generic');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('read');
    // Protocol residue inside <thinking> should be retained in reasoning_content
    expect(result.reasoningContent).toContain('=read=path/src/index.ts');
  });

  test('does not crash when reasoning_content has only protocol residue without tool calls', () => {
    const body = JSON.stringify({
      model: 'test-model',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'The answer is 42.',
            reasoning_content: '=read=path/to/file computed the result',
          },
          finish_reason: 'stop',
        },
      ],
    });

    const result = parseSuccessResponse(body, 'generic');
    // No tool calls — the protocol residue is just text, not a tool call
    expect(result.toolCalls).toHaveLength(0);
    expect(result.toolCallFormat).toBe('none');
    expect(result.content).toBe('The answer is 42.');
    expect(result.reasoningContent).toContain('=read=path/to/file');
  });

  test('returns no tool calls when reasoning_content has </think> but no tool_call XML', () => {
    const body = JSON.stringify({
      model: 'test-model',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Regular content here.',
            reasoning_content: '</think>\nJust thinking without a tool call.',
          },
          finish_reason: 'stop',
        },
      ],
    });

    const result = parseSuccessResponse(body, 'generic');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.toolCallFormat).toBe('none');
  });

  test('parses tool calls from reasoning_content with qwen3_xml fallback when generic parser fails', () => {
    // Generic parser cannot handle Qwen3 XML format, but qwen3_xml fallback should
    const body = JSON.stringify({
      model: 'qwen-test',
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            reasoning_content:
              '<tool_call>\n<function=read>\n<parameter=path>./package.json</parameter>\n</function>\n</tool_call>',
          },
          finish_reason: 'stop',
        },
      ],
    });

    const result = parseSuccessResponse(body, 'generic');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('read');
    expect(result.toolCalls[0].arguments).toEqual({ path: './package.json' });
    expect(result.toolCallFormat).toBe('content_xml');
  });
});
