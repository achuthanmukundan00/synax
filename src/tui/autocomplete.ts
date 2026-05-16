/**
 * Tab autocomplete strategies for the TUI prompt box.
 *
 * Supports two completion modes:
 *  1. **Path completion** — when cursor is on a token that starts with `/`,
 *     `./`, `../`, or `~/`, list directory entries matching the trailing prefix.
 *  2. **@-mention** — when cursor is after an `@` symbol, list files in the
 *     repository root.
 *
 * The result always contains the *full* prompt value that would result if the
 * user accepted that completion, so callers can synchronise the prompt directly.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { homedir } from 'node:os';

// ─── Public types ──────────────────────────────────────────────────────────

export interface CompletionResult {
  /** Full prompt values to show in the autocomplete popup. */
  items: string[];
  /** Start offset (inclusive) of the token being replaced. */
  from: number;
  /** End offset (exclusive) of the token being replaced. */
  to: number;
}

// ─── Word boundary helpers ─────────────────────────────────────────────────

/** Find the space-delimited word that contains (or is adjacent to) `cursorPos`. */
export function getWordAtCursor(input: string, cursorPos: number): { start: number; end: number } {
  let start = cursorPos;
  while (start > 0 && input[start - 1] !== ' ') {
    start--;
  }
  let end = cursorPos;
  while (end < input.length && input[end] !== ' ') {
    end++;
  }
  return { start, end };
}

/** True when `token` looks like a filesystem path of some kind. */
export function isPathToken(token: string): boolean {
  return token.startsWith('/') || token.startsWith('./') || token.startsWith('../') || token.startsWith('~/');
}

/** True when `token` looks like an @-mention (starts with @, no spaces). */
export function isAtMention(token: string): boolean {
  return token.startsWith('@') && token.length > 1 && !token.includes(' ');
}

// ─── Path completion ───────────────────────────────────────────────────────

/**
 * Try to produce path completions for the current token at the cursor.
 *
 * Returns `null` when the token is not a path-like token or no files match.
 */
export function getPathCompletions(input: string, cursorPos: number, cwd: string): CompletionResult | null {
  const { start, end } = getWordAtCursor(input, cursorPos);
  const token = input.slice(start, end);
  if (!token || !isPathToken(token)) return null;

  // The rightmost / divides the directory from the prefix to match
  const lastSlashIdx = token.lastIndexOf('/');
  if (lastSlashIdx < 0) return null; // shouldn't happen for path tokens, but be safe

  const dirPart = token.slice(0, lastSlashIdx + 1); // includes the /
  const prefix = token.slice(lastSlashIdx + 1);

  // Resolve the directory to an absolute path
  let resolvedDir: string;
  if (dirPart.startsWith('~/')) {
    resolvedDir = join(homedir(), dirPart.slice(2));
  } else if (dirPart.startsWith('/')) {
    resolvedDir = dirPart;
  } else {
    // Relative:  ./ or ../
    resolvedDir = join(cwd, dirPart);
  }

  // Normalise trailing separator for the join
  if (resolvedDir.endsWith(sep) || resolvedDir.endsWith('/')) {
    // keep as-is
  }

  let entries: string[];
  try {
    entries = readdirSync(resolvedDir);
  } catch {
    return null;
  }

  const matches = entries.filter((entry) => entry.startsWith(prefix)).sort();

  if (matches.length === 0) return null;

  // Build the list of items to suggest
  const items: string[] = [];
  for (const match of matches) {
    const fullPath = join(resolvedDir, match);
    let suffix = '';
    try {
      if (statSync(fullPath).isDirectory()) suffix = '/';
    } catch {
      // ignore
    }
    const completedToken = token.slice(0, lastSlashIdx + 1) + match + suffix;
    const fullPrompt = input.slice(0, start) + completedToken + input.slice(end);
    items.push(fullPrompt);
  }

  return { items, from: start, to: end };
}

// ─── @-mention completion ──────────────────────────────────────────────────

/**
 * Try to produce @-mention completions from the repository root.
 *
 * Returns `null` when the current token does not look like an @-mention,
 * or no files match.
 */
export function getAtMentionCompletions(input: string, cursorPos: number, repoRoot: string): CompletionResult | null {
  const { start, end } = getWordAtCursor(input, cursorPos);
  const token = input.slice(start, end);
  if (!token || !isAtMention(token)) return null;

  const query = token.slice(1).toLowerCase(); // drop the @
  if (!query) return null;

  // Walk the repo root (max depth 3, max 20 results)
  const matches = collectRepoFiles(repoRoot, query);
  if (matches.length === 0) return null;

  const items: string[] = [];
  for (const relPath of matches) {
    const completedToken = '@' + relPath;
    const fullPrompt = input.slice(0, start) + completedToken + input.slice(end);
    items.push(fullPrompt);
  }

  return { items, from: start, to: end };
}

/**
 * Recursively list files under `rootDir` whose name matches `query`.
 */
function collectRepoFiles(rootDir: string, query: string): string[] {
  const results: string[] = [];
  const maxResults = 20;
  const maxDepth = 3;

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth || results.length >= maxResults) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) break;

      // Skip dotfiles, node_modules, .git
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (entry.name.startsWith('.')) continue;

      const absPath = join(dir, entry.name);
      const relPath = absPath.startsWith(rootDir + sep) ? absPath.slice(rootDir.length + 1) : entry.name;

      if (entry.isDirectory()) {
        walk(absPath, depth + 1);
      } else if (entry.name.toLowerCase().includes(query)) {
        results.push(relPath);
      }
    }
  }

  walk(rootDir, 0);
  return results;
}

// ─── Combined entry point ──────────────────────────────────────────────────

/**
 * Try path completion first; fall back to @-mention completion.
 *
 * Returns `null` when neither strategy produces matches.
 */
export function getCompletions(
  input: string,
  cursorPos: number,
  cwd: string,
  repoRoot: string,
): CompletionResult | null {
  const pathResult = getPathCompletions(input, cursorPos, cwd);
  if (pathResult) return pathResult;

  return getAtMentionCompletions(input, cursorPos, repoRoot);
}
