/**
 * Tool-call parser registry and integration tests.
 *
 * Tests cover:
 * - Registry registration, lookup, listing
 * - Parser selection and auto-detection
 * - Canonical output structure
 * - Backward-compatible API
 */
import {
  toolCallParserRegistry,
  ensureParsersRegistered,
  detectParserId,
  resetCallIdCounter,
  sanitizeReasoningTags,
} from '../../llm/parsers/index';

// Also test via the tool-calls.ts re-export layer
import {
  parseToolCallsFromContent,
  parseToolCallsFromContentResult,
  parseOpenAIToolCallsResult,
} from '../../llm/tool-calls';

beforeAll(() => {
  ensureParsersRegistered();
});

beforeEach(() => {
  resetCallIdCounter();
});

// ─── Registry tests ───────────────────────────────────────

describe('ToolCallParserRegistry', () => {
  it('registers all built-in parsers on demand', () => {
    const ids = toolCallParserRegistry.listIds();
    expect(ids).toContain('generic');
    expect(ids).toContain('qwen3_xml');
    expect(ids).toContain('qwen3_coder'); // alias
    expect(ids).toContain('hermes');
    expect(ids).toContain('llama3_json');
    expect(ids).toContain('pythonic');
    expect(ids).toContain('llama4_pythonic');
    expect(ids).toContain('mistral');
    expect(ids).toContain('deepseek_v3');
    expect(ids).toContain('deepseek_v31');
    expect(ids).toContain('xlam');
    expect(ids).toContain('granite');
    expect(ids).toContain('granite4');
    expect(ids).toContain('granite-20b-fc');
    expect(ids).toContain('internlm');
    expect(ids).toContain('functiongemma');
    expect(ids).toContain('olmo3');
    expect(ids).toContain('jamba');
    expect(ids).toContain('minimax');
    expect(ids).toContain('kimi_k2');
    expect(ids).toContain('hunyuan_a13b');
    expect(ids).toContain('longcat');
    expect(ids).toContain('gigachat3');
    expect(ids).toContain('openai');
    expect(ids).toContain('glm45');
    expect(ids).toContain('glm47');
    expect(ids).toContain('step3');
    expect(ids).toContain('step3p5');

    // Verify listParsers returns descriptions
    const list = toolCallParserRegistry.listParsers();
    expect(list.length).toBe(ids.length);
    for (const entry of list) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.modelFamilies.length).toBeGreaterThan(0);
    }
  });

  it('returns undefined for unknown parser IDs', () => {
    expect(toolCallParserRegistry.get('nonexistent')).toBeUndefined();
  });

  it('returns error result when parsing with unknown parser ID', () => {
    const result = toolCallParserRegistry.parse('nonexistent', 'some text');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unknown parser');
  });

  it('qwen3_coder alias returns same parser as qwen3_xml', () => {
    const qwen3xml = toolCallParserRegistry.get('qwen3_xml');
    const qwen3coder = toolCallParserRegistry.get('qwen3_coder');
    expect(qwen3xml).toBeDefined();
    expect(qwen3coder).toBeDefined();
    // Both should parse Qwen XML the same way
    const input = '<tool_call><function=read><parameter=path>a.ts</parameter></function></tool_call>';
    const resultXml = qwen3xml!.parse(input);
    const resultCoder = qwen3coder!.parse(input);
    expect(resultXml.calls.length).toBe(1);
    expect(resultCoder.calls.length).toBe(1);
    expect(resultXml.calls[0].name).toBe('read');
    expect(resultCoder.calls[0].name).toBe('read');
  });
});

// ─── Auto-detection tests ─────────────────────────────────

