export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ToolCallParseFailureReason = 'malformed-json';

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

interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
}

type ParsedToolCallCandidate = { ok: true; call: ParsedToolCall | null } | { ok: false; message: string };

type ParsedToolCallList = { ok: true; calls: ParsedToolCall[] } | { ok: false; message: string };

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
  const result = parseToolCallsFromContentResult(sanitizeReasoningTags(content));
  return result.ok ? result.calls : [];
}

export function parseToolCallsFromContentResult(content: string): ToolCallParseResult {
  const sanitized = sanitizeReasoningTags(content);
  const calls: ParsedToolCall[] = [];

  for (const block of extractToolCallBlocks(sanitized)) {
    const parsed = parseJsonObjectResult(block);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: 'malformed-json',
        message: 'tool_call block contained malformed JSON',
      };
    }
    const parsedCalls = toolCallsFromUnknownResult(parsed.value, calls.length);
    if (!parsedCalls.ok) {
      return { ok: false, reason: 'malformed-json', message: parsedCalls.message };
    }
    calls.push(...parsedCalls.calls);
  }

  for (const block of extractJsonCodeBlocks(sanitized)) {
    const parsed = parseJsonObject(block);
    if (!parsed) continue;
    const parsedCalls = toolCallsFromUnknownResult(parsed, calls.length);
    if (!parsedCalls.ok) {
      return { ok: false, reason: 'malformed-json', message: parsedCalls.message };
    }
    calls.push(...parsedCalls.calls);
  }

  if (calls.length === 0) {
    const parsed = parseJsonObject(sanitized.trim());
    if (parsed) {
      const parsedCalls = toolCallsFromUnknownResult(parsed, 0);
      if (!parsedCalls.ok) {
        return { ok: false, reason: 'malformed-json', message: parsedCalls.message };
      }
      calls.push(...parsedCalls.calls);
    }
  }

  return { ok: true, source: calls.length > 0 ? 'content' : 'none', calls };
}

export function sanitizeReasoningTags(content: string): string {
  return content.replace(/<(think|thinking)[^>]*>[\s\S]*?<\/\1>/gi, '').trim();
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

function extractToolCallBlocks(content: string): string[] {
  return [...content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)].map((match) => match[1]);
}

function extractJsonCodeBlocks(content: string): string[] {
  return [...content.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)].map((match) => match[1]);
}

function parseJsonObject(raw: string): unknown | null {
  const result = parseJsonObjectResult(raw);
  return result.ok ? result.value : null;
}

function parseJsonObjectResult(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

function toolCallsFromUnknownResult(value: unknown, offset: number): ParsedToolCallList {
  if (!value || typeof value !== 'object') return { ok: true, calls: [] };

  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.tool_calls)) {
    const result = parseOpenAIToolCallsResult(obj.tool_calls);
    return result.ok ? { ok: true, calls: result.calls } : { ok: false, message: result.message };
  }

  const single = parseNamedCallResult(obj, offset);
  if (!single.ok) return { ok: false, message: single.message };
  return { ok: true, calls: single.call ? [single.call] : [] };
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

function parseNamedCallResult(obj: Record<string, unknown>, index: number): ParsedToolCallCandidate {
  const name = obj.name ?? obj.tool_name;
  if (typeof name !== 'string') return { ok: true, call: null };
  const args = parseArgumentsResult(obj.arguments ?? obj.parameters ?? obj.input ?? {}, 'tool call arguments');
  if (!args.ok) return { ok: false, message: args.message };
  return {
    ok: true,
    call: {
      id: typeof obj.id === 'string' && obj.id.length > 0 ? obj.id : `call_${index + 1}`,
      name,
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
