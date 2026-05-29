import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';

import type { SuperPatchSuggestion } from './types';

export type SuperWorldPaths = {
  root: string;
  self: string;
  world: string;
  pulse: string;
  dreams: string;
  patchSuggestions: string;
  inbox: string;
  outbox: string;
};

export class SuperWorld {
  readonly paths: SuperWorldPaths;

  constructor(root: string) {
    const cleanRoot = normalize(root);
    this.paths = {
      root: cleanRoot,
      self: join(cleanRoot, 'self.md'),
      world: join(cleanRoot, 'world.md'),
      pulse: join(cleanRoot, 'pulse.md'),
      dreams: join(cleanRoot, 'dreams'),
      patchSuggestions: join(cleanRoot, 'patch_suggestions'),
      inbox: join(cleanRoot, 'inbox'),
      outbox: join(cleanRoot, 'outbox'),
    };
  }

  async ensure(): Promise<void> {
    await Promise.all([
      mkdir(this.paths.dreams, { recursive: true }),
      mkdir(this.paths.patchSuggestions, { recursive: true }),
      mkdir(this.paths.inbox, { recursive: true }),
      mkdir(this.paths.outbox, { recursive: true }),
      mkdir(join(this.paths.root, 'short_term_memory'), { recursive: true }),
      mkdir(join(this.paths.root, 'long_term_memory'), { recursive: true }),
      mkdir(join(this.paths.root, 'sources'), { recursive: true }),
      mkdir(join(this.paths.root, 'reflections'), { recursive: true }),
      mkdir(join(this.paths.root, 'plans'), { recursive: true }),
    ]);
  }

  async readContext(): Promise<{ self: string; world: string; pulse: string }> {
    const [self, world, pulse] = await Promise.all([
      readOptional(this.paths.self),
      readOptional(this.paths.world),
      readOptional(this.paths.pulse),
    ]);
    return { self, world, pulse };
  }

  async writePatchSuggestion(suggestion: SuperPatchSuggestion): Promise<string> {
    await mkdir(this.paths.patchSuggestions, { recursive: true });
    const stamp = suggestion.createdAt.replace(/[:.]/g, '-');
    const safeTitle =
      suggestion.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'patch';
    const filePath = join(this.paths.patchSuggestions, `${stamp}-${safeTitle}.md`);
    const body = [
      `# ${suggestion.title}`,
      '',
      `Target: ${suggestion.target}`,
      `Source: ${suggestion.source}`,
      `Mode: ${suggestion.mode}`,
      `Created: ${suggestion.createdAt}`,
      '',
      '## Rationale',
      '',
      suggestion.rationale,
      '',
      '## Patch',
      '',
      '```diff',
      suggestion.patch,
      '```',
      '',
    ].join('\n');
    await writeFile(filePath, body, 'utf8');
    return filePath;
  }
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}
