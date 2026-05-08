/**
 * Shared JSON-in-tags parser factory.
 *
 * Many model families use the same basic format: tool calls wrapped in
 * XML-style tags with JSON objects inside. This module provides a
 * factory for creating parsers for these families.
 *
 * Format:
 *   <tool_call>
 *   {"name": "func_name", "arguments": {"key": "value"}}
 *   </tool_call>
 *
 * Used by: Granite, InternLM, FunctionGemma, OLMo3, Jamba, MiniMax,
 * Kimi K2, Hunyuan, LongCat, GigaChat, and others.
 *
 * Reference: vLLM
 *   vllm/entrypoints/openai/tool_parsers/ — various parsers
 */

import type { ToolCallParser, ToolCallParseResult, ParsedToolCall } from './types';
import { extractDelimitedBlocks, safeJsonParse, generateCallId, sanitizeReasoningTags } from './utils';

export interface JsonInTagsParserConfig {
  id: string;
  description: string;
  modelFamilies: string[];
  /** Open tag regex or string (default: '<tool_call>'). */
  openTag?: string;
  /** Close tag regex or string (default: '</tool_call>'). */
  closeTag?: string;
  /** Key for function name in JSON object (default: 'name'). */
  nameKey?: string;
  /** Key for arguments in JSON object (default: 'arguments'). */
  argsKey?: string;
}

export function createJsonInTagsParser(config: JsonInTagsParserConfig): ToolCallParser {
  const openTag = config.openTag ?? '<tool_call>';
  const closeTag = config.closeTag ?? '</tool_call>';
  const nameKey = config.nameKey ?? 'name';
  const argsKey = config.argsKey ?? 'arguments';

  return {
    id: config.id,
    description: config.description,
    modelFamilies: config.modelFamilies,

    parse(content: string): ToolCallParseResult {
      const sanitized = sanitizeReasoningTags(content);
      const delimited = extractDelimitedBlocks(sanitized, openTag, closeTag);

      if (delimited.blocks.length === 0) {
        return {
          ok: true,
          parserId: config.id,
          calls: [],
          content: sanitized,
        };
      }

      const calls: ParsedToolCall[] = [];

      for (let i = 0; i < delimited.blocks.length; i++) {
        const block = delimited.blocks[i].trim();
        if (!block) continue;

        const parsed = safeJsonParse(block);
        if (!parsed.ok) {
          return {
            ok: false,
            parserId: config.id,
            calls: [],
            content: sanitized,
            error: `${config.id} block ${i + 1}: ${parsed.error}`,
          };
        }

        if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
          return {
            ok: false,
            parserId: config.id,
            calls: [],
            content: sanitized,
            error: `${config.id} block ${i + 1}: expected JSON object`,
          };
        }

        const obj = parsed.value as Record<string, unknown>;
        const name = obj[nameKey] ?? obj.tool_name ?? obj.function;
        if (typeof name !== 'string' || !name.trim()) {
          return {
            ok: false,
            parserId: config.id,
            calls: [],
            content: sanitized,
            error: `${config.id} block ${i + 1}: missing "${nameKey}" field`,
          };
        }

        let args: Record<string, unknown> = {};
        const rawArgs = obj[argsKey] ?? obj.parameters ?? obj.input ?? obj.args;
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
          id: generateCallId((obj.id ?? obj.call_id) as string | undefined, i + 1),
          name: name.trim(),
          arguments: args,
          rawSource: block,
          parserId: config.id,
        });
      }

      const nonToolContent = [delimited.before, ...delimited.between, delimited.after]
        .filter(Boolean)
        .join('\n')
        .trim();

      return {
        ok: true,
        parserId: config.id,
        calls,
        content: nonToolContent,
      };
    },
  };
}

// ─── Pre-configured parsers ───────────────────────────────

export const graniteParser: ToolCallParser = createJsonInTagsParser({
  id: 'granite',
  description: 'Granite format: <tool_call>{"name":"...","arguments":{...}}</tool_call>',
  modelFamilies: ['Granite', 'Granite 3', 'IBM Granite'],
});

export const granite4Parser: ToolCallParser = createJsonInTagsParser({
  id: 'granite4',
  description: 'Granite 4 format: same as granite, Granite-4-specific variant',
  modelFamilies: ['Granite 4'],
});

export const granite20bFcParser: ToolCallParser = createJsonInTagsParser({
  id: 'granite-20b-fc',
  description: 'Granite 20B Function Calling: <tool_call>{"name":"...","arguments":{...}}</tool_call>',
  modelFamilies: ['Granite 20B FC'],
});

export const internlmParser: ToolCallParser = createJsonInTagsParser({
  id: 'internlm',
  description: 'InternLM format: <tool_call>{"name":"...","arguments":{...}}</tool_call>',
  modelFamilies: ['InternLM', 'InternLM2', 'InternLM3'],
});

