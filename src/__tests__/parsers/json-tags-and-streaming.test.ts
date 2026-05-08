/**
 * JSON-in-tags parsers and streaming boundary tests.
 *
 * Tests for:
 * - Granite, InternLM, FunctionGemma, OLMo3, Jamba, MiniMax, etc.
 * - GigaChat3 <function=name> format
 * - Streaming chunk boundary behavior (re-parsing complete output after chunks)
 * - GLM and Step parsers
 */

import { toolCallParserRegistry, ensureParsersRegistered, resetCallIdCounter } from '../../llm/parsers/index';

beforeAll(() => ensureParsersRegistered());
beforeEach(() => resetCallIdCounter());

// ─── JSON-in-tags variants ─────────────────────────────────

describe('JSON-in-tags parsers (Granite, InternLM, etc.)', () => {
  const jsonInTagParsers = [
    'granite',
    'granite4',
    'granite-20b-fc',
    'internlm',
    'jamba',
    'minimax',
    'kimi_k2',
    'hunyuan_a13b',
    'longcat',
  ];

  for (const parserId of jsonInTagParsers) {
    it(`${parserId} parses standard <tool_call> JSON`, () => {
      const result = toolCallParserRegistry.parse(
        parserId,
        '<tool_call>{"name":"get_weather","arguments":{"location":"SF"}}</tool_call>',
      );
      expect(result.ok).toBe(true);
      expect(result.calls.length).toBe(1);
      expect(result.calls[0].name).toBe('get_weather');
      expect(result.calls[0].parserId).toBe(parserId);
    });

    it(`${parserId} returns empty calls for non-tool content`, () => {
      const result = toolCallParserRegistry.parse(parserId, 'Normal text.');
      expect(result.ok).toBe(true);
      expect(result.calls.length).toBe(0);
    });
  }
});

// ─── OLMo3 ─────────────────────────────────────────────────

describe('OLMo3 parser', () => {
  const parserId = 'olmo3';

  it('parses <function_calls> wrapper with <function_call> entries', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<function_calls><function_call>{"name":"get_weather","arguments":{"location":"SF"}}</function_call><function_call>{"name":"get_time","arguments":{"timezone":"PST"}}</function_call></function_calls>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(2);
    expect(result.calls[0].name).toBe('get_weather');
    expect(result.calls[1].name).toBe('get_time');
    expect(result.calls[0].parserId).toBe(parserId);
  });

  it('falls back to <tool_call> blocks', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call>{"name":"read","arguments":{"path":"x"}}</tool_call>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('read');
  });

  it('returns error for malformed function_call JSON', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<function_calls><function_call>not json</function_call></function_calls>',
    );
    expect(result.ok).toBe(false);
  });
});

// ─── FunctionGemma ─────────────────────────────────────────

describe('FunctionGemma parser', () => {
  const parserId = 'functiongemma';

  it('parses tag-delimited tool calls', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<tool_call>{"name":"get_weather","arguments":{"location":"SF"}}</tool_call>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('get_weather');
  });
});

// ─── GigaChat3 ─────────────────────────────────────────────

describe('GigaChat3 parser', () => {
  const parserId = 'gigachat3';

  it('parses <function=name> format with JSON args', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<function=get_weather>{"location":"SF","unit":"celsius"}</function>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('get_weather');
    expect(result.calls[0].arguments).toEqual({ location: 'SF', unit: 'celsius' });
    expect(result.calls[0].parserId).toBe(parserId);
  });

  it('parses multiple <function=name> blocks', () => {
    const result = toolCallParserRegistry.parse(
      parserId,
      '<function=read>{"path":"a.ts"}</function>\n<function=write>{"path":"b.ts","content":"hi"}</function>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(2);
    expect(result.calls[0].name).toBe('read');
    expect(result.calls[1].name).toBe('write');
  });

  it('handles function with no args body', () => {
    const result = toolCallParserRegistry.parse(parserId, '<function=list_files></function>');
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('list_files');
    expect(result.calls[0].arguments).toEqual({});
  });
});

// ─── GLM parsers ───────────────────────────────────────────

