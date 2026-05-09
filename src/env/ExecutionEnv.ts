/**
 * ExecutionEnv — filesystem and process abstraction boundary.
 *
 * Inspired by Pi's ExecutionEnv: the agent does not call fs/child_process
 * directly. All file and command operations go through this interface,
 * enabling testing (mock env), sandboxing (swap impl), and future
 * browser/WebContainer runtimes.
 */

// ─── Types ────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  maxBuffer?: number;
  timeout?: number;
}

// ─── Interface ────────────────────────────────────────────

export interface ExecutionEnv {
  /** Synchronous existence check. */
  fileExists(path: string): boolean;

  /** Read a text file. */
  readFile(path: string): Promise<string>;

  /** Write text content to a file (creates parent directories). */
  writeFile(path: string, content: string): Promise<void>;

  /** Create a directory and any missing parents. */
  makeDir(path: string): Promise<void>;

  /** Execute a shell command via bash -lc. Returns stdout, stderr, exit code. */
  execCommand(command: string, cwd: string, opts?: ExecOptions): Promise<ExecResult>;
}
