/**
 * Tests for reasoning display sanitization and empty-final-answer guard.
 *
 * Covers:
 * - Protocol XML markup stripped from thinking content
 * - Natural reasoning preserved
 * - Cross-chunk tool_call blocks handled
 * - Empty/non-informative final answers detected
 */
import { stripToolCallMarkup } from '../tui/markup-sanitizer';
import { assistantVisibleContent, isGenericStatusOnlyFinalAnswer } from '../session/formatting';

// ─── Wraps the shared sanitizer with the non-word-only guard ─────────────
function sanitizeThinkingContent(text: string): string {
  let result = stripToolCallMarkup(text);
  if (/^\W+$/.test(result)) result = '';
  return result;
}

// ─── Sanitizer: protocol markup stripping ───────────────────────────────

describe('sanitizeThinkingContent', () => {
  it('strips complete tool_call block with function and parameter tags', () => {
    const input =
      '</think> <tool_call> <function=read> <parameter=path>src/session/Session.ts</parameter></function></tool_call>';
    expect(sanitizeThinkingContent(input)).toBe('');
  });

  it('strips bare </think> tag', () => {
    expect(sanitizeThinkingContent('First, let me check the code. </think>')).toBe('First, let me check the code. ');
  });

  it('strips bare <think> and </think> tags but preserves content between', () => {
    expect(sanitizeThinkingContent('<think> reasoning </think> visible content')).toBe(' reasoning visible content');
  });

  it('preserves natural reasoning text', () => {
    const input = 'I need to inspect the dispatch path before summarizing.';
    expect(sanitizeThinkingContent(input)).toBe(input);
  });

  it('strips streaming tool_call chunk fragments', () => {
    // First chunk of a cross-chunk tool_call
    expect(sanitizeThinkingContent('<tool_call> <function=read>')).toBe('');
    // Second chunk completing the call
    expect(sanitizeThinkingContent('</function></tool_call>')).toBe('');
  });

  it('strips <thinking> and </thinking> tags but preserves content between', () => {
    expect(sanitizeThinkingContent('<thinking>deep thoughts</thinking> proceed')).toBe(' deep thoughts proceed');
  });

  it('strips <invoke> tags but preserves content between', () => {
    expect(sanitizeThinkingContent('<invoke> something </invoke> continue')).toBe(' something continue');
  });

  it('strips bare <think> (truncated reasoning)', () => {
    expect(sanitizeThinkingContent('Let me think about this <think>')).toBe('Let me think about this ');
  });

  it('collapses multiple horizontal whitespace but preserves newlines', () => {
    expect(sanitizeThinkingContent('  a   b   c  ')).toBe(' a b c ');
  });

  it('preserves newlines in reasoning text', () => {
    const input = 'Line 1\nLine 2\n\nLine 4';
    const result = sanitizeThinkingContent(input);
    expect(result).toContain('\n');
    expect(result).toMatch(/Line 1\nLine 2\n\nLine 4/);
  });

  it('normalizes excessive newlines to at most 2', () => {
    const input = 'a\n\n\n\n\nb';
    expect(sanitizeThinkingContent(input)).toBe('a\n\nb');
  });

  it('strips decoration-only tokens (◇) after sanitization', () => {
    expect(sanitizeThinkingContent('◇ </think>')).toBe('');
  });

  it('handles mixed protocol and natural text', () => {
    const input =
      'I need to examine the dispatch code. </think> <tool_call><function=read><parameter=path>src/index.ts</parameter></function></tool_call> Now let me check the internals.';
    expect(sanitizeThinkingContent(input)).toBe('I need to examine the dispatch code. Now let me check the internals.');
  });

  it('strips bare <parameter=...> tag fragment', () => {
    expect(sanitizeThinkingContent('<parameter=path>src/index.ts</parameter>')).toBe('');
  });

  it('strips </function> and </parameter> close tags', () => {
    expect(sanitizeThinkingContent('</parameter></function>')).toBe('');
  });

  it('allows text with only natural punctuation', () => {
    expect(sanitizeThinkingContent('What is the agent architecture?')).toBe('What is the agent architecture?');
  });

  // ─── Malformed protocol fragments (no closing >) ──────────────────────

  it('strips malformed function/parameter block without closing >', () => {
    const input = '<function=read <parameter=path src/__tests__/dispatch-intent.test.ts </parameter </function';
    const result = sanitizeThinkingContent(input);
    expect(result).not.toContain('<function');
    expect(result).not.toContain('<parameter');
    expect(result).not.toContain('</function');
    expect(result).not.toContain('</parameter');
  });

  it('strips partial tool_call fragment without >', () => {
    const input = '</think> <tool_call <function=read <parameter=path src/foo.ts';
    const result = sanitizeThinkingContent(input);
    expect(result).not.toContain('</think');
    expect(result).not.toContain('<tool_call');
    expect(result).not.toContain('<function');
    expect(result).not.toContain('<parameter');
  });

  it('preserves spacing around removed malformed fragments', () => {
    const input = 'before<function=read <parameter=path src/foo.ts </parameter </function after';
    const result = sanitizeThinkingContent(input);
    expect(result).toBe('before after');
  });

  it('preserves spacing around well-formed protocol blocks', () => {
    const input = 'before <tool_call><function=read><parameter=path>x</parameter></function></tool_call> after';
    const result = sanitizeThinkingContent(input);
    expect(result).toBe('before after');
  });

  it('handles </think> without closing >', () => {
    expect(sanitizeThinkingContent('Let me consider the options </think')).toBe('Let me consider the options ');
  });

  it('strips <think without > (truncated opening tag)', () => {
    expect(sanitizeThinkingContent('<think truncated thought')).toBe(' truncated thought');
  });

  it('handles </thinking without >', () => {
    expect(sanitizeThinkingContent('text before </thinking after')).toBe('text before after');
  });

  // ─── Bare protocol shorthand (=read=path) residue ─────────────────────────

  it('strips bare =read=path protocol residue', () => {
    expect(sanitizeThinkingContent('=read=path src/session/Session.ts')).toBe('');
  });

  it('strips concatenated =read=path calls without spaces between', () => {
    const input = '=read=path src/handoffHandoffManager.ts=read=path src/orchestrationplan-parser.ts';
    const result = sanitizeThinkingContent(input);
    expect(result).not.toContain('=read');
  });

  it('strips =read=path with paths that have slashes, concatenated', () => {
    const input = '=read=path srcllm/parsers/types.ts=read=path srcllm/parsersregistry.ts';
    const result = sanitizeThinkingContent(input);
    expect(result).not.toContain('=read');
  });

  it('preserves natural text around stripped =read=path residue', () => {
    const input = 'before =read=path src/foo.ts after';
    expect(sanitizeThinkingContent(input)).toBe('before after');
  });

  it('preserves natural text with no protocol residue', () => {
    const input = 'Let me inspect src/llm/parsers/registry.ts next.';
    expect(sanitizeThinkingContent(input)).toBe(input);
  });

  it('strips multiple =read=path references with natural text between', () => {
    const input = 'Check =read=path src/a.ts and =read=path src/b.ts now';
    const result = sanitizeThinkingContent(input);
    expect(result).not.toContain('=read');
    expect(result).toContain('Check');
    expect(result).toContain('and');
    expect(result).toContain('now');
  });

  it('strips bare function=read leaked without angle brackets', () => {
    expect(sanitizeThinkingContent('function=read')).toBe('');
    expect(sanitizeThinkingContent('parameter=path')).toBe('');
  });

  // ─── Word-joining regression: tags flush against text ─────────────────

  it('prevents word-joining when <think> tags are flush against text', () => {
    expect(sanitizeThinkingContent('check<think>reasoning</think>the code')).toBe('check reasoning the code');
  });

  it('prevents word-joining when <thinking> tags are flush against text', () => {
    expect(sanitizeThinkingContent('inspect<thinking>deep</thinking>dispatch')).toBe('inspect deep dispatch');
  });
});

