import { execFile } from 'child_process';
import { readdir, readFile, stat } from 'fs/promises';
import { isAbsolute, normalize, resolve } from 'path';
import { promisify } from 'util';

import { ToolContext, ToolDefinition, ToolResult } from './types';

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_FILES = 300;
const DEFAULT_MAX_READ_LINES = 1000;
const DEFAULT_MAX_MATCHES = 80;
const DEFAULT_MAX_GIT_LINES = 1000;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 160;

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

interface ReadTarget {
  path: string;
  absolutePath: string;
}

type ReadTargetResult = ({ ok: true } & ReadTarget) | { ok: false; reason: string };

export function createInspectionTools(): ToolDefinition[] {
  return [listFilesTool, readFileRangeTool, searchTextTool, showGitStatusTool, showGitDiffTool];
}

const readOnlySafety = {
  readOnly: true,
  rejectsUnsafePaths: false,
  boundedOutput: true,
};

const listFilesTool: ToolDefinition<ListFilesInput> = {
  name: 'list_files',
  description: 'List files under an optional path. Output is bounded, but read paths are not policy-filtered.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Optional directory or file path to list. Defaults to repository root.' },
      maxFiles: { type: 'number', description: `Maximum files to return. Default ${DEFAULT_MAX_FILES}.` },
    },
  },
  safetyPolicy: readOnlySafety,
  ledgerBehavior: 'records-file-list',
  async execute(input: ListFilesInput, context: ToolContext): Promise<ToolResult> {
    const maxFiles = boundedPositiveInteger(input.maxFiles, DEFAULT_MAX_FILES, DEFAULT_MAX_FILES);
    const target = resolveReadTarget(context.repoRoot, repoRootPath(input.path));
    if (!target.ok) {
      return failure('list_files', target.reason);
    }

    try {
      const files: string[] = [];
      await collectFiles(target.absolutePath, target.path, files, maxFiles);
      files.sort();
      return success('list_files', { files, truncated: files.length >= maxFiles });
    } catch (error) {
      return failure('list_files', errorMessage(error));
    }
  },
};

const readFileRangeTool: ToolDefinition<ReadFileRangeInput> = {
  name: 'read_file_range',
  description: 'Read a bounded, line-numbered range from one text file. Use this before proposing edits to that file.',
  inputSchema: {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'File path to read.' },
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

    const target = resolveReadTarget(context.repoRoot, input.path);
    if (!target.ok) {
      return failure('read_file_range', target.reason);
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
        return success('read_file_range', await listDirectory(target.absolutePath, target.path));
      }

      const text = await readFile(target.absolutePath, 'utf-8');
      const lines = splitLines(text);
      const selected = lines.slice(startLine - 1, endLine).map<LineOutput>((line, index) => ({
        lineNumber: startLine + index,
        text: line,
      }));
      const actualEndLine = selected.length > 0 ? selected[selected.length - 1].lineNumber : startLine;
      const joined = selected.map((line) => line.text).join('\n');
      context.ledger.recordFileRead(target.path, startLine, actualEndLine, joined);
      for (const line of selected) {
        context.ledger.recordFileRead(target.path, line.lineNumber, line.lineNumber, line.text);
      }

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
  description: 'Search text files for a literal string. Output is bounded, but read paths are not policy-filtered.',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Literal text to search for.' },
      path: { type: 'string', description: 'Optional directory or file path to search.' },
      maxMatches: { type: 'number', description: `Maximum matches to return. Default ${DEFAULT_MAX_MATCHES}.` },
    },
  },
  safetyPolicy: readOnlySafety,
  ledgerBehavior: 'records-search-results',
  async execute(input: SearchTextInput, context: ToolContext): Promise<ToolResult> {
    if (!input.query) {
      return failure('search_text', 'query is required');
    }

    const target = resolveReadTarget(context.repoRoot, repoRootPath(input.path));
    if (!target.ok) {
      return failure('search_text', target.reason);
    }

    const maxMatches = boundedPositiveInteger(input.maxMatches, DEFAULT_MAX_MATCHES, DEFAULT_MAX_MATCHES);
    const files: string[] = [];
    const matches: SearchMatchOutput[] = [];

    try {
      await collectFiles(target.absolutePath, target.path, files, DEFAULT_MAX_FILES);
      files.sort();
      for (const file of files) {
        const text = await readFile(resolveDisplayPath(target.absolutePath, target.path, file), 'utf-8');
        const lines = splitLines(text);
        for (let index = 0; index < lines.length; index += 1) {
          if (!lines[index].includes(input.query)) {
            continue;
          }

          const lineNumber = index + 1;
          matches.push({ path: file, lineNumber, line: lines[index] });
          context.ledger.recordFileRead(file, lineNumber, lineNumber, lines[index]);
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

async function collectFiles(
  absolutePath: string,
  displayPath: string,
  files: string[],
  maxFiles: number,
): Promise<void> {
  if (files.length >= maxFiles) {
    return;
  }

  const entryStat = await stat(absolutePath);
  if (entryStat.isFile()) {
    files.push(displayPath);
    return;
  }

  const entries = await readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= maxFiles) {
      return;
    }

    const childDisplayPath = displayPath ? `${displayPath}/${entry.name}` : entry.name;
    const childAbsolutePath = resolve(absolutePath, entry.name);

    if (entry.isDirectory()) {
      await collectFiles(childAbsolutePath, childDisplayPath, files, maxFiles);
    } else if (entry.isFile()) {
      files.push(childDisplayPath);
    }
  }
}

async function listDirectory(
  absolutePath: string,
  displayPath: string,
): Promise<{ path: string; entries: DirectoryEntryOutput[]; truncated: boolean }> {
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const directoryEntries: DirectoryEntryOutput[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory()) {
      directoryEntries.push({ name: entry.name, type: 'directory' });
    } else if (entry.isFile()) {
      directoryEntries.push({ name: entry.name, type: 'file' });
    }

    if (directoryEntries.length >= DEFAULT_MAX_DIRECTORY_ENTRIES) {
      return { path: displayPath || '.', entries: directoryEntries, truncated: true };
    }
  }

  return { path: displayPath || '.', entries: directoryEntries, truncated: false };
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

function resolveReadTarget(repoRoot: string, inputPath: string): ReadTargetResult {
  const trimmed = inputPath.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'path is required' };
  }

  const normalized = normalize(trimmed).replace(/\\/g, '/');
  return {
    ok: true,
    path: normalized === '.' ? '' : normalized,
    absolutePath: isAbsolute(trimmed) ? resolve(trimmed) : resolve(repoRoot, trimmed),
  };
}

function resolveDisplayPath(rootAbsolutePath: string, rootDisplayPath: string, fileDisplayPath: string): string {
  if (fileDisplayPath === rootDisplayPath) {
    return rootAbsolutePath;
  }

  const relativeToRoot =
    rootDisplayPath && fileDisplayPath.startsWith(`${rootDisplayPath}/`)
      ? fileDisplayPath.slice(rootDisplayPath.length + 1)
      : fileDisplayPath;
  return resolve(rootAbsolutePath, relativeToRoot);
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
