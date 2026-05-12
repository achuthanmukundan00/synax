import { extractReadOutput, renderMarkdownBlock, renderReviewOutput } from '../tui/transcript';

function ansiFree(lines: string[]): string[] {
  // eslint-disable-next-line no-control-regex
  return lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ''));
}

describe('renderMarkdownBlock', () => {
  const W = 80;

  it('renders headings at different levels', () => {
    const md = ['# Heading 1', '## Heading 2', '### Heading 3'].join('\n');
    const out = ansiFree(renderMarkdownBlock(md, W));
    expect(out).toContain('Heading 1');
    expect(out).toContain('Heading 2');
    expect(out).toContain('Heading 3');
    // Headings should be on separate lines
    expect(out.length).toBeGreaterThanOrEqual(3);
  });

  it('renders bullet lists with • glyphs', () => {
    const md = ['* first item', '* second item', '- third item'].join('\n');
    const out = ansiFree(renderMarkdownBlock(md, W));
    const bulletLines = out.filter((l) => l.includes('•'));
    expect(bulletLines.length).toBe(3);
    expect(bulletLines[0]).toContain('first item');
    expect(bulletLines[1]).toContain('second item');
    expect(bulletLines[2]).toContain('third item');
  });

  it('renders numbered lists', () => {
    const md = ['1. step one', '2. step two', '3. step three'].join('\n');
    const out = ansiFree(renderMarkdownBlock(md, W));
    const listLines = out.filter((l) => l.includes('•'));
    expect(listLines.length).toBe(3);
  });

  it('renders bold text in inline markdown', () => {
    const md = '**bold text** here';
    const out = ansiFree(renderMarkdownBlock(md, W));
    expect(out.join('\n')).toContain('bold text');
  });

  it('renders inline code', () => {
    const md = 'use the `read` tool';
    const out = ansiFree(renderMarkdownBlock(md, W));
    expect(out.join('\n')).toContain('read');
  });

  it('renders fenced code blocks', () => {
    const md = ['```', 'const x = 1;', 'const y = 2;', '```'].join('\n');
    const out = ansiFree(renderMarkdownBlock(md, W));
    // Code lines should appear indented
    const codeLines = out.filter((l) => l.includes('const'));
    expect(codeLines.length).toBe(2);
    expect(codeLines[0]).toContain('x = 1');
    expect(codeLines[1]).toContain('y = 2');
  });

  it('renders blockquotes', () => {
    const md = '> quoted text here';
    const out = ansiFree(renderMarkdownBlock(md, W));
    expect(out.some((l) => l.includes('quoted text here'))).toBe(true);
  });

  it('preserves paragraph breaks (blank lines)', () => {
    const md = ['First paragraph.', '', 'Second paragraph.'].join('\n');
    const out = ansiFree(renderMarkdownBlock(md, W));
    // Should contain blank lines between paragraphs
    const blankCount = out.filter((l) => l.trim() === '').length;
    expect(blankCount).toBeGreaterThanOrEqual(1);
  });

  it('handles horizontal rules', () => {
    const out = ansiFree(renderMarkdownBlock('---', W));
    // Should render as a dim rule, not as text
    expect(out.some((l) => l.includes('─'))).toBe(true);
    expect(out.some((l) => l.includes('---'))).toBe(false);
  });
});

describe('renderReviewOutput', () => {
  const W = 80;

  it('detects markdown and routes to markdown renderer', () => {
    const md = '## Section Title\n\n* bullet one\n* bullet two';
    const out = ansiFree(renderReviewOutput(md, W));
    // Should have result label
    expect(out.some((l) => l.includes('result'))).toBe(true);
    // Should render bullets (not raw * characters)
    expect(out.some((l) => l.includes('•') && l.includes('bullet one'))).toBe(true);
    expect(out.some((l) => l.includes('•') && l.includes('bullet two'))).toBe(true);
    // Should render heading (not raw ##)
    expect(out.some((l) => l.includes('Section Title') && !l.includes('##'))).toBe(true);
  });

  it('renders plain text as wrapped paragraphs', () => {
    const text = 'Just some plain text without any markdown formatting.';
    const out = ansiFree(renderReviewOutput(text, W));
    expect(out.some((l) => l.includes('result'))).toBe(true);
    expect(out.some((l) => l.includes('Just some plain text'))).toBe(true);
  });

  it('filters process-chatter lines from result', () => {
    const text = 'let me show you the diff\n## Actual Result\nHere is the output.';
    const out = renderReviewOutput(text, W);
    // Process chatter should be filtered out
    expect(out.some((l) => l.includes('show you the diff'))).toBe(false);
    // Real content should remain
    expect(out.some((l) => l.includes('Actual Result'))).toBe(true);
    expect(out.some((l) => l.includes('Here is the output'))).toBe(true);
  });

  it('handles empty body gracefully', () => {
    const out = ansiFree(renderReviewOutput('', W));
    expect(out.some((l) => l.includes('result'))).toBe(true);
  });

  it('preserves multi-paragraph structure', () => {
    const md = ['### Section', '', 'Paragraph one with **bold** text.', '', 'Paragraph two with `code`.'].join('\n');
    const out = ansiFree(renderReviewOutput(md, W));
    // Should have blank lines between paragraphs
    const textOnly = out.filter((l) => !l.includes('result') && !l.includes('╌'));
    const blankCount = textOnly.filter((l) => l.trim() === '').length;
    expect(blankCount).toBeGreaterThanOrEqual(2);
    // Content should be present
    expect(textOnly.some((l) => l.includes('Section'))).toBe(true);
    expect(textOnly.some((l) => l.includes('Paragraph one'))).toBe(true);
    expect(textOnly.some((l) => l.includes('Paragraph two'))).toBe(true);
  });
});

