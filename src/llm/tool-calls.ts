/**
 * Re-export canonical ParsedToolCall from parsers/types.
 * Existing code importing ParsedToolCall from here continues to work.
 * The new type adds optional fields (rawSource, parserId, warnings)
 * which are backward-compatible.
 */
export type { ParsedToolCall } from './parsers/types';
export { sanitizeReasoningTags } from './parsers/utils';
export { resetCallIdCounter } from './parsers/utils';
export { ensureParsersRegistered, detectParserId, toolCallParserRegistry } from './parsers/index';
import { repairJson } from './repair/json-repair';

// Note: ParsedToolCall is re-exported from parsers/types above.
// The import below is only for internal use (avoiding import loops).
import type { ParsedToolCall } from './parsers/types';
import { sanitizeReasoningTags as sanitizeReasoning, safeJsonParse } from './parsers/utils';
import type { ParsedModelOutput, ParseWarning } from './types';
import { sanitizeReasoning as repairSanitize } from './repair/reasoning-sanitizer';
// Re-export sanitizeReasoningTags for external consumers
// (handled by the `export { sanitizeReasoningTags }` above)

/**
 * Tool-call parser mode — expanded from the original 3 values.
 * Kept as string union to stay open for new parser IDs.
 */
export type ToolCallParserMode = string;

export type ToolCallParseFailureReason = 'malformed-json';

/**
 * Backward-compatible ToolCallParseResult.
 * Same shape as before — preserved for existing consumers.
 */
export type ToolCallParseResult =
  | {
      ok: true;
      source: 'openai' | 'content' | 'none';
      calls: ParsedToolCall[];
    }
  | {
      ok: false;
      reason: ToolCallParseFailureReason;
      message: string;
    };

import { toolCallParserRegistry } from './parsers/registry';
import { ensureParsersRegistered } from './parsers/index';

// Ensure parsers are registered lazily on first import
let parsersEnsured = false;
function ensureReg(): void {
  if (!parsersEnsured) {
    parsersEnsured = true;
    ensureParsersRegistered();
  }
}

interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
}

type ParsedToolCallCandidate = { ok: true; call: ParsedToolCall | null } | { ok: false; message: string };

type ParsedArguments = { ok: true; arguments: Record<string, unknown> } | { ok: false; message: string };

export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export function parseToolCallsFromContent(content: string): ParsedToolCall[] {
  // Reasoning is already extracted by the caller (client.ts / parseModelOutput).
  // We parse tool calls from cleaned content.
  const result = parseToolCallsFromContentResult(content);
  return result.ok ? result.calls : [];
}

/**
 * Parse raw model output into a typed ParsedModelOutput.
 *
 * This is the canonical entry point: it extracts reasoning, parses tool calls,
 * and returns separated fields. Replaces the ad-hoc global sanitize-then-parse
 * pattern previously scattered across tool-calls.ts and client.ts.
 *
 * @param content Raw model output text.
 * @param parserId The parser to use (e.g., 'generic', 'qwen3_xml').
 * @param reasoningContent Optional pre-extracted reasoning from the API response.
 */
export function parseModelOutput(content: string, parserId: string, reasoningContent?: string): ParsedModelOutput {
  const warnings: ParseWarning[] = [];
  const reasoning = reasoningContent?.trim() || undefined;
  let cleanedContent = content;

  // Extract reasoning from content if the provider embeds it inline
  // (Qwen models emit <think> blocks, some models leak thinking in various forms).
  // Use the dedicated reasoning sanitizer for provider-aware extraction.
  if (!reasoning) {
    const sanitizeResult = repairSanitize(content);
    if (sanitizeResult.removedReasoning) {
      warnings.push({ message: 'Extracted reasoning tags from model output', source: 'reasoning' });
    }
    cleanedContent = sanitizeResult.content;
  } else {
    // If reasoning was provided via API field, also strip any inline tags
    // from the content so they don't interfere with parsing.
    const stripped = sanitizeReasoning(cleanedContent);
    if (stripped !== cleanedContent) {
      warnings.push({ message: 'Stripped inline reasoning tags from content', source: 'reasoning' });
      cleanedContent = stripped;
    }
  }

  // Parse tool calls from the cleaned content
  const parserResult = toolCallParserRegistry.parse(parserId, cleanedContent);
  const toolCalls: ParsedToolCall[] = [];
  if (parserResult.ok) {
    toolCalls.push(...parserResult.calls);
  } else {
    warnings.push({ message: parserResult.error ?? 'parser error', source: 'parser' });
  }

  // Extract assistant-visible text (content without tool-call blocks)
  let assistantText = parserResult.content || cleanedContent;

  // Bug #114: When DeepSeek returns empty content but rich reasoning_content,
  // fall back to reasoning as the assistant-visible answer. Strip thinking/tool-call
  // tags from reasoning to produce clean prose.
  if (!assistantText && reasoning) {
    const sanitizedReasoning = sanitizeReasoning(reasoning);
    // Also strip tool-call markup that may have leaked into reasoning_content
    const visible = sanitizedReasoning
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, ' ')
      .replace(/<\|tool_call\|>[\s\S]*/gi, '')
      .trim();
    if (visible) {
      assistantText = visible;
      warnings.push({ message: 'Used reasoningContent as fallback for empty content (bug #114)', source: 'reasoning' });
    }
  }

  return {
    assistantText,
    toolCalls,
    reasoning,
    warnings,
  };
}

