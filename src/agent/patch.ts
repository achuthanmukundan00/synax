import { readFile } from 'fs/promises';

import { normalizeRepoPath } from '../tools/policy';
import { atomicWriteFile } from './safety';

export type PatchFailureState = 'invalid-patch' | 'stale-read' | 'replacement-match-failure' | 'unsafe-path';

export interface ReplaceInFilePatch {
  path: string;
  oldStr: string;
  newStr: string;
}

export interface PatchContext {
  repoRoot: string;
}

export interface PatchValidationSuccess {
  ok: true;
  path: string;
  matchCount: number;
  before: string;
  after: string;
}

export interface PatchPreview {
  path: string;
  diff: string;
}

export interface PatchValidationFailure {
  ok: false;
  failureState: PatchFailureState;
  message: string;
}

export type PatchValidationResult = PatchValidationSuccess | PatchValidationFailure;

export async function validateReplaceInFile(
  patch: ReplaceInFilePatch,
  context: PatchContext,
): Promise<PatchValidationResult> {
  if (!patch.path || !patch.oldStr) {
    return { ok: false, failureState: 'invalid-patch', message: 'path and oldStr are required' };
  }

  const target = normalizeRepoPath(context.repoRoot, patch.path);
  if (!target.ok || !target.absolutePath || target.path === undefined) {
    return { ok: false, failureState: 'unsafe-path', message: target.reason ?? 'invalid path' };
  }

  const before = await readFile(target.absolutePath, 'utf-8');
  const matchCount = countOccurrences(before, patch.oldStr);
  if (matchCount === 0) {
    const snippetLen = Math.min(before.length, 800);
    const snippet = before.slice(0, snippetLen);
    const truncated = before.length > snippetLen ? '...(truncated)' : '';
    return {
      ok: false,
      failureState: 'stale-read',
      message:
        `oldStr no longer matches the current contents of ${target.path}. ` +
        `Re-read the file and retry with an exact snippet. ` +
        `File begins with${truncated ? ' (truncated)' : ''}:\n${snippet}${truncated}`,
    };
  }
  if (matchCount > 1) {
    return {
      ok: false,
      failureState: 'replacement-match-failure',
      message: `oldStr must match exactly once in ${target.path}; found ${matchCount}`,
    };
  }

  return {
    ok: true,
    path: target.path,
    matchCount,
    before,
    after: before.replace(patch.oldStr, patch.newStr),
  };
}

export async function applyReplaceInFile(
  patch: ReplaceInFilePatch,
  context: PatchContext,
): Promise<PatchValidationResult> {
  const validation = await validateReplaceInFile(patch, context);
  if (!validation.ok) return validation;

  const target = normalizeRepoPath(context.repoRoot, validation.path);
  if (!target.ok || !target.absolutePath) {
    return { ok: false, failureState: 'unsafe-path', message: target.reason ?? 'invalid path' };
  }

  await atomicWriteFile(target.absolutePath, validation.after);
  return validation;
}

export function createPatchPreview(validation: PatchValidationSuccess): PatchPreview {
  return {
    path: validation.path,
    diff: createUnifiedDiff(validation.path, validation.before, validation.after),
  };
}

export function createUnifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return '';
  return [`--- ${path}`, `+++ ${path}`, ...diffLines(before, after)].join('\n');
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

const DIFF_CONTEXT_LINES = 3;

/**
 * Produce unified-diff body lines (context + -/+ markers) for two texts.
 *
 * Uses common prefix/suffix trimming, then a line-level LCS over the changed
 * middle region. Unchanged middle lines render as context (' ' prefix);
 * unchanged runs longer than 2*DIFF_CONTEXT_LINES are elided with hunk
 * separators. Falls back to whole-region replace when the middle is very
 * large (LCS is O(n²)) — still bounded by the changed region, never the
 * whole file like the previous implementation.
 */
function diffLines(before: string, after: string): string[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  // Trim common prefix.
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
    start += 1;
  }
  // Trim common suffix (not overlapping the prefix).
  let endB = beforeLines.length;
  let endA = afterLines.length;
  while (endB > start && endA > start && beforeLines[endB - 1] === afterLines[endA - 1]) {
    endB -= 1;
    endA -= 1;
  }

  const midBefore = beforeLines.slice(start, endB);
  const midAfter = afterLines.slice(start, endA);

  // Body of the changed region: LCS-based when affordable, plain replace otherwise.
  const MAX_LCS_LINES = 2000;
  const body: string[] =
    midBefore.length * midAfter.length <= MAX_LCS_LINES * MAX_LCS_LINES
      ? lcsDiff(midBefore, midAfter)
      : [...midBefore.map((l) => `-${l}`), ...midAfter.map((l) => `+${l}`)];

  // Surrounding context from the trimmed prefix/suffix.
  const preContext = beforeLines.slice(Math.max(0, start - DIFF_CONTEXT_LINES), start).map((l) => ` ${l}`);
  const postContext = beforeLines.slice(endB, endB + DIFF_CONTEXT_LINES).map((l) => ` ${l}`);

  const header = `@@ -${Math.max(1, start - DIFF_CONTEXT_LINES + 1)},${preContext.length + midBefore.length + postContext.length} +${Math.max(1, start - DIFF_CONTEXT_LINES + 1)},${preContext.length + midAfter.length + postContext.length} @@`;
  return [header, ...preContext, ...body, ...postContext];
}

/** Line-level LCS diff producing ' ', '-', '+' prefixed lines. */
function lcsDiff(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  // DP table of LCS lengths.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`-${a[i]}`);
      i += 1;
    } else {
      out.push(`+${b[j]}`);
      j += 1;
    }
  }
  while (i < m) out.push(`-${a[i++]}`);
  while (j < n) out.push(`+${b[j++]}`);
  return out;
}

function splitLines(text: string): string[] {
  const withoutTrailingNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
  return withoutTrailingNewline.length === 0 ? [] : withoutTrailingNewline.split(/\r?\n/);
}
