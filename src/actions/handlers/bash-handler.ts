/**
 * Bash tool handler — extracted from Session.ts.
 *
 * Handles: bash execution with safety blocking, command planning,
 * dangerous pattern detection, and repetition detection.
 */

import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve, relative, isAbsolute } from 'path';

import type { BashAction, ExecutionContext, AgentToolExecutionResult } from '../types';
import { toolFailure } from '../types';

const execFileAsync = promisify(execFile);

// ─── Public handler ───────────────────────────────────────

export async function handleBash(action: BashAction, context: ExecutionContext): Promise<AgentToolExecutionResult> {
  const command = action.command?.trim();
  if (!command) {
    return toolFailure('bash', 'command is required');
  }

  const blockReason = detectBlockedCommand(command);
  if (blockReason) {
    return toolFailure('bash', `Blocked: ${blockReason}`);
  }

  const plan = planBashCommand(command, context.repoRoot);
  const safetyWarnings = detectDangerousCommandWarnings(plan.command);

  try {
    const { stdout, stderr } = await execFileAsync('/bin/bash', ['-lc', plan.command], {
      cwd: context.repoRoot,
      maxBuffer: 256 * 1024,
      timeout: 30_000,
    });
    return {
      success: true,
      toolResult: {
        success: true,
        toolName: 'bash',
        output: {
          command: plan.command,
          ...(plan.originalCommand !== plan.command ? { originalCommand: plan.originalCommand } : {}),
          ...(plan.cwdRecovery ? { cwdRecovery: plan.cwdRecovery } : {}),
          safetyWarnings,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          exitCode: 0,
        },
      },
    };
  } catch (error) {
    const e = error as { stdout?: string | Buffer; stderr?: string | Buffer; code?: number };
    return {
      success: false,
      error: errorMessage(error),
      toolResult: {
        success: false,
        toolName: 'bash',
        error: errorMessage(error),
        output: {
          command: plan.command,
          ...(plan.originalCommand !== plan.command ? { originalCommand: plan.originalCommand } : {}),
          ...(plan.cwdRecovery ? { cwdRecovery: plan.cwdRecovery } : {}),
          safetyWarnings,
          stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf-8') ?? ''),
          stderr: typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf-8') ?? ''),
          exitCode: typeof e.code === 'number' ? e.code : 1,
        },
      },
    };
  }
}

// ─── Command planning ─────────────────────────────────────

interface BashCommandPlan {
  command: string;
  originalCommand: string;
  cwdRecovery?: string;
}

function planBashCommand(command: string, repoRoot: string): BashCommandPlan {
  const parsed = parseLeadingAbsoluteCd(command);
  if (!parsed || !parsed.rest.trim()) return { command, originalCommand: command };

  const root = resolve(repoRoot);
  const target = resolve(parsed.target);
  if (!isAbsolute(parsed.target)) return { command, originalCommand: command };

  if (!existsSync(target)) {
    return {
      command: parsed.rest.trim(),
      originalCommand: command,
      cwdRecovery: `stale leading cd target did not exist: ${target}; running command body from ${root}`,
    };
  }

  if (!isPathInside(root, target)) {
    return {
      command: parsed.rest.trim(),
      originalCommand: command,
      cwdRecovery: `stale leading cd target was outside the repository root: ${target}; running command body from ${root}`,
    };
  }

  return { command, originalCommand: command };
}

function parseLeadingAbsoluteCd(command: string): { target: string; rest: string } | null {
  const match = /^\s*cd\s+((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^;&|]+?))\s*&&\s*([\s\S]+)$/u.exec(command);
  if (!match) return null;
  return { target: unquoteShellPath(match[1].trim()), rest: match[2] };
}

function unquoteShellPath(path: string): string {
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    return path.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  }
  if (path.length >= 2 && path.startsWith("'") && path.endsWith("'")) {
    return path.slice(1, -1);
  }
  return path;
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// ─── Command safety ───────────────────────────────────────

function detectBlockedCommand(command: string): string | null {
  const normalized = command.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/\bcurl\b.*\|\s*(bash|sh)\b/.test(normalized)) return 'remote script execution via curl|bash is blocked';
  if (/\bwget\b.*\|\s*(bash|sh)\b/.test(normalized)) return 'remote script execution via wget|bash is blocked';
  if (/\brm\s+-rf\s+\/(?=[\s;|&)"']|$)/.test(normalized)) return 'destructive delete of root (rm -rf /) is blocked';
  if (/\brm\s+-rf\s+~(?=[\s;|&)"']|$)/.test(normalized)) return 'destructive delete of home (rm -rf ~) is blocked';
  if (/\bmkfs(\.| )/.test(normalized)) return 'filesystem formatting (mkfs) is blocked';
  if (/\bdd\s+if=.*\s+of=\/dev\//.test(normalized)) return 'raw block device write (dd to /dev) is blocked';
  if (/\bshutdown\b|\breboot\b|\bhalt\b/.test(normalized)) return 'system power-state command is blocked';
  return null;
}

function detectDangerousCommandWarnings(command: string): string[] {
  const normalized = command.toLowerCase().replace(/\s+/g, ' ').trim();
  const warnings: string[] = [];
  const patterns: Array<{ pattern: RegExp; warning: string }> = [
    {
      pattern: /\brm\s+-rf\s+\.(?=[\s;|&)"']|$)/,
      warning: 'destructive delete of current directory (`rm -rf .`) detected',
    },
    { pattern: /\brm\s+-rf\s+\/etc(?=[\s;|&/)"']|$)/, warning: 'system directory deletion (`rm -rf /etc`) detected' },
    { pattern: /\bchmod\s+-r\s+0{0,2}\s+\//, warning: 'broad permission reset on root detected' },
    { pattern: /\bchown\s+-r\s+.+\s+\//, warning: 'recursive ownership change on root detected' },
    { pattern: /\brm\s+-rf\s+\/usr\b/, warning: 'system directory deletion (`rm -rf /usr`) detected' },
    { pattern: /\brm\s+-rf\s+\/var\b/, warning: 'system directory deletion (`rm -rf /var`) detected' },
  ];
  for (const entry of patterns) {
    if (entry.pattern.test(normalized)) warnings.push(entry.warning);
  }
  return warnings;
}

// ─── Utilities ────────────────────────────────────────────

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Normalize a shell command for repetition detection.
 */
export function normalizeShellCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}
