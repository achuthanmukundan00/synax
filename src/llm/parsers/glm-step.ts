/**
 * GLM and Step tool-call parsers.
 *
 * GLM 4.5/4.7 models and Step 3/3.5 models use specialized tool-call formats.
 *
 * GLM format (as documented by vLLM):
 *   Uses a function-call token followed by a JSON object:
 *   <|tool_call|>{"name": "get_weather", "arguments": {"location": "SF"}}
 *
 * Step 3 format:
 *   Uses XML-style tags similar to Qwen but with Step-specific markup.
 *
 * These parsers are currently stubs that fall back to Hermes-style parsing
 * and will be refined as format-specific documentation becomes available.
 *
 * Reference: vLLM
 *   --tool-call-parser glm45, glm47, step3, step3p5
 */

import type { ToolCallParser, ToolCallParseResult } from './types';
import { extractDelimitedBlocks, safeJsonParse, generateCallId, sanitizeReasoningTags } from './utils';

// ─── GLM 4.5 ──────────────────────────────────────────────

export const glm45Parser: ToolCallParser = {
  id: 'glm45',
  description: 'GLM-4.5 format: special-token-delimited tool calls with JSON',
  modelFamilies: ['GLM-4.5', 'GLM-4', 'ChatGLM'],

  parse(content: string): ToolCallParseResult {
    const sanitized = sanitizeReasoningTags(content);

    // GLM uses <|tool_call|> special tokens
    const toolCallToken = '<|tool_call|>';
    const calls = parseSpecialTokenBlocks(sanitized, toolCallToken, 'glm45');

    if (calls.length > 0) {
      const nonTool = sanitized
        .replace(new RegExp(toolCallToken.replace(/[|]/g, '\\|') + '[\\s\\S]*?(?=<|$)', 'g'), '')
        .trim();
      return { ok: true, parserId: 'glm45', calls, content: nonTool };
    }

    // Fallback: Hermes-style
    return parseHermesFallback(sanitized, 'glm45');
  },
};

// ─── GLM 4.7 ──────────────────────────────────────────────

export const glm47Parser: ToolCallParser = {
  id: 'glm47',
  description: 'GLM-4.7 format: special-token-delimited tool calls with JSON',
  modelFamilies: ['GLM-4.7'],

  parse(content: string): ToolCallParseResult {
    const sanitized = sanitizeReasoningTags(content);

    const toolCallToken = '<|tool_call|>';
    const calls = parseSpecialTokenBlocks(sanitized, toolCallToken, 'glm47');

    if (calls.length > 0) {
      const nonTool = sanitized
        .replace(new RegExp(toolCallToken.replace(/[|]/g, '\\|') + '[\\s\\S]*?(?=<|$)', 'g'), '')
        .trim();
      return { ok: true, parserId: 'glm47', calls, content: nonTool };
    }

    return parseHermesFallback(sanitized, 'glm47');
  },
};

// ─── Step 3 ───────────────────────────────────────────────

export const step3Parser: ToolCallParser = {
  id: 'step3',
  description: 'Step 3 format: XML/tag-delimited tool calls (format TBD from vLLM docs)',
  modelFamilies: ['Step 3', 'Step-3'],

  parse(content: string): ToolCallParseResult {
    const sanitized = sanitizeReasoningTags(content);

    // Step models may use <tool_call> or <function_call> tags
    const tcDelimited = extractDelimitedBlocks(sanitized, '<tool_call>', '</tool_call>');
    const fcDelimited = extractDelimitedBlocks(sanitized, '<function_call>', '</function_call>');

    const blocks = [...tcDelimited.blocks, ...fcDelimited.blocks];
    if (blocks.length > 0) {
      return parseHermesFallback(sanitized, 'step3');
    }

    // Fallback: try Qwen-style XML
    return parseQwenFallback(sanitized, 'step3');
  },
};

// ─── Step 3.5 ─────────────────────────────────────────────

export const step3p5Parser: ToolCallParser = {
  id: 'step3p5',
  description: 'Step 3.5 format: XML/tag-delimited tool calls (format TBD from vLLM docs)',
  modelFamilies: ['Step 3.5', 'Step-3.5'],

  parse(content: string): ToolCallParseResult {
    const sanitized = sanitizeReasoningTags(content);
    const tcDelimited = extractDelimitedBlocks(sanitized, '<tool_call>', '</tool_call>');
    const fcDelimited = extractDelimitedBlocks(sanitized, '<function_call>', '</function_call>');

    const blocks = [...tcDelimited.blocks, ...fcDelimited.blocks];
    if (blocks.length > 0) {
      return parseHermesFallback(sanitized, 'step3p5');
    }
    return parseQwenFallback(sanitized, 'step3p5');
  },
};

// ─── Shared helpers ───────────────────────────────────────

