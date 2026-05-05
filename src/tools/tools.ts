import { execFile } from 'child_process';
import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';

import { normalizeRepoPath } from './policy';
import { redactSecrets } from './secrets';
import { ToolContext, ToolDefinition, ToolResult } from './types';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_READ_LINES = 120;
const DEFAULT_MAX_MATCHES = 50;
const DEFAULT_MAX_GIT_LINES = 200;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 80;
const SKIPPED_DIRECTORY_LISTING_NAMES = new Set(['cache']);

interface ListFilesInput {
  path?: string;
  maxFiles?: number;
}

interface ReadFileRangeInput {
  path?: string;
  startLine?: number;
  endLine?: number;
}

interface SearchTextInput {
  query?: string;
  path?: string;
  maxMatches?: number;
}

interface GitDiffInput {
  maxLines?: number;
}

interface LineOutput {
  lineNumber: number;
  text: string;
}

interface SearchMatchOutput {
  path: string;
  lineNumber: number;
  line: string;
}

interface DirectoryEntryOutput {
  name: string;
  type: 'file' | 'directory';
}

export function createInspectionTools(): ToolDefinition[] {
  return [listFilesTool, readFileRangeTool, searchTextTool, showGitStatusTool, showGitDiffTool];
}

const readOnlySafety = {
  readOnly: true,
  rejectsUnsafePaths: true,
  boundedOutput: true,
};

const listFilesTool: ToolDefinition<ListFilesInput> = {
  name: 'list_files',
  description:
    'List safe, non-generated repository files under an optional repo-relative directory. Use before reading files when you need candidate paths.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Optional repo-relative directory to list. Defaults to repository root.' },
      maxFiles: { type: 'number', description: `Maximum files to return. Default ${DEFAULT_MAX_FILES}.` },
    },
  },
  safetyPolicy: readOnlySafety,
  ledgerBehavior: 'records-file-list',
  async execute(input: ListFilesInput, context: ToolContext): Promise<ToolResult> {
    const maxFiles = boundedPositiveInteger(input.maxFiles, DEFAULT_MAX_FILES, DEFAULT_MAX_FILES);
    const target = normalizeRepoPath(context.repoRoot, repoRootPath(input.path));
    if (!target.ok || !target.absolutePath || target.path === undefined) {
      return failure('list_files', target.reason ?? 'invalid path');
    }

    try {
      const files: string[] = [];
      await collectFiles(context.repoRoot, target.path, files, maxFiles);
      files.sort();
      return success('list_files', { files, truncated: files.length >= maxFiles });
    } catch (error) {
      return failure('list_files', errorMessage(error));
    }
  },
};

const readFileRangeTool: ToolDefinition<ReadFileRangeInput> = {
  name: 'read_file_range',
  description:
    'Read a bounded, line-numbered range from one safe repo-relative text file. Use this before proposing edits to that file.',
  inputSchema: {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'Repo-relative file path to read.' },
      startLine: { type: 'number', description: '1-based first line to include. Defaults to 1.' },
      endLine: {
        type: 'number',
        description: `1-based final line to include. Defaults to startLine + ${DEFAULT_MAX_READ_LINES - 1}.`,
      },
    },
  },
  safetyPolicy: readOnlySafety,
  ledgerBehavior: 'records-file-range',
  async execute(input: ReadFileRangeInput, context: ToolContext): Promise<ToolResult> {
    if (!input.path) {
      return failure('read_file_range', 'path is required');
    }

    const target = normalizeRepoPath(context.repoRoot, input.path);
    if (!target.ok || !target.absolutePath || target.path === undefined) {
      return failure('read_file_range', target.reason ?? 'invalid path');
    }

    const startLine = boundedPositiveInteger(input.startLine, 1, Number.MAX_SAFE_INTEGER);
    const requestedEndLine = boundedPositiveInteger(
      input.endLine,
      startLine + DEFAULT_MAX_READ_LINES - 1,
      Number.MAX_SAFE_INTEGER,
    );
    const endLine = Math.min(requestedEndLine, startLine + DEFAULT_MAX_READ_LINES - 1);

    try {
      const targetStat = await stat(target.absolutePath);
      if (targetStat.isDirectory()) {
        return success('read_file_range', await listDirectory(context.repoRoot, target.path));
      }

      const text = redactSecrets(await readFile(target.absolutePath, 'utf-8'));
      const lines = splitLines(text);
      const selected = lines.slice(startLine - 1, endLine).map<LineOutput>((line, index) => ({
        lineNumber: startLine + index,
        text: line,
      }));
      const actualEndLine = selected.length > 0 ? selected[selected.length - 1].lineNumber : startLine;
      context.ledger.recordFileRange(target.path, startLine, actualEndLine);

      return success('read_file_range', {
        path: target.path,
        startLine,
        endLine: actualEndLine,
        totalLines: lines.length,
        lines: selected,
        truncated: requestedEndLine > endLine,
      });
    } catch (error) {
      return failure('read_file_range', errorMessage(error));
    }
  },
};

