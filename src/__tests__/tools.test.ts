import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { createInspectionLedger, createToolRegistry } from '../tools';

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
    for (let index = 0; index < 100; index += 1) {
      writeFileSync(join(TMP, `z-${index.toString().padStart(3, '0')}.txt`), 'extra\n', 'utf-8');
    }
    const registry = createToolRegistry({ repoRoot: TMP });

    const result = await registry.execute('read_file_range', { path: '.' });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ path: '.', truncated: true });
    const entries = (result.output as DirectoryListingOutput).entries;
    expect(entries).toHaveLength(80);
    expect(entries.slice(0, 3)).toEqual([
      { name: 'docs', type: 'directory' },
      { name: 'package.json', type: 'file' },
      { name: 'src', type: 'directory' },
    ]);
  });

  it('excludes heavy and generated paths from directory listings', async () => {
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
    expect(entries).toEqual(['README.md']);
  });

  it('rejects unsafe paths before reading', async () => {
    mkdirSync(join(TMP, 'node_modules'), { recursive: true });
    writeFileSync(join(TMP, '.env'), 'TOKEN=secret\n', 'utf-8');
    writeFileSync(join(TMP, '.synax.toml'), 'api_key = "sk-never-print-this"\n', 'utf-8');
    writeFileSync(join(TMP, 'node_modules', 'pkg.js'), 'module.exports = 1\n', 'utf-8');
    const registry = createToolRegistry({ repoRoot: TMP });

    await expect(registry.execute('read_file_range', { path: '.env' })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('unsafe path'),
    });
    await expect(registry.execute('read_file_range', { path: '.synax.toml' })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('unsafe path'),
    });
    await expect(registry.execute('read_file_range', { path: 'node_modules/pkg.js' })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('unsafe path'),
    });
  });

  it('applies the default secret-file denylist and keeps .synax.toml.example inspectable', async () => {
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
    expect(files).toEqual(['.synax.toml.example']);
  });

  it('redacts inline secrets from allowed file reads', async () => {
    writeFileSync(join(TMP, 'request.txt'), 'Authorization: Bearer bearer-never-print-this\n', 'utf-8');
    const registry = createToolRegistry({ repoRoot: TMP });

    const result = await registry.execute('read_file_range', { path: 'request.txt' });

    expect(result.success).toBe(true);
    expect(JSON.stringify(result.output)).not.toContain('bearer-never-print-this');
    expect(JSON.stringify(result.output)).toContain('[REDACTED]');
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

  it('lists safe files and hides generated/vendor/env files', async () => {
    mkdirSync(join(TMP, 'src'), { recursive: true });
    mkdirSync(join(TMP, 'dist'), { recursive: true });
    writeFileSync(join(TMP, 'src', 'tool.ts'), 'export {}\n', 'utf-8');
    writeFileSync(join(TMP, 'dist', 'tool.js'), 'compiled\n', 'utf-8');
    writeFileSync(join(TMP, '.env.local'), 'TOKEN=secret\n', 'utf-8');
    const registry = createToolRegistry({ repoRoot: TMP });

    const result = await registry.execute('list_files', {});

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ truncated: false });
    expect((result.output as ListFilesOutput).files).toEqual(['src/tool.ts']);
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

  it('continues to reject unsafe list_files paths', async () => {
    const registry = createToolRegistry({ repoRoot: TMP });

    await expect(registry.execute('list_files', { path: '/tmp' })).resolves.toMatchObject({
      success: false,
      error: 'absolute paths are not allowed',
    });
    await expect(registry.execute('list_files', { path: '../outside' })).resolves.toMatchObject({
      success: false,
      error: 'paths must stay inside the repository',
    });
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
