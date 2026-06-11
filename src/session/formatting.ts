/**
 * Formatting helpers — message construction, activity formatting, safety checks.
 *
 * Extracted from Session.ts. Pure functions with no mutable state.
 * Accept interfaces rather than the Session class to avoid circular deps.
 */

import type { ChatResponse } from '../llm/types';
import type { ParsedToolCall } from '../llm/tool-calls';
import type { ToolResult } from '../tools/types';
import type { ContextBudgetSettings } from '../agent/context-budget';
import { eventNow, type AgentEvent } from '../agent/events';
import { sanitizeReasoning } from '../llm/repair/reasoning-sanitizer';
import { buildImageContentBlock } from '../llm/image-utils';
import { STATUS_ONLY_PATTERNS } from './tool-definitions';
import type { AgentMessage, AgentConversation, AgentActivity } from './types';

// ─── Response formatting ─────────────────────────────────────────────────────

export function assistantVisibleContent(content: string): string {
  return sanitizeReasoning(content)
    .content.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, ' ')
    .replace(/<\|tool_call\|>[\s\S]*/gi, '')
    .trim();
}

/**
 * Check whether a final answer string is a status-only placeholder that
 * should be rejected (e.g. "completed", "Status: completed", empty).
 */
export function isStatusOnlyOutput(output: string): boolean {
  const trimmed = output.trim();
  if (trimmed.length === 0) return true;
  return STATUS_ONLY_PATTERNS.some((p) => p.test(trimmed));
}

export function assistantMessage(response: ChatResponse, settings?: ContextBudgetSettings): AgentMessage {
  const content = response.content;
  void settings;
  const reasoningContent = response.reasoningContent?.trim();
  const reasoningFields = reasoningContent ? { reasoning_content: reasoningContent } : {};

  if (toolCallFormat(response) === 'content_xml') {
    return {
      role: 'assistant',
      content,
      ...reasoningFields,
      _tool_call_ids: response.toolCalls.map((c) => c.id),
    };
  }

  const message: AgentMessage = {
    role: 'assistant',
    content,
    ...reasoningFields,
  };
  if (response.toolCalls.length > 0) {
    message.tool_calls = response.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
  }
  return message;
}

export function toolResultMessage(call: ParsedToolCall, content: string): AgentMessage {
  return {
    role: 'tool',
    tool_call_id: call.id,
    name: call.name,
    content,
  };
}

export function contentToolResultMessage(entries: Array<{ id: string; content: string }>): AgentMessage {
  return {
    role: 'user',
    content: entries.map((e) => `<tool_response>\n${e.content}\n</tool_response>`).join('\n'),
    _tool_result_ids: entries.map((e) => e.id),
  };
}

export function toolCallFormat(response: ChatResponse): NonNullable<ChatResponse['toolCallFormat']> {
  return response.toolCallFormat ?? 'openai';
}

// ─── Tool result appending ───────────────────────────────────────────────────

export function appendToolResult(
  conversation: AgentConversation,
  response: ChatResponse,
  call: ParsedToolCall,
  toolResult: ToolResult,
  contentToolResults: Array<{ id: string; content: string }>,
  settings: ContextBudgetSettings,
): void {
  const content = JSON.stringify(toolResult);
  void settings;

  if (toolCallFormat(response) === 'content_xml') {
    contentToolResults.push({ id: call.id, content });
    flushContentToolResults(conversation, response, contentToolResults);
    return;
  }
  conversation.messages.push(toolResultMessage(call, content));
}

export function flushContentToolResults(
  conversation: AgentConversation,
  response: ChatResponse,
  contentToolResults: Array<{ id: string; content: string }>,
): void {
  if (toolCallFormat(response) !== 'content_xml' || contentToolResults.length === 0) return;
  conversation.messages.push(contentToolResultMessage(contentToolResults));
  contentToolResults.splice(0, contentToolResults.length);
}

// ─── Tool result detail formatting ───────────────────────────────────────────