describe('GLM parsers', () => {
  it('glm45 parses <|tool_call|> special tokens', () => {
    const result = toolCallParserRegistry.parse(
      'glm45',
      '<|tool_call|>{"name":"get_weather","arguments":{"location":"SF"}}',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('get_weather');
  });

  it('glm45 falls back to Hermes-style', () => {
    const result = toolCallParserRegistry.parse(
      'glm45',
      '<tool_call>{"name":"read","arguments":{"path":"x"}}</tool_call>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('read');
  });

  it('glm47 parses <|tool_call|> special tokens', () => {
    const result = toolCallParserRegistry.parse(
      'glm47',
      '<|tool_call|>{"name":"get_weather","arguments":{"location":"SF"}}',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('get_weather');
  });
});

// ─── Step parsers ──────────────────────────────────────────

describe('Step parsers', () => {
  it('step3 parses <tool_call> blocks', () => {
    const result = toolCallParserRegistry.parse(
      'step3',
      '<tool_call>{"name":"read","arguments":{"path":"x"}}</tool_call>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('read');
  });

  it('step3p5 parses <function_call> blocks', () => {
    const result = toolCallParserRegistry.parse(
      'step3p5',
      '<function_call>{"name":"read","arguments":{"path":"x"}}</function_call>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('read');
  });
});

// ─── Streaming boundary simulation ─────────────────────────

describe('Streaming chunk boundary simulation', () => {
  /**
   * Simulate streaming by splitting complete tool-call text at various
   * boundaries and verifying that the parser still produces correct results
   * when given the reassembled complete text.
   *
   * In production, Synax accumulates stream chunks and parses the complete
   * response. These tests verify that text split at any boundary still
   * parses correctly once reassembled.
   */
  const hermesInput = '<tool_call>{"name":"read","arguments":{"path":"README.md","startLine":1}}</tool_call>';

  function splitAndReassemble(text: string, splitPoint: number): string {
    return text.slice(0, splitPoint) + text.slice(splitPoint);
  }

  it('parses correctly when split inside tag name', () => {
    const reassembled = splitAndReassemble(hermesInput, 4); // split after "<too"
    const result = toolCallParserRegistry.parse('hermes', reassembled);
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('read');
  });

  it('parses correctly when split inside JSON string', () => {
    const splitIdx = hermesInput.indexOf('README.md') + 5;
    const reassembled = splitAndReassemble(hermesInput, splitIdx);
    const result = toolCallParserRegistry.parse('hermes', reassembled);
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].arguments).toHaveProperty('path', 'README.md');
  });

  it('parses correctly when split before closing tag', () => {
    const splitIdx = hermesInput.lastIndexOf('</tool_call>');
    const reassembled = splitAndReassemble(hermesInput, splitIdx);
    const result = toolCallParserRegistry.parse('hermes', reassembled);
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('read');
  });

  it('parses Qwen XML when split inside function body', () => {
    const qwenInput = '<tool_call><function=read><parameter=path>a.ts</parameter></function></tool_call>';
    const splitIdx = qwenInput.indexOf('<parameter=') + 5;
    const reassembled = splitAndReassemble(qwenInput, splitIdx);
    const result = toolCallParserRegistry.parse('qwen3_xml', reassembled);
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('read');
    expect(result.calls[0].arguments).toEqual({ path: 'a.ts' });
  });

  it('parses Pythonic when split inside function name', () => {
    const pythonicInput = 'get_weather(location="SF", unit="celsius")';
    const splitIdx = 4; // split after "get_"
    const reassembled = splitAndReassemble(pythonicInput, splitIdx);
    const result = toolCallParserRegistry.parse('pythonic', reassembled);
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].name).toBe('get_weather');
  });
});

// ─── OpenAI passthrough ────────────────────────────────────

describe('OpenAI passthrough parser', () => {
  it('returns empty calls (tool_calls come via API, not text)', () => {
    const result = toolCallParserRegistry.parse(
      'openai',
      '<tool_call>{"name":"read","arguments":{"path":"x"}}</tool_call>',
    );
    expect(result.ok).toBe(true);
    expect(result.calls.length).toBe(0);
    expect(result.content).toContain('<tool_call>');
  });
});
