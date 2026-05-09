/**
 * Edit tool handler — extracted from Session.ts.
 *
 * Handles: exact string replacements in files that have already been read.
 * Includes patch validation, preview, approval, and application.
 */

import type { EditAction, ExecutionContext, AgentToolExecutionResult } from '../types';
import { toolFailure } from '../types';
import { canMutatePath } from '../../agent/task-policy';
import type { ReplaceInFilePatch } from '../../agent/patch';
import { applyReplaceInFile, createPatchPreview, validateReplaceInFile } from '../../agent/patch';
import { writeLastEditRecord } from '../../agent/safety';

// ─── Public handler ───────────────────────────────────────

export async function handleEdit(action: EditAction, context: ExecutionContext): Promise<AgentToolExecutionResult> {
  const toolName = 'edit';

  if (context.mode === 'read-only' || context.mode === 'verify') {
    return toolFailure(toolName, `${context.mode} mode does not allow edits`);
  }

  const mutationPath = canMutatePath(context.mode, context.repoRoot, action.path);
  if (!mutationPath.ok) {
    return toolFailure(toolName, mutationPath.reason ?? 'mutation path rejected');
  }

  await context.ensureCheckpoint?.();

  const validation = await validateReplaceInFile(
    { path: action.path, oldStr: action.oldStr, newStr: action.newStr },
    { repoRoot: context.repoRoot },
  );
  if (!validation.ok) {
    return toolFailure(toolName, validation.message);
  }

  const preview = createPatchPreview(validation);
  context.onPatchPreview?.(preview);
  const decision = context.approvePatch ? await context.approvePatch(preview) : 'accept';
  if (decision === 'reject') {
    const error = `patch rejected for ${preview.path}`;
    return {
      success: false,
      error,
      terminalState: 'user_input_required',
      toolResult: {
        success: false,
        toolName,
        error,
        output: { path: preview.path, diff: preview.diff, decision },
      },
    };
  }

  const applied = await applyReplaceInFile(
    { path: action.path, oldStr: action.oldStr, newStr: action.newStr },
    { repoRoot: context.repoRoot },
  );
  if (!applied.ok) {
    return toolFailure(toolName, applied.message);
  }
  await writeLastEditRecord(
    context.repoRoot,
    {
      path: applied.path,
      before: applied.before,
      after: applied.after,
      timestamp: new Date().toISOString(),
    },
    context.env,
  );

  return {
    success: true,
    changedFile: applied.path,
    toolResult: {
      success: true,
      toolName,
      output: {
        path: applied.path,
        diff: preview.diff,
      },
    },
  };
}

/**
 * Convert raw tool-call arguments to an EditAction, validating required fields.
 * Returns null if arguments are invalid.
 */
export function coerceEditAction(args: Record<string, unknown>): EditAction | null {
  if (typeof args.path !== 'string' || typeof args.oldStr !== 'string' || typeof args.newStr !== 'string') {
    return null;
  }
  return {
    kind: 'edit',
    path: args.path,
    oldStr: args.oldStr,
    newStr: args.newStr,
  };
}

/** @deprecated kept for backward compat — use coerceEditAction instead. */
export function coercePatch(input: Record<string, unknown>): ReplaceInFilePatch | null {
  if (typeof input.path !== 'string' || typeof input.oldStr !== 'string' || typeof input.newStr !== 'string') {
    return null;
  }
  return {
    path: input.path,
    oldStr: input.oldStr,
    newStr: input.newStr,
  };
}
