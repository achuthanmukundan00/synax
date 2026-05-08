/**
 * Generic tool-call parser (fallback).
 *
 * This is Synax's existing content-based tool-call parsing, preserved as
 * the "generic" parser. It tries multiple strategies:
 *
 * 1. <tool_call>{"name":"...","arguments":{...}}</tool_call> blocks (Hermes-style)
 * 2. ```json fenced code blocks
 * 3. Bare JSON objects (last resort)
 *
 * This parser is the safe default when no specific parser is configured
 * or auto-detected.
 *
 * It also supports the Qwen3 XML format via alias ('qwen3_coder' maps to 'qwen3_xml').
 */

import type { ToolCallParser, ToolCallParseResult, ParsedToolCall } from './types';
import { extractDelimitedBlocks, safeJsonParse, generateCallId, sanitizeReasoningTags } from './utils';

const PARSER_ID = 'generic';
const DESCRIPTION = 'Generic multi-strategy fallback: tries Hermes-style, fenced JSON, and bare JSON';
const FAMILIES = ['Any', 'Unknown', 'Generic'];

export const genericParser: ToolCallParser = {
  id: PARSER_ID,
  description: DESCRIPTION,
  modelFamilies: FAMILIES,

  parse(content: string): ToolCallParseResult {
    const sanitized = sanitizeReasoningTags(content);
    const calls: ParsedToolCall[] = [];
    const warnings: string[] = [];

    // Strategy 1: <tool_call>...</tool_call> blocks
    const toolCallBlocks = extractDelimitedBlocks(sanitized, '<tool_call>', '</tool_call>');
    let sawMalformedBlock = false;

    for (const block of toolCallBlocks.blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      const parsed = safeJsonParse(trimmed);
      if (!parsed.ok) {
        sawMalformedBlock = true;
        continue;
      }

      if (typeof parsed.value !== 'object' || parsed.value === null) {
        sawMalformedBlock = true;
        continue;
      }

      const obj = parsed.value as Record<string, unknown>;

      // Check for array of tool_calls (OpenAI-style wrapped)
      if (Array.isArray(obj.tool_calls)) {
        for (const tc of obj.tool_calls) {
          if (tc && typeof tc === 'object') {
            const tcObj = tc as Record<string, unknown>;
            const fn = tcObj.function;
            if (fn && typeof fn === 'object') {
              const fnObj = fn as Record<string, unknown>;
              const name = fnObj.name;
              if (typeof name === 'string') {
                const args = parseArgsValue(fnObj.arguments);
                calls.push({
                  id: generateCallId((tcObj.id ?? fnObj.id) as string | undefined, calls.length + 1),
                  name,
                  arguments: args,
                  rawSource: JSON.stringify(tc),
                  parserId: PARSER_ID,
                });
              }
            }
          }
        }
        continue;
      }

      // Single named call
      const name = obj.name ?? obj.tool_name;
      if (typeof name !== 'string' || !name.trim()) {
        sawMalformedBlock = true;
        continue;
      }

      const args = parseArgsValue(obj.arguments ?? obj.parameters ?? obj.input);
      calls.push({
        id: generateCallId((obj.id ?? obj.call_id) as string | undefined, calls.length + 1),
        name: name.trim(),
        arguments: args,
        rawSource: trimmed,
        parserId: PARSER_ID,
      });
    }

    // Strategy 2: ```json fenced code blocks
    const fencedBlocks = extractFencedJsonBlocks(sanitized);
    for (const block of fencedBlocks) {
      const parsed = safeJsonParse(block);
      if (!parsed.ok) continue;
      if (typeof parsed.value !== 'object' || parsed.value === null) continue;
      const obj = parsed.value as Record<string, unknown>;

      // Handle OpenAI-style tool_calls array inside the block
      if (Array.isArray(obj.tool_calls)) {
        for (const tc of obj.tool_calls) {
          if (tc && typeof tc === 'object') {
            const tcObj = tc as Record<string, unknown>;
            const fn = tcObj.function;
            if (fn && typeof fn === 'object') {
              const fnObj = fn as Record<string, unknown>;
              const name = fnObj.name;
              if (typeof name === 'string') {
                const args = parseArgsValue(fnObj.arguments);
                calls.push({
                  id: generateCallId((tcObj.id ?? fnObj.id) as string | undefined, calls.length + 1),
                  name,
                  arguments: args,
                  rawSource: JSON.stringify(tc),
                  parserId: PARSER_ID,
                  warnings: ['parsed from fenced code block'],
                });
              }
            }
          }
        }
        continue;
      }

      // Handle single named call in fenced block
      const name = obj.name ?? obj.tool_name;
      if (typeof name !== 'string' || !name.trim()) continue;
      const args = parseArgsValue(obj.arguments ?? obj.parameters ?? obj.input);
      calls.push({
        id: generateCallId((obj.id ?? obj.call_id) as string | undefined, calls.length + 1),
        name: name.trim(),
        arguments: args,
        rawSource: block,
        parserId: PARSER_ID,
        warnings: ['parsed from fenced code block'],
      });
    }

    // Strategy 3: Bare JSON object (last resort, only when no other calls found)
    if (calls.length === 0) {
      const trimmed = sanitized.trim();
      if (trimmed.startsWith('{')) {
        const parsed = safeJsonParse(trimmed);
        if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null) {
          const obj = parsed.value as Record<string, unknown>;

          // Handle OpenAI-style tool_calls array
          if (Array.isArray(obj.tool_calls)) {
            for (const tc of obj.tool_calls) {
              if (tc && typeof tc === 'object') {
                const tcObj = tc as Record<string, unknown>;
                const fn = tcObj.function;
                if (fn && typeof fn === 'object') {
                  const fnObj = fn as Record<string, unknown>;
                  const name = fnObj.name;
                  if (typeof name === 'string') {
                    const args = parseArgsValue(fnObj.arguments);
                    calls.push({
                      id: generateCallId((tcObj.id ?? fnObj.id) as string | undefined, calls.length + 1),
                      name,
                      arguments: args,
                      rawSource: JSON.stringify(tc),
                      parserId: PARSER_ID,
                      warnings: ['parsed from bare JSON text'],
                    });
                  }
                }
              }
            }
          } else {
            const name = obj.name ?? obj.tool_name;
            if (typeof name === 'string' && name.trim()) {
              const args = parseArgsValue(obj.arguments ?? obj.parameters ?? obj.input);
              calls.push({
                id: generateCallId((obj.id ?? obj.call_id) as string | undefined, 1),
                name: name.trim(),
                arguments: args,
                rawSource: trimmed,
                parserId: PARSER_ID,
                warnings: ['parsed from bare JSON text'],
              });
            }
          }
        }
      }
    }

    // If we saw malformed blocks but found no calls, check if the content
    // is actually a standalone tool-call response (not inside prose/code blocks).
    // Only flag as error if the malformed blocks appear to be intentional tool calls.
    if (sawMalformedBlock && calls.length === 0 && toolCallBlocks.blocks.length > 0) {
      if (isStandaloneToolCallContent(sanitized, toolCallBlocks)) {
        return {
          ok: false,
          parserId: PARSER_ID,
          calls: [],
          content: sanitized,
          error: 'tool_call block contained malformed JSON',
        };
      }
    }

    // Compute non-tool content
    let nonToolContent = sanitized;
    if (toolCallBlocks.blocks.length > 0) {
      nonToolContent = [toolCallBlocks.before, ...toolCallBlocks.between, toolCallBlocks.after]
        .filter(Boolean)
        .join('\n')
        .trim();
    } else {
      nonToolContent = sanitized;
    }

    return {
      ok: true,
      parserId: PARSER_ID,
      calls,
      content: nonToolContent,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  },
};

