import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';

import { createInspectionLedger, createToolRegistry } from '../tools';
import type { PasteContextRangeOutput } from '../tools/paste-context-range';

const TMP = join(process.cwd(), 'tmp', 'synax-tool-tests');

interface ListFilesOutput {
  files: string[];
  truncated: boolean;
}

interface GitStatusOutput {
  status: string[];
  truncated: boolean;
}

interface GitDiffOutput {
  diff: string[];
  truncated: boolean;
}

interface DirectoryListingOutput {
  path: string;
  entries: Array<{ name: string; type: 'file' | 'directory' }>;
  truncated: boolean;
}

function resetTmp(): void {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true });
  }
  mkdirSync(TMP, { recursive: true });
}

function initGitRepo(): void {
  execSync('git init', { cwd: TMP, stdio: 'ignore' });
  execSync('git config user.email "synax@example.test"', { cwd: TMP, stdio: 'ignore' });
  execSync('git config user.name "Synax Test"', { cwd: TMP, stdio: 'ignore' });
  writeFileSync(join(TMP, 'tracked.txt'), 'before\n', 'utf-8');
  execSync('git add tracked.txt', { cwd: TMP, stdio: 'ignore' });
  execSync('git commit -m "initial"', { cwd: TMP, stdio: 'ignore' });
}

