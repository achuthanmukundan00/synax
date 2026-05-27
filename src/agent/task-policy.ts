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

export function getAllowedModelTools(_mode: RunMode, bashEnabled: boolean): string[] {
  const base = bashEnabled ? ['read', 'bash', 'search_memory', 'view_image'] : ['read', 'search_memory', 'view_image'];
  return [...base, 'write', 'edit', 'save_memory'];
}

export function normalizeRunMode(mode: string | undefined): RunMode {
  return (mode as RunMode) ?? 'patch';
}

export function canMutatePath(_mode: RunMode, repoRoot: string, path: string): { ok: boolean; reason?: string } {
  const target = normalizeRepoPath(repoRoot, path);
  if (!target.ok || !target.path) {
    return { ok: false, reason: target.reason ?? 'invalid path' };
  }
  return { ok: true };
}

export function guardBroadTask(_task: string): BroadTaskGuardResult | null {
  return null;
}

export function guardUnsupportedTask(_task: string, _shellEnabled: boolean): UnsupportedTaskGuardResult | null {
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
