/**
 * Write tool handler — extracted from Session.ts.
 *
 * Handles: creating new files with path validation, existence checks,
 * size limits, and atomic writes.
 */

import { existsSync } from 'fs';
import { mkdir, readFile } from 'fs/promises';
import { dirname } from 'path';

import type { WriteAction, ExecutionContext, AgentToolExecutionResult } from '../types';
import { toolFailure } from '../types';
import { normalizeRepoPath } from '../../tools/policy';
import { canMutatePath } from '../../agent/task-policy';
import { atomicWriteFile } from '../../agent/safety';

// ─── Public handler ───────────────────────────────────────

export async function handleWrite(action: WriteAction, context: ExecutionContext): Promise<AgentToolExecutionResult> {
  const toolName = 'write';

  if (context.mode === 'read-only' || context.mode === 'verify') {
    return toolFailure(toolName, `${context.mode} mode does not allow writes`);
  }

  const target = normalizeRepoPath(context.repoRoot, action.path);
  if (!target.ok || !target.absolutePath || target.path === undefined) {
    return toolFailure(toolName, target.reason ?? 'invalid path');
  }
  const mutationPath = canMutatePath(context.mode, context.repoRoot, target.path);
  if (!mutationPath.ok) {
    return toolFailure(toolName, mutationPath.reason ?? 'mutation path rejected');
  }
  if (existsSync(target.absolutePath)) {
    return toolFailure(toolName, `file already exists: ${target.path}`);
  }

  if (Buffer.byteLength(action.content, 'utf-8') > 16 * 1024) {
    return toolFailure(toolName, 'create_file content is too large; write a smaller text file');
  }

  await context.ensureCheckpoint?.();
  await mkdir(dirname(target.absolutePath), { recursive: true });
  await atomicWriteFile(target.absolutePath, action.content);
  const written = await readFile(target.absolutePath, 'utf-8');
  return {
    success: true,
    changedFile: target.path,
    toolResult: {
      success: true,
      toolName,
      output: {
        path: target.path,
        bytes: Buffer.byteLength(written, 'utf-8'),
      },
    },
  };
}
