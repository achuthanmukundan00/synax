import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

import { createInspectionLedger } from '../tools';
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

  it('rejects edits to files that were not inspected', async () => {
    writeFileSync(join(TMP, 'a.ts'), 'before\n', 'utf-8');
    const ledger = createInspectionLedger();

    const result = await validateReplaceInFile(
      { path: 'a.ts', oldStr: 'before', newStr: 'after' },
      { repoRoot: TMP, ledger },
    );

    expect(result).toMatchObject({ ok: false, failureState: 'unread-file-patch' });
  });

  it('rejects replacements that match more than once', async () => {
    writeFileSync(join(TMP, 'a.ts'), 'same\nsame\n', 'utf-8');
    const ledger = createInspectionLedger();
    ledger.recordFileRange('a.ts', 1, 2);

    const result = await validateReplaceInFile(
      { path: 'a.ts', oldStr: 'same', newStr: 'changed' },
      { repoRoot: TMP, ledger },
    );

    expect(result).toMatchObject({ ok: false, failureState: 'replacement-match-failure' });
  });

  it('applies one exact replacement to an inspected file', async () => {
    writeFileSync(join(TMP, 'a.ts'), 'const value = 1;\n', 'utf-8');
    const ledger = createInspectionLedger();
    ledger.recordFileRange('a.ts', 1, 1);

    const result = await applyReplaceInFile(
      { path: 'a.ts', oldStr: 'value = 1', newStr: 'value = 2' },
      { repoRoot: TMP, ledger },
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
