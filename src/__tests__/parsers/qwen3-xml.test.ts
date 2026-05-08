/**
 * Qwen3 XML parser tests.
 *
 * Tests the qwen3_xml parser with:
 * - single call, multiple calls
 * - primitives (booleans, null, numbers, strings)
 * - nested JSON in parameters
 * - escaped content
 * - malformed blocks
 * - content before/after tool calls
 * - unknown tool names (should still parse)
 *
 * Reference: vLLM --tool-call-parser qwen3_xml
 *   vllm/entrypoints/openai/tool_parsers/qwen3_coder_tool_parser.py
 */

import { toolCallParserRegistry, ensureParsersRegistered, resetCallIdCounter } from '../../llm/parsers/index';

beforeAll(() => ensureParsersRegistered());
beforeEach(() => resetCallIdCounter());

const parserId = 'qwen3_xml';

describe('Qwen3 XML parser', () => {
  // ─── Basic ─────────────────────────────────────────

  it('parses a single tool call', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call><function=get_weather><parameter=location>San Francisco</parameter><parameter=unit>celsius</parameter></function></tool_call>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('get_weather');
    expect(result.calls[0].arguments).toEqual({ location: 'San Francisco', unit: 'celsius' });
    expect(result.calls[0].parserId).toBe(parserId);
    expect(result.calls[0].rawSource).toBeDefined();
  });

  it('parses multiple tool calls', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call><function=read><parameter=path>a.ts</parameter></function></tool_call>\n<tool_call><function=read><parameter=path>b.ts</parameter></function></tool_call>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(2);
    expect(result.calls[0].name).toBe('read');
    expect(result.calls[0].arguments).toEqual({ path: 'a.ts' });
    expect(result.calls[1].name).toBe('read');
    expect(result.calls[1].arguments).toEqual({ path: 'b.ts' });
  });

  it('parses multiple parameters in one call', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call><function=edit><parameter=path>src/x.ts</parameter><parameter=oldStr>hello</parameter><parameter=newStr>world</parameter></function></tool_call>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].arguments).toEqual({ path: 'src/x.ts', oldStr: 'hello', newStr: 'world' });
  });

  // ─── Primitives ────────────────────────────────────

  it('coerces boolean values', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call><function=test><parameter=flag>true</parameter><parameter=other>false</parameter></function></tool_call>',
    );
    expect(result.calls[0].arguments).toEqual({ flag: true, other: false });
  });

  it('coerces null values', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call><function=test><parameter=empty>null</parameter></function></tool_call>',
    );
    expect(result.calls[0].arguments).toEqual({ empty: null });
  });

  it('coerces number values', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call><function=test><parameter=int>42</parameter><parameter=float>3.14</parameter><parameter=sci>1.5e10</parameter><parameter=neg>-17</parameter></function></tool_call>',
    );
    expect(result.calls[0].arguments).toEqual({ int: 42, float: 3.14, sci: 15000000000, neg: -17 });
  });

  it('handles nested JSON in parameters', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call><function=test><parameter=data>{"nested":{"key":"value"},"arr":[1,2,3]}</parameter></function></tool_call>',
    );
    expect(result.calls[0].arguments).toEqual({
      data: { nested: { key: 'value' }, arr: [1, 2, 3] },
    });
  });

  it('handles array parameters', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call><function=test><parameter=items>[1,2,"three"]</parameter></function></tool_call>',
    );
    expect(result.calls[0].arguments).toEqual({ items: [1, 2, 'three'] });
  });

  // ─── Content before/after ──────────────────────────

  it('extracts content before and after tool calls', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      'Let me help you.\n<tool_call><function=read><parameter=path>README.md</parameter></function></tool_call>\nDone.',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.content).toContain('Let me help you');
    expect(result.content).not.toContain('<tool_call>');
  });

  it('returns empty content when only tool calls present', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call><function=read><parameter=path>x</parameter></function></tool_call>',
    );
    expect(result.content).toBe('');
  });

  // ─── Unicode / special chars ───────────────────────

  it('handles unicode in parameter values', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call><function=test><parameter=msg>こんにちは世界</parameter><parameter=emoji>🎉</parameter></function></tool_call>',
    );
    expect(result.calls[0].arguments).toEqual({ msg: 'こんにちは世界', emoji: '🎉' });
  });

  it('handles angle brackets in parameter values', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call><function=test><parameter=code><div>hello</div></parameter></function></tool_call>',
    );
    expect(result.calls[0].arguments).toEqual({ code: '<div>hello</div>' });
  });

  // ─── Malformed ─────────────────────────────────────

  it('rejects missing function wrapper', () => {
    const result = toolCallParserRegistry.parse(parserId, '<tool_call><parameter=path>x</parameter></tool_call>');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('missing <function=');
  });

  it('rejects malformed parameter tags', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call><function=read><parameter=path>x</function></tool_call>',
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('malformed <parameter=');
  });

  it('returns empty calls for content with no tool calls', () => {
    const result = toolCallParserRegistry.parse(parserId, 'Just a normal response.');
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(0);
    expect(result.content).toBe('Just a normal response.');
  });

  // ─── Unknown tool names ────────────────────────────

  it('parses unknown tool names (caller handles rejection)', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call><function=unknown_tool_xyz><parameter=arg>val</parameter></function></tool_call>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('unknown_tool_xyz');
  });

  // ─── Reasoning tags ────────────────────────────────

  it('strips reasoning tags before parsing', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<think>I should use read</think>\n<tool_call><function=read><parameter=path>x</parameter></function></tool_call>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('read');
  });
});
