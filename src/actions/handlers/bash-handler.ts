/**
 * Bash tool handler — extracted from Session.ts.
 *
 * Handles: bash execution with command planning and repetition detection.
 * All filesystem/process operations go through ExecutionEnv.
 */

import { resolve, isAbsolute } from 'path';

import type { BashAction, ExecutionContext, AgentToolExecutionResult } from '../types';
import { toolFailure } from '../types';
import type { ExecutionEnv, ExecResult } from '../../env/ExecutionEnv';

// ─── Public handler ───────────────────────────────────────

export async function handleBash(action: BashAction, context: ExecutionContext): Promise<AgentToolExecutionResult> {
  const command = action.command?.trim();
  if (!command) {
    return toolFailure('bash', 'command is required');
  }

  const plan = planBashCommand(command, context.repoRoot, context.env);

  const result: ExecResult = await context.env.execCommand(plan.command, context.repoRoot);

  return {
    success: result.exitCode === 0,
    error: result.exitCode !== 0 ? result.stderr || `exit code ${result.exitCode}` : undefined,
    toolResult: {
      success: result.exitCode === 0,
      toolName: 'bash',
      error: result.exitCode !== 0 ? result.stderr || `exit code ${result.exitCode}` : undefined,
      output: {
        command: plan.command,
        ...(plan.originalCommand !== plan.command ? { originalCommand: plan.originalCommand } : {}),
        ...(plan.cwdRecovery ? { cwdRecovery: plan.cwdRecovery } : {}),
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
    },
  };
}

// ─── Command planning ─────────────────────────────────────

interface BashCommandPlan {
  command: string;
  originalCommand: string;
  cwdRecovery?: string;
}

function planBashCommand(command: string, repoRoot: string, env: ExecutionEnv): BashCommandPlan {
  const parsed = parseLeadingAbsoluteCd(command);
  if (!parsed || !parsed.rest.trim()) return { command, originalCommand: command };

  const root = resolve(repoRoot);
  const target = resolve(parsed.target);
  if (!isAbsolute(parsed.target)) return { command, originalCommand: command };

  if (!env.fileExists(target)) {
    return {
      command: parsed.rest.trim(),
      originalCommand: command,
      cwdRecovery: `stale leading cd target did not exist: ${target}; running command body from ${root}`,
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

/**
 * Normalize a shell command for repetition detection.
 */
export function normalizeShellCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}
