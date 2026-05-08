/**
 * Shared parsing utilities for Synax tool-call parsers.
 *
 * These are the building blocks used by individual parser implementations.
 * They handle reasoning-tag sanitization, JSON repair, safe value coercion,
 * call id generation, and safe Pythonic argument parsing.
 */

import type { ParsedToolCall } from './types';

// ─── Reasoning-tag sanitization ─────────────────────────

/**
 * Strip <think>/<thinking> reasoning tags from model output.
 * These tags are model-internal and should not affect tool-call parsing.
 */
export function sanitizeReasoningTags(content: string): string {
  return content.replace(/<(think|thinking)\b[^>]*>[\s\S]*?<\/\1>/gi, '').trim();
}

// ─── JSON parsing with repair ───────────────────────────

/**
 * Parse JSON with limited repair for common local-model mistakes:
 * - Trailing commas in objects/arrays
 * - Missing closing braces/brackets
 * - Bare keys without quotes in simple cases
 *
 * This is intentionally conservative. Complex repair often masks real errors.
 */
export function safeJsonParse(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'empty input' };

  // Try direct parse first
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // continue to repair
  }

  // Repair 1: trailing commas
  const noTrailing = trimmed.replace(/,\s*([}\]])/g, '$1');
  try {
    return { ok: true, value: JSON.parse(noTrailing) };
  } catch {
    // continue
  }

  // Repair 2: unclosed braces/brackets (simple stack-based)
  const repaired = repairUnclosed(noTrailing);
  if (repaired) {
    try {
      return { ok: true, value: JSON.parse(repaired) };
    } catch {
      // continue
    }
  }

  // Repair 3: extract from surrounding text (model sometimes wraps JSON in prose)
  const extracted = extractJsonObject(trimmed);
  if (extracted) {
    try {
      return { ok: true, value: JSON.parse(extracted) };
    } catch {
      // continue
    }
  }

  return { ok: false, error: `could not parse JSON: ${trimmed.slice(0, 120)}` };
}

/**
 * Repair unclosed braces/brackets by adding missing closing chars.
 */
function repairUnclosed(json: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (const ch of json) {
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

    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === ch) {
        stack.pop();
      }
    }
  }

  if (stack.length === 0) return null; // no repair needed
  // Only repair if the imbalance is reasonable (< 10 unclosed)
  if (stack.length > 10) return null;
  return json + stack.reverse().join('');
}

/**
 * Extract a JSON object from text that may have prose around it.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  // Find matching closing brace
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
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
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // unclosed
}

// ─── Call id generation ──────────────────────────────────

let callIdCounter = 0;

/**
 * Generate a deterministic-ish call id.
 * Uses the model-provided id if available, otherwise `call_N`.
 */
export function generateCallId(provided?: string, index?: number): string {
  if (provided && provided.trim().length > 0) return provided.trim();
  const idx = index ?? ++callIdCounter;
  return `call_${idx}`;
}

/** Reset the call id counter (useful for tests). */
export function resetCallIdCounter(): void {
  callIdCounter = 0;
}

// ─── Safe value coercion ─────────────────────────────────

/**
 * Coerce a string value to the appropriate JS type for common literal forms.
 * Handles: booleans, null, numbers, quoted strings, nested JSON.
 * Strings that don't match any known literal are returned as-is.
 */
export function coerceValue(raw: string): unknown {
  const trimmed = raw.trim();

  // Booleans
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // Null
  if (trimmed === 'null') return null;

  // None (Pythonic)
  if (trimmed === 'None') return null;

  // Numbers (including negative, decimals, scientific notation)
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  // Quoted strings — unquote
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }

  // Nested JSON objects/arrays
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    const parsed = safeJsonParse(trimmed);
    if (parsed.ok) return parsed.value;
  }

  return trimmed;
}

// ─── Helper for building parsed calls ────────────────────

