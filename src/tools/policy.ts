import { homedir } from 'os';
import { isAbsolute, normalize, resolve } from 'path';

export interface PathPolicyResult {
  ok: boolean;
  path?: string;
  absolutePath?: string;
  reason?: string;
}

export function normalizeRepoPath(repoRoot: string, inputPath: string): PathPolicyResult {
  if (!inputPath || inputPath.trim().length === 0) {
    return { ok: false, reason: 'path is required' };
  }

  const normalized = normalize(expandHome(inputPath)).replace(/\\/g, '/');
  const absolutePath = isAbsolute(inputPath) ? resolve(normalized) : resolve(repoRoot, normalized);

  // Validate absolute paths are within allowed roots
  if (isAbsolute(inputPath)) {
    const repoNormalized = normalize(repoRoot).replace(/\\/g, '/').replace(/\/+$/, '');
    const homeNormalized = normalize(homedir()).replace(/\\/g, '/').replace(/\/+$/, '');

    if (!isWithinRoot(absolutePath, repoNormalized) && !isWithinRoot(absolutePath, homeNormalized)) {
      return {
        ok: false,
        reason:
          'path is outside the repository root and your home directory. ' +
          'Use a path within the current project or ~/ instead.',
      };
    }
  }

  return { ok: true, path: normalized === '.' ? '' : normalized, absolutePath };
}

function isWithinRoot(absolutePath: string, root: string): boolean {
  if (absolutePath === root) return true;
  return absolutePath.startsWith(root + '/');
}

/**
 * Expand ~ and $HOME to the user's home directory.
 */
function expandHome(filePath: string): string {
  if (filePath === '~' || filePath === '$HOME') {
    return homedir();
  }
  if (filePath.startsWith('~/')) {
    return homedir() + filePath.slice(1);
  }
  if (filePath.startsWith('$HOME/')) {
    return homedir() + filePath.slice(5);
  }
  return filePath;
}

export function isSafeRepoPath(repoRoot: string, inputPath: string): boolean {
  return normalizeRepoPath(repoRoot, inputPath).ok;
}
