/**
 * NodeExecutionEnv — default ExecutionEnv backed by Node.js fs and child_process.
 *
 * Wraps fs.promises and child_process.execFile for the agent runtime.
 * This is the production implementation; tests can swap in a mock env.
 */

import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dirname } from 'path';

import type { ExecutionEnv, ExecResult, ExecOptions } from './ExecutionEnv';

const execFileAsync = promisify(execFile);

export class NodeExecutionEnv implements ExecutionEnv {
  fileExists(path: string): boolean {
    return existsSync(path);
  }

  async readFile(path: string): Promise<string> {
    return readFile(path, 'utf-8');
  }

  async writeFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf-8');
  }

  async makeDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async execCommand(command: string, cwd: string, opts?: ExecOptions): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileAsync('/bin/bash', ['-lc', command], {
        cwd,
        maxBuffer: opts?.maxBuffer ?? 256 * 1024,
        timeout: opts?.timeout ?? 30_000,
      });
      return {
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        exitCode: 0,
      };
    } catch (error) {
      const e = error as { stdout?: string | Buffer; stderr?: string | Buffer; code?: number };
      return {
        stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf-8') ?? ''),
        stderr: typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf-8') ?? ''),
        exitCode: typeof e.code === 'number' ? e.code : 1,
      };
    }
  }
}
