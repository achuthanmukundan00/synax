import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { discoverLocalDocs, readLocalDoc } from '../context/local-docs';

const TMP = join(process.cwd(), 'tmp', 'synax-docs-provider-tests');

function resetTmp(): void {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true });
  }
  mkdirSync(TMP, { recursive: true });
}

describe('local docs provider', () => {
  beforeEach(() => resetTmp());

  afterEach(() => {
    if (existsSync(TMP)) {
      rmSync(TMP, { recursive: true, force: true });
    }
  });

  it('discovers bounded project docs and config examples while excluding generated docs output', async () => {
    mkdirSync(join(TMP, 'docs', 'guide'), { recursive: true });
    mkdirSync(join(TMP, 'docs', '.vitepress', 'dist'), { recursive: true });
    mkdirSync(join(TMP, 'specs'), { recursive: true });
    writeFileSync(join(TMP, 'README.md'), '# Synax\n', 'utf-8');
    writeFileSync(join(TMP, 'AGENTS.md'), '# Agents\n', 'utf-8');
    writeFileSync(join(TMP, 'CHANGELOG.md'), '# Changes\n', 'utf-8');
    writeFileSync(join(TMP, '.synax.toml.example'), 'model = "local"\n', 'utf-8');
    writeFileSync(join(TMP, 'docs', 'guide', 'commands.md'), '# Commands\n', 'utf-8');
    writeFileSync(join(TMP, 'docs', '.vitepress', 'dist', 'index.html'), 'generated\n', 'utf-8');
    writeFileSync(join(TMP, 'specs', 'PRD.md'), '# PRD\n', 'utf-8');
    writeFileSync(join(TMP, 'src.ts'), 'export {}\n', 'utf-8');

    const result = await discoverLocalDocs(TMP);

    expect(result).toEqual({
      files: [
        '.synax.toml.example',
        'AGENTS.md',
        'CHANGELOG.md',
        'README.md',
        'docs/guide/commands.md',
        'specs/PRD.md',
      ],
      truncated: false,
    });
  });

  it('reads local docs with bounded line ranges', async () => {
    writeFileSync(join(TMP, 'README.md'), ['one', 'two', 'three', 'four'].join('\n'), 'utf-8');

    const result = await readLocalDoc(TMP, 'README.md', { startLine: 2, endLine: 99, maxLines: 3 });

    expect(result).toEqual({
      path: 'README.md',
      startLine: 2,
      endLine: 4,
      totalLines: 4,
      lines: [
        { lineNumber: 2, text: 'two' },
        { lineNumber: 3, text: 'three' },
        { lineNumber: 4, text: 'four' },
      ],
      truncated: true,
    });
  });

  it('rejects reads outside the local docs set', async () => {
    writeFileSync(join(TMP, 'src.ts'), 'export {}\n', 'utf-8');

    await expect(readLocalDoc(TMP, 'src.ts')).rejects.toThrow('not a local docs path');
  });
});
