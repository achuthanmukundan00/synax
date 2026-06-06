/**
 * Tests for DeterministicCompactor — zero-token structural compression.
 */

import { extractTextContent } from '../llm/types';
import { DeterministicCompactor, createCompactor } from '../compaction/DeterministicCompactor';
import type { AgentMessage } from '../session/Session';

function msg(content: string): AgentMessage {
  return { role: 'tool', content, tool_call_id: 'c1', name: 'bash' };
}

function msgs(...contents: string[]): AgentMessage[] {
  return contents.map((c) => msg(c));
}

describe('DeterministicCompactor', () => {
  describe('stripAnsiCodes', () => {
    it('removes terminal color codes', () => {
      const compactor = new DeterministicCompactor();
      const input = msgs('\x1b[32mPASS\x1b[0m src/test.ts');
      const result = compactor.compact(input);
      expect(result.messages[0].content).toBe('PASS src/test.ts');
      expect(result.stats.savedTokens).toBeGreaterThan(0);
    });

    it('preserves plain text unchanged', () => {
      const compactor = new DeterministicCompactor();
      const input = msgs('plain text no colors');
      const result = compactor.compact(input);
      expect(result.messages[0].content).toBe('plain text no colors');
      expect(result.stats.savedTokens).toBe(0);
    });
  });

  describe('stripStackTraces', () => {
    it('collapses node_modules stack frames', () => {
      const compactor = new DeterministicCompactor();
      const stackTrace = [
        'Error: something went wrong',
        '    at Object.<anonymous> (/project/src/test.ts:10:5)',
        '    at Module._compile (node_modules/jest-runtime/index.js:123:1)',
        '    at Module.load (node_modules/jest-runtime/index.js:456:1)',
        '    at Function.execute (node_modules/jest-runtime/index.js:789:1)',
        '    at runTest (node_modules/jest-runtime/index.js:101:1)',
        'Normal output after stack.',
      ].join('\n');

      const input = msgs(stackTrace);
      const result = compactor.compact(input);
      const output = result.messages[0].content ?? '';

      // First two node_modules frames kept, rest collapsed
      expect(output).toContain('node_modules/jest-runtime/index.js:123:1');
      expect(output).toContain('node_modules/jest-runtime/index.js:456:1');
      expect(output).toContain('more node_modules frames omitted');
      expect(output).toContain('Normal output after stack.');
      expect(result.stats.savedTokens).toBeGreaterThan(0);
    });

    it('preserves non-stack content', () => {
      const compactor = new DeterministicCompactor();
      const input = msgs('Regular output\nno stack here');
      const result = compactor.compact(input);
      expect(result.messages[0].content).toBe('Regular output\nno stack here');
    });
  });

  describe('stripDuplicateLines', () => {
    it('collapses repeated identical lines', () => {
      const compactor = new DeterministicCompactor();
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) {
        lines.push(`npm http fetch GET 200 https://registry.npmjs.org/package-${i % 5}`);
      }
      const input = msgs(lines.join('\n'));
      const result = compactor.compact(input);

      // Should collapse repetitions
      expect(result.stats.savedTokens).toBeGreaterThan(0);
      expect(result.messages[0].content).toContain('repeated');
    });
  });

  describe('dedupRepeatedPatterns', () => {
    it('merges similar compiler error patterns', () => {
      const compactor = new DeterministicCompactor();
      const errors: string[] = [];
      for (let i = 0; i < 20; i++) {
        errors.push(`src/file${i}.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.`);
      }
      errors.push('src/main.ts(5,3): error TS2304: Cannot find name "foo".');
      const input = msgs(errors.join('\n'));
      const result = compactor.compact(input);

      expect(result.stats.savedTokens).toBeGreaterThan(0);
      expect(result.messages[0].content).toContain('similar instances');
      // Unique error should be preserved
      expect(result.messages[0].content).toContain('Cannot find name');
    });
  });

  describe('collapseWhitespace', () => {
    it('collapses multiple blank lines', () => {
      const compactor = new DeterministicCompactor();
      const input = msgs('line1\n\n\n\n\nline2\n\n\nline3');
      const result = compactor.compact(input);

      // Should have at most 2 consecutive blank lines
      const blankCount = (extractTextContent(result.messages[0].content) ?? '').match(/^\s*$/gm)?.length ?? 0;
      // After collapse, the maximum consecutive is 2, and since we have 2 gaps:
      // gap1: 4 blanks → max 2; gap2: 2 blanks → 2. Total: 4 blanks max
      expect(blankCount).toBeLessThanOrEqual(4);
    });

    it('trims excessive indentation', () => {
      const compactor = new DeterministicCompactor();
      const input = msgs('          deeply indented line');
      const result = compactor.compact(input);

      expect(result.messages[0].content).toBe('        deeply indented line');
    });
  });

  describe('integration', () => {
    it('applies multiple techniques in priority order', () => {
      const compactor = new DeterministicCompactor();
      const content = [
        '\x1b[31mFAIL\x1b[0m src/test.ts',
        '',
        '',
        '',
        'Error: test failure',
        '    at Object.<anonymous> (src/test.ts:10:5)',
        '    at Module._compile (node_modules/jest/index.js:1:1)',
        '    at Module._compile (node_modules/jest/index.js:2:1)',
        '    at Module._compile (node_modules/jest/index.js:3:1)',
        '    at Module._compile (node_modules/jest/index.js:4:1)',
        '',
        '',
        'npm http fetch GET 200 package-a',
        'npm http fetch GET 200 package-a',
        'npm http fetch GET 200 package-a',
        'npm http fetch GET 200 package-a',
        'npm http fetch GET 200 package-a',
      ].join('\n');

      const input = msgs(content);
      const result = compactor.compact(input);

      expect(result.stats.techniques).toContain('stripAnsiCodes');
      expect(result.stats.techniques).toContain('stripStackTraces');
      expect(result.stats.techniques).toContain('stripDuplicateLines');
      // The FAIL line should be plain text now
      expect(result.messages[0].content).toContain('FAIL src/test.ts');
      expect(result.messages[0].content).not.toContain('\x1b[31m');
      // Stack trace should be collapsed
      expect(result.messages[0].content).toContain('more node_modules frames omitted');
    });

    it('reports accurate token savings', () => {
      const compactor = new DeterministicCompactor();
      // Content with lots of redundant data
      const repetitive = Array(50).fill('repeated line with lots of characters').join('\n');
      const input = msgs(repetitive);
      const result = compactor.compact(input);

      expect(result.stats.originalTokens).toBeGreaterThan(0);
      expect(result.stats.savedTokens).toBeGreaterThan(0);
      expect(result.stats.afterTokens).toBeLessThan(result.stats.originalTokens);
    });

    it('does not lose semantically important content', () => {
      const compactor = new DeterministicCompactor();
      const content = [
        'Build output:',
        '  src/app.ts compiled successfully',
        '  src/lib.ts compiled successfully',
        '  src/utils.ts compiled successfully',
        'Error in src/broken.ts:',
        "  Type 'string' is not assignable to type 'number'",
        '  This is a critical error that must be preserved exactly.',
      ].join('\n');

      const input = msgs(content);
      const result = compactor.compact(input);
      const output = result.messages[0].content ?? '';

      // Important content preserved
      expect(output).toContain('critical error');
      expect(output).toContain('not assignable');
      expect(output).toContain('src/broken.ts');
    });
  });

  describe('createCompactor', () => {
    it('returns disabled compactor for light strategy', () => {
      const compactor = createCompactor('light');
      const input = msgs('\x1b[31mcolored text\x1b[0m repeated repeated repeated repeated repeated');
      const result = compactor.compact(input);

      // No compaction applied
      expect(result.stats.savedTokens).toBe(0);
      expect(result.stats.techniques).toHaveLength(0);
    });

    it('returns disabled compactor for none strategy', () => {
      const compactor = createCompactor('none');
      const input = msgs('\x1b[31mcolored text\x1b[0m');
      const result = compactor.compact(input);
      expect(result.stats.savedTokens).toBe(0);
    });

    it('returns active compactor for aggressive strategy', () => {
      const compactor = createCompactor('aggressive');
      const input = msgs('\x1b[31mcolored\x1b[0m');
      const result = compactor.compact(input);
      // ANSI strip should save tokens
      expect(result.stats.savedTokens).toBeGreaterThan(0);
    });

    it('returns active compactor for moderate strategy', () => {
      const compactor = createCompactor('moderate');
      const input = msgs('\x1b[31mcolored\x1b[0m');
      const result = compactor.compact(input);
      expect(result.stats.savedTokens).toBeGreaterThan(0);
    });
  });
});
