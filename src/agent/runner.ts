import { existsSync } from 'fs';
import { mkdir, readFile } from 'fs/promises';
import { dirname } from 'path';

import { type ChatOptions, type ChatResponse } from '../llm/types';
import { type ParsedToolCall } from '../llm/tool-calls';
import { createInspectionLedger, createToolRegistry, type InspectionLedger } from '../tools';
import { normalizeRepoPath } from '../tools/policy';
import { type ToolDefinition, type ToolRegistry, type ToolResult } from '../tools/types';
import {
  applyReplaceInFile,
  createPatchPreview,
  validateReplaceInFile,
  type PatchPreview,
  type ReplaceInFilePatch,
} from './patch';
import { atomicWriteFile, writeLastEditRecord } from './safety';
import { eventNow, type AgentEvent, type TerminalState } from './events';
import { canMutatePath, describeToolCall, guardBroadTask, getAllowedModelTools, type RunMode } from './task-policy';

export type AgentTerminalState = TerminalState;

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
  mode?: RunMode;
  tools?: ModelToolSurfaceOptions;
  conversation?: AgentConversation;
  registry?: ToolRegistry;
  onActivity?: (activity: AgentActivity) => void;
  onEvent?: (event: AgentEvent) => void;
  approvePatch?: (preview: PatchPreview) => PatchApprovalDecision | Promise<PatchApprovalDecision>;
  ensureCheckpoint?: () => Promise<unknown>;
}

export interface ModelToolSurfaceOptions {
  bashEnabled?: boolean;
  mode?: RunMode;
}

export interface AgentActivity {
  kind: 'model' | 'tool';
  message: string;
}

export type PatchApprovalDecision = 'accept' | 'reject';

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
const MAX_CONSECUTIVE_RECOVERABLE_TOOL_ERRORS = 3;

