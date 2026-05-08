/**
 * Qwen3 XML tool-call parser.
 *
 * Parses Qwen3-Coder / Qwen3 XML-format tool calls:
 *
 *   <tool_call>
 *   <function=get_weather>
 *   <parameter=location>San Francisco</parameter>
 *   <parameter=unit>celsius</parameter>
 *   </function>
 *   </tool_call>
 *
 * Reference: vLLM docs/features/tool_calling.md → "Qwen3-Coder Models"
 *   Supported via --tool-call-parser qwen3_xml
 */

import type { ToolCallParser, ToolCallParseResult, ParsedToolCall } from './types';
import { extractDelimitedBlocks, coerceValue, generateCallId, sanitizeReasoningTags } from './utils';

const PARSER_ID = 'qwen3_xml';
const DESCRIPTION =
  'Qwen3-Coder / Qwen3 XML format: <tool_call><function=name><parameter=key>value</parameter></function></tool_call>';
const FAMILIES = ['Qwen3', 'Qwen3-Coder', 'Qwen3.5', 'Qwen3.6'];

export const qwen3XmlParser: ToolCallParser = {
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
      const block = delimited.blocks[i];
      const parsed = parseQwenFunctionBlock(block, i);

      if (!parsed.ok) {
        // Unrecoverable parse error in a tool-call block
        return {
          ok: false,
          parserId: PARSER_ID,
          calls: [],
          content: sanitized,
          error: parsed.error,
        };
      }

      if (parsed.call) {
        if (parsed.warnings) warnings.push(...parsed.warnings);
        calls.push(parsed.call);
      }
    }

    // Extract non-tool text from between blocks
    const nonToolContent = [delimited.before, ...delimited.between, delimited.after].filter(Boolean).join('\n').trim();

    return {
      ok: true,
      parserId: PARSER_ID,
      calls,
      content: nonToolContent,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  },
};

// ─── Block parser ─────────────────────────────────────────

function parseQwenFunctionBlock(
  block: string,
  index: number,
): { ok: true; call?: ParsedToolCall; warnings?: string[] } | { ok: false; error: string } {
  const trimmed = block.trim();

  // Find <function=NAME>...</function>
  const fnMatch = trimmed.match(/<function=([^>\s]+)>\s*([\s\S]*?)\s*<\/function>/i);
  if (!fnMatch || !fnMatch[1]) {
    return { ok: false, error: 'Qwen tool_call block missing <function=...> wrapper' };
  }

  const fnName = fnMatch[1].trim();
  const argsBody = fnMatch[2] ?? '';
  const args: Record<string, unknown> = {};
  const warnings: string[] = [];
  const paramRegex = /<parameter=([^>\s]+)>\s*([\s\S]*?)\s*<\/parameter>/gi;
  let foundAnyParam = false;

  for (const param of argsBody.matchAll(paramRegex)) {
    const key = param[1]?.trim();
    if (!key) continue;
    foundAnyParam = true;

    const rawValue = (param[2] ?? '').trim();
    args[key] = coerceValue(rawValue);
  }

  if (!foundAnyParam && argsBody.trim().length > 0) {
    // Block has content but no valid <parameter=...> tags
    return { ok: false, error: 'Qwen tool_call block contained malformed <parameter=...>' };
  }

  const call: ParsedToolCall = {
    id: generateCallId(undefined, index + 1),
    name: fnName,
    arguments: args,
    rawSource: `<function=${fnName}>${argsBody}</function>`,
    parserId: PARSER_ID,
    warnings: warnings.length > 0 ? warnings : undefined,
  };

  return { ok: true, call };
}

// ─── Factory ──────────────────────────────────────────────

export function createQwen3XmlParser(): ToolCallParser {
  return qwen3XmlParser;
}
