/**
 * Llama 3 JSON tool-call parser.
 *
 * Parses Llama 3.x JSON-format tool calls:
 *
 *   <|python_tag|>{"name": "get_weather", "parameters": {"location": "SF", "unit": "celsius"}}
 *
 * The model outputs a `<|python_tag|>` prefix followed by a JSON object
 * with "name" and "parameters" fields. Multiple calls can appear as
 * separate `<|python_tag|>` blocks.
 *
 * vLLM also supports a custom chat template that wraps calls in a
 * `<|start_header_id|>assistant<|end_header_id|>` structure, but
 * the parser handles the raw `<|python_tag|>` blocks directly.
 *
 * Reference: vLLM docs/features/tool_calling.md
 *   --tool-call-parser llama3_json
 *   --chat-template examples/tool_chat_template_llama3.1_json.jinja
 *   vllm/entrypoints/openai/tool_parsers/llama_tool_parser.py
 */

import type { ToolCallParser, ToolCallParseResult, ParsedToolCall } from './types';
import { safeJsonParse, generateCallId, sanitizeReasoningTags } from './utils';

const PARSER_ID = 'llama3_json';
const DESCRIPTION = 'Llama 3.x JSON format: <|python_tag|>{"name":"...","parameters":{...}}';
const FAMILIES = ['Llama 3', 'Llama 3.1', 'Llama 3.2', 'Llama 3.3', 'Meta Llama 3'];

const PYTHON_TAG = '<|python_tag|>';

export const llama3JsonParser: ToolCallParser = {
  id: PARSER_ID,
  description: DESCRIPTION,
  modelFamilies: FAMILIES,

  parse(content: string): ToolCallParseResult {
    const sanitized = sanitizeReasoningTags(content);

    // Strip Llama header/footer tags if present (model output format)
    const text = sanitized
      .replace(/<\|start_header_id\|>assistant<\|end_header_id\|>/gi, '')
      .replace(/<\|eot_id\|>/gi, '')
      .trim();

    const calls: ParsedToolCall[] = [];
    let remaining = text;
    const nonToolParts: string[] = [];

    while (remaining.length > 0) {
      const tagIdx = remaining.indexOf(PYTHON_TAG);
      if (tagIdx === -1) {
        nonToolParts.push(remaining);
        break;
      }

      // Text before the tag
      if (tagIdx > 0) {
        nonToolParts.push(remaining.slice(0, tagIdx));
      }
      remaining = remaining.slice(tagIdx + PYTHON_TAG.length);

      // Find the JSON object after the tag
      const jsonStart = remaining.search(/\S/);
      if (jsonStart === -1) break;
      remaining = remaining.slice(jsonStart);

      if (!remaining.startsWith('{')) {
        // Not JSON — this is prose, treat as non-tool content
        const nextTag = remaining.indexOf(PYTHON_TAG);
        if (nextTag === -1) {
          nonToolParts.push(remaining);
          break;
        }
        nonToolParts.push(remaining.slice(0, nextTag));
        remaining = remaining.slice(nextTag);
        continue;
      }

      // Extract the JSON object (balanced braces)
      const jsonEnd = findBalancedClose(remaining, '{', '}');
      if (jsonEnd === -1) {
        nonToolParts.push(remaining);
        break;
      }

      const jsonStr = remaining.slice(0, jsonEnd + 1);
      remaining = remaining.slice(jsonEnd + 1);

      const parsed = safeJsonParse(jsonStr);
      if (!parsed.ok) {
        // Malformed JSON — skip and continue
        nonToolParts.push(`${PYTHON_TAG}${jsonStr}`);
        continue;
      }

      if (typeof parsed.value !== 'object' || parsed.value === null) {
        nonToolParts.push(`${PYTHON_TAG}${jsonStr}`);
        continue;
      }

      const obj = parsed.value as Record<string, unknown>;
      const name = obj.name ?? obj.tool_name ?? obj.function;
      if (typeof name !== 'string' || !name.trim()) {
        nonToolParts.push(`${PYTHON_TAG}${jsonStr}`);
        continue;
      }

      let args: Record<string, unknown> = {};
      const rawArgs = obj.parameters ?? obj.arguments ?? obj.input ?? obj.args;

      if (typeof rawArgs === 'string') {
        const parsedArgs = safeJsonParse(rawArgs);
        if (
          parsedArgs.ok &&
          typeof parsedArgs.value === 'object' &&
          parsedArgs.value !== null &&
          !Array.isArray(parsedArgs.value)
        ) {
          args = parsedArgs.value as Record<string, unknown>;
        }
      } else if (typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)) {
        args = rawArgs as Record<string, unknown>;
      }

      calls.push({
        id: generateCallId((obj.id ?? obj.call_id) as string | undefined, calls.length + 1),
        name: name.trim(),
        arguments: args,
        rawSource: jsonStr,
        parserId: PARSER_ID,
      });
    }

    const nonToolContent = nonToolParts.join('').trim();

    return {
      ok: true,
      parserId: PARSER_ID,
      calls,
      content: nonToolContent,
    };
  },
};

// ─── Helpers ──────────────────────────────────────────────

function findBalancedClose(text: string, open: string, close: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ─── Factory ──────────────────────────────────────────────

export function createLlama3JsonParser(): ToolCallParser {
  return llama3JsonParser;
}