export function parseToolCallsFromContentResult(content: string): ToolCallParseResult {
  ensureReg();
  // Content should already have reasoning extracted by the caller.
  // We only do a light pass to strip any remaining tag artifacts.
  const cleaned = sanitizeReasoning(content);

  const parserResult = toolCallParserRegistry.parse('generic', cleaned);
  if (!parserResult.ok) {
    return { ok: false, reason: 'malformed-json', message: parserResult.error ?? 'parse error' };
  }

  return {
    ok: true,
    source: parserResult.calls.length > 0 ? 'content' : 'none',
    calls: parserResult.calls,
  };
}

export function parseQwenToolCallsFromContentResult(content: string): ToolCallParseResult {
  ensureReg();
  // Content should already have reasoning extracted by the caller.
  const cleaned = sanitizeReasoning(content);

  const parserResult = toolCallParserRegistry.parse('qwen3_xml', cleaned);
  if (!parserResult.ok) {
    return { ok: false, reason: 'malformed-json', message: parserResult.error ?? 'parse error' };
  }

  return {
    ok: true,
    source: parserResult.calls.length > 0 ? 'content' : 'none',
    calls: parserResult.calls,
  };
}

export function parseOpenAIToolCalls(toolCalls: unknown): ParsedToolCall[] {
  const result = parseOpenAIToolCallsResult(toolCalls);
  return result.ok ? result.calls : [];
}

export function parseOpenAIToolCallsResult(toolCalls: unknown): ToolCallParseResult {
  if (!Array.isArray(toolCalls)) return { ok: true, source: 'none', calls: [] };
  const calls: ParsedToolCall[] = [];
  for (const [index, call] of toolCalls.entries()) {
    const parsed = parseOpenAIToolCallResult(call as OpenAIToolCall, index);
    if (!parsed.ok) {
      return { ok: false, reason: 'malformed-json', message: parsed.message };
    }
    if (parsed.call) calls.push(parsed.call);
  }
  return { ok: true, source: calls.length > 0 ? 'openai' : 'none', calls };
}

export function toOpenAIToolDefinition(tool: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}): OpenAIToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

export function toAnthropicToolDefinition(tool: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}): AnthropicToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

function parseJsonObject(raw: string): unknown | null {
  const result = safeJsonParse(raw);
  return result.ok ? result.value : null;
}

function parseOpenAIToolCallResult(call: OpenAIToolCall, index: number): ParsedToolCallCandidate {
  if (!call || typeof call !== 'object' || !call.function || typeof call.function !== 'object') {
    return { ok: true, call: null };
  }
  if (typeof call.function.name !== 'string') return { ok: true, call: null };
  const args = parseArgumentsResult(call.function.arguments, 'OpenAI tool call arguments');
  if (!args.ok) {
    // Attempt JSON repair on the raw arguments string before giving up
    const raw = call.function.arguments;
    if (typeof raw === 'string') {
      const repaired = repairJson(raw);
      if (repaired) {
        try {
          const parsed = JSON.parse(repaired.repaired) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return {
              ok: true,
              call: {
                id: typeof call.id === 'string' && call.id.length > 0 ? call.id : `call_${index + 1}`,
                name: call.function.name,
                arguments: parsed as Record<string, unknown>,
              },
            };
          }
        } catch {
          // Repair parse also failed — log and skip this call
        }
      }
    }
    // Skip individual malformed calls instead of failing the batch.
    // Valid calls in the same batch still execute.
    return { ok: true, call: null };
  }
  return {
    ok: true,
    call: {
      id: typeof call.id === 'string' && call.id.length > 0 ? call.id : `call_${index + 1}`,
      name: call.function.name,
      arguments: args.arguments,
    },
  };
}

function parseArgumentsResult(value: unknown, label: string): ParsedArguments {
  if (typeof value === 'string') {
    const parsed = parseJsonObject(value);
    if (!parsed) return { ok: false, message: `${label} contained malformed JSON` };
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: `${label} must be a JSON object` };
    }
    return { ok: true, arguments: parsed as Record<string, unknown> };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ok: true, arguments: value as Record<string, unknown> };
  }
  return { ok: false, message: `${label} must be a JSON object` };
}
