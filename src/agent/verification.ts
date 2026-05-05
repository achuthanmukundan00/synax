import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_OUTPUT_CHARS = 4000;

export type VerificationState = 'passed' | 'failed' | 'skipped';

export interface VerificationOptions {
  repoRoot: string;
  command?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface VerificationResult {
  state: VerificationState;
  command?: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
  failureState?: 'verification-failure';
}

export async function runVerification(options: VerificationOptions): Promise<VerificationResult> {
  const command = options.command?.trim();
  if (!command) {
    return { state: 'skipped', stdout: '', stderr: '' };
  }

  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  try {
    const result = await execAsync(command, {
      cwd: options.repoRoot,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return {
      state: 'passed',
      command,
      exitCode: 0,
      stdout: truncate(result.stdout, maxOutputChars),
      stderr: truncate(result.stderr, maxOutputChars),
    };
  } catch (error) {
    const err = error as Error & { code?: number; stdout?: string; stderr?: string; signal?: string };
    return {
      state: 'failed',
      command,
      exitCode: typeof err.code === 'number' ? err.code : undefined,
      stdout: truncate(err.stdout ?? '', maxOutputChars),
      stderr: truncate(err.stderr ?? err.message, maxOutputChars),
      failureState: 'verification-failure',
    };
  }
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}
