import { parseToolCallsFromContentResult, parseOpenAIToolCallsResult } from '../llm/tool-calls';

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
});
