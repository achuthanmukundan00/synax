import { normalizeRepoPath } from '../tools/policy';

export type RunMode = 'read-only' | 'patch' | 'verify' | 'docs';

export interface BroadTaskGuardResult {
  blocked: boolean;
  message: string;
  suggestedFirstStep: string;
}

export interface UnsupportedTaskGuardResult {
  blocked: boolean;
  message: string;
  suggestedFirstStep: string;
}

const DOCS_MUTATION_ROOTS = ['README.md', 'AGENTS.md', 'docs/', 'specs/'];

export function getAllowedModelTools(mode: RunMode, bashEnabled: boolean): string[] {
  const base = bashEnabled ? ['read', 'bash', 'search_memory', 'view_image'] : ['read', 'search_memory', 'view_image'];
  if (mode === 'read-only' || mode === 'verify') {
    return base;
  }
  return [...base, 'write', 'edit'];
}

export function normalizeRunMode(mode: string | undefined): RunMode {
  if (mode === 'read-only' || mode === 'patch' || mode === 'verify' || mode === 'docs') {
    return mode;
  }
  return 'patch';
}

export function canMutatePath(mode: RunMode, repoRoot: string, path: string): { ok: boolean; reason?: string } {
  const target = normalizeRepoPath(repoRoot, path);
  if (!target.ok || !target.path) {
    return { ok: false, reason: target.reason ?? 'invalid path' };
  }

  if (mode !== 'docs') {
    return { ok: true };
  }

  const normalizedPath = target.path;
  if (
    DOCS_MUTATION_ROOTS.some((prefix) =>
      prefix.endsWith('/') ? normalizedPath.startsWith(prefix) : normalizedPath === prefix,
    )
  ) {
    return { ok: true };
  }

  return { ok: false, reason: `docs mode only allows documentation files: ${normalizedPath}` };
}

export function guardBroadTask(task: string): BroadTaskGuardResult | null {
  const normalized = task.toLowerCase().trim();
  if (!normalized) return null;

  const matches: Array<{ pattern: RegExp; firstStep: string }> = [
    {
      pattern: /\bimplement all of v1\b/i,
      firstStep:
        'Inventory the current v0.7 safety paths and choose one checkpoint/report improvement to finish first.',
    },
    {
      pattern: /\brewrite the tui\b/i,
      firstStep:
        'Start by inspecting the current command/report path and define one tiny TUI-adjacent output improvement.',
    },
    {
      pattern: /\brefactor the agent runtime\b/i,
      firstStep:
        'Pick one agent runtime file and harden a single safety boundary instead of refactoring the whole runtime.',
    },
    {
      pattern: /\bfix everything\b/i,
      firstStep: 'Choose one failing command, tool, or safety path and repair that first.',
    },
  ];

  for (const entry of matches) {
    if (entry.pattern.test(normalized)) {
      return {
        blocked: true,
        message: `Task is too broad for a bounded self-development run: ${task}`,
        suggestedFirstStep: entry.firstStep,
      };
    }
  }

  return null;
}

export function guardUnsupportedTask(task: string, shellEnabled: boolean): UnsupportedTaskGuardResult | null {
  const normalized = task.toLowerCase().trim();
  if (!normalized) return null;

  const commitIntent =
    /\b(commit|git commit)\b/.test(normalized) &&
    (/\b(push|pr|pull request|merge)\b/.test(normalized) ||
      /\bunstaged changes\b/.test(normalized) ||
      /\bstaged changes\b/.test(normalized) ||
      /\bworking tree\b/.test(normalized) ||
      /\bchanges\b/.test(normalized));

  if (commitIntent && !shellEnabled) {
    return {
      blocked: true,
      message: 'This run cannot create commits because bash is disabled.',
      suggestedFirstStep:
        'Enable bash for Synax or run `git status` and `git commit -m "<message>"` manually in your shell.',
    };
  }

  return null;
}

export function describeToolCall(name: string, input: Record<string, unknown>): string {
  if (name === 'read') {
    if (typeof input.query === 'string') return `read search: ${input.query}`;
    if (typeof input.path === 'string') return `read ${input.path}`;
    return 'read repository listing';
  }

  if (name === 'write' || name === 'create_file') {
    return typeof input.path === 'string' ? `write ${input.path}` : 'write file';
  }

  if (name === 'edit' || name === 'replace_in_file') {
    return typeof input.path === 'string' ? `edit ${input.path}` : 'edit file';
  }

  if (name === 'git') {
    const action =
      typeof input.action === 'string'
        ? input.action
        : typeof input.operation === 'string'
          ? input.operation
          : 'status';
    return action === 'diff' ? 'git diff' : 'git status';
  }

  if (name === 'view_image') {
    return typeof input.path === 'string' ? `view_image ${input.path}` : 'view_image';
  }

  if (name === 'search_memory') {
    return typeof input.query === 'string' ? `search_memory: ${input.query.slice(0, 80)}` : 'search_memory';
  }

  return `${name}`;
}
