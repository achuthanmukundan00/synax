/**
 * Tool definitions — model-facing tool schemas and the Synax system prompt.
 *
 * Extracted from Session.ts. These are pure data — no state, no side effects.
 */

import { type ToolDefinition } from '../tools/types';
import { getAllowedModelTools } from '../agent/task-policy';
import type { ModelToolSurfaceOptions } from './types';

// ─── Model-facing tool definitions ───────────────────────────────────────────

export function buildModelFacingTools(options: ModelToolSurfaceOptions = {}): ToolDefinition[] {
  const bashEnabled = options.bashEnabled ?? true;
  const allowedNames = getAllowedModelTools(options.mode ?? 'patch', bashEnabled);
  const tools: ToolDefinition[] = [
    {
      name: 'read',
      description:
        'Inspect repository files. ALWAYS use startLine/endLine (50-200 line ranges preferred). Omit path to list files. Pass query to search text.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Optional repo-relative file or directory path.',
          },
          startLine: {
            type: 'number',
            description: '1-based first line. ALWAYS set this for file reads — never read entire large files.',
          },
          endLine: {
            type: 'number',
            description: '1-based final line. Set with startLine for a 50-200 line window.',
          },
          query: {
            type: 'string',
            description: 'Literal text to search for.',
          },
          maxFiles: {
            type: 'number',
            description: 'Maximum listed files.',
          },
          maxMatches: {
            type: 'number',
            description: 'Maximum search matches.',
          },
        },
        additionalProperties: false,
      },
      safetyPolicy: {
        readOnly: true,
        rejectsUnsafePaths: true,
        boundedOutput: true,
      },
      ledgerBehavior: 'records-file-range',
      async execute() {
        return {
          success: false,
          toolName: 'read',
          error: 'handled by the agent runner',
        };
      },
    },
    {
      name: 'write',
      description: 'Create one new repo-local text file. Fails if the file already exists.',
      inputSchema: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: {
            type: 'string',
            description: 'Repo-relative path for the new file.',
          },
          content: {
            type: 'string',
            description: 'Full file content to write.',
          },
        },
        additionalProperties: false,
      },
      safetyPolicy: {
        readOnly: false,
        rejectsUnsafePaths: true,
        boundedOutput: true,
      },
      ledgerBehavior: 'none',
      async execute() {
        return {
          success: false,
          toolName: 'write',
          error: 'handled by the agent runner',
        };
      },
    },
    {
      name: 'edit',
      description:
        'Replace exactly one string in one repo-local file. The target file must already have been read. oldStr must match exactly once.',
      inputSchema: {
        type: 'object',
        required: ['path', 'oldStr', 'newStr'],
        properties: {
          path: { type: 'string', description: 'Repo-relative file path.' },
          oldStr: {
            type: 'string',
            description: 'Exact text copied from a prior file read.',
          },
          newStr: { type: 'string', description: 'Replacement text.' },
        },
        additionalProperties: false,
      },
      safetyPolicy: {
        readOnly: false,
        rejectsUnsafePaths: true,
        boundedOutput: true,
      },
      ledgerBehavior: 'none',
      async execute() {
        return {
          success: false,
          toolName: 'edit',
          error: 'handled by the agent runner',
        };
      },
    },
  ];

  if (bashEnabled) {
    tools.push({
      name: 'bash',
      description: 'Execute a shell command in the repository root. Use for git workflows and verification commands.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to run when enabled.',
          },
        },
        additionalProperties: false,
      },
      safetyPolicy: {
        readOnly: false,
        rejectsUnsafePaths: true,
        boundedOutput: true,
      },
      ledgerBehavior: 'none',
      async execute() {
        return {
          success: false,
          toolName: 'bash',
          error: 'handled by the agent runner',
        };
      },
    });
  }

  // search_memory: always available (read-only, no fs access)
  tools.push({
    name: 'search_memory',
    description:
      'Search conversation history for past actions, errors, file changes, and context. ' +
      'Use this to recall what you did in earlier turns instead of re-reading files.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'Search query. Uses FTS5 with stemming — "error login" matches "errors" and "logging".',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum results to return (1-20, default 10).',
        },
      },
      additionalProperties: false,
    },
    safetyPolicy: {
      readOnly: true,
      rejectsUnsafePaths: false,
      boundedOutput: true,
    },
    ledgerBehavior: 'none',
    async execute() {
      return {
        success: false,
        toolName: 'search_memory',
        error: 'handled by the agent runner',
      };
    },
  });

  return tools.filter((tool) => allowedNames.includes(tool.name));
}

// ─── System prompt ───────────────────────────────────────────────────────────

/** The canonical Synax system prompt. Exported for reuse by delegation layers. */
export function systemPrompt(): string {
  return [
    'You are Synax, a disciplined local coding agent.',
    'Tools: read, write, edit, bash, search_memory.',
    'Use bash for terminal commands, including git and verification.',
    'Use read for local file inspection: list files, search text, or read bounded line ranges.',
    'Use write for new text files and edit for exact replacements in files you have already read.',
    'Use search_memory to recall past tool outputs, errors, file changes, and findings from earlier turns in this session. Memory is stored automatically — you do not need to save anything yourself.',
    'If search_memory returns nothing, the session is fresh and there is no history yet; proceed from scratch.',
    'Keep working until the task is done, then stop and summarize.',
    'Be concise. Show file paths clearly when working with files.',
    'When calling a tool, emit only tool calls. Do not mix final-answer prose with tool calls.',
  ].join('\n');
}
