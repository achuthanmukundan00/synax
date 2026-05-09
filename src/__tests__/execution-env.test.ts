/**
 * Tests for the ExecutionEnv abstraction.
 *
 * Verifies that NodeExecutionEnv works correctly and that a mock
 * ExecutionEnv can be swapped in for testing purposes.
 */

import { NodeExecutionEnv } from '../env/NodeExecutionEnv';
import type { ExecutionEnv, ExecResult } from '../env/ExecutionEnv';

describe('NodeExecutionEnv', () => {
  let env: NodeExecutionEnv;

  beforeEach(() => {
    env = new NodeExecutionEnv();
  });

  test('fileExists returns true for existing files', () => {
    expect(env.fileExists(__filename)).toBe(true);
  });

  test('fileExists returns false for nonexistent files', () => {
    expect(env.fileExists('/nonexistent/path/12345.test')).toBe(false);
  });

  test('readFile reads file contents', async () => {
    const content = await env.readFile(__filename);
    expect(content).toContain('NodeExecutionEnv');
  });

  test('makeDir creates a directory', async () => {
    const tmpDir = `/tmp/synax-env-test-${Date.now()}`;
    try {
      await env.makeDir(tmpDir);
      expect(env.fileExists(tmpDir)).toBe(true);
    } finally {
      // Cleanup — NodeExecutionEnv doesn't have a removeDir, so we skip
    }
  });

  test('writeFile creates file with content', async () => {
    const tmpPath = `/tmp/synax-env-write-${Date.now()}.txt`;
    try {
      await env.writeFile(tmpPath, 'hello world');
      expect(env.fileExists(tmpPath)).toBe(true);
      const content = await env.readFile(tmpPath);
      expect(content).toBe('hello world');
    } finally {
      // best-effort cleanup
      try {
        const { unlink } = require('fs/promises');
        await unlink(tmpPath);
      } catch {
        /* ignore */
      }
    }
  });
});

describe('Mock ExecutionEnv', () => {
  /** In-memory mock for testing without touching the real filesystem. */
  function createMockEnv(): ExecutionEnv {
    const files = new Map<string, string>();

    return {
      fileExists(path: string): boolean {
        return files.has(path);
      },

      async readFile(path: string): Promise<string> {
        const content = files.get(path);
        if (content === undefined) {
          const err = new Error(`ENOENT: ${path}`);
          (err as NodeJS.ErrnoException).code = 'ENOENT';
          throw err;
        }
        return content;
      },

      async writeFile(path: string, content: string): Promise<void> {
        files.set(path, content);
      },

      async makeDir(_path: string): Promise<void> {
        // no-op in mock
      },

      async execCommand(command: string, _cwd: string): Promise<ExecResult> {
        if (command.includes('fail')) {
          return { stdout: '', stderr: 'command failed', exitCode: 1 };
        }
        return { stdout: 'mock output', stderr: '', exitCode: 0 };
      },
    };
  }

  test('can write and read files', async () => {
    const env = createMockEnv();
    expect(env.fileExists('/test.txt')).toBe(false);
    await env.writeFile('/test.txt', 'hello');
    expect(env.fileExists('/test.txt')).toBe(true);
    const content = await env.readFile('/test.txt');
    expect(content).toBe('hello');
  });

  test('readFile throws ENOENT for missing files', async () => {
    const env = createMockEnv();
    await expect(env.readFile('/missing.txt')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  test('execCommand returns mock output', async () => {
    const env = createMockEnv();
    const result = await env.execCommand('echo hello', '/tmp');
    expect(result.stdout).toBe('mock output');
    expect(result.exitCode).toBe(0);
  });

  test('execCommand returns failure for commands containing "fail"', async () => {
    const env = createMockEnv();
    const result = await env.execCommand('npm run fail', '/tmp');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('command failed');
  });

  test('mock env is isolated between instances', async () => {
    const env1 = createMockEnv();
    const env2 = createMockEnv();
    await env1.writeFile('/a.txt', 'one');
    expect(env1.fileExists('/a.txt')).toBe(true);
    expect(env2.fileExists('/a.txt')).toBe(false);
  });
});
