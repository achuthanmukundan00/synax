/**
 * Write tool handler — extracted from Session.ts.
 *
 * Handles: creating new files with path validation, existence checks,
 * size limits, and atomic writes. All filesystem ops go through ExecutionEnv.
 */

import type { WriteAction, ExecutionContext, AgentToolExecutionResult } from '../types';
import { toolFailure } from '../types';
import { normalizeRepoPath } from '../../tools/policy';
import { atomicWriteFile } from '../../agent/safety';

// ─── Public handler ───────────────────────────────────────

export async function handleWrite(action: WriteAction, context: ExecutionContext): Promise<AgentToolExecutionResult> {
  const toolName = 'write';

  const target = normalizeRepoPath(context.repoRoot, action.path);
  if (!target.ok || !target.absolutePath || target.path === undefined) {
    return toolFailure(toolName, target.reason ?? 'invalid path');
  }
  if (context.env.fileExists(target.absolutePath)) {
    return toolFailure(toolName, `file already exists: ${target.path}`);
  }

  if (Buffer.byteLength(action.content, 'utf-8') > 16 * 1024) {
    return toolFailure(toolName, 'create_file content is too large; write a smaller text file');
  }

  await context.ensureCheckpoint?.();
  await atomicWriteFile(target.absolutePath, action.content, context.env);
  const written = await context.env.readFile(target.absolutePath);
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
