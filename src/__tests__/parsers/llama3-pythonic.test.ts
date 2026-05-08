/**
 * Llama 3 JSON and Pythonic parser tests.
 *
 * Tests llama3_json, pythonic, and llama4_pythonic parsers.
 *
 * Reference: vLLM
 *   --tool-call-parser llama3_json
 *   --tool-call-parser pythonic
 *   --tool-call-parser llama4_pythonic
 */

import { toolCallParserRegistry, ensureParsersRegistered, resetCallIdCounter } from '../../llm/parsers/index';

beforeAll(() => ensureParsersRegistered());
beforeEach(() => resetCallIdCounter());

// ─── Llama 3 JSON ─────────────────────────────────────────

describe('Llama 3 JSON parser', () => {
  const parserId = 'llama3_json';

  it('parses <|python_tag|> prefixed JSON', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<|python_tag|>{"name":"get_weather","parameters":{"location":"SF","unit":"celsius"}}',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('get_weather');
    expect(result.calls[0].arguments).toEqual({ location: 'SF', unit: 'celsius' });
    expect(result.calls[0].parserId).toBe(parserId);
  });

  it('parses multiple <|python_tag|> blocks', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<|python_tag|>{"name":"read","parameters":{"path":"a.ts"}}\n<|python_tag|>{"name":"read","parameters":{"path":"b.ts"}}',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(2);
    expect(result.calls[0].name).toBe('read');
    expect(result.calls[1].name).toBe('read');
  });

  it('handles string arguments (JSON-encoded)', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<|python_tag|>{"name":"bash","parameters":"{\\"command\\":\\"ls\\"}"}',
    );
    expect(result.ok).toBe(true);
    expect(result.calls[0].arguments).toEqual({ command: 'ls' });
  });

  it('strips Llama header tags', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<|start_header_id|>assistant<|end_header_id|>\n<|python_tag|>{"name":"read","parameters":{"path":"x"}}<|eot_id|>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('read');
  });

  it('extracts prose before and after tool calls', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      'Here you go:\n<|python_tag|>{"name":"read","parameters":{"path":"x"}}\nHope that helps.',
    );
    expect(result.content).toContain('Here you go');
    expect(result.content).not.toContain('<|python_tag|>');
  });

  it('skips non-JSON after <|python_tag|>', () => {
    const result = toolCallParserRegistry.parse(parserId, '<|python_tag|>not valid json here');
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(0);
  });

  it('returns empty calls for non-tool content', () => {
    const result = toolCallParserRegistry.parse(parserId, 'Normal response.');
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(0);
  });
});

// ─── Pythonic ──────────────────────────────────────────────

describe('Pythonic parser', () => {
  const parserId = 'pythonic';

  it('parses a single function call with keyword args', () => {
    const result = toolCallParserRegistry.parse(parserId, 'get_weather(location="San Francisco", unit="celsius")');
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('get_weather');
    expect(result.calls[0].arguments).toEqual({ location: 'San Francisco', unit: 'celsius' });
  });

  it('parses a list of function calls (parallel)', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '[get_weather(city="SF", metric="celsius"), get_weather(city="Seattle", metric="celsius")]',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(2);
    expect(result.calls[0].name).toBe('get_weather');
    expect(result.calls[0].arguments).toEqual({ city: 'SF', metric: 'celsius' });
    expect(result.calls[1].arguments).toEqual({ city: 'Seattle', metric: 'celsius' });
  });

  it('coerces numeric values', () => {
    const result = toolCallParserRegistry.parse(parserId, 'set_count(n=42, pi=3.14)');
    expect(result.calls[0].arguments).toEqual({ n: 42, pi: 3.14 });
  });

  it('coerces boolean and None values', () => {
    const result = toolCallParserRegistry.parse(parserId, 'configure(debug=True, verbose=False, cache=None)');
    expect(result.calls[0].arguments).toEqual({ debug: true, verbose: false, cache: null });
  });

  it('handles mixed single and double quotes', () => {
    const result = toolCallParserRegistry.parse(parserId, 'replace(path="src/x.ts", oldStr=\'hello\', newStr="world")');
    expect(result.calls[0].arguments).toEqual({ path: 'src/x.ts', oldStr: 'hello', newStr: 'world' });
  });

  it('handles escaped quotes in strings', () => {
    const result = toolCallParserRegistry.parse(parserId, 'echo(message="say \\"hello\\" world")');
    // The Pythonic string parsing should handle escaped quotes
    expect(result.calls.length).toBe(1);
  });

  it('extracts prose around function calls', () => {
    const result = toolCallParserRegistry.parse(parserId, 'Let me help.\nget_weather(location="SF")\nDone.');
    expect(result.calls.length).toBe(1);
    expect(result.content).toContain('Let me help');
    expect(result.content).not.toContain('get_weather');
  });

  it('returns empty calls for non-tool content', () => {
    const result = toolCallParserRegistry.parse(parserId, 'Normal response.');
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(0);
  });

  it('handles no-arg function calls', () => {
    const result = toolCallParserRegistry.parse(parserId, 'list_files()');
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('list_files');
    expect(result.calls[0].arguments).toEqual({});
  });
});

// ─── Llama 4 Pythonic ──────────────────────────────────────

describe('Llama 4 Pythonic parser', () => {
  const parserId = 'llama4_pythonic';

  it('strips <|python_tag|> before parsing', () => {
    const result = toolCallParserRegistry.parse(parserId, '<|python_tag|>get_weather(location="SF", unit="celsius")');
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('get_weather');
    expect(result.calls[0].parserId).toBe(parserId);
  });

  it('parses list with <|python_tag|> prefix', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<|python_tag|>[read(path="a.ts"), write(path="b.ts", content="hi")]',
    );
    expect(result.calls.length).toBe(2);
    expect(result.calls[0].name).toBe('read');
    expect(result.calls[1].name).toBe('write');
  });
});
