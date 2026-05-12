/**
 * View image tool handler.
 *
 * Handles: reading image files, base64 encoding, returning data for
 * vision-model analysis. Integrated into the ActionExecutor dispatch.
 */

import type { ViewImageAction, ExecutionContext, AgentToolExecutionResult } from '../types';
import { toolFailure } from '../types';
import { encodeImageBase64, MAX_IMAGE_SIZE_BYTES, SUPPORTED_IMAGE_EXTENSIONS } from '../../llm/image-utils';
import { normalizeRepoPath } from '../../tools/policy';

export async function handleViewImage(
  action: ViewImageAction,
  context: ExecutionContext,
): Promise<AgentToolExecutionResult> {
  const target = normalizeRepoPath(context.repoRoot, action.path);
  if (!target.ok || !target.path) {
    return toolFailure('view_image', target.reason ?? 'invalid path');
  }

  try {
    const encoded = await encodeImageBase64(target.path);

    return {
      success: true,
      toolResult: {
        success: true,
        toolName: 'view_image',
        output: {
          path: action.path,
          mimeType: encoded.mimeType,
          sizeBytes: encoded.sizeBytes,
          base64: encoded.base64,
          dataUrl: encoded.dataUrl,
          truncated: encoded.sizeBytes > 5 * 1024 * 1024, // > 5MB
          note:
            encoded.sizeBytes > 5 * 1024 * 1024
              ? 'Image over 5MB. Some vision models may downsample or reject large images.'
              : undefined,
        },
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('unsupported image format')) {
      const supported = [...SUPPORTED_IMAGE_EXTENSIONS].join(', ');
      return toolFailure('view_image', `${message}. Supported formats: ${supported}`);
    }
    if (message.includes('too large')) {
      const maxMB = (MAX_IMAGE_SIZE_BYTES / (1024 * 1024)).toFixed(0);
      return toolFailure('view_image', `${message} (max ${maxMB}MB)`);
    }
    return toolFailure('view_image', message);
  }
}