export function formatToolResultDetail(toolResult: ToolResult): string {
  const output = toolResult.output;
  if (!output || typeof output !== 'object') {
    return toolResult.error ?? JSON.stringify(toolResult);
  }
  const record = output as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof record.command === 'string') lines.push(`command: ${record.command}`);
  if (Array.isArray(record.safetyWarnings) && record.safetyWarnings.length > 0) {
    lines.push(`warnings: ${record.safetyWarnings.join(', ')}`);
  }
  if (typeof record.stdout === 'string' && record.stdout.length > 0) {
    lines.push(`stdout:\n${record.stdout.trimEnd()}`);
  }
  if (typeof record.stderr === 'string' && record.stderr.length > 0) {
    lines.push(`stderr:\n${record.stderr.trimEnd()}`);
  }
  if (typeof record.exitCode === 'number') lines.push(`exitCode: ${record.exitCode}`);
  if (lines.length > 0) return lines.join('\n');
  return toolResult.error ?? JSON.stringify(toolResult, null, 2);
}

// ─── Activity formatting ─────────────────────────────────────────────────────

export function formatModelResponseActivity(response: ChatResponse, _step: number): AgentActivity {
  const lines: string[] = [];
  const reasoningContent = response.reasoningContent?.trim();
  const visibleContent = assistantVisibleContent(response.content);

  if (reasoningContent && !visibleContent.includes(reasoningContent)) {
    lines.push(`<thinking>\n${reasoningContent}\n</thinking>`);
  }

  if (visibleContent.length > 0) {
    lines.push(visibleContent);
  }

  if (response.toolCalls.length > 0) {
    const toolNames = response.toolCalls.map((c) => c.name).join(', ');
    lines.push(`→ ${response.toolCalls.length} tool call(s): ${toolNames}`);
  }

  return {
    kind: 'model_response',
    message: lines.join('\n') || '(empty response)',
    modelOutput: lines.join('\n'),
    toolCallCount: response.toolCalls.length,
  };
}

// ─── Completion detection ────────────────────────────────────────────────────

/**
 * Detect premature "I'm done" claims before any work was done.
 * Uses typed verification contracts: checks whether files were changed
 * AND whether the text contains self-declaration phrases.
 *
 * The regex-based phrase matching is a transitional heuristic — issue #45
 * will replace this with typed verification levels.
 */
export function isPrematureCompletionClaim(text: string, changedFiles: string[] = []): boolean {
  // files_changed verification level: if files were modified, completion is genuine
  if (changedFiles.length > 0) return false;

  const normalized = assistantVisibleContent(text).toLowerCase();

  if (normalized.length < 10) return false;

  const prematurePhrases = [
    'verified passed',
    'verification passed',
    'all tests pass',
    'completed successfully',
    'task complete',
    'work is complete',
  ];

  if (normalized.length < 60) {
    return prematurePhrases.some((phrase) => normalized.includes(phrase));
  }

  const tailStart = Math.floor(normalized.length * 0.6);
  const tail = normalized.slice(tailStart);
  return prematurePhrases.some((phrase) => tail.includes(phrase));
}

/**
 * Detect a model response that is only a generic status line rather than
 * a substantive answer — e.g. "Status: completed\nWorking tree: dirty".
 * Such responses should not be treated as valid completions after tool use.
 */
export function isGenericStatusOnlyFinalAnswer(text: string): boolean {
  const lines = text
    .split('\n')
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return true;
  const statusPattern = /^status:\s*(completed|failed|error|running|pending|skipped)$/;
  const worktreePattern = /^working\s+tree:\s*(clean|dirty)$/;
  return lines.length <= 2 && lines.every((l) => statusPattern.test(l) || worktreePattern.test(l));
}

// ─── Tool-call safety preamble check ─────────────────────────────────────────

export function isSafeToolPreamble(text: string): boolean {
  const normalized = assistantVisibleContent(text);

  if (!normalized) return true;
  const joined = normalized.toLowerCase();

  const forbiddenPatterns = [
    /\b(?:the\s+)?answer\s+is\b/,
    /\bfinal\s+answer\s*[:：-]/,
    /^\s*final\s+answer\b/m,
    /\bin\s+summary\s*[,.:：-]/,
    /\bin\s+conclusion\s*[,.:：-]/,
    /\bto\s+summarize\s*[,.:：-]/,
    /\bhere\s+is\s+the\s+answer\b/,
  ];

  return !forbiddenPatterns.some((pattern) => pattern.test(joined));
}

