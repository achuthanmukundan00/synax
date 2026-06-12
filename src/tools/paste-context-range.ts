/**
 * paste_context_range tool — materialize a selected range from the last user
 * message into a temp file, avoiding expensive model re-generation.
 *
 * The model emits a compact reference (anchors, lines, or byte offsets) and
 * the runtime copies the exact text directly from the already-visible context.
 *
 * Safety constraints:
 * - Only user-visible message content is selectable (lastUserMessage).
 * - Materialization and execution are separate steps — this tool only copies.
 * - Output goes to a session-scoped temp directory (/tmp/synax/paste-...).
 * - Returns sha256 so the model/user can verify subsequent commands operate
 *   on the intended text.
 */

import { createHash, randomBytes } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, normalize } from 'path';

import { ToolContext, ToolDefinition, ToolResult } from './types';

// ─── Input types ──────────────────────────────────────────

export interface PasteContextRangeInput {
  /** Source identifier. Only "last_user_message" supported in MVP. */
  source?: string;
  /** 1-based first line to extract. */
  startLine?: number;
  /** 1-based final line to extract. */
  endLine?: number;
  /** Anchor text marking the start of the range. First occurrence is used. */
  startAnchor?: string;
  /** Anchor text marking the end of the range. First occurrence after startAnchor is used. */
  endAnchor?: string;
  /** 0-based byte offset for range start. */
  startByte?: number;
  /** 0-based byte offset for range end (exclusive, like String.slice). */
  endByte?: number;
}

export interface PasteContextRangeOutput {
  /** Absolute path to the temp file containing the materialized content. */
  path: string;
  /** Source identifier used. */
  source: string;
  /** Byte offset of the start of the extracted range in the source message. */
  start: number;
  /** Byte offset of the end of the extracted range in the source message. */
  end: number;
  /** Number of bytes in the extracted content. */
  bytes: number;
  /** SHA-256 hex digest of the materialized content. */
  sha256: string;
  /** Number of lines in the materialized content. */
  lines?: number;
}

// ─── Temp directory ───────────────────────────────────────

const PASTE_ROOT = join(tmpdir(), 'synax', 'paste');
let pasteCounter = 0;

function ensurePasteRoot(): string {
  mkdirSync(PASTE_ROOT, { recursive: true });
  return PASTE_ROOT;
}

function createPasteFile(content: string): { path: string } {
  ensurePasteRoot();
  pasteCounter += 1;
  const sessionTag = randomBytes(4).toString('hex');
  const filename = `range-${pasteCounter.toString().padStart(3, '0')}-${sessionTag}.txt`;
  const filePath = join(PASTE_ROOT, filename);
  writeFileSync(filePath, content, 'utf-8');
  return { path: filePath };
}

// ─── Byte slicing ─────────────────────────────────────────

function sliceByBytes(
  source: string,
  startByte: number,
  endByte: number,
): { content: string; start: number; end: number } | { error: string } {
  const sourceBytes = Buffer.byteLength(source, 'utf-8');
  const start = Math.max(0, Math.min(startByte, sourceBytes));
  const end = Math.max(start, Math.min(endByte, sourceBytes));

  if (start === end && sourceBytes > 0) {
    return { error: `byte range [${startByte}, ${endByte}) is empty for content of ${sourceBytes} bytes` };
  }

  const buf = Buffer.from(source, 'utf-8');
  const slice = buf.subarray(start, end);
  return {
    content: slice.toString('utf-8'),
    start,
    end,
  };
}

// ─── Line slicing ─────────────────────────────────────────

function sliceByLines(
  source: string,
  startLine: number,
  endLine: number,
): { content: string; start: number; end: number } | { error: string } {
  const lines = splitLines(source);
  if (startLine < 1 || startLine > lines.length) {
    return { error: `startLine ${startLine} out of range (1-${lines.length})` };
  }
  const clampedEnd = Math.min(endLine, lines.length);
  const selectedLines = lines.slice(startLine - 1, clampedEnd);

  // Reconstruct with original line endings
  const content = selectedLines.join('\n') + (endLine > lines.length ? '' : selectedLines.length > 0 ? '\n' : '');

  // Byte offsets: find the byte position of the start of startLine
  const startByte = lines.slice(0, startLine - 1).reduce((acc, l) => acc + Buffer.byteLength(l, 'utf-8') + 1, 0);
  const endByte = startByte + Buffer.byteLength(content, 'utf-8');

  return { content, start: startByte, end: endByte };
}

// ─── Anchor slicing ───────────────────────────────────────

function sliceByAnchors(
  source: string,
  startAnchor: string,
  endAnchor: string,
): { content: string; start: number; end: number } | { error: string } {
  const sourceBuf = Buffer.from(source, 'utf-8');

  // JavaScript indexOf returns character indices, but we need byte offsets.
  // Convert the character index to a byte offset by measuring the prefix.
  const charToByteOffset = (charIdx: number): number => Buffer.byteLength(source.slice(0, charIdx), 'utf-8');

  const startCharIdx = source.indexOf(startAnchor);
  if (startCharIdx === -1) {
    return { error: `startAnchor "${truncateForError(startAnchor)}" not found in source message` };
  }

  const startByte = charToByteOffset(startCharIdx);
  const searchFromChar = startCharIdx + startAnchor.length;
  const endCharIdx = source.indexOf(endAnchor, searchFromChar);
  if (endCharIdx === -1) {
    return { error: `endAnchor "${truncateForError(endAnchor)}" not found after startAnchor in source message` };
  }

  const endByte = charToByteOffset(endCharIdx) + Buffer.byteLength(endAnchor, 'utf-8');

  const slice = sourceBuf.subarray(startByte, endByte);
  return {
    content: slice.toString('utf-8'),
    start: startByte,
    end: endByte,
  };
}

