import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { promisify } from 'util';

import { normalizeRepoPath } from '../tools/policy';
import type { ExecutionEnv } from '../env/ExecutionEnv';

const execFileAsync = promisify(execFile);

export interface SafetyCheckpoint {
  id: string;
  createdAt: string;
  statusPath: string;
  diffPath: string;
}

export interface RunLogRecord {
  task: string;
  mode?: string;
  terminalState: string;
  changedFiles: string[];
  filesRead?: string[];
  checkpointId?: string;
  verification: string;
  error?: string;
}

export interface LastEditRecord {
  path: string;
  before: string;
  after: string;
  timestamp: string;
}

export async function detectDirtyTree(repoRoot: string): Promise<{ dirty: boolean; summary: string[] }> {
  try {
    const { stdout: topLevel } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    if (normalizePath(topLevel.trim()) !== normalizePath(repoRoot)) {
      return { dirty: false, summary: [] };
    }
    const { stdout } = await execFileAsync('git', ['status', '--short'], { cwd: repoRoot, maxBuffer: 128 * 1024 });
    const lines = splitLines(stdout);
    return { dirty: lines.length > 0, summary: lines.slice(0, 40) };
  } catch {
    return { dirty: false, summary: [] };
  }
}

export async function createSafetyCheckpoint(repoRoot: string): Promise<SafetyCheckpoint | null> {
  const now = new Date();
  const id = now.toISOString().replace(/[:.]/g, '-');
  const dir = join(repoRoot, '.synax', 'checkpoints');
  await mkdir(dir, { recursive: true });
  const statusPath = join(dir, `${id}.status.txt`);
  const diffPath = join(dir, `${id}.diff.patch`);
  try {
    const { stdout: topLevel } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    if (normalizePath(topLevel.trim()) !== normalizePath(repoRoot)) return null;
    const [{ stdout: status }, { stdout: diff }] = await Promise.all([
      execFileAsync('git', ['status', '--short'], { cwd: repoRoot, maxBuffer: 128 * 1024 }),
      execFileAsync('git', ['diff', '--no-ext-diff'], { cwd: repoRoot, maxBuffer: 1024 * 1024 }),
    ]);
    await atomicWriteFile(statusPath, status);
    await atomicWriteFile(diffPath, diff);
    return { id, createdAt: now.toISOString(), statusPath, diffPath };
  } catch {
    return null;
  }
}

export async function writeRunLog(repoRoot: string, record: RunLogRecord): Promise<string> {
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(repoRoot, '.synax', 'runs');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  await atomicWriteFile(path, `${JSON.stringify({ ...record, createdAt: new Date().toISOString() }, null, 2)}\n`);
  return path;
}

export async function writeLastEditRecord(repoRoot: string, record: LastEditRecord, env?: ExecutionEnv): Promise<void> {
  const dir = join(repoRoot, '.synax');
  if (env) {
    await env.makeDir(dir);
    await env.writeFile(join(dir, 'last-edit.json'), `${JSON.stringify(record, null, 2)}\n`);
  } else {
    await mkdir(dir, { recursive: true });
    await atomicWriteFile(join(dir, 'last-edit.json'), `${JSON.stringify(record, null, 2)}\n`);
  }
}

export async function undoLastEdit(repoRoot: string): Promise<{ ok: boolean; message: string; path?: string }> {
  const recordPath = join(repoRoot, '.synax', 'last-edit.json');
  try {
    const raw = await readFile(recordPath, 'utf-8');
    const parsed = JSON.parse(raw) as LastEditRecord;
    const target = normalizeRepoPath(repoRoot, parsed.path);
    if (!target.ok || !target.absolutePath || target.path === undefined) {
      return { ok: false, message: `cannot undo ${parsed.path}: ${target.reason ?? 'invalid path'}` };
    }
    const fileStat = await stat(target.absolutePath);
    if (!fileStat.isFile()) return { ok: false, message: `not a file: ${parsed.path}` };
    const current = await readFile(target.absolutePath, 'utf-8');
    if (current !== parsed.after) {
      return { ok: false, message: `cannot undo ${parsed.path}: file has changed since last Synax edit` };
    }
    await atomicWriteFile(target.absolutePath, parsed.before);
    return { ok: true, message: `restored ${parsed.path}`, path: parsed.path };
  } catch {
    return { ok: false, message: 'no Synax-owned edit to undo' };
  }
}

export async function atomicWriteFile(path: string, content: string, env?: ExecutionEnv): Promise<void> {
  if (env) {
    await env.makeDir(dirname(path));
    const tmpPath = `${path}.synax-tmp-${randomUUID()}`;
    await env.writeFile(tmpPath, content);
    // Use raw fs rename for atomicity — not available via ExecutionEnv yet
    await rename(tmpPath, path);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.synax-tmp-${randomUUID()}`;
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, path);
}

export async function readLatestCheckpoint(repoRoot: string): Promise<SafetyCheckpoint | null> {
  const dir = join(repoRoot, '.synax', 'checkpoints');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const checkpointFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.status.txt'))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    const latest = checkpointFiles[0];
    if (!latest) return null;
    const id = latest.replace(/\.status\.txt$/, '');
    const statusPath = join(dir, latest);
    const diffPath = join(dir, `${id}.diff.patch`);
    const statusStat = await stat(statusPath);
    const diffStat = await stat(diffPath);
    if (!statusStat.isFile() || !diffStat.isFile()) return null;
    return {
      id,
      createdAt: statusStat.mtime.toISOString(),
      statusPath,
      diffPath,
    };
  } catch {
    return null;
  }
}

function splitLines(text: string): string[] {
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed ? trimmed.split(/\r?\n/) : [];
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, '');
}
