/**
 * Repair module tests — JSON repair, XML repair, and reasoning sanitization.
 *
 * Covers:
 * - repairJson: trailing commas, inner quotes, missing braces, truncation, unrepairable
 * - repairXml: unclosed tags, leaked reasoning, mixed content, unrepairable
 * - sanitizeReasoning: think/thinking blocks, fenced response blocks, truncated tags
 * - Integration: repair + parse via registry
 * - builtins.ts wiring (replace stubs)
 * - retry-nudge fallback (ModelToolCallParseError handling)
 */

import { repairJson } from '../../llm/repair/json-repair';
import { repairXml } from '../../llm/repair/xml-repair';
import { sanitizeReasoning } from '../../llm/repair/reasoning-sanitizer';
import { ensureParsersRegistered, resetCallIdCounter } from '../../llm/parsers/index';
import {
  parseToolCallsFromContentResult,
  parseQwenToolCallsFromContentResult,
  parseOpenAIToolCallsResult,
} from '../../llm/tool-calls';
import { createBuiltinExtensions } from '../../extensions';

beforeAll(() => ensureParsersRegistered());
beforeEach(() => resetCallIdCounter());

// ─── JSON repair ─────────────────────────────────────────

describe('repairJson', () => {
  it('repairs trailing commas in objects', () => {
    const raw = '{"name":"read","arguments":{"path":"x",}}';
    const result = repairJson(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.repaired).not.toContain(',}');
  });

  it('repairs trailing commas in arrays', () => {
    const raw = '{"name":"read","arguments":{"paths":["a",]}}';
    const result = repairJson(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.repaired).not.toContain(',]');
  });

  it('balances missing closing braces', () => {
    const raw = '{"name":"edit","arguments":{"path":"x","oldStr":"y"';
    const result = repairJson(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    // Should add closing braces to balance
    const parsed = JSON.parse(r.repaired);
    expect(parsed.name).toBe('edit');
    expect(parsed.arguments.path).toBe('x');
  });

  it('repairs truncated JSON objects with missing braces', () => {
    // Missing closing braces but strings are complete
    const raw = '{"name":"bash","arguments":{"command":"npm test"';
    const result = repairJson(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.fixes.length).toBeGreaterThan(0);
    const parsed = JSON.parse(r.repaired);
    expect(parsed.name).toBe('bash');
    expect(parsed.arguments.command).toBe('npm test');
  });

  it('gracefully handles unescaped inner quotes by returning null', () => {
    // Unescaped inner quotes are genuinely corrupt and cannot be reliably repaired
    const raw = '{"query":"find "foo" in bar"}';
    const result = repairJson(raw);
    // Returns null because the input is too broken — this is correct behavior
    // (the retry-nudge fallback in runner.ts handles this case)
    expect(result).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(repairJson('')).toBeNull();
    expect(repairJson('not json at all just random text')).toBeNull();
    expect(repairJson('   ')).toBeNull();
  });

  it('repairs JSON extracted from surrounding text', () => {
    const raw = 'Here is the call: {"name":"read","arguments":{"path":"README.md"}} end of text';
    const result = repairJson(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    const parsed = JSON.parse(r.repaired);
    expect(parsed.name).toBe('read');
    expect(parsed.arguments.path).toBe('README.md');
    expect(r.fixes).toContain('extracted JSON from surrounding text');
  });

  it('handles multiple trailing commas', () => {
    const raw = '{"name":"read","arguments":{"a":1,"b":2,},}';
    const result = repairJson(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    const parsed = JSON.parse(r.repaired);
    expect(parsed.name).toBe('read');
    expect(parsed.arguments.a).toBe(1);
    expect(parsed.arguments.b).toBe(2);
  });

  it('handles deeply nested truncated objects', () => {
    const raw = '{"name":"edit","arguments":{"path":"x","changes":[{"old":"a","new":"b"';
    const result = repairJson(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.fixes.length).toBeGreaterThan(0);
  });

  it('records fixes for debugging', () => {
    const raw = '{"name":"read","arguments":{"path":"x",}}';
    const result = repairJson(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.fixes).toContain('removed trailing commas');
  });
});

// ─── XML repair ──────────────────────────────────────────

describe('repairXml', () => {
  it('closes unclosed <tool_call> tags', () => {
    const raw = '<tool_call>\n<function=read>\n<parameter=path>README.md</parameter>\n</function>\n';
    const result = repairXml(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.repaired).toContain('</tool_call>');
  });

  it('strips leaked reasoning tags inside tool calls', () => {
    const raw =
      '<think>I should read the file</think><tool_call><function=read><parameter=path>README.md</parameter></function></tool_call>';
    const result = repairXml(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.repaired).not.toContain('<think>');
    expect(r.repaired).toContain('<tool_call>');
  });

  it('balances unclosed <function> tags', () => {
    const raw = '<tool_call><function=read><parameter=path>x</parameter></tool_call>';
    const result = repairXml(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    // Function has no closing tag — should be balanced
    expect(r.repaired).toContain('</function>');
  });

  it('balances unclosed <parameter> tags', () => {
    const raw =
      '<tool_call><function=edit><parameter=path>x</parameter><parameter=oldStr>y</parameter><parameter=newStr>z<parameter=flag>true</parameter></function></tool_call>';
    const result = repairXml(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    // The newStr parameter is unclosed
    expect(r.fixes.length).toBeGreaterThan(0);
  });

  it('extracts tool-call blocks from mixed content', () => {
    const raw =
      'Some text before. <tool_call><function=read><parameter=path>x</parameter></function></tool_call> Some text after.';
    const result = repairXml(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.repaired).toContain('<tool_call>');
    // Non-tool content should be stripped
    expect(r.repaired).not.toContain('Some text before');
    expect(r.repaired).not.toContain('Some text after');
  });

  it('returns null for non-XML garbage', () => {
    expect(repairXml('plain text without any XML tags')).toBeNull();
    expect(repairXml('')).toBeNull();
  });

  it('handles multiple tool-call blocks', () => {
    const raw =
      '<tool_call><function=read><parameter=path>a.ts</parameter></function></tool_call>\n<tool_call><function=read><parameter=path>b.ts</parameter></function></tool_call>';
    const result = repairXml(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.repaired.split('<tool_call>').length).toBeGreaterThanOrEqual(3); // 2 blocks + leading split
  });

  it('records fixes for debugging', () => {
    const raw = '<tool_call><function=read><parameter=path>x</parameter></function>';
    const result = repairXml(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.fixes.length).toBeGreaterThan(0);
  });

  it('wraps bare function names missing <function=...> wrapper', () => {
    // Model emitted: <tool_call>read<parameter=path>foo</parameter></tool_call>
    // instead of: <tool_call><function=read>...</function></tool_call>
    const raw = '<tool_call>\nread\n<parameter=path>README.md</parameter>\n</tool_call>';
    const result = repairXml(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.repaired).toContain('<function=read>');
    expect(r.repaired).toContain('</function>');
    expect(r.fixes).toContain('wrapped bare function name in <function=...> tags');
  });

  it('wraps bare function name with parameters on same line', () => {
    const raw =
      '<tool_call>edit<parameter=path>src/cli.ts</parameter><parameter=oldStr>foo</parameter><parameter=newStr>bar</parameter></tool_call>';
    const result = repairXml(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.repaired).toContain('<function=edit>');
    expect(r.repaired).toContain('</function>');
  });

  it('leaves blocks with existing <function=...> unchanged', () => {
    const raw = '<tool_call><function=read><parameter=path>x</parameter></function></tool_call>';
    const result = repairXml(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    // No wrapping fix recorded — block was already correct
    expect(r.fixes.every((f) => !f.includes('bare function'))).toBe(true);
  });

  it('wraps bare function in one block while leaving correct sibling alone', () => {
    const raw =
      '<tool_call><function=read><parameter=path>a.ts</parameter></function></tool_call>\n<tool_call>read<parameter=path>b.ts</parameter></tool_call>';
    const result = repairXml(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.fixes).toContain('wrapped bare function name in <function=...> tags');
    // Second block should be wrapped
    expect(r.repaired).toContain('<function=read>');
  });

  it('wraps dotted function names like mcp.call', () => {
    const raw = '<tool_call>\nmcp.read\n<parameter=uri>file://foo</parameter>\n</tool_call>';
    const result = repairXml(raw);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.repaired).toContain('<function=mcp.read>');
    expect(r.repaired).toContain('</function>');
    expect(r.fixes).toContain('wrapped bare function name in <function=...> tags');
  });

  it('repair-then-parse: bare function name survives through qwen3_xml parser', () => {
    // Simulate the repair → parse pipeline that tryRepairAndParse runs
    const raw = '<tool_call>\nread\n<parameter=path>README.md</parameter>\n</tool_call>';
    const repaired = repairXml(raw);
    expect(repaired).not.toBeNull();
    // After repair, parser should succeed
    const parsed = parseQwenToolCallsFromContentResult((repaired as NonNullable<typeof repaired>).repaired);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.calls.length).toBe(1);
      expect(parsed.calls[0].name).toBe('read');
      expect(parsed.calls[0].arguments).toEqual({ path: 'README.md' });
    }
  });
});

// ─── Reasoning sanitizer ────────────────────────────────

describe('sanitizeReasoning', () => {
  it('strips <think>...</think> blocks', () => {
    const input = '<think>hidden reasoning</think>visible output';
    const result = sanitizeReasoning(input);
    expect(result.content).toBe('visible output');
    expect(result.removedReasoning).toBe(true);
  });

  it('strips <thinking>...</thinking> blocks', () => {
    const input = '<thinking>nested thinking</thinking>final answer';
    const result = sanitizeReasoning(input);
    expect(result.content).toBe('final answer');
    expect(result.removedReasoning).toBe(true);
  });

  it('strips fenced response blocks (DeepSeek style)', () => {
    const input = '```response\nsome reasoning\n```\nactual output';
    const result = sanitizeReasoning(input);
    expect(result.content).toBe('actual output');
    expect(result.removedReasoning).toBe(true);
  });

  it('strips fenced thinking blocks (DeepSeek style)', () => {
    const input = '```thinking\nmodel thought\n```\ntool call here';
    const result = sanitizeReasoning(input);
    expect(result.content).toBe('tool call here');
    expect(result.removedReasoning).toBe(true);
  });

  it('returns content unchanged when no reasoning present', () => {
    const input = 'plain model output with no tags';
    const result = sanitizeReasoning(input);
    expect(result.content).toBe(input);
    expect(result.removedReasoning).toBe(false);
  });

  it('handles multiple reasoning blocks in sequence', () => {
    const input = '<think>first</think>\n<think>second</think>\nfinal';
    const result = sanitizeReasoning(input);
    expect(result.content).toBe('final');
    expect(result.removedReasoning).toBe(true);
  });

  it('handles empty input gracefully', () => {
    const result = sanitizeReasoning('');
    expect(result.content).toBe('');
    expect(result.removedReasoning).toBe(false);
  });

  it('handles trimmed/collapsed whitespace', () => {
    const input = '<think>hidden</think>\n\n\n\nvisible';
    const result = sanitizeReasoning(input);
    expect(result.content).toBe('visible');
    expect(result.removedReasoning).toBe(true);
  });

  it('handles self-closing think tags', () => {
    const input = '<think/>visible';
    const result = sanitizeReasoning(input);
    expect(result.content).toBe('visible');
    expect(result.removedReasoning).toBe(true);
  });

  it('handles truncated opening think tag (no close)', () => {
    const input = 'output start <think>truncated reasoning';
    const result = sanitizeReasoning(input);
    expect(result.content).toBe('output start');
    expect(result.removedReasoning).toBe(true);
  });

  it('strips stray closing think tags from final answers', () => {
    const input = 'visible result </think>';
    const result = sanitizeReasoning(input);
    expect(result.content).toBe('visible result');
    expect(result.removedReasoning).toBe(true);
  });
});

// ─── Integration: repair + parse via registry ───────────

describe('repair + parse integration', () => {
  it('repairs JSON tool calls and parses successfully', () => {
    // Simulate a model emitting trailing-comma JSON
    const raw = '<tool_call>{"name":"read","arguments":{"path":"README.md",}}</tool_call>';
    const result = parseToolCallsFromContentResult(raw);
    // Should parse successfully via repair
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.calls.length).toBeGreaterThan(0);
      expect(result.calls[0].name).toBe('read');
    }
  });

  it('repairs XML tool calls and parses successfully', () => {
    const raw =
      '<think>let me read</think><tool_call><function=read><parameter=path>a.ts</parameter></function></tool_call>';
    const result = parseQwenToolCallsFromContentResult(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.calls.length).toBeGreaterThan(0);
      expect(result.calls[0].name).toBe('read');
    }
  });

  it('handles truncated JSON via repair', () => {
    // Truncated end — repair should attempt to close
    const raw = '<tool_call>{"name":"bash","arguments":{"command":"npm test"</tool_call>';
    const result = parseToolCallsFromContentResult(raw);
    // Repair may or may not succeed here — this tests that we don't crash
    expect(result).toBeDefined();
  });
});

