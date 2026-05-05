import { execFile } from 'child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface SafetyCheckpoint {
  id: string;
  createdAt: string;
  statusPath: string;
  diffPath: string;
}

export interface RunLogRecord {
  task: string;
  terminalState: string;
  changedFiles: string[];
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
    await writeFile(statusPath, status, 'utf-8');
    await writeFile(diffPath, diff, 'utf-8');
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
  await writeFile(path, `${JSON.stringify({ ...record, createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf-8');
  return path;
}

export async function writeLastEditRecord(repoRoot: string, record: LastEditRecord): Promise<void> {
  const dir = join(repoRoot, '.synax');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'last-edit.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
}

export async function undoLastEdit(repoRoot: string): Promise<{ ok: boolean; message: string; path?: string }> {
  const recordPath = join(repoRoot, '.synax', 'last-edit.json');
  try {
    const raw = await readFile(recordPath, 'utf-8');
    const parsed = JSON.parse(raw) as LastEditRecord;
    const target = join(repoRoot, parsed.path);
    const fileStat = await stat(target);
    if (!fileStat.isFile()) return { ok: false, message: `not a file: ${parsed.path}` };
    const current = await readFile(target, 'utf-8');
    if (current !== parsed.after) {
      return { ok: false, message: `cannot undo ${parsed.path}: file has changed since last Synax edit` };
    }
    await atomicWriteFile(target, parsed.before);
    return { ok: true, message: `restored ${parsed.path}`, path: parsed.path };
  } catch {
    return { ok: false, message: 'no Synax-owned edit to undo' };
  }
}

export async function atomicWriteFile(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.synax-tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, path);
}

function splitLines(text: string): string[] {
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed ? trimmed.split(/\r?\n/) : [];
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, '');
}
