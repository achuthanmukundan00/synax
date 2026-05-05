import { readFile } from 'fs/promises';

import { type InspectionLedger } from '../tools/ledger';
import { normalizeRepoPath } from '../tools/policy';
import { atomicWriteFile } from './safety';

export type PatchFailureState = 'invalid-patch' | 'unread-file-patch' | 'replacement-match-failure' | 'unsafe-path';

export interface ReplaceInFilePatch {
  path: string;
  oldStr: string;
  newStr: string;
}

export interface PatchContext {
  repoRoot: string;
  ledger: InspectionLedger;
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

  if (!context.ledger.hasInspectedFile(target.path)) {
    return {
      ok: false,
      failureState: 'unread-file-patch',
      message: `patch target was not inspected: ${target.path}`,
    };
  }

  const before = await readFile(target.absolutePath, 'utf-8');
  const matchCount = countOccurrences(before, patch.oldStr);
  if (matchCount !== 1) {
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
  return [`--- ${path}`, `+++ ${path}`, ...prefixChangedLines(before, after)].join('\n');
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

function prefixChangedLines(before: string, after: string): string[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  return [...beforeLines.map((line) => `-${line}`), ...afterLines.map((line) => `+${line}`)];
}

function splitLines(text: string): string[] {
  const withoutTrailingNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
  return withoutTrailingNewline.length === 0 ? [] : withoutTrailingNewline.split(/\r?\n/);
}