interface AgentToolExecutionResult {
  success: boolean;
  toolResult: ToolResult;
  changedFile?: string;
  error?: string;
  terminalState?: AgentTerminalState;
}

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
  const mode = options.mode ?? 'patch';
  const tools = buildModelFacingTools({ ...options.tools, mode });
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const changedFiles: string[] = [];
  const toolCalls: AgentTurnResult['toolCalls'] = [];
  let consecutiveRecoverableToolErrors = 0;

  const broadTask = guardBroadTask(options.task);
  if (broadTask) {
    return {
      terminalState: 'blocked',
      finalAnswer: `${broadTask.message}\nSuggested first step: ${broadTask.suggestedFirstStep}`,
      steps: 0,
      toolCalls,
      changedFiles,
      conversation,
      error: broadTask.message,
    };
  }

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
        terminalState: message.toLowerCase().includes('context budget') ? 'budget_exhausted' : 'model_error',
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
        terminalState: 'budget_exhausted',
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
        terminalState: 'model_error',
        finalAnswer: response.content.trim(),
        steps: step,
        toolCalls,
        changedFiles,
        conversation,
        error: 'model emitted a malformed tool_call block',
      };
    }

    if (response.toolCalls.length > 0 && response.content.trim().length > 0) {
      if (!isSafeToolPreamble(response.content)) {
        return {
          terminalState: 'model_error',
          finalAnswer: response.content.trim(),
          steps: step,
          toolCalls,
          changedFiles,
          conversation,
          error: 'model emitted ambiguous mixed output (tool calls plus final text)',
        };
      }

      conversation.messages[conversation.messages.length - 1] = assistantMessage({
        ...response,
        content: '',
      });
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
          terminalState: 'budget_exhausted',
          finalAnswer: response.content.trim(),
          steps: step,
          toolCalls,
          changedFiles,
          conversation,
          error: `max tool calls exceeded: ${maxToolCalls}`,
        };
      }
      options.onActivity?.({
        kind: 'tool',
        message: describeToolCall(call.name, call.arguments as Record<string, unknown>),
      });
      options.onEvent?.({
        type: 'tool_started',
        timestamp: eventNow(),
        stepIndex: step,
        toolCallId: call.id,
        toolName: call.name,
        summary: JSON.stringify(call.arguments).slice(0, 180),
      });
      const result = await executeAgentTool(call, {
        repoRoot: options.repoRoot,
        registry,
        ledger: conversation.inspectionLedger,
        mode,
        ensureCheckpoint: options.ensureCheckpoint,
        approvePatch: options.approvePatch,
        onPatchPreview: (preview) => {
          options.onEvent?.({
            type: 'patch_preview',
            timestamp: eventNow(),
            stepIndex: step,
            toolCallId: call.id,
            toolName: call.name,
            ...preview,
          });
        },
      });
      toolCalls.push({ name: call.name, success: result.success, error: result.error });
      options.onEvent?.({
        type: 'tool_finished',
        timestamp: eventNow(),
        stepIndex: step,
        toolCallId: call.id,
        toolName: call.name,
        status: result.success ? 'ok' : 'error',
        summary: result.success ? 'completed' : (result.error ?? 'failed'),
      });
      if (result.changedFile) changedFiles.push(result.changedFile);
      conversation.messages.push(toolResultMessage(call, JSON.stringify(result.toolResult)));

      if (result.success) {
        consecutiveRecoverableToolErrors = 0;
      } else if (isRecoverableToolError(call, result)) {
        consecutiveRecoverableToolErrors += 1;
        if (consecutiveRecoverableToolErrors < MAX_CONSECUTIVE_RECOVERABLE_TOOL_ERRORS) {
          continue;
        }

        return {
          terminalState: 'tool_error',
          finalAnswer: response.content.trim(),
          steps: step,
          toolCalls,
          changedFiles,
          conversation,
          error: `too many consecutive recoverable tool errors: ${MAX_CONSECUTIVE_RECOVERABLE_TOOL_ERRORS}`,
        };
      } else {
        return {
          terminalState: result.terminalState ?? 'tool_error',
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
    terminalState: 'budget_exhausted',
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
  context: {
    repoRoot: string;
    registry: ToolRegistry;
    ledger: InspectionLedger;
    mode: RunMode;
    ensureCheckpoint?: () => Promise<unknown>;
    approvePatch?: (preview: PatchPreview) => PatchApprovalDecision | Promise<PatchApprovalDecision>;
    onPatchPreview?: (preview: PatchPreview) => void;
  },
): Promise<AgentToolExecutionResult> {
  if (call.name === 'read') {
    return executeReadTool(call.arguments, context.registry);
  }

  if (call.name === 'git') {
    return executeGitTool(call.arguments, context.registry);
  }

  if (call.name === 'edit' || call.name === 'replace_in_file') {
    return executeReplaceInFile(call.arguments, context, call.name);
  }

  if (call.name === 'write' || call.name === 'create_file') {
    return executeCreateFile(call.arguments, context, call.name);
  }

  if (call.name === 'bash') {
    return toolFailure('bash', 'bash tool is not enabled in this scaffold');
  }

  const toolResult = await context.registry.execute(call.name, call.arguments);
  return {
    success: toolResult.success,
    toolResult,
    error: toolResult.error,
  };
}

async function executeReadTool(
  input: Record<string, unknown>,
  registry: ToolRegistry,
): Promise<AgentToolExecutionResult> {
  if (typeof input.query === 'string' && input.query.trim().length > 0) {
    const result = await registry.execute('search_text', input);
    return publicToolResult('read', result);
  }
  if (typeof input.path === 'string' && input.path.trim().length > 0) {
    const result = await registry.execute('read_file_range', input);
    return publicToolResult('read', result);
  }
  const result = await registry.execute('list_files', input);
  return publicToolResult('read', result);
}

async function executeGitTool(
  input: Record<string, unknown>,
  registry: ToolRegistry,
): Promise<AgentToolExecutionResult> {
  const action =
    typeof input.action === 'string' ? input.action : typeof input.operation === 'string' ? input.operation : 'status';
  const result =
    action === 'diff' ? await registry.execute('show_git_diff', input) : await registry.execute('show_git_status', {});
  return publicToolResult('git', result);
}

async function executeReplaceInFile(
  input: Record<string, unknown>,
  context: {
    repoRoot: string;
    ledger: InspectionLedger;
    mode: RunMode;
    ensureCheckpoint?: () => Promise<unknown>;
    approvePatch?: (preview: PatchPreview) => PatchApprovalDecision | Promise<PatchApprovalDecision>;
    onPatchPreview?: (preview: PatchPreview) => void;
  },
  toolName = 'replace_in_file',
): Promise<AgentToolExecutionResult> {
  const patch = coercePatch(input);
  if (!patch) {
    return toolFailure(toolName, 'path, oldStr, and newStr are required');
  }

  if (context.mode === 'read-only' || context.mode === 'verify') {
    return toolFailure(toolName, `${context.mode} mode does not allow edits`);
  }

  const mutationPath = canMutatePath(context.mode, context.repoRoot, patch.path);
  if (!mutationPath.ok) {
    return toolFailure(toolName, mutationPath.reason ?? 'mutation path rejected');
  }

  await context.ensureCheckpoint?.();

  const validation = await validateReplaceInFile(patch, { repoRoot: context.repoRoot, ledger: context.ledger });
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

  const applied = await applyReplaceInFile(patch, { repoRoot: context.repoRoot, ledger: context.ledger });
  if (!applied.ok) {
    return toolFailure(toolName, applied.message);
  }
  await writeLastEditRecord(context.repoRoot, {
    path: applied.path,
    before: applied.before,
    after: applied.after,
    timestamp: new Date().toISOString(),
  });

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

async function executeCreateFile(
  input: Record<string, unknown>,
  context: {
    repoRoot: string;
    mode: RunMode;
    ensureCheckpoint?: () => Promise<unknown>;
  },
  toolName = 'create_file',
): Promise<AgentToolExecutionResult> {
  if (typeof input.path !== 'string' || typeof input.content !== 'string') {
    return toolFailure(toolName, 'path and content are required');
  }

  if (context.mode === 'read-only' || context.mode === 'verify') {
    return toolFailure(toolName, `${context.mode} mode does not allow writes`);
  }

  const target = normalizeRepoPath(context.repoRoot, input.path);
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

  if (Buffer.byteLength(input.content, 'utf-8') > 16 * 1024) {
    return toolFailure(toolName, 'create_file content is too large; write a smaller text file');
  }

  await context.ensureCheckpoint?.();
  await mkdir(dirname(target.absolutePath), { recursive: true });
  await atomicWriteFile(target.absolutePath, input.content);
  const written = await readFile(target.absolutePath, 'utf-8');
  return {
    success: true,
    changedFile: target.path,
    toolResult: {
      success: true,
      toolName,
      output: { path: target.path, bytes: Buffer.byteLength(written, 'utf-8') },
    },
  };
}

export function buildModelFacingTools(options: ModelToolSurfaceOptions = {}): ToolDefinition[] {
  const bashEnabled = options.bashEnabled ?? false;
  const allowedNames = getAllowedModelTools(options.mode ?? 'patch', bashEnabled);
  const tools: ToolDefinition[] = [
    {
      name: 'read',
      description:
        'Inspect repository files with bounded output. Omit path to list files, pass path to read a file range, or pass query to search text.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional repo-relative file or directory path.' },
          startLine: { type: 'number', description: '1-based first line for file reads.' },
          endLine: { type: 'number', description: '1-based final line for file reads.' },
          query: { type: 'string', description: 'Literal text to search for.' },
          maxFiles: { type: 'number', description: 'Maximum listed files.' },
          maxMatches: { type: 'number', description: 'Maximum search matches.' },
        },
        additionalProperties: false,
      },
      safetyPolicy: { readOnly: true, rejectsUnsafePaths: true, boundedOutput: true },
      ledgerBehavior: 'records-file-range',
      async execute() {
        return { success: false, toolName: 'read', error: 'handled by the agent runner' };
      },
    },
    {
      name: 'write',
      description: 'Create one new repo-local text file. Fails if the file already exists.',
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
        return { success: false, toolName: 'write', error: 'handled by the agent runner' };
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
          oldStr: { type: 'string', description: 'Exact text copied from a prior file read.' },
          newStr: { type: 'string', description: 'Replacement text.' },
        },
        additionalProperties: false,
      },
      safetyPolicy: { readOnly: false, rejectsUnsafePaths: true, boundedOutput: true },
      ledgerBehavior: 'none',
      async execute() {
        return { success: false, toolName: 'edit', error: 'handled by the agent runner' };
      },
    },
    {
      name: 'git',
      description: 'Inspect bounded git status or diff. Pass action "diff" for diff; defaults to status.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'diff'], description: 'Git inspection action.' },
          maxLines: { type: 'number', description: 'Maximum diff lines for action=diff.' },
        },
        additionalProperties: false,
      },
      safetyPolicy: { readOnly: true, rejectsUnsafePaths: true, boundedOutput: true },
      ledgerBehavior: 'records-git-status',
      async execute() {
        return { success: false, toolName: 'git', error: 'handled by the agent runner' };
      },
    },
  ];

  if (bashEnabled) {
    tools.splice(3, 0, {
      name: 'bash',
      description:
        'Reserved shell execution surface. This v0.3 scaffold exposes the name only when shell execution policy enables it.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run when enabled.' },
        },
        additionalProperties: false,
      },
      safetyPolicy: { readOnly: false, rejectsUnsafePaths: true, boundedOutput: true },
      ledgerBehavior: 'none',
      async execute() {
        return { success: false, toolName: 'bash', error: 'handled by the agent runner' };
      },
    });
  }

  return tools.filter((tool) => allowedNames.includes(tool.name));
}