describe('tool registry and inspection tools', () => {
  beforeEach(() => resetTmp());

  afterEach(() => {
    if (existsSync(TMP)) {
      rmSync(TMP, { recursive: true, force: true });
    }
  });

  it('registers explicit read-only inspection tools', () => {
    const registry = createToolRegistry({ repoRoot: TMP });

    expect(registry.list().map((tool) => tool.name)).toEqual([
      'list_files',
      'read_file_range',
      'search_text',
      'show_git_status',
      'show_git_diff',
      'context_range_paste',
      'paste_context_range',
    ]);
    expect(registry.get('read_file_range')?.safetyPolicy.readOnly).toBe(true);
    expect(registry.get('read_file_range')?.ledgerBehavior).toBe('records-file-range');
  });

  it('returns validation failures for invalid tool input', async () => {
    const registry = createToolRegistry({ repoRoot: TMP });

    await expect(registry.execute('list_files', null)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('input must be an object'),
    });
    await expect(registry.execute('search_text', { query: '' })).resolves.toMatchObject({
      success: false,
      error: 'query is required',
    });
    await expect(registry.execute('unknown_tool', {})).resolves.toMatchObject({
      success: false,
      error: 'unknown tool: unknown_tool',
    });
  });

  it('reads bounded line-numbered file ranges and records inspection state', async () => {
    writeFileSync(join(TMP, 'src.ts'), ['one', 'two', 'three', 'four'].join('\n'), 'utf-8');
    const ledger = createInspectionLedger();
    const registry = createToolRegistry({ repoRoot: TMP, ledger });

    const result = await registry.execute('read_file_range', {
      path: 'src.ts',
      startLine: 2,
      endLine: 3,
    });

    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      path: 'src.ts',
      startLine: 2,
      endLine: 3,
      totalLines: 4,
      lines: [
        { lineNumber: 2, text: 'two' },
        { lineNumber: 3, text: 'three' },
      ],
      truncated: false,
    });
    expect(ledger.hasInspectedFile('src.ts')).toBe(true);
    expect(ledger.hasInspectedRange('src.ts', 2, 3)).toBe(true);
    expect(ledger.hasReadText('src.ts', 'two\nthree')).toBe(true);
  });

  it('reads the repository root as a bounded non-recursive directory listing', async () => {
    mkdirSync(join(TMP, 'src'), { recursive: true });
    mkdirSync(join(TMP, 'docs'), { recursive: true });
    writeFileSync(join(TMP, 'package.json'), '{}\n', 'utf-8');
    writeFileSync(join(TMP, 'src', 'nested.ts'), 'export {}\n', 'utf-8');
    for (let index = 0; index < 200; index += 1) {
      writeFileSync(join(TMP, `z-${index.toString().padStart(3, '0')}.txt`), 'extra\n', 'utf-8');
    }
    const registry = createToolRegistry({ repoRoot: TMP });

    const result = await registry.execute('read_file_range', { path: '.' });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ path: '.', truncated: true });
    const entries = (result.output as DirectoryListingOutput).entries;
    expect(entries).toHaveLength(160);
    expect(entries.slice(0, 3)).toEqual([
      { name: 'docs', type: 'directory' },
      { name: 'package.json', type: 'file' },
      { name: 'src', type: 'directory' },
    ]);
  });

  it('lists repo-local paths without read denylist filtering', async () => {
    for (const directory of [
      '.git',
      'node_modules',
      'dist',
      'coverage',
      '.next',
      '.vite',
      'build',
      '.cache',
      'cache',
    ]) {
      mkdirSync(join(TMP, directory), { recursive: true });
      writeFileSync(join(TMP, directory, 'ignored.txt'), 'ignored\n', 'utf-8');
    }
    writeFileSync(join(TMP, 'README.md'), '# Synax\n', 'utf-8');
    const registry = createToolRegistry({ repoRoot: TMP });

    const result = await registry.execute('read_file_range', { path: '.' });

    expect(result.success).toBe(true);
    const entries = (result.output as DirectoryListingOutput).entries.map((entry) => entry.name);
    expect(entries).toEqual([
      '.cache',
      '.git',
      '.next',
      '.vite',
      'build',
      'cache',
      'coverage',
      'dist',
      'node_modules',
      'README.md',
    ]);
  });

  it('allows reads of dotfiles, generated files, and dependency paths', async () => {
    mkdirSync(join(TMP, 'node_modules'), { recursive: true });
    writeFileSync(join(TMP, '.env'), 'TOKEN=secret\n', 'utf-8');
    writeFileSync(join(TMP, '.synax.toml'), 'api_key = "sk-never-print-this"\n', 'utf-8');
    writeFileSync(join(TMP, 'node_modules', 'pkg.js'), 'module.exports = 1\n', 'utf-8');
    const registry = createToolRegistry({ repoRoot: TMP });

    await expect(registry.execute('read_file_range', { path: '.env' })).resolves.toMatchObject({
      success: true,
      output: expect.objectContaining({ path: '.env' }),
    });
    await expect(registry.execute('read_file_range', { path: '.synax.toml' })).resolves.toMatchObject({
      success: true,
      output: expect.objectContaining({ path: '.synax.toml' }),
    });
    await expect(registry.execute('read_file_range', { path: 'node_modules/pkg.js' })).resolves.toMatchObject({
      success: true,
      output: expect.objectContaining({ path: 'node_modules/pkg.js' }),
    });
  });

  it('includes secret-shaped files in listings by default', async () => {
    for (const file of [
      '.env',
      '.env.local',
      '.synax.toml',
      'cert.pem',
      'deploy.key',
      'identity.p12',
      'server.crt',
      'id_rsa',
      'id_ed25519',
    ]) {
      writeFileSync(join(TMP, file), 'secret\n', 'utf-8');
    }
    writeFileSync(join(TMP, '.synax.toml.example'), 'model = "example"\n', 'utf-8');
    const registry = createToolRegistry({ repoRoot: TMP });

    const result = await registry.execute('list_files', {});

    expect(result.success).toBe(true);
    const files = (result.output as ListFilesOutput).files;
    expect(files).toEqual([
      '.env',
      '.env.local',
      '.synax.toml',
      '.synax.toml.example',
      'cert.pem',
      'deploy.key',
      'id_ed25519',
      'id_rsa',
      'identity.p12',
      'server.crt',
    ]);
  });

  it('does not redact file read output', async () => {
    writeFileSync(join(TMP, 'request.txt'), 'Authorization: Bearer bearer-never-print-this\n', 'utf-8');
    const registry = createToolRegistry({ repoRoot: TMP });

    const result = await registry.execute('read_file_range', { path: 'request.txt' });

    expect(result.success).toBe(true);
    expect(JSON.stringify(result.output)).toContain('bearer-never-print-this');
    expect(JSON.stringify(result.output)).not.toContain('[REDACTED]');
  });

  it('searches text with bounded repo-relative matches and ledger entries', async () => {
    mkdirSync(join(TMP, 'src'), { recursive: true });
    writeFileSync(join(TMP, 'src', 'a.ts'), 'alpha\nneedle here\nneedle again\n', 'utf-8');
    writeFileSync(join(TMP, 'src', 'b.ts'), 'no match\nneedle there\n', 'utf-8');
    const ledger = createInspectionLedger();
    const registry = createToolRegistry({ repoRoot: TMP, ledger });

    const result = await registry.execute('search_text', {
      query: 'needle',
      maxMatches: 2,
    });

    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      query: 'needle',
      matches: [
        { path: 'src/a.ts', lineNumber: 2, line: 'needle here' },
        { path: 'src/a.ts', lineNumber: 3, line: 'needle again' },
      ],
      truncated: true,
    });
    expect(ledger.hasInspectedRange('src/a.ts', 2, 3)).toBe(true);
  });

  it('lists files without generated/vendor/env filtering', async () => {
    mkdirSync(join(TMP, 'src'), { recursive: true });
    mkdirSync(join(TMP, 'dist'), { recursive: true });
    writeFileSync(join(TMP, 'src', 'tool.ts'), 'export {}\n', 'utf-8');
    writeFileSync(join(TMP, 'dist', 'tool.js'), 'compiled\n', 'utf-8');
    writeFileSync(join(TMP, '.env.local'), 'TOKEN=secret\n', 'utf-8');
    const registry = createToolRegistry({ repoRoot: TMP });

    const result = await registry.execute('list_files', {});

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ truncated: false });
    expect((result.output as ListFilesOutput).files).toEqual(['.env.local', 'dist/tool.js', 'src/tool.ts']);
  });

  it('treats empty and whitespace list_files paths as the repository root', async () => {
    writeFileSync(join(TMP, 'root.txt'), 'root\n', 'utf-8');
    const registry = createToolRegistry({ repoRoot: TMP });

    await expect(registry.execute('list_files', { path: '', maxFiles: 50 })).resolves.toMatchObject({
      success: true,
      output: { files: ['root.txt'], truncated: false },
    });
    await expect(registry.execute('list_files', { path: '   ', maxFiles: 50 })).resolves.toMatchObject({
      success: true,
      output: { files: ['root.txt'], truncated: false },
    });
    await expect(registry.execute('list_files', { path: '.', maxFiles: 50 })).resolves.toMatchObject({
      success: true,
      output: { files: ['root.txt'], truncated: false },
    });
  });

  it('rejects absolute paths outside repo root and home directory', async () => {
    const registry = createToolRegistry({ repoRoot: TMP });

    // Absolute path outside both repo root and home directory
    await expect(
      registry.execute('read_file_range', { path: '/home/nonexistent-user/secret.txt' }),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('outside the repository root'),
    });

    await expect(registry.execute('list_files', { path: '/etc/passwd', maxFiles: 50 })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('outside the repository root'),
    });

    await expect(registry.execute('search_text', { query: 'needle', path: '/tmp' })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('outside the repository root'),
    });
  });

  it('allows absolute paths within repo root', async () => {
    writeFileSync(join(TMP, 'root.txt'), 'root\n', 'utf-8');
    const registry = createToolRegistry({ repoRoot: TMP });

    const result = await registry.execute('read_file_range', { path: join(TMP, 'root.txt') });
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ path: join(TMP, 'root.txt') });
  });

  it('allows ~ and $HOME paths', async () => {
    const homeFile = join(homedir(), '.synax-test-boundary.txt');
    writeFileSync(homeFile, 'home content\n', 'utf-8');
    const registry = createToolRegistry({ repoRoot: TMP });

    try {
      const tildeResult = await registry.execute('read_file_range', {
        path: '~/.synax-test-boundary.txt',
      });
      expect(tildeResult.success).toBe(true);
      expect(tildeResult.output).toMatchObject({ path: homeFile });

      const dollarResult = await registry.execute('read_file_range', {
        path: '$HOME/.synax-test-boundary.txt',
      });
      expect(dollarResult.success).toBe(true);

      // Absolute path within home directory should work
      const absResult = await registry.execute('read_file_range', { path: homeFile });
      expect(absResult.success).toBe(true);
    } finally {
      rmSync(homeFile, { force: true });
    }
  });

  it('allows relative and parent-relative paths within repo boundary', async () => {
    const outside = join(TMP, '..', 'synax-tool-outside');
    rmSync(outside, { recursive: true, force: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'outside.txt'), 'outside\n', 'utf-8');
    const registry = createToolRegistry({ repoRoot: TMP });

    try {
      // Relative .. paths still work (resolved relative to repoRoot)
      await expect(
        registry.execute('list_files', { path: '../synax-tool-outside', maxFiles: 50 }),
      ).resolves.toMatchObject({
        success: true,
        output: { files: ['../synax-tool-outside/outside.txt'], truncated: false },
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('returns bounded read-only git status and diff results visible to the ledger', async () => {
    initGitRepo();
    writeFileSync(join(TMP, 'tracked.txt'), 'before\nafter\n', 'utf-8');
    writeFileSync(join(TMP, 'new.txt'), 'new\n', 'utf-8');
    const ledger = createInspectionLedger();
    const registry = createToolRegistry({ repoRoot: TMP, ledger });

    const status = await registry.execute('show_git_status', {});
    const diff = await registry.execute('show_git_diff', { maxLines: 20 });

    expect(status.success).toBe(true);
    expect((status.output as GitStatusOutput).status).toEqual(expect.arrayContaining([' M tracked.txt', '?? new.txt']));
    expect(diff.success).toBe(true);
    expect((diff.output as GitDiffOutput).diff.join('\n')).toContain('+after');
    expect(ledger.hasGitStatusInspection()).toBe(true);
    expect(ledger.hasGitDiffInspection()).toBe(true);
  });
});

describe('paste_context_range tool', () => {
  beforeEach(() => resetTmp());

  afterEach(() => {
    if (existsSync(TMP)) {
      rmSync(TMP, { recursive: true, force: true });
    }
  });

  function registryWithLastUserMessage(message: string) {
    const registry = createToolRegistry({ repoRoot: TMP });
    registry.setLastUserMessage(message);
    return registry;
  }

  it('is registered in the inspection tool set', () => {
    const registry = createToolRegistry({ repoRoot: TMP });
    expect(registry.list().map((t) => t.name)).toContain('paste_context_range');
  });

  it('has read-only safety policy', () => {
    const registry = createToolRegistry({ repoRoot: TMP });
    const tool = registry.get('paste_context_range');
    expect(tool?.safetyPolicy.readOnly).toBe(true);
    expect(tool?.safetyPolicy.rejectsUnsafePaths).toBe(true);
    expect(tool?.safetyPolicy.boundedOutput).toBe(true);
  });

  it('has correct ledger behavior', () => {
    const registry = createToolRegistry({ repoRoot: TMP });
    const tool = registry.get('paste_context_range');
    expect(tool?.ledgerBehavior).toBe('records-pasted-range');
  });

  it('returns error when lastUserMessage is not set', async () => {
    const registry = createToolRegistry({ repoRoot: TMP });
    const result = await registry.execute('paste_context_range', {
      startLine: 1,
      endLine: 2,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('last_user_message is not available');
  });

  it('returns error when lastUserMessage is empty', async () => {
    const registry = registryWithLastUserMessage('');
    const result = await registry.execute('paste_context_range', {
      startLine: 1,
      endLine: 2,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('last_user_message is empty');
  });

  it('rejects unsupported source', async () => {
    const registry = registryWithLastUserMessage('some content');
    const result = await registry.execute('paste_context_range', {
      source: 'some_other_source',
      startLine: 1,
      endLine: 1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('unsupported source');
  });

  it('returns error when no range is specified', async () => {
    const registry = registryWithLastUserMessage('hello world');
    const result = await registry.execute('paste_context_range', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('no range specified');
  });

  describe('line-based slicing', () => {
    it('extracts a line range with exact byte preservation', async () => {
      const content = ['line1', 'line2', 'line3', 'line4', ''].join('\n');
      const registry = registryWithLastUserMessage(content);

      const result = await registry.execute('paste_context_range', {
        startLine: 2,
        endLine: 3,
      });

      expect(result.success).toBe(true);
      const output = result.output as PasteContextRangeOutput;
      expect(output.source).toBe('last_user_message');
      expect(output.bytes).toBe(Buffer.byteLength('line2\nline3\n', 'utf-8'));
      expect(output.lines).toBe(2);
      expect(output.start).toBeGreaterThanOrEqual(0);

      // Verify file contents are exact
      const fileContent = readFileSync(output.path, 'utf-8');
      expect(fileContent).toBe('line2\nline3\n');

      // Verify sha256 matches
      const expectedHash = createHash('sha256').update(fileContent, 'utf-8').digest('hex');
      expect(output.sha256).toBe(expectedHash);
    });

    it('handles single-line extraction', async () => {
      const registry = registryWithLastUserMessage(['alpha', 'beta', 'gamma', ''].join('\n'));
      const result = await registry.execute('paste_context_range', {
        startLine: 2,
        endLine: 2,
      });

      expect(result.success).toBe(true);
      const output = result.output as PasteContextRangeOutput;
      const fileContent = readFileSync(output.path, 'utf-8');
      expect(fileContent).toBe('beta\n');
      expect(output.lines).toBe(1);
    });

    it('returns error for startLine out of range', async () => {
      const registry = registryWithLastUserMessage(['a', 'b', ''].join('\n'));
      const result = await registry.execute('paste_context_range', {
        startLine: 5,
        endLine: 6,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('out of range');
    });

    it('clamps endLine to available lines', async () => {
      const registry = registryWithLastUserMessage(['a', 'b', 'c', ''].join('\n'));
      const result = await registry.execute('paste_context_range', {
        startLine: 2,
        endLine: 10,
      });

      expect(result.success).toBe(true);
      const fileContent = readFileSync((result.output as PasteContextRangeOutput).path, 'utf-8');
      expect(fileContent).toBe('b\nc');
    });

    it('handles multiline content with trailing newlines', async () => {
      const registry = registryWithLastUserMessage(['one', '', 'two', '', 'three', ''].join('\n'));
      const result = await registry.execute('paste_context_range', {
        startLine: 2,
        endLine: 4,
      });

      expect(result.success).toBe(true);
      const fileContent = readFileSync((result.output as PasteContextRangeOutput).path, 'utf-8');
      expect(fileContent).toBe('\ntwo\n\n');
    });
  });

  describe('anchor-based slicing', () => {
    it('extracts content between two anchors', async () => {
      const content = ['some text', '```bash', 'echo hello', './run.sh', '```', 'more text', ''].join('\n');
      const registry = registryWithLastUserMessage(content);

      const result = await registry.execute('paste_context_range', {
        startAnchor: '```bash',
        endAnchor: '```',
      });

      expect(result.success).toBe(true);
      const output = result.output as PasteContextRangeOutput;
      const fileContent = readFileSync(output.path, 'utf-8');
      expect(fileContent).toBe('```bash\necho hello\n./run.sh\n```');
      expect(output.lines).toBe(4);
    });

    it('handles anchors that appear multiple times', async () => {
      const content = ['```', 'first', '```', 'some text', '```', 'second', '```', ''].join('\n');
      const registry = registryWithLastUserMessage(content);

      // Should find the first ``` and the next ``` after it
      const result = await registry.execute('paste_context_range', {
        startAnchor: '```',
        endAnchor: '```',
      });

      expect(result.success).toBe(true);
      const fileContent = readFileSync((result.output as PasteContextRangeOutput).path, 'utf-8');
      expect(fileContent).toBe('```\nfirst\n```');
    });

    it('returns error when startAnchor is not found', async () => {
      const registry = registryWithLastUserMessage('some content');
      const result = await registry.execute('paste_context_range', {
        startAnchor: '```python',
        endAnchor: '```',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('returns error when endAnchor is not found after startAnchor', async () => {
      const registry = registryWithLastUserMessage(['```bash', 'echo hello', ''].join('\n'));
      const result = await registry.execute('paste_context_range', {
        startAnchor: '```bash',
        endAnchor: '```',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found after startAnchor');
    });

    it('returns error when anchors are empty', async () => {
      const registry = registryWithLastUserMessage('content');
      const result = await registry.execute('paste_context_range', {
        startAnchor: '',
        endAnchor: 'end',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('must be non-empty');
    });
  });

  describe('byte-based slicing', () => {
    it('extracts a byte range exactly', async () => {
      const content = 'hello world';
      const registry = registryWithLastUserMessage(content);

      const result = await registry.execute('paste_context_range', {
        startByte: 0,
        endByte: 5,
      });

      expect(result.success).toBe(true);
      const output = result.output as PasteContextRangeOutput;
      expect(output.start).toBe(0);
      expect(output.end).toBe(5);
      expect(output.bytes).toBe(5);

      const fileContent = readFileSync(output.path, 'utf-8');
      expect(fileContent).toBe('hello');
    });

    it('clamps byte offsets to content bounds', async () => {
      const content = 'hello';
      const registry = registryWithLastUserMessage(content);

      const result = await registry.execute('paste_context_range', {
        startByte: 2,
        endByte: 100,
      });

      expect(result.success).toBe(true);
      const output = result.output as PasteContextRangeOutput;
      const fileContent = readFileSync(output.path, 'utf-8');
      expect(fileContent).toBe('llo');
      expect(output.end).toBe(5);
    });

    it('returns error for empty byte range', async () => {
      const registry = registryWithLastUserMessage('content');
      const result = await registry.execute('paste_context_range', {
        startByte: 3,
        endByte: 3,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
    });
  });

  describe('unicode content', () => {
    it('preserves multibyte unicode characters', async () => {
      const content = ['café résumé 🎉', 'line2', ''].join('\n');
      const registry = registryWithLastUserMessage(content);

      const result = await registry.execute('paste_context_range', {
        startLine: 1,
        endLine: 1,
      });

      expect(result.success).toBe(true);
      const output = result.output as PasteContextRangeOutput;
      const fileContent = readFileSync(output.path, 'utf-8');
      expect(fileContent).toBe('café résumé 🎉\n');

      // Verify byte count accounts for multibyte
      expect(output.bytes).toBe(Buffer.byteLength('café résumé 🎉\n', 'utf-8'));
    });

    it('handles content with emoji and CJK characters', async () => {
      const content = ['你好世界', '🌟 star 🌟', '普通', ''].join('\n');
      const registry = registryWithLastUserMessage(content);

      const result = await registry.execute('paste_context_range', {
        startAnchor: '🌟',
        endAnchor: '🌟',
      });

      expect(result.success).toBe(true);
      const fileContent = readFileSync((result.output as PasteContextRangeOutput).path, 'utf-8');
      expect(fileContent).toBe('🌟 star 🌟');
    });
  });

  describe('temp file safety', () => {
    it('creates temp files under the system temp dir', async () => {
      const registry = registryWithLastUserMessage('test content');
      const result = await registry.execute('paste_context_range', {
        startLine: 1,
        endLine: 1,
      });

      expect(result.success).toBe(true);
      const output = result.output as PasteContextRangeOutput;
      expect(output.path).toContain(join(tmpdir(), 'synax', 'paste', 'range-'));
      expect(existsSync(output.path)).toBe(true);
    });

    it('includes sha256 hash of content', async () => {
      const content = 'verify me!';
      const registry = registryWithLastUserMessage(content);
      const result = await registry.execute('paste_context_range', {
        startByte: 0,
        endByte: Buffer.byteLength(content, 'utf-8'),
      });

      expect(result.success).toBe(true);
      const output = result.output as PasteContextRangeOutput;
      const expectedHash = createHash('sha256').update(content, 'utf-8').digest('hex');
      expect(output.sha256).toBe(expectedHash);
      expect(output.sha256).toHaveLength(64);
    });

    it('returns source and byte metadata in output', async () => {
      const content = ['metadata test', 'second line', ''].join('\n');
      const registry = registryWithLastUserMessage(content);
      const result = await registry.execute('paste_context_range', {
        startLine: 1,
        endLine: 2,
      });

      expect(result.success).toBe(true);
      const output = result.output as PasteContextRangeOutput;
      expect(output.source).toBe('last_user_message');
      expect(output.bytes).toBeGreaterThan(0);
      expect(output.start).toBeGreaterThanOrEqual(0);
      expect(output.end).toBeGreaterThan(output.start);
      expect(output.lines).toBe(2);
    });
  });

  describe('ledger recording', () => {
    it('records pasted content in the inspection ledger', async () => {
      const content = ['line1', 'line2', 'line3', ''].join('\n');
      const ledger = createInspectionLedger();
      const registry = createToolRegistry({ repoRoot: TMP, ledger });
      registry.setLastUserMessage(content);

      const result = await registry.execute('paste_context_range', {
        startLine: 1,
        endLine: 2,
      });

      expect(result.success).toBe(true);
      // Ledger should record the paste with the full content and a paste: prefix path
      const output = result.output as PasteContextRangeOutput;
      expect(ledger.hasReadText(`paste:${output.path}`, 'line1\nline2\n')).toBe(true);
    });
  });

  describe('camelCase name normalization', () => {
    it('recognizes pasteContextRange as paste_context_range', async () => {
      const registry = registryWithLastUserMessage(['hello', 'world', ''].join('\n'));
      const result = await registry.execute('pasteContextRange', {
        startLine: 1,
        endLine: 2,
      });

      expect(result.success).toBe(true);
      expect(result.toolName).toBe('paste_context_range');
    });
  });

  describe('input validation', () => {
    it('rejects non-object input', async () => {
      const registry = createToolRegistry({ repoRoot: TMP });
      await expect(registry.execute('paste_context_range', null)).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('input must be an object'),
      });

      await expect(registry.execute('paste_context_range', 'string')).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('input must be an object'),
      });

      await expect(registry.execute('paste_context_range', [1, 2, 3])).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('input must be an object'),
      });
    });
  });
});
