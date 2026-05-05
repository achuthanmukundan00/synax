import { execFile } from 'child_process';
import { promisify } from 'util';

import { loadProjectConfig, normalizeProviderConfig } from '../config/project';
import { createOpenAICompatibleClient } from '../llm/client';
import { type ParsedToolCall } from '../llm/tool-calls';
import { createContextLedger, createInspectionLedger, createToolRegistry } from '../tools';
import { type ToolDefinition } from '../tools/types';
import { applyReplaceInFile, createUnifiedDiff, validateReplaceInFile, type ReplaceInFilePatch } from './patch';
import { runVerification, type VerificationResult } from './verification';

const execFileAsync = promisify(execFile);
const MAX_TURNS = 8;

export interface RunTaskOptions {
  repoRoot: string;
  task: string;
  yes?: boolean;
}

export interface RunTaskReport {
  state: 'complete' | 'partial' | 'failed' | 'unverified';
  failureState?: string;
  filesChanged: string[];
  contextReport: string;
  verification: VerificationResult;
  messages: string[];
}

export async function runAgentTask(options: RunTaskOptions): Promise<RunTaskReport> {
  const projectConfig = loadProjectConfig(options.repoRoot);
  const providerConfig = normalizeProviderConfig(projectConfig.config.provider ?? {});
  const contextLedger = createContextLedger();
  const inspectionLedger = createInspectionLedger();
  const registry = createToolRegistry({ repoRoot: options.repoRoot, ledger: inspectionLedger });
  const messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string; tool_calls?: unknown }> =
    [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: options.task },
    ];
  const reportMessages: string[] = [];
  const filesChanged: string[] = [];

  contextLedger.setBudget(projectConfig.config.contextBudgetTokens ?? 16000);
  contextLedger.setTask(options.task);
  contextLedger.recordInstructionSource('system', { included: true, approximateTokens: 700 });
  contextLedger.recordInstructionSource('task', { included: true, approximateTokens: estimateTokens(options.task) });

  const dirty = await getDirtyStatus(options.repoRoot);
  if (dirty.length > 0) {
    reportMessages.push(`Dirty working tree warning: ${dirty.join(', ')}`);
  }

  const client = createOpenAICompatibleClient(providerConfig, { ledger: contextLedger });
  const tools = [...registry.list(), replaceInFileTool()];

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const response = await client.chat({ messages, tools, temperature: 0 });
    messages.push({
      role: 'assistant',
      content: response.content,
      tool_calls: response.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    });

    if (response.toolCalls.length === 0) {
      break;
    }

    for (const call of response.toolCalls) {
      if (call.name === 'replace_in_file') {
        const patch = coercePatch(call.arguments);
        if (!patch) {
          return finalizeFailure('invalid-patch', filesChanged, contextLedger.getCompact(), reportMessages);
        }
        const validation = await validateReplaceInFile(patch, { repoRoot: options.repoRoot, ledger: inspectionLedger });
        if (!validation.ok) {
          return finalizeFailure(validation.failureState, filesChanged, contextLedger.getCompact(), [
            ...reportMessages,
            validation.message,
          ]);
        }
        reportMessages.push(createUnifiedDiff(validation.path, validation.before, validation.after));
        if (!options.yes) {
          return finalizeFailure('confirmation-required', filesChanged, contextLedger.getCompact(), reportMessages);
        }
        const applied = await applyReplaceInFile(patch, { repoRoot: options.repoRoot, ledger: inspectionLedger });
        if (!applied.ok) {
          return finalizeFailure(applied.failureState, filesChanged, contextLedger.getCompact(), [
            ...reportMessages,
            applied.message,
          ]);
        }
        filesChanged.push(applied.path);
        messages.push(toolResultMessage(call, `applied replace_in_file to ${applied.path}`));
        continue;
      }

      const result = await registry.execute(call.name, call.arguments);
      messages.push(toolResultMessage(call, JSON.stringify(result)));
      if (!result.success) {
        reportMessages.push(`Tool failure (${call.name}): ${result.error ?? 'unknown error'}`);
      }
    }
  }

  const verificationCommand = selectVerificationCommand(projectConfig.config.verification?.defaultCommand);
  const verification = await runVerification({ repoRoot: options.repoRoot, command: verificationCommand });
  const state =
    verification.state === 'passed' ? 'complete' : verification.state === 'skipped' ? 'unverified' : 'failed';
  return { state, filesChanged, contextReport: contextLedger.getCompact(), verification, messages: reportMessages };
}

function replaceInFileTool(): ToolDefinition {
  return {
    name: 'replace_in_file',
    description:
      'Replace exactly one string in one repo file. The file must already have been inspected with read_file_range.',
    inputSchema: {
      type: 'object',
      required: ['path', 'oldStr', 'newStr'],
      properties: {
        path: { type: 'string' },
        oldStr: { type: 'string' },
        newStr: { type: 'string' },
      },
    },
    safetyPolicy: { readOnly: false, rejectsUnsafePaths: true, boundedOutput: true },
    ledgerBehavior: 'none',
    async execute() {
      return { success: false, toolName: 'replace_in_file', error: 'replace_in_file is handled by the agent loop' };
    },
  };
}

function systemPrompt(): string {
  return [
    'You are Synax, a local-first CLI coding agent.',
    'Use tools to inspect files before edits.',
    'For edits, call replace_in_file with path, oldStr, and newStr.',
    'Do not edit unread files. Prefer one small patch and then stop.',
    'OpenAI tool calls are preferred. If the server only supports text, emit <tool_call>{"name":"...","arguments":{...}}</tool_call>.',
  ].join('\n');
}

function coercePatch(input: Record<string, unknown>): ReplaceInFilePatch | null {
  if (typeof input.path !== 'string' || typeof input.oldStr !== 'string' || typeof input.newStr !== 'string') {
    return null;
  }
  return { path: input.path, oldStr: input.oldStr, newStr: input.newStr };
}

function toolResultMessage(
  call: ParsedToolCall,
  content: string,
): { role: string; content: string; tool_call_id: string; name: string } {
  return { role: 'tool', tool_call_id: call.id, name: call.name, content };
}

function selectVerificationCommand(command: string | undefined): string | undefined {
  const trimmed = command?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

async function getDirtyStatus(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--short'], { cwd: repoRoot, maxBuffer: 64 * 1024 });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function finalizeFailure(
  failureState: string,
  filesChanged: string[],
  contextReport: string,
  messages: string[],
): RunTaskReport {
  return {
    state: filesChanged.length > 0 ? 'partial' : 'failed',
    failureState,
    filesChanged,
    contextReport,
    verification: { state: 'skipped', stdout: '', stderr: '' },
    messages,
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