// ─── Tool error classification ───────────────────────────────────────────────

export function isRecoverableToolError(call: ParsedToolCall, result: { success: boolean; error?: string }): boolean {
  if (result.success) return false;
  if (call.name === 'bash') return !isBashLoopError(result.error);
  if (call.name === 'edit' || call.name === 'replace_in_file') return isEditRecoverableError(result.error);
  if (call.name === 'write') return isWriteRecoverableError(result.error);
  if (call.name !== 'read') return false;
  return isEnoentError(result.error) || isReadPolicyLimitError(result.error);
}

/**
 * Policy refusals are intentional, bounded denials (e.g., the per-turn read
 * budget). They are recoverable but must NOT count toward the consecutive
 * recoverable-error kill switch: a single batch of parallel reads issued
 * after the cap would otherwise terminate the whole turn and discard the
 * model's work. Refused reads are cheap (output omitted) and the turn is
 * still bounded by maxToolCalls.
 */
export function isPolicyRefusal(call: ParsedToolCall, result: { success: boolean; error?: string }): boolean {
  if (result.success) return false;
  return call.name === 'read' && isReadPolicyLimitError(result.error);
}

export function isEnoentError(error: string | undefined): boolean {
  return error !== undefined && /\bENOENT\b/.test(error);
}

export function isReadPolicyLimitError(error: string | undefined): boolean {
  if (error === undefined) return false;
  return error.includes('total read limit reached') || error.includes('Read loop detected');
}

export function isBashLoopError(error: string | undefined): boolean {
  return error !== undefined && error.includes('Bash loop detected');
}

export function isEditRecoverableError(error: string | undefined): boolean {
  if (error === undefined) return false;
  return error.includes('oldStr no longer matches') || error.includes('oldStr must match exactly once');
}

export function isWriteRecoverableError(error: string | undefined): boolean {
  if (error === undefined) return false;
  return error.includes('file already exists');
}

// ─── Event emission ──────────────────────────────────────────────────────────

export interface AssistantDeltaEmitter {
  eventBus: { emit(event: AgentEvent): void };
  onEvent?: (event: AgentEvent) => void;
}

export function emitAssistantDelta(
  emitter: AssistantDeltaEmitter,
  delta: { content?: string; reasoningContent?: string },
): void {
  if (!delta.content && !delta.reasoningContent) return;
  const event = {
    type: 'assistant_delta' as const,
    timestamp: eventNow(),
    content: delta.content,
    reasoningContent: delta.reasoningContent,
  };
  emitter.eventBus.emit(event);
}

// ─── Utility ─────────────────────────────────────────────────────────────────

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── Image view result → vision-model message ─────────────────────────────────

/**
 * When view_image succeeds, build a user message that exposes the image
 * as an actual image_url content block so vision-capable models can "see" it.
 *
 * Returns null when the tool result is not a successful view_image call.
 */
export function tryBuildImageViewMessage(toolResult: ToolResult): AgentMessage | null {
  if (toolResult.toolName !== 'view_image' || !toolResult.success) return null;

  const output = toolResult.output as Record<string, unknown> | undefined;
  if (!output || typeof output.dataUrl !== 'string') return null;

  const path = typeof output.path === 'string' ? output.path : 'image';
  const mimeType = typeof output.mimeType === 'string' ? output.mimeType : 'image/png';
  const dataUrl = output.dataUrl;

  const imageBlock = buildImageContentBlock(dataUrl);

  return {
    role: 'user',
    content: [{ type: 'text', text: `Image file: ${path} (${mimeType}, ${formatSize(output.sizeBytes)})` }, imageBlock],
  };
}

function formatSize(bytes: unknown): string {
  if (typeof bytes !== 'number' || bytes <= 0) return 'unknown size';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