// ─── assistantVisibleContent: empty final answer detection ───────────────

describe('assistantVisibleContent (empty final answer guard)', () => {
  it('returns empty for model content that is only </think>', () => {
    expect(assistantVisibleContent('</think>')).toBe('');
  });

  it('returns empty for content with only protocol markup', () => {
    expect(
      assistantVisibleContent(
        '<tool_call><function=read><parameter=path>src/index.ts</parameter></function></tool_call>',
      ),
    ).toBe('');
  });

  it('returns visible text for natural completion', () => {
    expect(assistantVisibleContent('The dispatch flow works like this: first, classifyDispatchIntent is called.')).toBe(
      'The dispatch flow works like this: first, classifyDispatchIntent is called.',
    );
  });

  it('returns visible text when natural content precedes protocol markup', () => {
    const input = 'I found the answer. </think>';
    expect(assistantVisibleContent(input)).toBe('I found the answer.');
  });

  it('strips <tool_call> blocks alongside reasoning tags', () => {
    const input = 'Summary: works. <tool_call><function=read><parameter=path>x</parameter></function></tool_call>';
    expect(assistantVisibleContent(input)).toBe('Summary: works.');
  });
});

// ─── isGenericStatusOnlyFinalAnswer: generic status detection ─────────────

describe('isGenericStatusOnlyFinalAnswer', () => {
  it('detects plain Status: completed', () => {
    expect(isGenericStatusOnlyFinalAnswer('Status: completed')).toBe(true);
  });

  it('detects Status: completed with working tree dirty', () => {
    expect(isGenericStatusOnlyFinalAnswer('Status: completed\nWorking tree: dirty')).toBe(true);
  });

  it('detects Status: failed', () => {
    expect(isGenericStatusOnlyFinalAnswer('Status: failed')).toBe(true);
  });

  it('detects lowercase variants', () => {
    expect(isGenericStatusOnlyFinalAnswer('status: completed\nworking tree: clean')).toBe(true);
  });

  it('rejects text with actual content', () => {
    expect(isGenericStatusOnlyFinalAnswer('Found 3 hardcoded API keys in src/auth.ts.')).toBe(false);
  });

  it('rejects empty string (not a status)', () => {
    // Empty returns true because there is no substantive answer
    expect(isGenericStatusOnlyFinalAnswer('')).toBe(true);
  });

  it('rejects mixed status with additional prose', () => {
    expect(isGenericStatusOnlyFinalAnswer('Status: completed. The routing module has been refactored.')).toBe(false);
  });

  it('rejects legitimate short answers', () => {
    expect(isGenericStatusOnlyFinalAnswer('All tests pass.')).toBe(false);
    expect(isGenericStatusOnlyFinalAnswer('Done.')).toBe(false);
    expect(isGenericStatusOnlyFinalAnswer('The bug is in the parser.')).toBe(false);
  });

  it('handles whitespace around status lines', () => {
    expect(isGenericStatusOnlyFinalAnswer('  Status: completed  \n  Working tree: dirty  ')).toBe(true);
  });
});
