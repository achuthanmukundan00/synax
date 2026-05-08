/**
 * Pythonic tool-call parser.
 *
 * Parses Python-list-format tool calls used by models that generate
 * Python syntax for function calls:
 *
 *   [get_weather(city='San Francisco', metric='celsius'),
 *    get_weather(city='Seattle', metric='celsius')]
 *
 * Also supports bare calls without the list wrapper:
 *
 *   get_weather(city='San Francisco', metric='celsius')
 *
 * This parser uses a safe tokenizer — it does NOT eval anything.
 * Supports parallel tool calls (multiple functions in one list).
 *
 * Variants:
 *   - pythonic: general Pythonic list format
 *   - llama4_pythonic: subset with Llama-4-specific handling
 *
 * Reference: vLLM docs/features/tool_calling.md → "Models with Pythonic Tool Calls"
 *   --tool-call-parser pythonic
 *   vllm/entrypoints/openai/tool_parsers/pythonic_tool_parser.py
 */

import type { ToolCallParser, ToolCallParseResult, ParsedToolCall } from './types';
import { parsePythonicArgs, generateCallId, sanitizeReasoningTags } from './utils';

// ─── Token types ──────────────────────────────────────────

interface Token {
  type: 'lparen' | 'rparen' | 'lbracket' | 'rbracket' | 'comma' | 'name' | 'text' | 'whitespace';
  value: string;
  pos: number;
}

// ─── Shared parser logic ──────────────────────────────────

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    // Whitespace
    if (/\s/.test(ch)) {
      const start = i;
      while (i < input.length && /\s/.test(input[i])) i++;
      tokens.push({ type: 'whitespace', value: input.slice(start, i), pos: start });
      continue;
    }

    // Brackets/parens
    if (ch === '(') {
      tokens.push({ type: 'lparen', value: '(', pos: i });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ')', pos: i });
      i++;
      continue;
    }
    if (ch === '[') {
      tokens.push({ type: 'lbracket', value: '[', pos: i });
      i++;
      continue;
    }
    if (ch === ']') {
      tokens.push({ type: 'rbracket', value: ']', pos: i });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ',', pos: i });
      i++;
      continue;
    }

    // Strings (single or double quoted)
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i++;
      while (i < input.length && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < input.length) i++;
        i++;
      }
      if (i < input.length) i++; // closing quote
      tokens.push({ type: 'text', value: input.slice(start, i), pos: start });
      continue;
    }

    // Names/identifiers
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      while (i < input.length && /[\w.]/.test(input[i])) i++;
      tokens.push({ type: 'name', value: input.slice(start, i), pos: start });
      continue;
    }

    // Anything else as text
    tokens.push({ type: 'text', value: ch, pos: i });
    i++;
  }

  return tokens;
}

function parsePythonicCalls(text: string, parserId: string): { calls: ParsedToolCall[]; remainder: string } {
  const tokens = tokenize(text);
  const calls: ParsedToolCall[] = [];
  const nonCallTokens: Token[] = [];

  let i = 0;
  while (i < tokens.length) {
    // Skip whitespace in non-call context
    while (i < tokens.length && tokens[i].type === 'whitespace') {
      nonCallTokens.push(tokens[i]);
      i++;
    }
    if (i >= tokens.length) break;

    // Check for function call pattern: name ( args )
    if (tokens[i].type === 'name' && i + 1 < tokens.length && tokens[i + 1].type === 'lparen') {
      const fnName = tokens[i].value;
      i += 2; // skip name and '('

      // Collect args until matching ')'
      let depth = 1;
      const argTokens: Token[] = [];
      while (i < tokens.length && depth > 0) {
        const tok = tokens[i];
        if (tok.type === 'lparen') depth++;
        else if (tok.type === 'rparen') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        argTokens.push(tok);
        i++;
      }

      if (depth === 0) {
        // Successfully parsed a function call
        const argsStr = argTokens.map((t) => t.value).join('');
        const args = parsePythonicArgs(argsStr);
        calls.push({
          id: generateCallId(undefined, calls.length + 1),
          name: fnName,
          arguments: args,
          rawSource: `${fnName}(${argsStr})`,
          parserId,
        });

        // Check for comma after call
        while (i < tokens.length && tokens[i].type === 'whitespace') i++;
        if (i < tokens.length && tokens[i].type === 'comma') {
          i++; // skip comma
        }
        continue;
      }
    }

    // Check for list wrapper: [ call1, call2, ... ]
    if (tokens[i].type === 'lbracket') {
      const listStart = i;
      i++; // skip '['
      let depth = 1;
      const listTokens: Token[] = [];

      while (i < tokens.length && depth > 0) {
        const tok = tokens[i];
        if (tok.type === 'lbracket') depth++;
        else if (tok.type === 'rbracket') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        listTokens.push(tok);
        i++;
      }

      if (depth === 0) {
        // Recursively parse the list contents
        const listContent = listTokens.map((t) => t.value).join('');
        const nested = parsePythonicCalls(listContent, parserId);
        for (const call of nested.calls) {
          calls.push(call);
        }
        // Check for comma after list
        while (i < tokens.length && tokens[i].type === 'whitespace') i++;
        if (i < tokens.length && tokens[i].type === 'comma') {
          i++;
        }
        continue;
      }

      // Unclosed bracket — push remaining as non-call
      nonCallTokens.push(tokens[listStart]);
      for (let j = listStart + 1; j < i; j++) {
        nonCallTokens.push(tokens[j]);
      }
      continue;
    }

    // Not a function call — accumulate as non-call text
    nonCallTokens.push(tokens[i]);
    i++;
  }

  const remainder = nonCallTokens
    .map((t) => t.value)
    .join('')
    .trim();
  return { calls, remainder };
}

// ─── Parser instances ─────────────────────────────────────

const PYTHONIC_DESCRIPTION = 'Pythonic list format: [func_name(key="value", ...), ...]';
const PYTHONIC_FAMILIES = ['Llama 4', 'Pythonic-capable models'];

export const pythonicParser: ToolCallParser = {
  id: 'pythonic',
  description: PYTHONIC_DESCRIPTION,
  modelFamilies: PYTHONIC_FAMILIES,

  parse(content: string): ToolCallParseResult {
    const sanitized = sanitizeReasoningTags(content);
    const { calls, remainder } = parsePythonicCalls(sanitized, 'pythonic');

    return {
      ok: true,
      parserId: 'pythonic',
      calls,
      content: remainder,
    };
  },
};

export const llama4PythonicParser: ToolCallParser = {
  id: 'llama4_pythonic',
  description: 'Llama 4 Pythonic format: same as pythonic but with Llama-4-specific patterns',
  modelFamilies: ['Llama 4'],

  parse(content: string): ToolCallParseResult {
    const sanitized = sanitizeReasoningTags(content);

    // Llama 4 may wrap calls in <|python_tag|> — strip those
    const cleaned = sanitized.replace(/<\|python_tag\|>/gi, '').trim();

    const { calls, remainder } = parsePythonicCalls(cleaned, 'llama4_pythonic');

    return {
      ok: true,
      parserId: 'llama4_pythonic',
      calls,
      content: remainder,
    };
  },
};

// ─── Factories ────────────────────────────────────────────

export function createPythonicParser(): ToolCallParser {
  return pythonicParser;
}

export function createLlama4PythonicParser(): ToolCallParser {
  return llama4PythonicParser;
}
