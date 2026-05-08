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

// Note: ParsedToolCall is re-exported from parsers/types above.
// The import below is only for internal use (avoiding import loops).
import type { ParsedToolCall } from './parsers/types';
import { sanitizeReasoningTags as sanitizeReasoning, safeJsonParse } from './parsers/utils';
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
  const result = parseToolCallsFromContentResult(sanitizeReasoning(content));
  return result.ok ? result.calls : [];
}

export function parseToolCallsFromContentResult(content: string): ToolCallParseResult {
  ensureReg();
  const sanitized = sanitizeReasoning(content);

  // Use the generic parser via registry for comprehensive parsing
  const parserResult = toolCallParserRegistry.parse('generic', sanitized);
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
  const sanitized = sanitizeReasoning(content);

  const parserResult = toolCallParserRegistry.parse('qwen3_xml', sanitized);
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
  if (!args.ok) return { ok: false, message: args.message };
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
