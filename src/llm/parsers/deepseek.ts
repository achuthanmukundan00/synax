/**
 * DeepSeek V3 / V3.1 tool-call parser.
 *
 * Parses DeepSeek tool-call format. DeepSeek models output tool calls in
 * a format similar to Hermes, using XML-style tags with JSON inside:
 *
 *   <tool_call>
 *   {"name": "get_weather", "arguments": {"location": "SF", "unit": "celsius"}}
 *   </tool_call>
 *
 * DeepSeek V3.1 may also use a <｜tool▁call▁begin｜>...<｜tool▁call▁end｜> format
 * with a special token prefix.
 *
 * DeepSeek reasoning models (R1) may emit tool calls inside <think> blocks
 * — the sanitizeReasoningTags step strips those before parsing.
 *
 * Reference: vLLM
 *   --tool-call-parser deepseek_v3
 *   --tool-call-parser deepseek_v31
 *   vllm/entrypoints/openai/tool_parsers/deepseek_v3_tool_parser.py
 *   vllm/entrypoints/openai/tool_parsers/deepseek_v31_tool_parser.py
 */

import type { ToolCallParser, ToolCallParseResult, ParsedToolCall } from './types';
import { extractDelimitedBlocks, safeJsonParse, generateCallId, sanitizeReasoningTags } from './utils';

// ─── DeepSeek V3 ──────────────────────────────────────────

const DSV3_ID = 'deepseek_v3';
const DSV3_DESC = 'DeepSeek V3 format: <tool_call>{"name":"...","arguments":{...}}</tool_call>';
const DSV3_FAMILIES = ['DeepSeek V3', 'DeepSeek Chat', 'DeepSeek R1', 'DeepSeek'];

const DEEPSEEK_BEGIN = '<｜tool▁call▁begin｜>';
const DEEPSEEK_END = '<｜tool▁call▁end｜>';

export const deepseekV3Parser: ToolCallParser = {
  id: DSV3_ID,
  description: DSV3_DESC,
  modelFamilies: DSV3_FAMILIES,

  parse(content: string): ToolCallParseResult {
    const sanitized = sanitizeReasoningTags(content);
    return parseDeepSeekContent(sanitized, DSV3_ID);
  },
};

// ─── DeepSeek V3.1 ────────────────────────────────────────

const DSV31_ID = 'deepseek_v31';
const DSV31_DESC = 'DeepSeek V3.1 format: special-token-delimited tool calls with JSON';
const DSV31_FAMILIES = ['DeepSeek V3.1'];

export const deepseekV31Parser: ToolCallParser = {
  id: DSV31_ID,
  description: DSV31_DESC,
  modelFamilies: DSV31_FAMILIES,

  parse(content: string): ToolCallParseResult {
    const sanitized = sanitizeReasoningTags(content);
    return parseDeepSeekContent(sanitized, DSV31_ID);
  },
};

// ─── Shared implementation ────────────────────────────────

function parseDeepSeekContent(sanitized: string, parserId: string): ToolCallParseResult {
  // Try <tool_call>...</tool_call> delimiters first (Hermes-compatible style)
  const delimited = extractDelimitedBlocks(sanitized, '<tool_call>', '</tool_call>');

  if (delimited.blocks.length > 0) {
    return parseHermesStyleBlocks(delimited, parserId);
  }

  // Try special token delimiters
  const specialDelimited = extractDelimitedBlocks(sanitized, DEEPSEEK_BEGIN, DEEPSEEK_END);

  if (specialDelimited.blocks.length > 0) {
    return parseHermesStyleBlocks(specialDelimited, parserId);
  }

  return {
    ok: true,
    parserId,
    calls: [],
    content: sanitized,
  };
}

function parseHermesStyleBlocks(
  delimited: ReturnType<typeof extractDelimitedBlocks>,
  parserId: string,
): ToolCallParseResult {
  const calls: ParsedToolCall[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < delimited.blocks.length; i++) {
    const block = delimited.blocks[i].trim();
    if (!block) continue;

    const parsed = safeJsonParse(block);
    if (!parsed.ok) {
      return {
        ok: false,
        parserId,
        calls: [],
        content: `${delimited.before}\n${delimited.after}`.trim(),
        error: `DeepSeek tool_call block ${i + 1}: ${parsed.error}`,
      };
    }

    if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
      return {
        ok: false,
        parserId,
        calls: [],
        content: `${delimited.before}\n${delimited.after}`.trim(),
        error: `DeepSeek tool_call block ${i + 1}: expected JSON object`,
      };
    }

    const obj = parsed.value as Record<string, unknown>;
    const name = obj.name ?? obj.tool_name ?? obj.function;
    if (typeof name !== 'string' || !name.trim()) {
      return {
        ok: false,
        parserId,
        calls: [],
        content: `${delimited.before}\n${delimited.after}`.trim(),
        error: `DeepSeek tool_call block ${i + 1}: missing "name"`,
      };
    }

    let args: Record<string, unknown> = {};
    const rawArgs = obj.arguments ?? obj.parameters ?? obj.input;
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
        warnings.push(`DeepSeek block ${i + 1}: arguments string parse failed`);
      }
    } else if (typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)) {
      args = rawArgs as Record<string, unknown>;
    }

    calls.push({
      id: generateCallId((obj.id ?? obj.call_id) as string | undefined, i + 1),
      name: name.trim(),
      arguments: args,
      rawSource: block,
      parserId,
    });
  }

  const nonToolContent = [delimited.before, ...delimited.between, delimited.after].filter(Boolean).join('\n').trim();

  return {
    ok: true,
    parserId,
    calls,
    content: nonToolContent,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

// ─── Factories ────────────────────────────────────────────

export function createDeepseekV3Parser(): ToolCallParser {
  return deepseekV3Parser;
}

export function createDeepseekV31Parser(): ToolCallParser {
  return deepseekV31Parser;
}