export const functionGemmaParser: ToolCallParser = createJsonInTagsParser({
  id: 'functiongemma',
  description: 'FunctionGemma format: <tool_call>{"name":"...","arguments":{...}}</tool_call>',
  modelFamilies: ['FunctionGemma', 'Gemma 2 Function Calling'],
});

/**
 * OLMo3 tool-call parser.
 *
 * OLMo3 wraps multiple tool calls in <function_calls>...</function_calls>
 * with individual <function_call> entries:
 *
 *   <function_calls>
 *   <function_call>
 *   {"name": "get_weather", "arguments": {"location": "SF"}}
 *   </function_call>
 *   <function_call>
 *   {"name": "get_time", "arguments": {"timezone": "PST"}}
 *   </function_call>
 *   </function_calls>
 *
 * Reference: vLLM
 *   --tool-call-parser olmo3
 *   vllm/entrypoints/openai/tool_parsers/olmo3_tool_parser.py
 */
export const olmo3Parser: ToolCallParser = {
  id: 'olmo3',
  description:
    'OLMo3 format: <function_calls><function_call>{"name":"...","arguments":{...}}</function_call></function_calls>',
  modelFamilies: ['OLMo3', 'OLMo 3', 'OLMoE'],

  parse(content: string): ToolCallParseResult {
    const sanitized = sanitizeReasoningTags(content);

    // First try <function_calls> wrapper
    const fcDelimited = extractDelimitedBlocks(sanitized, '<function_calls>', '</function_calls>');

    if (fcDelimited.blocks.length > 0) {
      const calls: ParsedToolCall[] = [];

      for (let i = 0; i < fcDelimited.blocks.length; i++) {
        const wrapperBlock = fcDelimited.blocks[i];
        // Extract individual <function_call> blocks
        const innerDelimited = extractDelimitedBlocks(wrapperBlock, '<function_call>', '</function_call>');

        for (let j = 0; j < innerDelimited.blocks.length; j++) {
          const block = innerDelimited.blocks[j].trim();
          if (!block) continue;

          const parsed = safeJsonParse(block);
          if (!parsed.ok) {
            return {
              ok: false,
              parserId: 'olmo3',
              calls: [],
              content: sanitized,
              error: `OLMo3 function_call block ${j + 1}: ${parsed.error}`,
            };
          }

          if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
            return {
              ok: false,
              parserId: 'olmo3',
              calls: [],
              content: sanitized,
              error: `OLMo3 function_call block ${j + 1}: expected JSON object`,
            };
          }

          const obj = parsed.value as Record<string, unknown>;
          const name = obj.name ?? obj.tool_name;
          if (typeof name !== 'string' || !name.trim()) {
            return {
              ok: false,
              parserId: 'olmo3',
              calls: [],
              content: sanitized,
              error: `OLMo3 function_call block ${j + 1}: missing "name"`,
            };
          }

          let args: Record<string, unknown> = {};
          const rawArgs = obj.arguments ?? obj.parameters;
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
            rawSource: block,
            parserId: 'olmo3',
          });
        }
      }

      const nonToolContent = [fcDelimited.before, ...fcDelimited.between, fcDelimited.after]
        .filter(Boolean)
        .join('\n')
        .trim();

      return { ok: true, parserId: 'olmo3', calls, content: nonToolContent };
    }

    // Fallback: try plain <tool_call> blocks (some OLMo3 variants)
    const tcDelimited = extractDelimitedBlocks(sanitized, '<tool_call>', '</tool_call>');
    if (tcDelimited.blocks.length > 0) {
      return createJsonInTagsParser({
        id: 'olmo3',
        description: '',
        modelFamilies: [],
      }).parse(sanitized);
    }

    return { ok: true, parserId: 'olmo3', calls: [], content: sanitized };
  },
};

// Additional parsers using the shared JSON-in-tags pattern

export const jambaParser: ToolCallParser = createJsonInTagsParser({
  id: 'jamba',
  description: 'Jamba format: <tool_call>{"name":"...","arguments":{...}}</tool_call>',
  modelFamilies: ['Jamba', 'AI21 Jamba'],
});

export const minimaxParser: ToolCallParser = createJsonInTagsParser({
  id: 'minimax',
  description: 'MiniMax format: <tool_call>{"name":"...","arguments":{...}}</tool_call>',
  modelFamilies: ['MiniMax'],
});

export const kimiK2Parser: ToolCallParser = createJsonInTagsParser({
  id: 'kimi_k2',
  description: 'Kimi K2 format: <tool_call>{"name":"...","arguments":{...}}</tool_call>',
  modelFamilies: ['Kimi K2', 'Moonshot Kimi'],
});