export function makeCall(
  name: string,
  args: Record<string, unknown>,
  opts: { id?: string; index?: number; rawSource?: string; parserId?: string; warnings?: string[] } = {},
): ParsedToolCall {
  const warnings = [...(opts.warnings ?? [])];
  return {
    id: generateCallId(opts.id, opts.index),
    name,
    arguments: args,
    rawSource: opts.rawSource,
    parserId: opts.parserId,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

// ─── Safe Pythonic argument parsing ──────────────────────

/**
 * Parse a Pythonic function-call argument string into key-value pairs.
 *
 * Example input: `location="San Francisco", unit='celsius', count=42`
 * Returns: `{ location: "San Francisco", unit: "celsius", count: 42 }`
 *
 * This is a safe tokenizer — it does NOT eval anything.
 */
export function parsePythonicArgs(argsStr: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!argsStr.trim()) return result;

  const tokens = tokenizePythonicArgs(argsStr);
  let i = 0;

  while (i < tokens.length) {
    // Expect: identifier = value
    if (i >= tokens.length) break;
    const keyToken = tokens[i];
    if (keyToken.type !== 'identifier') {
      i++;
      continue;
    }
    const key = keyToken.value;
    i++;

    // Skip '='
    if (i < tokens.length && tokens[i].type === 'operator' && tokens[i].value === '=') {
      i++;
    } else {
      // Positional arg or missing value — skip
      continue;
    }

    // Value
    if (i < tokens.length) {
      const valToken = tokens[i];
      result[key] = coercePythonicValue(valToken);
      i++;
      // Skip comma
      if (i < tokens.length && tokens[i].type === 'operator' && tokens[i].value === ',') {
        i++;
      }
    }
  }

  return result;
}

interface PyToken {
  type: 'identifier' | 'string' | 'number' | 'operator' | 'name' | 'other';
  value: string;
}

function tokenizePythonicArgs(input: string): PyToken[] {
  const tokens: PyToken[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    // Whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Operator/comma/eq
    if (ch === ',' || ch === '=') {
      tokens.push({ type: 'operator', value: ch });
      i++;
      continue;
    }

    // Single-quoted string
    if (ch === "'") {
      i++;
      let val = '';
      while (i < input.length && input[i] !== "'") {
        if (input[i] === '\\' && i + 1 < input.length) {
          val += input[++i];
        } else {
          val += input[i];
        }
        i++;
      }
      if (i < input.length) i++; // closing quote
      tokens.push({ type: 'string', value: val });
      continue;
    }

    // Double-quoted string
    if (ch === '"') {
      i++;
      let val = '';
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          val += input[++i];
        } else {
          val += input[i];
        }
        i++;
      }
      if (i < input.length) i++; // closing quote
      tokens.push({ type: 'string', value: val });
      continue;
    }

    // Number
    if (/[-\d]/.test(ch)) {
      const start = i;
      if (ch === '-') i++;
      while (i < input.length && /[\d.eE+-]/.test(input[i])) i++;
      const numStr = input.slice(start, i);
      if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(numStr)) {
        tokens.push({ type: 'number', value: numStr });
        continue;
      }
      // Not a valid number, back up
      i = start;
    }

    // Identifier / name
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      while (i < input.length && /[\w.]/.test(input[i])) i++;
      const val = input.slice(start, i);
      if (val === 'True') tokens.push({ type: 'name', value: 'True' });
      else if (val === 'False') tokens.push({ type: 'name', value: 'False' });
      else if (val === 'None') tokens.push({ type: 'name', value: 'None' });
      else tokens.push({ type: 'identifier', value: val });
      continue;
    }

    // Anything else
    tokens.push({ type: 'other', value: ch });
    i++;
  }

  return tokens;
}

function coercePythonicValue(token: PyToken): unknown {
  switch (token.type) {
    case 'string':
      return token.value;
    case 'number':
      return Number(token.value);
    case 'name':
      if (token.value === 'True') return true;
      if (token.value === 'False') return false;
      if (token.value === 'None') return null;
      return token.value;
    case 'identifier':
      // Bare identifier in value position — treat as string
      return token.value;
    default:
      return token.value;
  }
}

// ─── Tool-call delimiter extraction ──────────────────────

/**
 * Split content into segments separated by tool-call blocks.
 * Returns { before, blocks, between } where:
 * - before is text before the first block
 * - blocks is an array of matched tool-call text
 * - between is text after the last block
 */
export interface DelimitedResult {
  before: string;
  blocks: string[];
  between: string[];
  after: string;
}

export function extractDelimitedBlocks(content: string, openTag: string, closeTag: string): DelimitedResult {
  const blocks: string[] = [];
  const between: string[] = [];

  // Find first occurrence
  const firstOpen = content.indexOf(openTag);
  if (firstOpen === -1) {
    return { before: content, blocks: [], between: [], after: '' };
  }
  const before = content.slice(0, firstOpen);
  let remaining = content.slice(firstOpen);

  while (remaining.length > 0) {
    const openIdx = remaining.indexOf(openTag);

    if (openIdx === -1) {
      // No more open tags — remaining is trailing text
      between.push(remaining);
      break;
    }

    if (openIdx > 0) {
      // Text between blocks
      between.push(remaining.slice(0, openIdx));
      remaining = remaining.slice(openIdx);
      continue;
    }

    // openIdx === 0 — we're at an open tag
    // Find matching close tag
    const closeIdx = remaining.indexOf(closeTag, openTag.length);
    if (closeIdx === -1) {
      // No matching close tag — treat remaining as text
      between.push(remaining);
      break;
    }

    const block = remaining.slice(openTag.length, closeIdx);
    blocks.push(block);
    remaining = remaining.slice(closeIdx + closeTag.length);
  }

  return {
    before,
    blocks,
    between,
    after: '', // No trailing after — all covered by between or blocks
  };
}

// ─── Content extraction helpers ─────────────────────────

/**
 * Extract all content that is NOT inside tool-call delimiters.
 * Used to separate tool calls from prose for transcript rendering.
 */
export function extractNonToolContent(content: string, openTag: string, closeTag: string): string {
  const delimited = extractDelimitedBlocks(content, openTag, closeTag);

  const parts: string[] = [];
  if (delimited.before.trim()) parts.push(delimited.before);
  for (const b of delimited.between) {
    if (b.trim()) parts.push(b);
  }
  if (delimited.after.trim()) parts.push(delimited.after);

  return parts.join('\n').trim();
}

// ─── Multiple pattern extraction ─────────────────────────

/**
 * Try to find a pattern anywhere in the text (not just at start).
 * Returns the match and the text before/after for multi-pattern parsing.
 */
export function findPattern(
  content: string,
  regex: RegExp,
): { match: RegExpMatchArray; before: string; after: string } | null {
  const m = regex.exec(content);
  if (!m) return null;
  return {
    match: m,
    before: content.slice(0, m.index),
    after: content.slice(m.index + m[0].length),
  };
}
