/**
 * Tab autocomplete strategies for the TUI prompt box.
 *
 * Supports four completion modes:
 *  1. **Path completion** — when cursor is on a token that starts with `/`,
 *     `./`, `../`, or `~/`, list directory entries matching the trailing prefix.
 *  2. **@-mention** — when cursor is after an `@` symbol, list files in the
 *     repository root.
 *  3. **Model name completion** — when cursor follows a model-selection slash
 *     command (e.g. `/model `), suggest configured model IDs.
 *  4. **Context-aware dispatch** — Tab selects the right completion mode based
 *     on the token at the cursor and the surrounding command context.
 *
 * The result always contains the *full* prompt value that would result if the
 * user accepted that completion, so callers can synchronise the prompt directly.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { homedir } from 'node:os';
import type { EffectiveSynaxConfig } from '../config/schema';
import { slashAutocompleteItems } from './key-handlers';

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

// ─── Completion context detection ──────────────────────────────────────────

/**
 * Slash commands whose first argument is a model name.
 * After typing e.g. `/model qw`, Tab should suggest model IDs.
 */
const MODEL_ARG_COMMANDS = new Set(['model', 'models']);

/**
 * Detect which completion strategy is appropriate for the current input and
 * cursor position.
 */
export type CompletionContext =
  | { kind: 'slash_command'; commandQuery: string }
  | { kind: 'model_name'; prefix: string }
  | { kind: 'path'; token: string; start: number; end: number }
  | { kind: 'at_mention'; query: string }
  | { kind: 'none' };

export function detectCompletionContext(input: string, cursorPos: number): CompletionContext {
  const { start, end } = getWordAtCursor(input, cursorPos);
  const token = input.slice(start, end);

  // Slash command detection: when the cursor word starts with /
  if (token.startsWith('/')) {
    // Absolute paths have multiple / separators; treat those as path, not command
    if (token.indexOf('/', 1) !== -1) {
      // e.g. /usr/bin, /home/user/docs — these are paths, not commands
      return { kind: 'path', token, start, end };
    }

    const spaceIdx = token.indexOf(' ');
    const commandPart = spaceIdx > 0 ? token.slice(1, spaceIdx) : token.slice(1);
    const afterCommand = spaceIdx > 0 ? token.slice(spaceIdx + 1) : '';

    // If this looks like `/model qwen`, the user wants model name completion
    if (MODEL_ARG_COMMANDS.has(commandPart) && spaceIdx > 0) {
      return { kind: 'model_name', prefix: afterCommand };
    }

    // Otherwise it's a slash command query
    return { kind: 'slash_command', commandQuery: token };
  }

  // Check if the preceding context (before the current word) ends with
  // a model-selection command. This handles cases like `/model qw` where
  // the cursor is on 'qw' but the token doesn't start with /.
  const beforeToken = input.slice(0, start).trimEnd();
  if (beforeToken) {
    const beforeParts = beforeToken.split(/\s+/);
    const lastBeforePart = beforeParts[beforeParts.length - 1] ?? '';
    if (lastBeforePart.startsWith('/')) {
      const cmdName = lastBeforePart.slice(1);
      if (MODEL_ARG_COMMANDS.has(cmdName)) {
        return { kind: 'model_name', prefix: token };
      }
    }
  }

  // Path detection
  if (isPathToken(token)) {
    return { kind: 'path', token, start, end };
  }

  // @-mention detection
  if (isAtMention(token)) {
    return { kind: 'at_mention', query: token.slice(1) };
  }

  return { kind: 'none' };
}

// ─── Model name completion ─────────────────────────────────────────────────

/**
 * Collect all unique model IDs from the effective config.
 */
export function collectModelNames(config?: EffectiveSynaxConfig): string[] {
  if (!config) return [];
  const names = new Set<string>();
  for (const provider of Object.values(config.providers)) {
    for (const model of provider.models) {
      if (model.id) names.add(model.id);
    }
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/**
 * Try to produce model name completions for the current token.
 *
 * Returns `null` when no model names match the prefix.
 */
export function getModelNameCompletions(
  input: string,
  cursorPos: number,
  config?: EffectiveSynaxConfig,
): CompletionResult | null {
  const models = collectModelNames(config);
  if (models.length === 0) return null;

  const ctx = detectCompletionContext(input, cursorPos);
  if (ctx.kind !== 'model_name' && ctx.kind !== 'none') return null;

  let prefix: string;
  let start: number;
  let end: number;

  if (ctx.kind === 'model_name') {
    // We know the exact prefix from the context
    prefix = ctx.prefix.toLowerCase();
    // Find the start of the model name argument in the input
    const { start: wordStart, end: wordEnd } = getWordAtCursor(input, cursorPos);
    start = wordStart;
    end = wordEnd;
  } else {
    // Try to detect if we're after a model command
    const { start: wordStart, end: wordEnd } = getWordAtCursor(input, cursorPos);
    const token = input.slice(wordStart, wordEnd);
    const beforeToken = input.slice(0, wordStart).trimEnd();
    if (!beforeToken) return null;
    const beforeParts = beforeToken.split(/\s+/);
    const lastBefore = beforeParts[beforeParts.length - 1] ?? '';
    if (!lastBefore.startsWith('/') || !MODEL_ARG_COMMANDS.has(lastBefore.slice(1))) return null;
    prefix = token.toLowerCase();
    start = wordStart;
    end = wordEnd;
  }

  const matches = models.filter((m) => m.toLowerCase().includes(prefix));
  if (matches.length === 0) return null;

  const items = matches.map((modelId) => {
    const fullPrompt = input.slice(0, start) + modelId + input.slice(end);
    return fullPrompt;
  });

  return { items, from: start, to: end };
}

// ─── Combined entry point ──────────────────────────────────────────────────

/**
 * Context-aware Tab completion dispatcher.
 *
 * Detection order:
 *  1. Slash command → command completions (handled externally via slashAutocompleteItems)
 *  2. Model name context → model name completions
 *  3. Path token → path completions
 *  4. @-mention → @-mention completions
 *
 * Returns `null` when no strategy produces matches.
 */
export function getCompletions(
  input: string,
  cursorPos: number,
  cwd: string,
  repoRoot: string,
  config?: EffectiveSynaxConfig,
): CompletionResult | null {
  const ctx = detectCompletionContext(input, cursorPos);

  if (ctx.kind === 'model_name' && config) {
    return getModelNameCompletions(input, cursorPos, config);
  }

  if (ctx.kind === 'path') {
    const pathResult = getPathCompletions(input, cursorPos, cwd);
    if (pathResult) return pathResult;
  }

  if (ctx.kind === 'at_mention') {
    return getAtMentionCompletions(input, cursorPos, repoRoot);
  }

  if (ctx.kind === 'slash_command') {
    const items = slashAutocompleteItems(input);
    if (items.length === 0) return null;
    const { start, end } = getWordAtCursor(input, cursorPos);
    const completions = items.map((item) => input.slice(0, start) + item + input.slice(end));
    return { items: completions, from: start, to: end };
  }

  // For 'none' context, still try path and @-mention as fallback.
  if (ctx.kind === 'none') {
    const pathResult = getPathCompletions(input, cursorPos, cwd);
    if (pathResult) return pathResult;
    return getAtMentionCompletions(input, cursorPos, repoRoot);
  }

  return null;
}