// ─── Helpers ──────────────────────────────────────────────

function parseArgsValue(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    const parsed = safeJsonParse(raw);
    if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null && !Array.isArray(parsed.value)) {
      return parsed.value as Record<string, unknown>;
    }
  } else if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function extractFencedJsonBlocks(content: string): string[] {
  return [...content.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)].map((m) => m[1]);
}

/**
 * Check if the content is primarily a tool-call response (standalone blocks).
 * If tool_calls appear inside prose/fenced code, they are likely examples.
 */
function isStandaloneToolCallContent(content: string, blocks: ReturnType<typeof extractDelimitedBlocks>): boolean {
  // If content is entirely within fenced code blocks, it's not a standalone tool call
  const fencedContent = content.match(/```[\s\S]*?```/g);
  if (fencedContent) {
    for (const fenced of fencedContent) {
      if (fenced.includes('<tool_call>')) return false;
    }
  }

  // If there's substantial non-whitespace content before the first block, not standalone
  if (blocks.before.trim().length > 0) {
    // Allow a short preamble (like model intro text) but not full prose
    if (blocks.before.trim().split(/\s+/).length > 5) return false;
  }

  // If there's text between blocks that looks like prose, not standalone
  for (const between of blocks.between) {
    if (between.trim().split(/\s+/).length > 5) return false;
  }

  // If there's substantial text after the last block, not standalone
  if (blocks.after.trim().split(/\s+/).length > 5) return false;

  return true;
}

// ─── Factory ──────────────────────────────────────────────

export function createGenericParser(): ToolCallParser {
  return genericParser;
}
