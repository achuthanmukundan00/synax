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

export function getAllowedModelTools(mode: RunMode, bashEnabled: boolean): string[] {
  // Always-available read-only tools
  const base = ['read', 'save_memory', 'search_memory', 'view_image'];

  // Mutation tools only in patch mode
  if (mode === 'patch' || mode === 'verify') {
    if (bashEnabled) base.push('bash');
    base.push('write', 'edit');
  }

  return base;
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

/**
 * Heuristic: does the task ask for information rather than file changes?
 *
 * Used to relax the `files_changed` verification contract in patch mode so
 * Q&A / analysis tasks ("explain X", "why does Y fail?") are not pushed into
 * making spurious edits just to satisfy the contract.
 *
 * Conservative by design: returns true only when the task BOTH looks
 * informational AND contains no mutation verbs. Ambiguous tasks keep the
 * strict contract.
 */
export function isInformationalTask(task: string): boolean {
  const lower = task.toLowerCase().trim();

  const mutationIntent =
    /\b(fix|change|modif|add|edit|write|implement|update|refactor|resolve|patch|correct|repair|create|delete|remove|rename|move|migrate|upgrade|install|bump|revert|apply|format|cleanup|clean up|optimi[sz]e)\b/;
  if (mutationIntent.test(lower)) return false;

  const informationalIntent =
    /\b(explain|describe|summari[sz]e|analy[sz]e|review|inspect|compare|what|why|how|where|which|who|list|show|find|tell me|walk me through|document for me)\b/;
  return informationalIntent.test(lower) || lower.endsWith('?');
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
    return typeof input.query === 'string' ? `search_memory: ${input.query}` : 'search_memory';
  }

  return `${name}`;
}
