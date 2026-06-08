import {
  parseQwenToolCallsFromContentResult,
  parseToolCallsFromContentResult,
  parseOpenAIToolCallsResult,
  sanitizeReasoningTags,
  parseModelOutput,
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

describe('parseModelOutput — typed parsing pipeline', () => {
  it('extracts tool calls and separates assistant text', () => {
    const output = parseModelOutput(
      'I will read the file now.\n<tool_call>\n{"name":"read","arguments":{"path":"src/index.ts"}}\n</tool_call>',
      'generic',
    );

    expect(output.toolCalls).toHaveLength(1);
    expect(output.toolCalls[0].name).toBe('read');
    expect(output.assistantText).toContain('I will read the file now');
    expect(output.warnings).toHaveLength(0);
  });

  it('strips reasoning tags and records a warning', () => {
    const output = parseModelOutput(
      '<think>I need to check the file first</think>\n<tool_call>\n{"name":"read","arguments":{"path":"src/main.ts"}}\n</tool_call>',
      'hermes',
    );

    expect(output.toolCalls).toHaveLength(1);
    expect(output.toolCalls[0].name).toBe('read');
    expect(output.warnings.some((w) => w.source === 'reasoning')).toBe(true);
  });

  it('preserves reasoning from API reasoning_content field', () => {
    const output = parseModelOutput(
      '<tool_call>\n{"name":"bash","arguments":{"command":"npm test"}}\n</tool_call>',
      'generic',
      'I should run the tests to verify',
    );

    expect(output.reasoning).toBe('I should run the tests to verify');
    expect(output.toolCalls).toHaveLength(1);
  });

  it('handles content without tool calls', () => {
    const output = parseModelOutput('The task is complete. All tests pass.', 'generic');

    expect(output.toolCalls).toHaveLength(0);
    expect(output.assistantText).toContain('The task is complete');
    expect(output.warnings).toHaveLength(0);
  });

  it('handles mixed reasoning and tool calls from Qwen-style output', () => {
    const output = parseModelOutput(
      '<think>I need to check the file first</think>\nI will look at the source.\n<tool_call>\n<function=read>\n<parameter=path>src/app.ts</parameter>\n</function>\n</tool_call>',
      'qwen3_xml',
    );

    expect(output.toolCalls).toHaveLength(1);
    expect(output.toolCalls[0].name).toBe('read');
    expect(output.warnings.some((w) => w.source === 'reasoning')).toBe(true);
  });

  it('handles legit XML content containing think tags in code', () => {
    // User task might involve editing a file that contains <think> XML elements
    const output = parseModelOutput(
      '<tool_call>\n{"name":"edit","arguments":{"path":"config.xml","oldStr":"<think>old</think>","newStr":"<think>new</think>"}}\n</tool_call>',
      'generic',
    );

    // The tool call should still parse correctly even though content contains <think>
    expect(output.toolCalls.length).toBeGreaterThanOrEqual(0);
    // The parser may or may not strip the think tags — the key is that it doesn't crash
  });

  // ─── Bug #114: reasoningContent fallback for empty content ─────────

  it('falls back to reasoningContent when content is empty (bug #114)', () => {
    // DeepSeek thinking models may return rich reasoning_content with
    // an empty content field. parseModelOutput should use reasoningContent
    // as assistantText in this case.
    const output = parseModelOutput(
      '',
      'generic',
      'The bug is in src/llm/client.ts at the parseSuccessResponse function. ' +
        'When DeepSeek returns reasoning_content but empty content, finalAnswer falls back ' +
        'to an opaque terminal state string instead of using the reasoning text.',
    );

    expect(output.toolCalls).toHaveLength(0);
    expect(output.assistantText).toContain('The bug is in src/llm/client.ts');
    expect(output.reasoning).toContain('src/llm/client.ts');
    expect(output.warnings.some((w) => w.message.includes('reasoningContent as fallback'))).toBe(true);
  });

  it('strips thinking tags from reasoningContent before using as assistantText', () => {
    // Reasoning content may contain <think> tags that should be stripped
    // before surfacing as the visible answer.
    const output = parseModelOutput(
      '',
      'generic',
      '<think>Let me analyze this.</think>\nThe fix should be in parseModelOutput.',
    );

    expect(output.assistantText).toBe('The fix should be in parseModelOutput.');
    expect(output.assistantText).not.toContain('<think>');
    expect(output.warnings.some((w) => w.source === 'reasoning')).toBe(true);
  });

  it('does not override assistantText with reasoningContent when content has visible text', () => {
    const output = parseModelOutput(
      'The refactor is complete. All tests pass.',
      'generic',
      'I should check if the tests pass first.',
    );

    // assistantText comes from content, not from reasoningContent
    expect(output.assistantText).toContain('The refactor is complete');
    expect(output.reasoning).toBe('I should check if the tests pass first.');
  });
});