export const hunyuanA13bParser: ToolCallParser = createJsonInTagsParser({
  id: 'hunyuan_a13b',
  description: 'Hunyuan A13B format: <tool_call>{"name":"...","arguments":{...}}</tool_call>',
  modelFamilies: ['Hunyuan', 'Tencent Hunyuan'],
});

export const longcatParser: ToolCallParser = createJsonInTagsParser({
  id: 'longcat',
  description: 'LongCat format: <tool_call>{"name":"...","arguments":{...}}</tool_call>',
  modelFamilies: ['LongCat'],
});

/**
 * GigaChat 3 tool-call parser.
 *
 * GigaChat 3 uses a custom format with <function> tags:
 *
 *   <function=func_name>{"key": "value"}</function>
 *
 * Reference: vLLM
 *   --tool-call-parser gigachat3
 */
export const gigachat3Parser: ToolCallParser = {
  id: 'gigachat3',
  description: 'GigaChat 3 format: <function=name>{"key":"value"}</function>',
  modelFamilies: ['GigaChat', 'GigaChat 3'],

  parse(content: string): ToolCallParseResult {
    const sanitized = sanitizeReasoningTags(content);
    const fnRegex = /<function=([^>\s]+)>\s*([\s\S]*?)\s*<\/function>/gi;
    const calls: ParsedToolCall[] = [];
    const nonToolParts: string[] = [];

    let match: RegExpExecArray | null;
    let lastIndex = 0;

    fnRegex.lastIndex = 0;
    while ((match = fnRegex.exec(sanitized)) !== null) {
      // Text before this match
      if (match.index > lastIndex) {
        nonToolParts.push(sanitized.slice(lastIndex, match.index));
      }
      lastIndex = match.index + match[0].length;

      const fnName = match[1]?.trim();
      const body = (match[2] ?? '').trim();

      if (!fnName) continue;

      let args: Record<string, unknown> = {};
      if (body) {
        const parsed = safeJsonParse(body);
        if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null && !Array.isArray(parsed.value)) {
          args = parsed.value as Record<string, unknown>;
        }
      }

      calls.push({
        id: generateCallId(undefined, calls.length + 1),
        name: fnName,
        arguments: args,
        rawSource: match[0],
        parserId: 'gigachat3',
      });
    }

    // Remaining text after last match
    if (lastIndex < sanitized.length) {
      nonToolParts.push(sanitized.slice(lastIndex));
    }

    return {
      ok: true,
      parserId: 'gigachat3',
      calls,
      content: nonToolParts.join('').trim(),
    };
  },
};

/**
 * OpenAI tool-call parser.
 *
 * This is a no-op parser for vLLM's `--tool-call-parser openai` mode.
 * In this mode, vLLM returns native OpenAI-format tool_calls in the
 * API response, so no text parsing is needed.
 *
 * Synax handles OpenAI tool_calls natively via parseOpenAIToolCallsResult
 * in the client. This parser is a passthrough for explicit config:
 *   tool_call_parser = "openai"
 */
export const openaiPassthroughParser: ToolCallParser = {
  id: 'openai',
  description: 'OpenAI native tool calls (no text parsing needed — tool_calls arrive via API response)',
  modelFamilies: ['OpenAI', 'GPT-4', 'GPT-4o', 'GPT-oss'],

  parse(content: string): ToolCallParseResult {
    // OpenAI tool calls arrive via the API's tool_calls field, not in text content.
    // Any tool-call markup in the text is likely an artifact, skip it.
    return {
      ok: true,
      parserId: 'openai',
      calls: [],
      content,
    };
  },
};

// ─── Factories ────────────────────────────────────────────

export function createGraniteParser(): ToolCallParser {
  return graniteParser;
}
export function createGranite4Parser(): ToolCallParser {
  return granite4Parser;
}
export function createGranite20bFcParser(): ToolCallParser {
  return granite20bFcParser;
}
export function createInternlmParser(): ToolCallParser {
  return internlmParser;
}
export function createFunctionGemmaParser(): ToolCallParser {
  return functionGemmaParser;
}
export function createOlmo3Parser(): ToolCallParser {
  return olmo3Parser;
}
export function createJambaParser(): ToolCallParser {
  return jambaParser;
}
export function createMinimaxParser(): ToolCallParser {
  return minimaxParser;
}
export function createKimiK2Parser(): ToolCallParser {
  return kimiK2Parser;
}
export function createHunyuanA13bParser(): ToolCallParser {
  return hunyuanA13bParser;
}
export function createLongcatParser(): ToolCallParser {
  return longcatParser;
}
export function createGigachat3Parser(): ToolCallParser {
  return gigachat3Parser;
}
export function createOpenaiPassthroughParser(): ToolCallParser {
  return openaiPassthroughParser;
}