describe('extractReadOutput', () => {
  const W = 80;

  it('extracts file lines with line numbers from ToolResult JSON', () => {
    const detail = JSON.stringify({
      success: true,
      toolName: 'read_file_range',
      output: {
        path: 'src/foo.ts',
        startLine: 1,
        endLine: 3,
        totalLines: 100,
        lines: [
          { lineNumber: 1, text: 'import { foo } from "bar";' },
          { lineNumber: 2, text: '' },
          { lineNumber: 3, text: 'export const x = 1;' },
        ],
        truncated: false,
      },
    });
    const out = ansiFree(extractReadOutput(detail, W));
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('   1');
    expect(out[0]).toContain('import { foo }');
    expect(out[2]).toContain('   3');
    expect(out[2]).toContain('export const x = 1;');
  });

  it('shows truncation note when lines exceed maxDisplayLines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({
      lineNumber: i + 1,
      text: `line ${i + 1} content`,
    }));
    const detail = JSON.stringify({
      success: true,
      toolName: 'read_file_range',
      output: { path: 'src/foo.ts', startLine: 1, endLine: 20, totalLines: 100, lines, truncated: false },
    });
    const out = ansiFree(extractReadOutput(detail, W, 15));
    // 15 content lines + 1 truncation note
    expect(out).toHaveLength(16);
    expect(out[15]).toContain('more lines');
    expect(out[15]).toContain('1–20');
  });

  it('returns empty array when lines are missing', () => {
    const detail = JSON.stringify({
      success: true,
      toolName: 'read_file_range',
      output: { path: 'src/foo.ts', startLine: 1, endLine: 0, totalLines: 0, lines: [], truncated: false },
    });
    expect(extractReadOutput(detail, W)).toEqual([]);
  });

  it('returns empty array for non-JSON detail', () => {
    expect(extractReadOutput('not json', W)).toEqual([]);
  });

  it('returns empty array when output has no lines array', () => {
    const detail = JSON.stringify({
      success: true,
      toolName: 'read_file_range',
      output: { path: 'src/foo.ts' },
    });
    expect(extractReadOutput(detail, W)).toEqual([]);
  });

  it('clips long lines to fit width', () => {
    const longLine = 'x'.repeat(100);
    const detail = JSON.stringify({
      success: true,
      toolName: 'read_file_range',
      output: {
        path: 'src/foo.ts',
        startLine: 1,
        endLine: 1,
        totalLines: 100,
        lines: [{ lineNumber: 1, text: longLine }],
        truncated: false,
      },
    });
    const out = ansiFree(extractReadOutput(detail, W));
    expect(out).toHaveLength(1);
    // Content should be clipped with …
    expect(out[0]).toContain('…');
    expect(out[0].length).toBeLessThan(W);
  });

  it('respects custom maxDisplayLines', () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({
      lineNumber: i + 1,
      text: `line ${i + 1}`,
    }));
    const detail = JSON.stringify({
      success: true,
      toolName: 'read_file_range',
      output: { path: 'src/foo.ts', startLine: 1, endLine: 10, totalLines: 100, lines, truncated: false },
    });
    expect(extractReadOutput(detail, W, 5)).toHaveLength(6); // 5 lines + truncation
    expect(extractReadOutput(detail, W, 20)).toHaveLength(10); // no truncation needed
  });

  it('handles middle-of-file line ranges (non-1 start)', () => {
    const detail = JSON.stringify({
      success: true,
      toolName: 'read_file_range',
      output: {
        path: 'src/foo.ts',
        startLine: 50,
        endLine: 52,
        totalLines: 200,
        lines: [
          { lineNumber: 50, text: 'function bar() {' },
          { lineNumber: 51, text: '  return 42;' },
          { lineNumber: 52, text: '}' },
        ],
        truncated: false,
      },
    });
    const out = ansiFree(extractReadOutput(detail, W));
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('  50');
    expect(out[0]).toContain('function bar()');
    expect(out[2]).toContain('  52');
  });
});
