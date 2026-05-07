import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

import { applyReplaceInFile, validateReplaceInFile } from '../agent/patch';
import { parseToolCallsFromContent } from '../llm/tool-calls';
import { runVerification } from '../agent/verification';

const TMP = join(process.cwd(), '..', 'tmp', 'synax-agent-flow-tests');

function resetTmp(): void {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true });
  }
  mkdirSync(TMP, { recursive: true });
}

describe('Qwen/Unsloth tool call parsing', () => {
  it('parses Qwen-style tool_call JSON blocks from assistant content', () => {
    const calls = parseToolCallsFromContent(
      '<tool_call>\n{"name":"read_file_range","arguments":{"path":"src/a.ts","startLine":1}}\n</tool_call>',
    );

    expect(calls).toEqual([
      {
        id: 'call_1',
        name: 'read_file_range',
        arguments: { path: 'src/a.ts', startLine: 1 },
      },
    ]);
  });

  it('parses Qwen-Coder function call blocks with JSON-string arguments', () => {
    const calls = parseToolCallsFromContent(
      '```json\n{"tool_calls":[{"id":"abc","type":"function","function":{"name":"search_text","arguments":"{\\"query\\":\\"needle\\"}"}}]}\n```',
    );

    expect(calls).toEqual([{ id: 'abc', name: 'search_text', arguments: { query: 'needle' } }]);
  });
});

describe('replace_in_file patch validation', () => {
  beforeEach(() => resetTmp());
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it('accepts exact replacement edits without a structured read first', async () => {
    writeFileSync(join(TMP, 'a.ts'), 'before\n', 'utf-8');

    const result = await validateReplaceInFile({ path: 'a.ts', oldStr: 'before', newStr: 'after' }, { repoRoot: TMP });

    expect(result).toMatchObject({
      ok: true,
      path: 'a.ts',
      before: 'before\n',
      after: 'after\n',
    });
  });

  it('rejects invalid and unsafe edit paths', async () => {
    const invalid = await validateReplaceInFile({ path: '', oldStr: 'before', newStr: 'after' }, { repoRoot: TMP });
    const outside = await validateReplaceInFile(
      { path: '../outside.ts', oldStr: 'before', newStr: 'after' },
      { repoRoot: TMP },
    );

    expect(invalid).toMatchObject({ ok: false, failureState: 'invalid-patch' });
    expect(outside).toMatchObject({ ok: false, failureState: 'unsafe-path' });
  });

  it('requires exact current file text before allowing a replacement', async () => {
    writeFileSync(join(TMP, 'a.ts'), 'const value = 1;\n', 'utf-8');

    const result = await validateReplaceInFile(
      { path: 'a.ts', oldStr: 'const value = 1;', newStr: 'const value = 2;' },
      { repoRoot: TMP },
    );

    expect(result).toMatchObject({ ok: true });
  });

  it('rejects replacements that match more than once', async () => {
    writeFileSync(join(TMP, 'a.ts'), 'same\nsame\n', 'utf-8');

    const result = await validateReplaceInFile({ path: 'a.ts', oldStr: 'same', newStr: 'changed' }, { repoRoot: TMP });

    expect(result).toMatchObject({ ok: false, failureState: 'replacement-match-failure' });
  });

  it('rejects replacements that do not match', async () => {
    writeFileSync(join(TMP, 'a.ts'), 'const value = 1;\n', 'utf-8');

    const result = await validateReplaceInFile(
      { path: 'a.ts', oldStr: 'value = 2', newStr: 'value = 3' },
      { repoRoot: TMP },
    );

    expect(result).toMatchObject({ ok: false, failureState: 'stale-read' });
  });

  it('rejects stale reads when the file no longer contains the prior text', async () => {
    writeFileSync(join(TMP, 'a.ts'), 'const value = 1;\n', 'utf-8');
    writeFileSync(join(TMP, 'a.ts'), 'const value = 2;\n', 'utf-8');

    const result = await validateReplaceInFile(
      { path: 'a.ts', oldStr: 'const value = 1;', newStr: 'const value = 3;' },
      { repoRoot: TMP },
    );

    expect(result).toMatchObject({ ok: false, failureState: 'stale-read' });
  });

  it('applies one exact replacement to an inspected file', async () => {
    writeFileSync(join(TMP, 'a.ts'), 'const value = 1;\n', 'utf-8');

    const result = await applyReplaceInFile(
      { path: 'a.ts', oldStr: 'const value = 1;', newStr: 'const value = 2;' },
      { repoRoot: TMP },
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(join(TMP, 'a.ts'), 'utf-8')).toBe('const value = 2;\n');
  });
});

describe('bounded verification', () => {
  beforeEach(() => resetTmp());
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it('reports skipped verification when no command is selected', async () => {
    const result = await runVerification({ repoRoot: TMP });

    expect(result.state).toBe('skipped');
  });

  it('captures command, exit code, and failure state for failed verification', async () => {
    const result = await runVerification({ repoRoot: TMP, command: 'node -e "process.exit(7)"', timeoutMs: 5000 });

    expect(result).toMatchObject({
      state: 'failed',
      command: 'node -e "process.exit(7)"',
      exitCode: 7,
      failureState: 'verification-failure',
    });
  });
});