function publicToolResult(toolName: string, result: ToolResult): AgentToolExecutionResult {
  return {
    success: result.success,
    toolResult: { ...result, toolName },
    error: result.error,
  };
}

function isRecoverableToolError(call: ParsedToolCall, result: { success: boolean; error?: string }): boolean {
  return call.name === 'read' && !result.success && isEnoentError(result.error);
}

function isEnoentError(error: string | undefined): boolean {
  return error !== undefined && /\bENOENT\b/.test(error);
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

function isSafeToolPreamble(text: string): boolean {
  const normalized = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();

  if (!normalized) return true;
  if (normalized.length > 140) return false;

  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length > 2) return false;

  const joined = lines.join(' ').toLowerCase();

  const forbiddenPhrases = [
    'answer is',
    'final answer',
    'therefore',
    'in summary',
    'done',
    'completed',
    'i found',
    'the result',
    'conclusion',
  ];

  if (forbiddenPhrases.some((phrase) => joined.includes(phrase))) {
    return false;
  }

  const allowedPatterns = [
    /^let me (inspect|check|read|look|open|review)\b.*\.?$/,
    /^i'?ll (inspect|check|read|look|open|review)\b.*\.?$/,
    /^i will (inspect|check|read|look|open|review)\b.*\.?$/,
    /^checking\b.*\.?$/,
    /^reading\b.*\.?$/,
    /^inspecting\b.*\.?$/,
  ];

  return allowedPatterns.some((pattern) => pattern.test(joined));
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
    'You are Synax, an expert code assistant.',
    'Inspect files before editing.',
    'Make minimal, targeted changes.',
    'Do not invent file contents.',
    'Edit only using text from prior reads.',
    'Write only small repo-local text files.',
    'Respect tool-call and step budgets.',
    'For tool calls, emit tool calls only.',
    'Do not include preambles around tool calls.',
    'For Synax questions, inspect README.md, docs/, and specs/ first.',
    'Keep documentation consistent with code.',
    'Stop inspecting once you have enough context.',
    'When finished, verify requirements and summarize changes.',
  ].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