function parseSpecialTokenBlocks(content: string, token: string, parserId: string) {
  const calls: Array<import('./types').ParsedToolCall> = [];
  let remaining = content;

  while (remaining.length > 0) {
    const idx = remaining.indexOf(token);
    if (idx === -1) break;

    const bodyStart = idx + token.length;
    const body = remaining.slice(bodyStart).trim();

    if (body.startsWith('{')) {
      // Find balanced JSON
      let depth = 0;
      let inString = false;
      let escape = false;
      let jsonEnd = -1;

      for (let i = 0; i < body.length; i++) {
        const ch = body[i];
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
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            jsonEnd = i;
            break;
          }
        }
      }

      if (jsonEnd !== -1) {
        const jsonStr = body.slice(0, jsonEnd + 1);
        const parsed = safeJsonParse(jsonStr);
        if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null && !Array.isArray(parsed.value)) {
          const obj = parsed.value as Record<string, unknown>;
          const name = obj.name ?? obj.tool_name;
          if (typeof name === 'string' && name.trim()) {
            let args: Record<string, unknown> = {};
            const rawArgs = obj.arguments ?? obj.parameters;
            if (typeof rawArgs === 'string') {
              const pa = safeJsonParse(rawArgs);
              if (pa.ok && typeof pa.value === 'object' && pa.value !== null && !Array.isArray(pa.value)) {
                args = pa.value as Record<string, unknown>;
              }
            } else if (typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)) {
              args = rawArgs as Record<string, unknown>;
            }
            calls.push({
              id: generateCallId(undefined, calls.length + 1),
              name: name.trim(),
              arguments: args,
              rawSource: jsonStr,
              parserId,
            });
          }
        }
        remaining = body.slice(jsonEnd + 1);
      } else {
        remaining = body;
      }
    } else {
      remaining = body;
    }
  }

  return calls;
}

function parseHermesFallback(sanitized: string, parserId: string): ToolCallParseResult {
  // Try both <tool_call> and <function_call> delimiters
  const tcDelimited = extractDelimitedBlocks(sanitized, '<tool_call>', '</tool_call>');
  const fcDelimited = extractDelimitedBlocks(sanitized, '<function_call>', '</function_call>');
  const allBlocks = [...tcDelimited.blocks, ...fcDelimited.blocks];

  if (allBlocks.length === 0) {
    return { ok: true, parserId, calls: [], content: sanitized };
  }

  const calls: Array<import('./types').ParsedToolCall> = [];
  for (let i = 0; i < allBlocks.length; i++) {
    const block = allBlocks[i].trim();
    if (!block) continue;
    const parsed = safeJsonParse(block);
    if (!parsed.ok)
      return {
        ok: false,
        parserId,
        calls: [],
        content: sanitized,
        error: `${parserId} block ${i + 1}: ${parsed.error}`,
      };

    if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
      return {
        ok: false,
        parserId,
        calls: [],
        content: sanitized,
        error: `${parserId} block ${i + 1}: expected JSON object`,
      };
    }
    const obj = parsed.value as Record<string, unknown>;
    const name = obj.name ?? obj.tool_name;
    if (typeof name !== 'string' || !name.trim()) {
      return {
        ok: false,
        parserId,
        calls: [],
        content: sanitized,
        error: `${parserId} block ${i + 1}: missing "name"`,
      };
    }

    let args: Record<string, unknown> = {};
    const rawArgs = obj.arguments ?? obj.parameters;
    if (typeof rawArgs === 'string') {
      const pa = safeJsonParse(rawArgs);
      if (pa.ok && typeof pa.value === 'object' && pa.value !== null && !Array.isArray(pa.value))
        args = pa.value as Record<string, unknown>;
    } else if (typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)) {
      args = rawArgs as Record<string, unknown>;
    }

    calls.push({
      id: generateCallId(undefined, i + 1),
      name: name.trim(),
      arguments: args,
      rawSource: block,
      parserId,
    });
  }

  const nonTool = [
    tcDelimited.before,
    ...tcDelimited.between,
    tcDelimited.after,
    fcDelimited.before,
    ...fcDelimited.between,
    fcDelimited.after,
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
  return { ok: true, parserId, calls, content: nonTool };
}

function parseQwenFallback(sanitized: string, parserId: string): ToolCallParseResult {
  const delimited = extractDelimitedBlocks(sanitized, '<tool_call>', '</tool_call>');
  if (delimited.blocks.length === 0) {
    return { ok: true, parserId, calls: [], content: sanitized };
  }

  const calls: Array<import('./types').ParsedToolCall> = [];
  for (let i = 0; i < delimited.blocks.length; i++) {
    const block = delimited.blocks[i];
    const fnMatch = block.match(/<function=([^>\s]+)>\s*([\s\S]*?)\s*<\/function>/i);
    if (!fnMatch || !fnMatch[1]) {
      return { ok: false, parserId, calls: [], content: sanitized, error: `${parserId} block missing <function=...>` };
    }

    const args: Record<string, unknown> = {};
    const paramRegex = /<parameter=([^>\s]+)>\s*([\s\S]*?)\s*<\/parameter>/gi;
    for (const param of block.matchAll(paramRegex)) {
      const key = param[1]?.trim();
      if (key) args[key] = (param[2] ?? '').trim();
    }

    calls.push({
      id: generateCallId(undefined, i + 1),
      name: fnMatch[1].trim(),
      arguments: args,
      rawSource: block,
      parserId,
    });
  }

  const nonTool = [delimited.before, ...delimited.between, delimited.after].filter(Boolean).join('\n').trim();
  return { ok: true, parserId, calls, content: nonTool };
}

// ─── Factories ────────────────────────────────────────────

export function createGlm45Parser(): ToolCallParser {
  return glm45Parser;
}
export function createGlm47Parser(): ToolCallParser {
  return glm47Parser;
}
export function createStep3Parser(): ToolCallParser {
  return step3Parser;
}
export function createStep3p5Parser(): ToolCallParser {
  return step3p5Parser;
}