describe('detectParserId', () => {
  it('detects Qwen3 models', () => {
    expect(detectParserId('Qwen3.6-35B-A3B')).toBe('qwen3_xml');
    expect(detectParserId('Qwen3.5-30B')).toBe('qwen3_xml');
    expect(detectParserId('Qwen3-Coder-480B')).toBe('qwen3_xml');
    expect(detectParserId('qwen3-xxx')).toBe('qwen3_xml');
  });

  it('detects Qwen2.5 → hermes', () => {
    expect(detectParserId('Qwen2.5-72B-Instruct')).toBe('hermes');
  });

  it('detects Hermes models', () => {
    expect(detectParserId('hermes-3-llama-3.1-8b')).toBe('hermes');
    expect(detectParserId('NousResearch/Hermes-2-Pro')).toBe('hermes');
    expect(detectParserId('openhermes-2.5')).toBe('hermes');
  });

  it('detects Llama 3 models → llama3_json', () => {
    expect(detectParserId('meta-llama/Llama-3.1-8B-Instruct')).toBe('llama3_json');
    expect(detectParserId('Llama-3.2-3B')).toBe('llama3_json');
    expect(detectParserId('Llama-3.3-70B')).toBe('llama3_json');
  });

  it('detects Llama 4 models → llama4_pythonic', () => {
    expect(detectParserId('Llama-4-Maverick')).toBe('llama4_pythonic');
    expect(detectParserId('llama4-scout')).toBe('llama4_pythonic');
  });

  it('detects DeepSeek models', () => {
    expect(detectParserId('deepseek-chat')).toBe('deepseek_v3');
    expect(detectParserId('deepseek-v3')).toBe('deepseek_v3');
    expect(detectParserId('deepseek-v3.1')).toBe('deepseek_v31');
    expect(detectParserId('deepseek-r1')).toBe('deepseek_v3');
    expect(detectParserId('DeepSeek-Reasoner')).toBe('deepseek_v3');
  });

  it('detects Mistral models', () => {
    expect(detectParserId('mistral-large')).toBe('mistral');
    expect(detectParserId('Mixtral-8x22B')).toBe('mistral');
  });

  it('detects xLAM models', () => {
    expect(detectParserId('xLAM-8B')).toBe('xlam');
  });

  it('detects Granite variants', () => {
    expect(detectParserId('granite-3-8b-instruct')).toBe('granite');
    expect(detectParserId('granite-4-8b')).toBe('granite4');
    expect(detectParserId('granite-20b-fc')).toBe('granite-20b-fc');
  });

  it('detects InternLM', () => {
    expect(detectParserId('internlm3-8b')).toBe('internlm');
  });

  it('detects FunctionGemma', () => {
    expect(detectParserId('functiongemma-270m')).toBe('functiongemma');
    expect(detectParserId('gemma-2-function-calling')).toBe('functiongemma');
  });

  it('detects OLMo3', () => {
    expect(detectParserId('olmo3-7b')).toBe('olmo3');
    expect(detectParserId('OLMoE-1B')).toBe('olmo3');
  });

  it('detects GLM variants', () => {
    expect(detectParserId('glm-4-9b-chat')).toBe('glm45');
    expect(detectParserId('glm-4.5')).toBe('glm45');
    expect(detectParserId('glm-4.7')).toBe('glm47');
  });

  it('detects Step models', () => {
    expect(detectParserId('step-3-8b')).toBe('step3');
    expect(detectParserId('step-3.5-8b')).toBe('step3p5');
  });

  it('detects Kimi K2', () => {
    expect(detectParserId('kimi-k2-7b')).toBe('kimi_k2');
  });

  it('detects Hunyuan', () => {
    expect(detectParserId('hunyuan-a13b')).toBe('hunyuan_a13b');
  });

  it('detects LongCat', () => {
    expect(detectParserId('longcat-8b')).toBe('longcat');
  });

  it('detects Jamba', () => {
    expect(detectParserId('jamba-1.5')).toBe('jamba');
  });

  it('detects MiniMax', () => {
    expect(detectParserId('MiniMax-M2')).toBe('minimax');
  });

  it('detects GigaChat', () => {
    expect(detectParserId('gigachat-3')).toBe('gigachat3');
  });

  it('returns undefined for unrecognized models', () => {
    expect(detectParserId('unknown-model-123')).toBeUndefined();
    expect(detectParserId('')).toBeUndefined();
  });
});

// ─── Canonical output structure ───────────────────────────

describe('canonical tool-call structure', () => {
  it('all parsers produce consistent ParsedToolCall records', () => {
    // Only test parsers that support Hermes-style <tool_call> JSON
    const hermesStyleParsers = [
      'generic',
      'hermes',
      'deepseek_v3',
      'deepseek_v31',
      'xlam',
      'granite',
      'granite4',
      'granite-20b-fc',
      'internlm',
      'functiongemma',
      'jamba',
      'minimax',
      'kimi_k2',
      'hunyuan_a13b',
      'longcat',
      'glm45',
      'glm47',
      'step3',
      'step3p5',
    ];

    for (const parserId of hermesStyleParsers) {
      const result = toolCallParserRegistry.parse(
        parserId,
        '<tool_call>{"name":"echo","arguments":{"msg":"hello"}}</tool_call>',
      );
      expect(result.ok).toBe(true);
      expect(result.parserId).toBe(parserId);
      expect(Array.isArray(result.calls)).toBe(true);

      for (const call of result.calls) {
        expect(typeof call.id).toBe('string');
        expect(call.id.length).toBeGreaterThan(0);
        expect(typeof call.name).toBe('string');
        expect(call.name.length).toBeGreaterThan(0);
        expect(typeof call.arguments).toBe('object');
        expect(call.parserId).toBe(parserId);
      }
    }
  });

  it('generic parser returns canonical fields', () => {
    const result = parseToolCallsFromContentResult(
      '<tool_call>{"name":"read","arguments":{"path":"x.ts"}}</tool_call>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].id).toBe('call_1');
    expect(result.calls[0].name).toBe('read');
    expect(result.calls[0].arguments).toEqual({ path: 'x.ts' });
    expect(result.calls[0].parserId).toBe('generic');
    expect(typeof result.calls[0].rawSource).toBe('string');
  });
});

// ─── Backward compatible API ──────────────────────────────

describe('backward-compatible API', () => {
  it('parseToolCallsFromContent still works', () => {
    const calls = parseToolCallsFromContent('<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>');
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe('bash');
    expect(calls[0].arguments).toEqual({ command: 'ls' });
  });

  it('parseOpenAIToolCallsResult still works', () => {
    const result = parseOpenAIToolCallsResult([
      { id: 'abc', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.source).toBe('openai');
    expect(result.calls.length).toBe(1);
  });

  it('sanitizeReasoningTags is exported and works', () => {
    expect(sanitizeReasoningTags('<think>hidden</think>visible')).toBe('visible');
    expect(sanitizeReasoningTags('<thinking>nested</thinking>')).toBe('');
  });
});
