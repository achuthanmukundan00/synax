import { parseToolCallsFromContentResult, parseOpenAIToolCallsResult, sanitizeReasoningTags } from '../llm/tool-calls';

describe('tool-call parser result API', () => {
  it('returns a typed success result for native OpenAI tool calls', () => {
    const result = parseOpenAIToolCallsResult([
      {
        id: 'call_read',
        type: 'function',
        function: {
          name: 'read',
          arguments: '{"path":"src/cli.ts"}',
        },
      },
    ]);

    expect(result).toEqual({
      ok: true,
      source: 'openai',
      calls: [{ id: 'call_read', name: 'read', arguments: { path: 'src/cli.ts' } }],
    });
  });

  it('returns a typed failure result for malformed tool_call blocks', () => {
    const result = parseToolCallsFromContentResult('<tool_call>\n{"name":"read","arguments":\n</tool_call>');

    expect(result).toEqual({
      ok: false,
      reason: 'malformed-json',
      message: 'tool_call block contained malformed JSON',
    });
  });

  it('ignores malformed fenced JSON when it does not form a valid tool call', () => {
    const result = parseToolCallsFromContentResult('```json\n{"name":"read","arguments":\n```\n');

    expect(result).toEqual({
      ok: true,
      source: 'none',
      calls: [],
    });
  });

  it('sanitizes leaked think tags before parsing', () => {
    const result = parseToolCallsFromContentResult(
      '<think>hidden</think><tool_call>{"name":"read","arguments":{"path":"README.md"}}</tool_call>',
    );
    expect(result).toEqual({
      ok: true,
      source: 'content',
      calls: [{ id: 'call_1', name: 'read', arguments: { path: 'README.md' } }],
    });
    expect(sanitizeReasoningTags('<thinking>x</thinking>final')).toBe('final');
  });
});