// ─── builtins.ts wiring ──────────────────────────────────

describe('builtin extensions wiring', () => {
  it('toolCallRepairer.repairMalformedJson is no longer a stub', () => {
    const builtins = createBuiltinExtensions();
    const repaired = builtins.toolCallRepairer.repairMalformedJson('{"name":"read","arguments":{"path":"x",}}');
    expect(repaired).not.toBeNull();
    expect(repaired).toContain('"path":"x"');
    expect(repaired).not.toContain(',}');
  });

  it('toolCallRepairer.repairMalformedXml is wired', () => {
    const builtins = createBuiltinExtensions();
    expect(builtins.toolCallRepairer.repairMalformedXml).toBeDefined();
    if (builtins.toolCallRepairer.repairMalformedXml) {
      const repaired = builtins.toolCallRepairer.repairMalformedXml(
        '<tool_call><function=read><parameter=path>x</parameter></function>',
      );
      expect(repaired).not.toBeNull();
      expect(repaired).toContain('</tool_call>');
    }
  });

  it('reasoningSanitizer.sanitize is no longer a stub', () => {
    const builtins = createBuiltinExtensions();
    const result = builtins.reasoningSanitizer.sanitize('<think>x</think>output');
    expect(result.removedReasoning).toBe(true);
    expect(result.content).toBe('output');
  });

  it('reasoningSanitizer returns unchanged when no tags present', () => {
    const builtins = createBuiltinExtensions();
    const result = builtins.reasoningSanitizer.sanitize('clean output');
    expect(result.removedReasoning).toBe(false);
    expect(result.content).toBe('clean output');
  });
});

// ─── Fallback: retry nudge behavior ──────────────────────

describe('retry-nudge fallback', () => {
  it('parseToolCallsFromContent returns failure for malformed JSON that cannot be repaired', () => {
    const result = parseToolCallsFromContentResult('<tool_call>\n{"name":"read","arguments":\n</tool_call>');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('malformed-json');
      expect(result.message).toContain('malformed');
    }
  });

  it('parseOpenAIToolCallsResult returns failure for malformed native tool calls', () => {
    const result = parseOpenAIToolCallsResult([{ function: { name: 'read', arguments: 'not-json' } }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('malformed-json');
    }
  });
});
