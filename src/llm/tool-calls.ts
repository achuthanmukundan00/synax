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
  const result = parseToolCallsFromContentResult(content);
  return result.ok ? result.calls : [];
}

export function parseToolCallsFromContentResult(content: string): ToolCallParseResult {
  const calls: ParsedToolCall[] = [];

  for (const block of extractToolCallBlocks(content)) {
    const parsed = parseJsonObjectResult(block);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: 'malformed-json',
        message: 'tool_call block contained malformed JSON',
      };
    }
    calls.push(...toolCallsFromUnknown(parsed.value, calls.length));
  }

  for (const block of extractJsonCodeBlocks(content)) {
    const parsed = parseJsonObject(block);
    if (!parsed) continue;
    calls.push(...toolCallsFromUnknown(parsed, calls.length));
  }

  if (calls.length === 0) {
    const parsed = parseJsonObject(content.trim());
    if (parsed) {
      calls.push(...toolCallsFromUnknown(parsed, 0));
    }
  }

  return { ok: true, source: calls.length > 0 ? 'content' : 'none', calls };
}

export function parseOpenAIToolCalls(toolCalls: unknown): ParsedToolCall[] {
  const result = parseOpenAIToolCallsResult(toolCalls);
  return result.ok ? result.calls : [];
}

export function parseOpenAIToolCallsResult(toolCalls: unknown): ToolCallParseResult {
  if (!Array.isArray(toolCalls)) return { ok: true, source: 'none', calls: [] };
  const calls = toolCalls.flatMap((call, index) => {
    const parsed = parseOpenAIToolCall(call as OpenAIToolCall, index);
    return parsed ? [parsed] : [];
  });
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

function toolCallsFromUnknown(value: unknown, offset: number): ParsedToolCall[] {
  if (!value || typeof value !== 'object') return [];

  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.tool_calls)) {
    return parseOpenAIToolCalls(obj.tool_calls);
  }

  const single = parseNamedCall(obj, offset);
  return single ? [single] : [];
}

function parseOpenAIToolCall(call: OpenAIToolCall, index: number): ParsedToolCall | null {
  if (!call || typeof call !== 'object' || !call.function || typeof call.function !== 'object') return null;
  if (typeof call.function.name !== 'string') return null;
  const args = parseArguments(call.function.arguments);
  if (!args) return null;
  return {
    id: typeof call.id === 'string' && call.id.length > 0 ? call.id : `call_${index + 1}`,
    name: call.function.name,
    arguments: args,
  };
}

function parseNamedCall(obj: Record<string, unknown>, index: number): ParsedToolCall | null {
  const name = obj.name ?? obj.tool_name;
  if (typeof name !== 'string') return null;
  const args = parseArguments(obj.arguments ?? obj.parameters ?? obj.input ?? {});
  if (!args) return null;
  return {
    id: typeof obj.id === 'string' && obj.id.length > 0 ? obj.id : `call_${index + 1}`,
    name,
    arguments: args,
  };
}

function parseArguments(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const parsed = parseJsonObject(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}
