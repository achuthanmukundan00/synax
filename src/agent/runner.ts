import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';

import { type ChatOptions, type ChatResponse } from '../llm/types';
import { type ParsedToolCall } from '../llm/tool-calls';
import { createInspectionLedger, createToolRegistry, type InspectionLedger } from '../tools';
import { normalizeRepoPath } from '../tools/policy';
import { type ToolDefinition, type ToolRegistry, type ToolResult } from '../tools/types';
import { applyReplaceInFile, createUnifiedDiff, validateReplaceInFile, type ReplaceInFilePatch } from './patch';

export type AgentTerminalState =
  | 'completed'
  | 'failedValidation'
  | 'failedTests'
  | 'modelError'
  | 'budgetExhausted'
  | 'toolError'
  | 'failedVerification';

export interface AgentMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: unknown;
}

export interface AgentClient {
  chat(options: ChatOptions): Promise<ChatResponse>;
}

export interface AgentConversation {
  messages: AgentMessage[];
  inspectionLedger: InspectionLedger;
}

export interface AgentRunnerOptions {
  repoRoot: string;
  client: AgentClient;
  maxSteps?: number;
  maxToolCalls?: number;
  conversation?: AgentConversation;
  registry?: ToolRegistry;
  onActivity?: (activity: AgentActivity) => void;
}

export interface AgentActivity {
  kind: 'model' | 'tool';
  message: string;
}

export interface AgentTurnResult {
  terminalState: AgentTerminalState;
  finalAnswer: string;
  steps: number;
  toolCalls: Array<{ name: string; success: boolean; error?: string }>;
  changedFiles: string[];
  conversation: AgentConversation;
  error?: string;
}

const DEFAULT_MAX_STEPS = 32;
const DEFAULT_MAX_TOOL_CALLS = 96;

export function createAgentConversation(): AgentConversation {
  return {
    messages: [{ role: 'system', content: systemPrompt() }],
    inspectionLedger: createInspectionLedger(),
  };
}

export function resetAgentConversation(conversation: AgentConversation): void {
  conversation.messages.splice(0, conversation.messages.length, { role: 'system', content: systemPrompt() });
  conversation.inspectionLedger = createInspectionLedger();
}

export async function runAgentTurn(options: AgentRunnerOptions & { task: string }): Promise<AgentTurnResult> {
  const conversation = options.conversation ?? createAgentConversation();
  const registry =
    options.registry ?? createToolRegistry({ repoRoot: options.repoRoot, ledger: conversation.inspectionLedger });
  const tools = [...registry.list(), replaceInFileTool(), createFileTool()];
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const changedFiles: string[] = [];
  const toolCalls: AgentTurnResult['toolCalls'] = [];

  conversation.messages.push({ role: 'user', content: options.task });

  for (let step = 1; step <= maxSteps; step += 1) {
    let response: ChatResponse;
    const isFinalStep = step === maxSteps;
    try {
      options.onActivity?.({ kind: 'model', message: `model step ${step}` });
      response = await options.client.chat({
        messages: isFinalStep ? [...conversation.messages, finalAnswerNowMessage()] : conversation.messages,
        tools,
        temperature: 0,
        maxTokens: 2048,
      });
    } catch (error) {
      const message = errorMessage(error);
      return {
        terminalState: message.toLowerCase().includes('context budget') ? 'budgetExhausted' : 'modelError',
        finalAnswer: '',
        steps: step,
        toolCalls,
        changedFiles,
        conversation,
        error: message,
      };
    }

    conversation.messages.push(assistantMessage(response));

    if (isFinalStep && response.toolCalls.length > 0) {
      return {
        terminalState: 'budgetExhausted',
        finalAnswer: response.content.trim(),
        steps: step,
        toolCalls,
        changedFiles,
        conversation,
        error: `max steps exceeded: ${maxSteps}`,
      };
    }

    if (response.toolCalls.length === 0 && response.content.includes('<tool_call')) {
      return {
        terminalState: 'modelError',
        finalAnswer: response.content.trim(),
        steps: step,
        toolCalls,
        changedFiles,
        conversation,
        error: 'model emitted a malformed tool_call block',
      };
    }

    if (response.toolCalls.length === 0) {
      return {
        terminalState: 'completed',
        finalAnswer: response.content.trim(),
        steps: step,
        toolCalls,
        changedFiles,
        conversation,
      };
    }

    for (const call of response.toolCalls) {
      if (toolCalls.length >= maxToolCalls) {
        return {
          terminalState: 'budgetExhausted',
          finalAnswer: response.content.trim(),
          steps: step,
          toolCalls,
          changedFiles,
          conversation,
          error: `max tool calls exceeded: ${maxToolCalls}`,
        };
      }
      options.onActivity?.({ kind: 'tool', message: `${call.name}(${JSON.stringify(call.arguments)})` });
      const result = await executeAgentTool(call, {
        repoRoot: options.repoRoot,
        registry,
        ledger: conversation.inspectionLedger,
      });
      toolCalls.push({ name: call.name, success: result.success, error: result.error });
      if (result.changedFile) changedFiles.push(result.changedFile);
      conversation.messages.push(toolResultMessage(call, JSON.stringify(result.toolResult)));

      if (!result.success) {
        return {
          terminalState: 'toolError',
          finalAnswer: response.content.trim(),
          steps: step,
          toolCalls,
          changedFiles,
          conversation,
          error: result.error,
        };
      }
    }
  }

  return {
    terminalState: 'budgetExhausted',
    finalAnswer: '',
    steps: maxSteps,
    toolCalls,
    changedFiles,
    conversation,
    error: `max steps exceeded: ${maxSteps}`,
  };
}

function assistantMessage(response: ChatResponse): AgentMessage {
  return {
    role: 'assistant',
    content: response.content,
    tool_calls: response.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })),
  };
}