// ─── Range resolution ─────────────────────────────────────

function resolveRange(
  source: string,
  input: PasteContextRangeInput,
): { content: string; start: number; end: number } | { error: string } {
  // Anchor-based: highest priority
  if (input.startAnchor !== undefined && input.endAnchor !== undefined) {
    if (input.startAnchor.length === 0 || input.endAnchor.length === 0) {
      return { error: 'startAnchor and endAnchor must be non-empty when provided' };
    }
    return sliceByAnchors(source, input.startAnchor, input.endAnchor);
  }

  // Line-based
  if (input.startLine !== undefined && input.endLine !== undefined) {
    return sliceByLines(source, input.startLine, input.endLine);
  }

  // Byte-based
  if (input.startByte !== undefined && input.endByte !== undefined) {
    return sliceByBytes(source, input.startByte, input.endByte);
  }

  return {
    error: 'no range specified: provide (startLine, endLine), (startByte, endByte), or (startAnchor, endAnchor)',
  };
}

// ─── Tool definition ──────────────────────────────────────

export const pasteContextRangeTool: ToolDefinition<PasteContextRangeInput, PasteContextRangeOutput> = {
  name: 'paste_context_range',
  description:
    'Copy a selected range from the last user message into a temp file. ' +
    'Use anchors, line numbers, or byte offsets to select a range. ' +
    'Returns the temp file path and sha256 hash so you can verify subsequent ' +
    'commands operate on the intended content. ' +
    'This avoids expensive model re-generation of already-visible text.',
  inputSchema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description:
          'Source identifier for the message to slice. Only "last_user_message" is supported in the current version.',
        default: 'last_user_message',
      },
      startLine: {
        type: 'number',
        description: '1-based first line to extract from the source message.',
      },
      endLine: {
        type: 'number',
        description: '1-based final line to extract from the source message.',
      },
      startAnchor: {
        type: 'string',
        description:
          'Literal text marking the start of the range (e.g. "```bash"). The first occurrence is used. Include this text in the output.',
      },
      endAnchor: {
        type: 'string',
        description:
          'Literal text marking the end of the range (e.g. "```"). The first occurrence after startAnchor is used. Include this text in the output.',
      },
      startByte: {
        type: 'number',
        description: '0-based byte offset for the range start.',
      },
      endByte: {
        type: 'number',
        description: '0-based byte offset for the range end (exclusive).',
      },
    },
    additionalProperties: false,
  },
  safetyPolicy: {
    readOnly: true,
    rejectsUnsafePaths: true,
    boundedOutput: true,
  },
  ledgerBehavior: 'records-pasted-range',
  async execute(input: PasteContextRangeInput, context: ToolContext): Promise<ToolResult<PasteContextRangeOutput>> {
    // Resolve source
    const sourceKind = input.source ?? 'last_user_message';
    if (sourceKind !== 'last_user_message') {
      return {
        success: false,
        toolName: 'paste_context_range',
        error: `unsupported source: "${sourceKind}". Only "last_user_message" is supported in this version.`,
      };
    }

    const sourceText = context.lastUserMessage;
    if (sourceText === undefined || sourceText === null) {
      return {
        success: false,
        toolName: 'paste_context_range',
        error:
          'last_user_message is not available. The session has not provided user message content to the tool context.',
      };
    }

    if (sourceText.length === 0) {
      return {
        success: false,
        toolName: 'paste_context_range',
        error: 'last_user_message is empty',
      };
    }

    // Resolve range
    const resolved = resolveRange(sourceText, input);
    if ('error' in resolved) {
      return {
        success: false,
        toolName: 'paste_context_range',
        error: resolved.error,
      };
    }

    const { content, start, end } = resolved;

    if (content.length === 0) {
      return {
        success: false,
        toolName: 'paste_context_range',
        error: `selected range [${start}, ${end}) is empty`,
      };
    }

    // Materialize to temp file
    const { path } = createPasteFile(content);

    // Compute sha256
    const sha256 = createHash('sha256').update(content, 'utf-8').digest('hex');

    // Record in ledger for visibility
    context.ledger.recordFileRead(`paste:${path}`, 1, splitLines(content).length, content);

    return {
      success: true,
      toolName: 'paste_context_range',
      output: {
        path: normalize(path),
        source: sourceKind,
        start,
        end,
        bytes: Buffer.byteLength(content, 'utf-8'),
        sha256,
        lines: splitLines(content).length,
      },
    };
  },
};

// ─── Helpers ──────────────────────────────────────────────

function splitLines(text: string): string[] {
  const withoutFinalNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
  return withoutFinalNewline.length === 0 ? [] : withoutFinalNewline.split(/\r?\n/);
}

function truncateForError(text: string, maxLen = 40): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen) + '…';
}
