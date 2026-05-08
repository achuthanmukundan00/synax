/**
 * Hermes tool-call parser tests.
 *
 * Tests the hermes parser with:
 * - single/multiple <tool_call> JSON blocks
 * - string and object arguments
 * - custom id
 * - malformed JSON
 * - content before/after
 * - unicode
 * - unknown tools
 *
 * Reference: vLLM --tool-call-parser hermes
 *   (also used by Qwen2.5 models)
 *   vllm/entrypoints/openai/tool_parsers/hermes_tool_parser.py
 */

import { toolCallParserRegistry, ensureParsersRegistered, resetCallIdCounter } from '../../llm/parsers/index';

beforeAll(() => ensureParsersRegistered());
beforeEach(() => resetCallIdCounter());

const parserId = 'hermes';

describe('Hermes parser', () => {
  it('parses a single tool call', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call>{"name":"get_weather","arguments":{"location":"SF","unit":"celsius"}}</tool_call>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('get_weather');
    expect(result.calls[0].arguments).toEqual({ location: 'SF', unit: 'celsius' });
    expect(result.calls[0].parserId).toBe(parserId);
  });

  it('parses multiple tool calls', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>\n<tool_call>{"name":"read","arguments":{"path":"b.ts"}}</tool_call>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(2);
    expect(result.calls[0].name).toBe('read');
    expect(result.calls[1].name).toBe('read');
  });

  it('handles string arguments (JSON-encoded args)', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call>{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}</tool_call>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].arguments).toEqual({ command: 'ls' });
  });

  it('handles object arguments directly', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls[0].arguments).toEqual({ command: 'ls' });
  });

  it('preserves call id from model output', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call>{"id":"call_abc","name":"read","arguments":{"path":"x"}}</tool_call>',
    );
    expect(result.calls[0].id).toBe('call_abc');
  });

  it('generates id when not provided', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call>{"name":"read","arguments":{"path":"x"}}</tool_call>',
    );
    expect(result.calls[0].id).toBe('call_1');
  });

  it('handles alternate field names (tool_name, parameters)', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call>{"tool_name":"bash","parameters":{"command":"ls"}}</tool_call>',
    );
    expect(result.calls[0].name).toBe('bash');
    expect(result.calls[0].arguments).toEqual({ command: 'ls' });
  });

  it('rejects missing name field', () => {
    const result = toolCallParserRegistry.parse(parserId, '<tool_call>{"arguments":{"path":"x"}}</tool_call>');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('missing "name"');
  });

  it('rejects malformed JSON in block', () => {
    const result = toolCallParserRegistry.parse(parserId, '<tool_call>{"name":"read","arguments":</tool_call>');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('could not parse JSON');
  });

  it('rejects non-object JSON in block', () => {
    const result = toolCallParserRegistry.parse(parserId, '<tool_call>["array", "not", "object"]</tool_call>');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('expected JSON object');
  });

  it('extracts content before and after tool calls', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      'Let me help.\n<tool_call>{"name":"read","arguments":{"path":"x"}}</tool_call>\nDone.',
    );
    expect(result.content).toContain('Let me help');
    expect(result.content).not.toContain('<tool_call>');
  });

  it('handles empty blocks gracefully', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call></tool_call><tool_call>{"name":"read","arguments":{"path":"x"}}</tool_call>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('read');
  });

  it('handles unicode in arguments', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call>{"name":"echo","arguments":{"message":"こんにちは"}}</tool_call>',
    );
    expect(result.calls[0].arguments).toEqual({ message: 'こんにちは' });
  });

  it('handles booleans and null in arguments', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call>{"name":"test","arguments":{"flag":true,"empty":null,"count":42}}</tool_call>',
    );
    expect(result.calls[0].arguments).toEqual({ flag: true, empty: null, count: 42 });
  });

  it('handles nested objects in arguments', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call>{"name":"test","arguments":{"nested":{"a":1,"b":[2,3]}}}</tool_call>',
    );
    expect(result.calls[0].arguments).toEqual({ nested: { a: 1, b: [2, 3] } });
  });

  it('returns empty calls for non-tool content', () => {
    const result = toolCallParserRegistry.parse(parserId, 'Just a normal assistant response.');
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(0);
    expect(result.content).toBe('Just a normal assistant response.');
  });
});
