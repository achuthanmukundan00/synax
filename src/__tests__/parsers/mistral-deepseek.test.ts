/**
 * Mistral and DeepSeek parser tests.
 *
 * Tests mistral, deepseek_v3, and deepseek_v31 parsers.
 *
 * Reference: vLLM
 *   --tool-call-parser mistral
 *   --tool-call-parser deepseek_v3
 *   --tool-call-parser deepseek_v31
 */

import { toolCallParserRegistry, ensureParsersRegistered, resetCallIdCounter } from '../../llm/parsers/index';

beforeAll(() => ensureParsersRegistered());
beforeEach(() => resetCallIdCounter());

// ─── Mistral ───────────────────────────────────────────────

describe('Mistral parser', () => {
  const parserId = 'mistral';

  it('parses [TOOL_CALLS] with single call', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '[TOOL_CALLS][{"name":"get_weather","arguments":{"location":"SF","unit":"celsius"}}]',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('get_weather');
    expect(result.calls[0].arguments).toEqual({ location: 'SF', unit: 'celsius' });
    expect(result.calls[0].parserId).toBe(parserId);
  });

  it('parses [TOOL_CALLS] with multiple calls', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '[TOOL_CALLS][{"name":"read","arguments":{"path":"a.ts"}},{"name":"read","arguments":{"path":"b.ts"}}]',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(2);
    expect(result.calls[0].name).toBe('read');
    expect(result.calls[1].name).toBe('read');
  });

  it('handles string arguments', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '[TOOL_CALLS][{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}]',
    );
    expect(result.calls[0].arguments).toEqual({ command: 'ls' });
  });

  it('extracts content before and after tool calls', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      'Here:\n[TOOL_CALLS][{"name":"read","arguments":{"path":"x"}}]\nDone.',
    );
    expect(result.content).toContain('Here');
    expect(result.content).not.toContain('[TOOL_CALLS]');
  });

  it('returns error when [TOOL_CALLS] is not followed by array', () => {
    const result = toolCallParserRegistry.parse(parserId, '[TOOL_CALLS]{"name":"read"}');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not followed by JSON array');
  });

  it('skips malformed items in array with warnings', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '[TOOL_CALLS][{"name":"read","arguments":{"path":"x"}}, "not an object", {"tool_name":"bash","parameters":{"command":"ls"}}]',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(2);
    expect(result.warnings?.length).toBeGreaterThan(0);
  });

  it('returns empty calls for non-tool content', () => {
    const result = toolCallParserRegistry.parse(parserId, 'Normal response.');
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(0);
  });
});

// ─── DeepSeek V3 ───────────────────────────────────────────

describe('DeepSeek V3 parser', () => {
  const parserId = 'deepseek_v3';

  it('parses <tool_call> JSON blocks', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call>{"name":"get_weather","arguments":{"location":"SF"}}</tool_call>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('get_weather');
    expect(result.calls[0].parserId).toBe(parserId);
  });

  it('parses special token delimited blocks', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<｜tool▁call▁begin｜>{"name":"read","arguments":{"path":"x"}}<｜tool▁call▁end｜>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('read');
  });

  it('parses multiple tool calls', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>\n<tool_call>{"name":"write","arguments":{"path":"b","content":"hello"}}</tool_call>',
    );
    expect(result.calls.length).toBe(2);
  });

  it('strips reasoning tags before parsing', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<think>I should read the file</think>\n<tool_call>{"name":"read","arguments":{"path":"x"}}</tool_call>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('read');
  });

  it('returns error for malformed JSON in block', () => {
    const result = toolCallParserRegistry.parse(parserId, '<tool_call>not json</tool_call>');
    expect(result.ok).toBe(false);
  });
});

// ─── DeepSeek V3.1 ─────────────────────────────────────────

describe('DeepSeek V3.1 parser', () => {
  const parserId = 'deepseek_v31';

  it('parses <tool_call> JSON blocks (same as V3)', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call>{"name":"get_weather","arguments":{"location":"SF"}}</tool_call>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('get_weather');
    expect(result.calls[0].parserId).toBe(parserId);
  });

  it('returns empty calls for non-tool content', () => {
    const result = toolCallParserRegistry.parse(parserId, 'Normal response.');
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(0);
  });
});