const searchTextTool: ToolDefinition<SearchTextInput> = {
  name: 'search_text',
  description:
    'Search safe repository text files for a literal string. Returns bounded repo-relative matches with line numbers.',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Literal text to search for.' },
      path: { type: 'string', description: 'Optional safe repo-relative directory or file to search.' },
      maxMatches: { type: 'number', description: `Maximum matches to return. Default ${DEFAULT_MAX_MATCHES}.` },
    },
  },
  safetyPolicy: readOnlySafety,
  ledgerBehavior: 'records-search-results',
  async execute(input: SearchTextInput, context: ToolContext): Promise<ToolResult> {
    if (!input.query) {
      return failure('search_text', 'query is required');
    }

    const target = normalizeRepoPath(context.repoRoot, repoRootPath(input.path));
    if (!target.ok || target.path === undefined) {
      return failure('search_text', target.reason ?? 'invalid path');
    }

    const maxMatches = boundedPositiveInteger(input.maxMatches, DEFAULT_MAX_MATCHES, DEFAULT_MAX_MATCHES);
    const files: string[] = [];
    const matches: SearchMatchOutput[] = [];

    try {
      await collectFiles(context.repoRoot, target.path, files, DEFAULT_MAX_FILES);
      files.sort();
      for (const file of files) {
        const text = redactSecrets(await readFile(join(context.repoRoot, file), 'utf-8'));
        const lines = splitLines(text);
        for (let index = 0; index < lines.length; index += 1) {
          if (!lines[index].includes(input.query)) {
            continue;
          }

          const lineNumber = index + 1;
          matches.push({ path: file, lineNumber, line: lines[index] });
          context.ledger.recordFileRange(file, lineNumber, lineNumber);
          if (matches.length >= maxMatches) {
            return success('search_text', { query: input.query, matches, truncated: true });
          }
        }
      }

      return success('search_text', { query: input.query, matches, truncated: false });
    } catch (error) {
      return failure('search_text', errorMessage(error));
    }
  },
};

const showGitStatusTool: ToolDefinition<Record<string, never>> = {
  name: 'show_git_status',
  description: 'Show bounded porcelain git status for the repository. Read-only and useful before planning edits.',
  inputSchema: { type: 'object', properties: {} },
  safetyPolicy: readOnlySafety,
  ledgerBehavior: 'records-git-status',
  async execute(_input: Record<string, never>, context: ToolContext): Promise<ToolResult> {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--short'], {
        cwd: context.repoRoot,
        maxBuffer: 64 * 1024,
      });
      context.ledger.recordGitStatus();
      return success('show_git_status', {
        status: splitLines(stdout).slice(0, DEFAULT_MAX_GIT_LINES),
        truncated: splitLines(stdout).length > DEFAULT_MAX_GIT_LINES,
      });
    } catch (error) {
      return failure('show_git_status', errorMessage(error));
    }
  },
};

const showGitDiffTool: ToolDefinition<GitDiffInput> = {
  name: 'show_git_diff',
  description:
    'Show a bounded git diff for unstaged repository changes. Read-only and useful for reviewing the current patch.',
  inputSchema: {
    type: 'object',
    properties: {
      maxLines: { type: 'number', description: `Maximum diff lines to return. Default ${DEFAULT_MAX_GIT_LINES}.` },
    },
  },
  safetyPolicy: readOnlySafety,
  ledgerBehavior: 'records-git-diff',
  async execute(input: GitDiffInput, context: ToolContext): Promise<ToolResult> {
    const maxLines = boundedPositiveInteger(input.maxLines, DEFAULT_MAX_GIT_LINES, DEFAULT_MAX_GIT_LINES);
    try {
      const { stdout } = await execFileAsync('git', ['diff', '--no-ext-diff'], {
        cwd: context.repoRoot,
        maxBuffer: 256 * 1024,
      });
      const lines = splitLines(stdout);
      context.ledger.recordGitDiff();
      return success('show_git_diff', { diff: lines.slice(0, maxLines), truncated: lines.length > maxLines });
    } catch (error) {
      return failure('show_git_diff', errorMessage(error));
    }
  },
};

async function collectFiles(repoRoot: string, relativeDir: string, files: string[], maxFiles: number): Promise<void> {
  if (files.length >= maxFiles) {
    return;
  }

  const absolute = join(repoRoot, relativeDir);
  const entryStat = await stat(absolute);
  if (entryStat.isFile()) {
    if (normalizeRepoPath(repoRoot, relativeDir).ok) {
      files.push(relativeDir);
    }
    return;
  }

  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= maxFiles) {
      return;
    }

    const child = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (!normalizeRepoPath(repoRoot, child).ok) {
      continue;
    }

    if (entry.isDirectory()) {
      await collectFiles(repoRoot, child, files, maxFiles);
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
}

async function listDirectory(
  repoRoot: string,
  relativeDir: string,
): Promise<{ path: string; entries: DirectoryEntryOutput[]; truncated: boolean }> {
  const entries = await readdir(join(repoRoot, relativeDir), { withFileTypes: true });
  const safeEntries: DirectoryEntryOutput[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory() && SKIPPED_DIRECTORY_LISTING_NAMES.has(entry.name)) {
      continue;
    }

    const child = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (!normalizeRepoPath(repoRoot, child).ok) {
      continue;
    }

    if (entry.isDirectory()) {
      safeEntries.push({ name: entry.name, type: 'directory' });
    } else if (entry.isFile()) {
      safeEntries.push({ name: entry.name, type: 'file' });
    }

    if (safeEntries.length >= DEFAULT_MAX_DIRECTORY_ENTRIES) {
      return { path: relativeDir || '.', entries: safeEntries, truncated: true };
    }
  }

  return { path: relativeDir || '.', entries: safeEntries, truncated: false };
}

function boundedPositiveInteger(value: number | undefined, defaultValue: number, maxValue: number): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (!Number.isInteger(value) || value < 1) {
    return defaultValue;
  }

  return Math.min(value, maxValue);
}

function repoRootPath(value: string | undefined): string {
  return value === undefined || value.trim().length === 0 ? '.' : value;
}

function splitLines(text: string): string[] {
  const withoutFinalNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
  return withoutFinalNewline.length === 0 ? [] : withoutFinalNewline.split(/\r?\n/);
}

function success<TOutput>(toolName: string, output: TOutput): ToolResult<TOutput> {
  return { success: true, toolName, output };
}

function failure(toolName: string, error: string): ToolResult {
  return { success: false, toolName, error };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