async function executeAgentTool(
  call: ParsedToolCall,
  context: { repoRoot: string; registry: ToolRegistry; ledger: InspectionLedger },
): Promise<{ success: boolean; toolResult: ToolResult; changedFile?: string; error?: string }> {
  if (call.name === 'replace_in_file') {
    return executeReplaceInFile(call.arguments, context);
  }

  if (call.name === 'create_file') {
    return executeCreateFile(call.arguments, context.repoRoot);
  }

  const toolResult = await context.registry.execute(call.name, call.arguments);
  return {
    success: toolResult.success,
    toolResult,
    error: toolResult.error,
  };
}

async function executeReplaceInFile(
  input: Record<string, unknown>,
  context: { repoRoot: string; ledger: InspectionLedger },
): Promise<{ success: boolean; toolResult: ToolResult; changedFile?: string; error?: string }> {
  const patch = coercePatch(input);
  if (!patch) {
    return toolFailure('replace_in_file', 'path, oldStr, and newStr are required');
  }

  const validation = await validateReplaceInFile(patch, { repoRoot: context.repoRoot, ledger: context.ledger });
  if (!validation.ok) {
    return toolFailure('replace_in_file', validation.message);
  }

  const applied = await applyReplaceInFile(patch, { repoRoot: context.repoRoot, ledger: context.ledger });
  if (!applied.ok) {
    return toolFailure('replace_in_file', applied.message);
  }

  return {
    success: true,
    changedFile: applied.path,
    toolResult: {
      success: true,
      toolName: 'replace_in_file',
      output: {
        path: applied.path,
        diff: createUnifiedDiff(applied.path, validation.before, validation.after),
      },
    },
  };
}

async function executeCreateFile(
  input: Record<string, unknown>,
  repoRoot: string,
): Promise<{ success: boolean; toolResult: ToolResult; changedFile?: string; error?: string }> {
  if (typeof input.path !== 'string' || typeof input.content !== 'string') {
    return toolFailure('create_file', 'path and content are required');
  }

  const target = normalizeRepoPath(repoRoot, input.path);
  if (!target.ok || !target.absolutePath || target.path === undefined) {
    return toolFailure('create_file', target.reason ?? 'invalid path');
  }
  if (existsSync(target.absolutePath)) {
    return toolFailure('create_file', `file already exists: ${target.path}`);
  }

  await mkdir(dirname(target.absolutePath), { recursive: true });
  await writeFile(target.absolutePath, input.content, 'utf-8');
  const written = await readFile(target.absolutePath, 'utf-8');
  return {
    success: true,
    changedFile: target.path,
    toolResult: {
      success: true,
      toolName: 'create_file',
      output: { path: target.path, bytes: Buffer.byteLength(written, 'utf-8') },
    },
  };
}

function replaceInFileTool(): ToolDefinition {
  return {
    name: 'replace_in_file',
    description:
      'Replace exactly one string in one repo-local file. The target file must already have been read with read_file_range. oldStr must match exactly once.',
    inputSchema: {
      type: 'object',
      required: ['path', 'oldStr', 'newStr'],
      properties: {
        path: { type: 'string', description: 'Repo-relative file path.' },
        oldStr: { type: 'string', description: 'Exact text copied from a prior file read.' },
        newStr: { type: 'string', description: 'Replacement text.' },
      },
      additionalProperties: false,
    },
    safetyPolicy: { readOnly: false, rejectsUnsafePaths: true, boundedOutput: true },
    ledgerBehavior: 'none',
    async execute() {
      return { success: false, toolName: 'replace_in_file', error: 'handled by the agent runner' };
    },
  };
}

function createFileTool(): ToolDefinition {
  return {
    name: 'create_file',
    description:
      'Create one new repo-local text file. Fails if the file already exists. Use for new docs or small new source files only.',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', description: 'Repo-relative path for the new file.' },
        content: { type: 'string', description: 'Full file content to write.' },
      },
      additionalProperties: false,
    },
    safetyPolicy: { readOnly: false, rejectsUnsafePaths: true, boundedOutput: true },
    ledgerBehavior: 'none',
    async execute() {
      return { success: false, toolName: 'create_file', error: 'handled by the agent runner' };
    },
  };
}

function coercePatch(input: Record<string, unknown>): ReplaceInFilePatch | null {
  if (typeof input.path !== 'string' || typeof input.oldStr !== 'string' || typeof input.newStr !== 'string') {
    return null;
  }
  return { path: input.path, oldStr: input.oldStr, newStr: input.newStr };
}

function toolResultMessage(call: ParsedToolCall, content: string): AgentMessage {
  return { role: 'tool', tool_call_id: call.id, name: call.name, content };
}

function toolFailure(toolName: string, error: string): { success: false; toolResult: ToolResult; error: string } {
  return {
    success: false,
    error,
    toolResult: { success: false, toolName, error },
  };
}

function finalAnswerNowMessage(): AgentMessage {
  return {
    role: 'system',
    content: [
      'Final step: answer now using only the context already gathered.',
      'Do not call tools, inspect more files, or request more information.',
      'If the context is incomplete, give the best concise answer possible and state the uncertainty.',
    ].join('\n'),
  };
}

function systemPrompt(): string {
  return [
    'You are Synax, a local code-editing agent working inside a git repository.',
    'Inspect files before editing.',
    'Make minimal, targeted changes.',
    'Do not invent file contents.',
    'Use exact replacement edits only with text copied from prior file reads.',
    'Use create_file only for small new repo-local text files.',
    'Honor explicit user limits on tool calls.',
    'Once you have enough context, stop inspecting and answer.',
    'When finished, summarize changed files, what changed, and verification status.',
  ].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
