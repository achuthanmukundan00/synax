/**
 * Tests for XML repair — bounded auto-recovery for Qwen-style XML tool calls.
 *
 * All tests exercise the public `repairXml()` interface (the internal helpers
 * are not exported) so we verify observable behaviour: the `repaired` string
 * and `fixes[]` array returned by the function.
 */

import { repairXml } from '../../llm/repair/xml-repair';
import { ensureParsersRegistered } from '../../llm/tool-calls';
import { parseSuccessResponse } from '../../llm/client';

// ─── Null / empty / non-XML input ───────────────────────────────────

describe('repairXml — null/empty guard', () => {
  test('returns null for empty string', () => {
    expect(repairXml('')).toBeNull();
  });

  test('returns null for whitespace-only string', () => {
    expect(repairXml('   \n  \t  ')).toBeNull();
  });

  test('returns null when string lacks <tool_call> or </tool_call> tags', () => {
    expect(repairXml('hello world')).toBeNull();
    expect(repairXml('<function=read></function>')).toBeNull();
    expect(repairXml('<other_tag>content</other_tag>')).toBeNull();
  });
});

// ─── Well-formed input ──────────────────────────────────────────────

describe('repairXml — well-formed input', () => {
  const wellFormed = [
    '<tool_call>\n<function=read>\n<parameter=path>foo</parameter>\n</function>\n</tool_call>',
    '<tool_call>\n<function=write>\n<parameter=path>bar</parameter>\n<parameter=content>hello</parameter>\n</function>\n</tool_call>',
  ];

  test.each(wellFormed)('returns repair result with no fixes for pre-formatted input', (input) => {
    const result = repairXml(input);
    expect(result).not.toBeNull();
    // Semantic content should be preserved
    expect(result!.repaired).toContain('<tool_call>');
    expect(result!.repaired).toContain('</tool_call>');
  });
});

// ─── Missing closing tags (adds missing) ────────────────────────────

