/**
 * Hermes tool-call parser.
 *
 * Parses Hermes-format tool calls used by NousResearch Hermes models,
 * Qwen2.5 models, and other Hermes-family models:
 *
 *   <tool_call>
 *   {"name": "get_weather", "arguments": {"location": "SF", "unit": "celsius"}}
 *   </tool_call>
 *
 * Each <tool_call> block contains a single JSON object with
 * "name" and "arguments" fields. Multiple blocks = multiple calls.
 *
 * Reference: vLLM docs/features/tool_calling.md → "Qwen Models"
 *   Qwen2.5 chat templates support Hermes-style tool use.
 *   vllm/entrypoints/openai/tool_parsers/hermes_tool_parser.py
 */

import type { ToolCallParser, ToolCallParseResult, ParsedToolCall } from './types';
import { extractDelimitedBlocks, safeJsonParse, generateCallId, sanitizeReasoningTags } from './utils';

const PARSER_ID = 'hermes';
const DESCRIPTION = 'Hermes / Qwen2.5 format: <tool_call>{"name":"...","arguments":{...}}</tool_call>';
const FAMILIES = ['Hermes', 'NousResearch Hermes', 'OpenHermes', 'Qwen2.5'];

export const hermesParser: ToolCallParser = {
  id: PARSER_ID,
  description: DESCRIPTION,
  modelFamilies: FAMILIES,

  parse(content: string): ToolCallParseResult {
    const sanitized = sanitizeReasoningTags(content);
    const delimited = extractDelimitedBlocks(sanitized, '<tool_call>', '</tool_call>');

    if (delimited.blocks.length === 0) {
      return {
        ok: true,
        parserId: PARSER_ID,
        calls: [],
        content: sanitized,
      };
    }

    const calls: ParsedToolCall[] = [];
    const warnings: string[] = [];

    for (let i = 0; i < delimited.blocks.length; i++) {
      const block = delimited.blocks[i].trim();
      if (!block) continue;

      const parsed = safeJsonParse(block);
      if (!parsed.ok) {
        return {
          ok: false,
          parserId: PARSER_ID,
          calls: [],
          content: sanitized,
          error: `Hermes tool_call block ${i + 1}: ${parsed.error}`,
        };
      }

      if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
        return {
          ok: false,
          parserId: PARSER_ID,
          calls: [],
          content: sanitized,
          error: `Hermes tool_call block ${i + 1}: expected JSON object, got ${typeof parsed.value}`,
        };
      }

      const obj = parsed.value as Record<string, unknown>;
      const name = obj.name ?? obj.tool_name ?? obj.function;
      if (typeof name !== 'string' || !name.trim()) {
        return {
          ok: false,
          parserId: PARSER_ID,
          calls: [],
          content: sanitized,
          error: `Hermes tool_call block ${i + 1}: missing "name" field`,
        };
      }

      let args: Record<string, unknown> = {};
      const rawArgs = obj.arguments ?? obj.parameters ?? obj.input ?? obj.args;

      if (typeof rawArgs === 'string') {
        const parsedArgs = safeJsonParse(rawArgs);
        if (
          parsedArgs.ok &&
          typeof parsedArgs.value === 'object' &&
          parsedArgs.value !== null &&
          !Array.isArray(parsedArgs.value)
        ) {
          args = parsedArgs.value as Record<string, unknown>;
        } else {
          warnings.push(`Hermes block ${i + 1}: arguments string could not be parsed as JSON object`);
        }
      } else if (typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)) {
        args = rawArgs as Record<string, unknown>;
      }

      const call: ParsedToolCall = {
        id: generateCallId((obj.id ?? obj.call_id) as string | undefined, i + 1),
        name: name.trim(),
        arguments: args,
        rawSource: block,
        parserId: PARSER_ID,
        warnings: warnings.length > 0 ? [...warnings] : undefined,
      };
      warnings.length = 0; // clear per-call warnings after attaching
      calls.push(call);
    }

    const nonToolContent = [delimited.before, ...delimited.between, delimited.after].filter(Boolean).join('\n').trim();

    return {
      ok: true,
      parserId: PARSER_ID,
      calls,
      content: nonToolContent,
    };
  },
};

// ─── Factory ──────────────────────────────────────────────

export function createHermesParser(): ToolCallParser {
  return hermesParser;
}
