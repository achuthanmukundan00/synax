import {
  parseQwenToolCallsFromContentResult,
  parseToolCallsFromContentResult,
  parseOpenAIToolCallsResult,
  sanitizeReasoningTags,
} from '../llm/tool-calls';

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

  it('accepts markdown final answers that mention <tool_call> literally', () => {
    const result = parseToolCallsFromContentResult(
      '## Audit report\nThis mentions `<tool_call>` in prose and references src/llm/tool-calls.ts.',
    );

    expect(result).toEqual({
      ok: true,
      source: 'none',
      calls: [],
    });
  });

  it('accepts fenced code blocks that contain literal <tool_call> text', () => {
    const result = parseToolCallsFromContentResult(
      '```md\nUse <tool_call> ... </tool_call> only as an example, not as output.\n```',
    );

    expect(result).toEqual({
      ok: true,
      source: 'none',
      calls: [],
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
    expect(result).toMatchObject({
      ok: true,
      source: 'content',
      calls: [{ id: 'call_1', name: 'read', arguments: { path: 'README.md' } }],
    });
    expect(sanitizeReasoningTags('<thinking>x</thinking>final')).toBe('final');
  });

  it('parses Qwen XML tool calls with primitives and JSON safely', () => {
    const result = parseQwenToolCallsFromContentResult(
      'Preamble\n<tool_call>\n<function=read>\n<parameter=path>\nREADME.md\n</parameter>\n<parameter=flag>true</parameter>\n<parameter=count>12</parameter>\n<parameter=data>{"a":[1]}</parameter>\n<parameter=unsafe>process.exit(1)</parameter>\n</function>\n</tool_call>',
    );

    expect(result).toMatchObject({
      ok: true,
      source: 'content',
      calls: [
        {
          id: 'call_1',
          name: 'read',
          arguments: { path: 'README.md', flag: true, count: 12, data: { a: [1] }, unsafe: 'process.exit(1)' },
        },
      ],
    });
  });

  it('parses multiple Qwen XML tool calls and rejects malformed wrappers', () => {
    const ok = parseQwenToolCallsFromContentResult(
      '<tool_call><function=read><parameter=path>a.ts</parameter></function></tool_call>\n<tool_call><function=read><parameter=path>b.ts</parameter></function></tool_call>',
    );
    expect(ok).toMatchObject({ ok: true, calls: [{ name: 'read' }, { name: 'read' }] });

    const malformed = parseQwenToolCallsFromContentResult(
      '<tool_call><function=read><parameter=path>x</function></tool_call>',
    );
    expect(malformed).toEqual({
      ok: false,
      reason: 'malformed-json',
      message: 'Qwen tool_call block contained malformed <parameter=...>',
    });
  });
});