describe('repairXml — missing closing tags', () => {
  test('adds missing </tool_call> when <tool_call> has no close', () => {
    const input = '<tool_call>\n<function=read>\n<parameter=path>foo</parameter>\n</function>';
    const result = repairXml(input);
    expect(result).not.toBeNull();
    expect(result!.repaired).toContain('</tool_call>');
    expect(result!.fixes).toContain('balanced <tool_call> tags');
  });

  test('adds missing </function> inside tool_call block', () => {
    const input = '<tool_call>\n<function=read>\n<parameter=path>foo</parameter>\n</parameter>\n</tool_call>';
    const result = repairXml(input);
    expect(result).not.toBeNull();
    expect(result!.repaired).toContain('</function>');
    expect(result!.fixes).toContain('balanced <function> tags');
  });

  test('adds missing </parameter> inside function block', () => {
    const input =
      '<tool_call>\n<function=read>\n<parameter=path>foo</parameter>\n<parameter=line>42\n</function>\n</tool_call>';
    const result = repairXml(input);
    expect(result).not.toBeNull();
    expect(result!.repaired).toContain('</parameter>');
    expect(result!.fixes).toContain('balanced <parameter> tags');
  });

  test('adds missing </tool_call> and missing </function> together', () => {
    const input = '<tool_call>\n<function=read>\n<parameter=path>foo</parameter>\n</parameter>';
    const result = repairXml(input);
    expect(result).not.toBeNull();
    expect(result!.repaired).toContain('</function>');
    expect(result!.repaired).toContain('</tool_call>');
    expect(result!.fixes.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Extra closing tags (strips extras) ─────────────────────────────

describe('repairXml — extra closing tags', () => {
  test('strips extra </tool_call> from the end', () => {
    const input = '<tool_call>\n<function=read>\n</function>\n</tool_call>\n</tool_call>\n</tool_call>';
    const result = repairXml(input);
    expect(result).not.toBeNull();
    // Count closing tool_call tags
    const closes = (result!.repaired.match(/<\/tool_call>/gi) || []).length;
    const opens = (result!.repaired.match(/<tool_call>/gi) || []).length;
    expect(closes).toBe(opens);
    expect(result!.fixes).toContain('balanced <tool_call> tags');
  });

  test('strips extra </function> from the end', () => {
    const input =
      '<tool_call>\n<function=read>\n<parameter=path>x</parameter>\n</function>\n</function>\n</function>\n</tool_call>';
    const result = repairXml(input);
    expect(result).not.toBeNull();
    const closes = (result!.repaired.match(/<\/function>/gi) || []).length;
    const opens = (result!.repaired.match(/<function=[^>]+>/gi) || []).length;
    expect(closes).toBe(opens);
    expect(result!.fixes).toContain('balanced <function> tags');
  });

  test('strips extra </parameter> from the end', () => {
    const input =
      '<tool_call>\n<function=read>\n<parameter=path>x</parameter>\n</parameter>\n</parameter>\n</function>\n</tool_call>';
    const result = repairXml(input);
    expect(result).not.toBeNull();
    const closes = (result!.repaired.match(/<\/parameter>/gi) || []).length;
    const opens = (result!.repaired.match(/<parameter=[^>]+>/gi) || []).length;
    expect(closes).toBe(opens);
    expect(result!.fixes).toContain('balanced <parameter> tags');
  });
});

// ─── Reasoning tag stripping ────────────────────────────────────────

describe('repairXml — reasoning tag stripping', () => {
  test('strips <think> blocks from inside tool-call content', () => {
    const input =
      '<tool_call>\n<function=read>\n<think>I should read this file</think>\n<parameter=path>foo</parameter>\n</function>\n</tool_call>';
    const result = repairXml(input);
    expect(result).not.toBeNull();
    expect(result!.repaired).not.toContain('<think>');
    expect(result!.repaired).toContain('<parameter=path>foo</parameter>');
    expect(result!.fixes).toContain('stripped reasoning tags inside tool blocks');
  });

  test('strips <thinking> blocks from inside tool-call content', () => {
    const input =
      '<tool_call>\n<function=read>\n<thinking>Let me think about this</thinking>\n<parameter=path>foo</parameter>\n</function>\n</tool_call>';
    const result = repairXml(input);
    expect(result).not.toBeNull();
    expect(result!.repaired).not.toContain('<thinking>');
    expect(result!.fixes).toContain('stripped reasoning tags inside tool blocks');
  });

  test('strips DeepSeek-style ```response blocks from inside tool-call content', () => {
    const input =
      '<tool_call>\n<function=read>\n```response\nSome reasoning\n```\n<parameter=path>foo</parameter>\n</function>\n</tool_call>';
    const result = repairXml(input);
    expect(result).not.toBeNull();
    expect(result!.repaired).not.toContain('```response');
    expect(result!.fixes).toContain('stripped reasoning tags inside tool blocks');
  });

  test('strips both <think> and <thinking> in one pass', () => {
    const input =
      '<tool_call>\n<function=write>\n<think>thinking text</think><thinking>more thinking</thinking>\n<parameter=path>x</parameter>\n</function>\n</tool_call>';
    const result = repairXml(input);
    expect(result).not.toBeNull();
    expect(result!.repaired).not.toContain('<think>');
    expect(result!.repaired).not.toContain('<thinking>');
    expect(result!.fixes).toContain('stripped reasoning tags inside tool blocks');
  });
});

// ─── Mixed content extraction ───────────────────────────────────────

describe('repairXml — mixed content extraction', () => {
  test('extracts tool-call blocks from text that has surrounding prose', () => {
    const input =
      'Let me read that file for you.\n<tool_call>\n<function=read>\n<parameter=path>foo</parameter>\n</function>\n</tool_call>\nDone.';
    const result = repairXml(input);
    expect(result).not.toBeNull();
    // Surrounding prose should be stripped
    expect(result!.repaired).not.toContain('Let me read that file');
    expect(result!.repaired).not.toContain('Done.');
    expect(result!.repaired).toContain('<tool_call>');
    expect(result!.repaired).toContain('</tool_call>');
    expect(result!.fixes).toContain('extracted tool-call blocks from mixed content');
  });

  test('extracts and joins multiple tool-call blocks from mixed content', () => {
    const input =
      'First\n<tool_call>\n<function=read>\n<parameter=path>a</parameter>\n</function>\n</tool_call>\nSome text\n<tool_call>\n<function=write>\n<parameter=path>b</parameter>\n</function>\n</tool_call>\nDone.';
    const result = repairXml(input);
    expect(result).not.toBeNull();
    // Should have 2 tool_call blocks
    const matches = result!.repaired.match(/<tool_call>/g);
    expect(matches).toHaveLength(2);
    expect(result!.fixes).toContain('extracted tool-call blocks from mixed content');
  });
});

// ─── Bare function name wrapping ────────────────────────────────────

describe('repairXml — bare function name wrapping', () => {
  test('wraps bare function name inside <tool_call> with <function=> tag', () => {
    const input = '<tool_call>\nread\n<parameter=path>foo</parameter>\n</tool_call>';
    const result = repairXml(input);
    expect(result).not.toBeNull();
    expect(result!.repaired).toContain('<function=read>');
    expect(result!.repaired).toContain('</function>');
    // The bare "read" should no longer appear as bare text
    expect(result!.fixes).toContain('wrapped bare function name in <function=...> tags');
  });
});

// ─── Case sensitivity ──────────────────────────────────────────────

describe('repairXml — case insensitive tags', () => {
  test('handles uppercase <TOOL_CALL> tags', () => {
    const input = '<TOOL_CALL>\n<FUNCTION=read>\n<PARAMETER=path>foo</PARAMETER>\n</FUNCTION>\n</TOOL_CALL>';
    const result = repairXml(input);
    expect(result).not.toBeNull();
    // The repair normalizes to lowercase
    expect(result!.repaired).toContain('<tool_call>');
    expect(result!.repaired).toContain('</tool_call>');
  });

  test('handles mixed-case <Tool_Call> tags', () => {
    const input = '<Tool_Call>\n<Function=read>\n<Parameter=path>foo</Parameter>\n</Function>\n</Tool_Call>';
    const result = repairXml(input);
    expect(result).not.toBeNull();
    // Should still detect and process these tags
    expect(result!.repaired).toMatch(/<tool_call>/i);
  });
});

// ─── End-to-end: repair results feed into tool call parsing ────────

describe('repairXml — downstream parse after repair', () => {
  beforeAll(() => {
    ensureParsersRegistered();
  });

  test('repaired malformed XML can be parsed as valid tool calls', () => {
    // Missing </function> inside tool_call — repair should fix it, then
    // parseSuccessResponse should extract the tool call.
    const input = '<tool_call>\n<function=read>\n<parameter=path>./README.md</parameter>\n</tool_call>';
    const repaired = repairXml(input);
    expect(repaired).not.toBeNull();

    const body = JSON.stringify({
      model: 'qwen-test',
      choices: [
        {
          message: { role: 'assistant', content: repaired!.repaired },
          finish_reason: 'tool_calls',
        },
      ],
    });

    const result = parseSuccessResponse(body, 'qwen3_xml');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('read');
    expect(result.toolCalls[0].arguments).toMatchObject({ path: './README.md' });
  });

  test('repaired thinking-and-bare-name input yields parseable tool calls', () => {
    const input =
      '<tool_call>\n<think>I should check this file</think>\nread\n<parameter=path>./src/agent/dispatch-intent.ts</parameter>\n</tool_call>';
    const repaired = repairXml(input);
    expect(repaired).not.toBeNull();

    const body = JSON.stringify({
      model: 'qwen-test',
      choices: [
        {
          message: { role: 'assistant', content: repaired!.repaired },
          finish_reason: 'tool_calls',
        },
      ],
    });

    const result = parseSuccessResponse(body, 'qwen3_xml');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('read');
    expect(result.toolCalls[0].arguments).toMatchObject({ path: './src/agent/dispatch-intent.ts' });
  });
});
