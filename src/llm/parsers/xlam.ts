/**
 * xLAM tool-call parser.
 *
 * Parses xLAM-format tool calls. The xLAM family uses Hermes-compatible
 * XML-style tags with JSON tool call objects:
 *
 *   <tool_call>
 *   {"name": "get_weather", "arguments": {"location": "SF", "unit": "celsius"}}
 *   </tool_call>
 *
 * Reference: vLLM
 *   --tool-call-parser xlam
 *   vllm/entrypoints/openai/tool_parsers/xlam_tool_parser.py
 *
 * Note: xLAM also supports a second format using plain function name then args:
 *   get_weather
 *   {"location": "SF", "unit": "celsius"}
 * This parser handles both formats.
 */

import type { ToolCallParser, ToolCallParseResult, ParsedToolCall } from './types';
import { extractDelimitedBlocks, safeJsonParse, generateCallId, sanitizeReasoningTags } from './utils';

const PARSER_ID = 'xlam';
const DESCRIPTION = 'xLAM format: <tool_call>{"name":"...","arguments":{...}}</tool_call> or bare function+JSON';
const FAMILIES = ['xLAM'];

export const xlamParser: ToolCallParser = {
  id: PARSER_ID,
  description: DESCRIPTION,
  modelFamilies: FAMILIES,

  parse(content: string): ToolCallParseResult {
    const sanitized = sanitizeReasoningTags(content);

    // Try <tool_call>...</tool_call> delimiters first
    const delimited = extractDelimitedBlocks(sanitized, '<tool_call>', '</tool_call>');

    if (delimited.blocks.length > 0) {
      const calls: ParsedToolCall[] = [];

      for (let i = 0; i < delimited.blocks.length; i++) {
        const block = delimited.blocks[i].trim();
        if (!block) continue;

        // xLAM may use JSON object inside the tag
        const parsed = safeJsonParse(block);
        if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null && !Array.isArray(parsed.value)) {
          const obj = parsed.value as Record<string, unknown>;
          const name = obj.name ?? obj.tool_name;
          if (typeof name === 'string' && name.trim()) {
            calls.push(buildCall(name.trim(), obj, block, i));
            continue;
          }
        }

        // xLAM alternate format: function name on first line, JSON args on subsequent lines
        const lines = block
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        if (lines.length >= 1) {
          const fnName = lines[0];
          if (/^[a-zA-Z_]\w*$/.test(fnName)) {
            const argsJson = lines.slice(1).join('\n');
            let args: Record<string, unknown> = {};
            if (argsJson.trim()) {
              const parsedArgs = safeJsonParse(argsJson);
              if (
                parsedArgs.ok &&
                typeof parsedArgs.value === 'object' &&
                parsedArgs.value !== null &&
                !Array.isArray(parsedArgs.value)
              ) {
                args = parsedArgs.value as Record<string, unknown>;
              }
            }
            calls.push({
              id: generateCallId(undefined, i + 1),
              name: fnName,
              arguments: args,
              rawSource: block,
              parserId: PARSER_ID,
            });
            continue;
          }
        }

        // Unrecognized format in block — treat as error
        return {
          ok: false,
          parserId: PARSER_ID,
          calls: [],
          content: sanitized,
          error: `xLAM block ${i + 1}: unrecognized format`,
        };
      }

      const nonToolContent = [delimited.before, ...delimited.between, delimited.after]
        .filter(Boolean)
        .join('\n')
        .trim();

      return { ok: true, parserId: PARSER_ID, calls, content: nonToolContent };
    }

    return { ok: true, parserId: PARSER_ID, calls: [], content: sanitized };
  },
};

function buildCall(name: string, obj: Record<string, unknown>, raw: string, index: number): ParsedToolCall {
  let args: Record<string, unknown> = {};
  const rawArgs = obj.arguments ?? obj.parameters ?? obj.input;
  if (typeof rawArgs === 'string') {
    const parsed = safeJsonParse(rawArgs);
    if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null && !Array.isArray(parsed.value)) {
      args = parsed.value as Record<string, unknown>;
    }
  } else if (typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)) {
    args = rawArgs as Record<string, unknown>;
  }
  return {
    id: generateCallId((obj.id ?? obj.call_id) as string | undefined, index + 1),
    name,
    arguments: args,
    rawSource: raw,
    parserId: PARSER_ID,
  };
}

// ─── Factory ──────────────────────────────────────────────

export function createXlamParser(): ToolCallParser {
  return xlamParser;
}
