import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';

import { normalizeRepoPath } from '../tools/policy';
import { redactSecrets } from '../tools/secrets';

const DEFAULT_MAX_DOC_FILES = 200;
const DEFAULT_MAX_READ_LINES = 120;
const DOC_ROOT_FILES = new Set(['README.md', 'AGENTS.md', 'CHANGELOG.md', '.synax.toml.example']);
const DOC_DIRECTORIES = new Set(['docs', 'specs']);
const GENERATED_DOC_PREFIXES = ['docs/.vitepress/dist'];

export interface LocalDocsDiscovery {
  files: string[];
  truncated: boolean;
}

export interface LocalDocReadOptions {
  startLine?: number;
  endLine?: number;
  maxLines?: number;
}

export interface LocalDocLine {
  lineNumber: number;
  text: string;
}

export interface LocalDocRead {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: LocalDocLine[];
  truncated: boolean;
}

export interface LocalDocsSearchMatch {
  path: string;
  lineNumber: number;
  line: string;
}

export interface LocalDocsSearchResult {
  query: string;
  matches: LocalDocsSearchMatch[];
  truncated: boolean;
}

export async function discoverLocalDocs(
  repoRoot: string,
  maxFiles = DEFAULT_MAX_DOC_FILES,
): Promise<LocalDocsDiscovery> {
  const files: string[] = [];
  await collectLocalDocs(repoRoot, '.', files, boundedPositiveInteger(maxFiles, DEFAULT_MAX_DOC_FILES));
  files.sort();

  return { files, truncated: files.length >= maxFiles };
}

export async function readLocalDoc(
  repoRoot: string,
  path: string,
  options: LocalDocReadOptions = {},
): Promise<LocalDocRead> {
  const target = normalizeRepoPath(repoRoot, path);
  if (!target.ok || !target.absolutePath || target.path === undefined) {
    throw new Error(target.reason ?? 'invalid path');
  }

  if (!isLocalDocPath(target.path)) {
    throw new Error(`not a local docs path: ${target.path}`);
  }

  const targetStat = await stat(target.absolutePath);
  if (!targetStat.isFile()) {
    throw new Error(`not a local docs file: ${target.path}`);
  }

  const startLine = boundedPositiveInteger(options.startLine, 1);
  const requestedEndLine = boundedPositiveInteger(options.endLine, startLine + DEFAULT_MAX_READ_LINES - 1);
  const maxLines = boundedPositiveInteger(options.maxLines, DEFAULT_MAX_READ_LINES, DEFAULT_MAX_READ_LINES);
  const endLine = Math.min(requestedEndLine, startLine + maxLines - 1);
  const lines = splitLines(redactSecrets(await readFile(target.absolutePath, 'utf-8')));
  const selected = lines.slice(startLine - 1, endLine).map<LocalDocLine>((line, index) => ({
    lineNumber: startLine + index,
    text: line,
  }));
  const actualEndLine = selected.length > 0 ? selected[selected.length - 1].lineNumber : startLine;

  return {
    path: target.path,
    startLine,
    endLine: actualEndLine,
    totalLines: lines.length,
    lines: selected,
    truncated: requestedEndLine > endLine,
  };
}

export async function searchLocalDocs(
  repoRoot: string,
  query: string,
  maxMatches = 80,
): Promise<LocalDocsSearchResult> {
  const discovery = await discoverLocalDocs(repoRoot);
  const matches: LocalDocsSearchMatch[] = [];
  const needle = query.trim().toLowerCase();
  if (!needle) return { query, matches, truncated: false };

  for (const path of discovery.files) {
    const target = normalizeRepoPath(repoRoot, path);
    if (!target.ok || !target.absolutePath) continue;
    const lines = splitLines(redactSecrets(await readFile(target.absolutePath, 'utf-8')));
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].toLowerCase().includes(needle)) continue;
      matches.push({ path, lineNumber: i + 1, line: lines[i] });
      if (matches.length >= maxMatches) {
        return { query, matches, truncated: true };
      }
    }
  }

  return { query, matches, truncated: false };
}

async function collectLocalDocs(
  repoRoot: string,
  relativeDir: string,
  files: string[],
  maxFiles: number,
): Promise<void> {
  if (files.length >= maxFiles) {
    return;
  }

  const entries = await readdir(join(repoRoot, relativeDir), { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= maxFiles) {
      return;
    }

    const child = relativeDir === '.' ? entry.name : `${relativeDir}/${entry.name}`;
    const normalized = normalizeRepoPath(repoRoot, child);
    if (!normalized.ok || normalized.path === undefined) {
      continue;
    }

    if (entry.isDirectory()) {
      if (DOC_DIRECTORIES.has(normalized.path) || isInsideDocDirectory(normalized.path)) {
        await collectLocalDocs(repoRoot, normalized.path, files, maxFiles);
      }
      continue;
    }

    if (entry.isFile() && isLocalDocPath(normalized.path)) {
      files.push(normalized.path);
    }
  }
}

function isLocalDocPath(path: string): boolean {
  if (GENERATED_DOC_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return false;
  }

  return DOC_ROOT_FILES.has(path) || path.endsWith('.toml.example') || isInsideDocDirectory(path);
}

function isInsideDocDirectory(path: string): boolean {
  const [first] = path.split('/');
  return DOC_DIRECTORIES.has(first);
}

function boundedPositiveInteger(
  value: number | undefined,
  defaultValue: number,
  maxValue = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return defaultValue;
  }

  return Math.min(value, maxValue);
}

function splitLines(text: string): string[] {
  const withoutFinalNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
  return withoutFinalNewline.length === 0 ? [] : withoutFinalNewline.split(/\r?\n/);
}
