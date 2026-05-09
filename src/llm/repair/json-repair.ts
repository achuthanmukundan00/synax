/**
 * JSON repair — bounded auto-recovery for local-model tool-call JSON.
 *
 * Local models frequently emit malformed JSON with:
 * - Trailing commas: {"name": "read", "args": {"path": "x",}}
 * - Unescaped inner quotes: {"query": "find "foo" in bar"}
 * - Truncated objects: {"name": "bash", "args": {"command": "npm te
 * - Missing closing braces: {"name": "edit", "args": {"path": "x", "oldStr": "y"
 * - Mixed format: prose + partial JSON blocks
 *
 * Each repair is recorded in `fixes[]` for debugging. Returns `null` when
 * the input is unrepairable (garbage, empty, or too broken to guess).
 */

export interface RepairResult {
  repaired: string;
  fixes: string[];
}

/**
 * Attempt to repair malformed JSON produced by a local model.
 *
 * Repairs are applied in increasing order of invasiveness:
 * 1. Trim whitespace and surrounding noise
 * 2. Fix trailing commas
 * 3. Balance braces/brackets
 * 4. Heuristic inner-quote repair
 *
 * Returns `null` if the string is unrepairable.
 */
export function repairJson(raw: string): RepairResult | null {
  const fixes: string[] = [];
  let working = raw.trim();

  if (!working) return null;

  // Step 0: Extract the probable JSON region from surrounding text
  const extracted = extractJsonRegion(working);
  if (extracted !== working) {
    fixes.push('extracted JSON from surrounding text');
    working = extracted;
  }

  if (!working) return null;

  // Step 1: Fix trailing commas
  const trailingFixed = fixTrailingCommas(working);
  if (trailingFixed !== working) {
    fixes.push('removed trailing commas');
    working = trailingFixed;
  }

  // Step 2: Fix unescaped inner quotes (heuristic, conservative)
  const quotesFixed = fixInnerQuotes(working);
  if (quotesFixed !== working) {
    fixes.push('escaped inner quotes');
    working = quotesFixed;
  }

  // Step 3: Balance braces and brackets
  const balanced = balanceBraces(working);
  if (balanced !== working) {
    fixes.push('balanced braces/brackets');
    working = balanced;
  }

  // Step 4: Try to parse. If it works, return the repaired text.
  if (isValidJson(working)) {
    return { repaired: working, fixes };
  }

  // Step 5: As a last resort, try trimming from the end (for truncated output)
  const truncated = fixTruncatedObject(working);
  if (truncated && truncated !== working) {
    fixes.push('recovered truncated object');
    working = truncated;
    if (isValidJson(working)) {
      return { repaired: working, fixes };
    }
  }

  // If nothing works, return null
  return null;
}

// ─── Internal helpers ─────────────────────────────────────

/**
 * Extract a JSON object or array from surrounding text.
 * Looks for the most likely JSON region.
 */
function extractJsonRegion(text: string): string {
  // If text starts with { or [, it's likely already focused
  if (text.startsWith('{') || text.startsWith('[')) return text;

  // Try to find JSON object
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');

  const start = objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
  if (start === -1) return text; // no JSON found, return as-is

  // Try to find matching closer
  const closer = text[start] === '{' ? '}' : ']';
  const opener = text[start];
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
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  // If no matching closer found, return from start to end
  return text.slice(start);
}

/**
 * Fix trailing commas before } or ].
 */
function fixTrailingCommas(json: string): string {
  // Replace comma before } or ] with just the brace
  return json.replace(/,\s*([}\]])/g, '$1');
}

/**
 * Heuristic: fix unescaped inner double-quotes inside string values.
 *
 * Pattern: string contains " like "this" which should be escaped.
 * This is conservative — only targets patterns where JSON parsing fails
 * due to quote collision within string values.
 */
function fixInnerQuotes(json: string): string {
  // This is inherently heuristic. We target the common case:
  // "key": "value with "unescaped" quotes inside"
  //
  // Strategy: find string values that contain un-escaped quotes.
  // We'll use the fact that a well-formed JSON string:
  // " starts a string, " ends it. Within a string, " is escaped as \".
  //
  // When we see a " that's inside what should be a string value
  // (preceded by :" or ," or {" or ["), and the next unescaped " would
  // make the JSON invalid, we escape it.

  const result: string[] = [];
  let inString = false;
  let inKey = false; // we're inside a key (before the colon)
  let escape = false;
  let colonSeen = false; // just saw colon, next value is a string likely

  for (let i = 0; i < json.length; i++) {
    const ch = json[i];

    if (escape) {
      escape = false;
      result.push(ch);
      continue;
    }

    if (ch === '\\') {
      escape = true;
      result.push(ch);
      continue;
    }

    if (ch === '"') {
      if (!inString) {
        inString = true;
        inKey = colonSeen ? false : true; // after colon, we're in a value
        colonSeen = false;
        result.push(ch);
      } else {
        // Closing a string — peek ahead to see if this is really the end
        // or if there's more string content that should have been escaped.
        const peek = json.slice(i + 1);
        const restTrimmed = peek.trimStart();

        // If the next non-whitespace is NOT one of: , } ] : (or end of input),
        // this is likely an inner quote that should have been escaped.
        // But only fix if we're in a string value (not a key).
        if (
          !inKey &&
          restTrimmed.length > 0 &&
          !restTrimmed.startsWith(',') &&
          !restTrimmed.startsWith('}') &&
          !restTrimmed.startsWith(']') &&
          !restTrimmed.startsWith(':') &&
          !restTrimmed.startsWith('\n') &&
          !restTrimmed.startsWith('\r')
        ) {
          // This is likely an inner quote — escape it
          result.push('\\');
        }
        inString = false;
        inKey = false;
        result.push(ch);
      }
      continue;
    }

    if (!inString && ch === ':') {
      colonSeen = true;
    } else if (!inString && (ch === ',' || ch === '{' || ch === '[')) {
      colonSeen = false;
    } else if (!inString && /\S/.test(ch)) {
      colonSeen = false;
    }

    result.push(ch);
  }

  return result.join('');
}

/**
 * Balance unclosed braces and brackets using a stack.
 * Adds missing closing chars at the end.
 */
function balanceBraces(json: string): string {
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
      // else: extra closer — we don't try to fix that
    }
  }

  // Only repair if the imbalance is reasonable
  if (stack.length === 0) return json;
  if (stack.length > 20) return json; // too broken
  return json + stack.reverse().join('');
}

/**
 * Attempt to recover a truncated JSON object.
 * Tries progressively removing the last character, then last comma-prefixed
 * segment, then adds a synthetic closing brace.
 */
function fixTruncatedObject(json: string): string | null {
  // Strategy: try to close the object by adding missing braces
  const balanced = balanceBraces(json);
  if (balanced !== json) return balanced;

  // If balancing didn't help and the string ends mid-value,
  // try truncating to the last complete key-value pair
  if (json.endsWith(',')) {
    // Already clean — just needs closing
    const cleaned = json + '}';
    if (isValidJson(cleaned)) return cleaned;

    // Try removing trailing comma and closing
    const alt = json.slice(0, -1) + '}';
    if (isValidJson(alt)) return alt;
  }

  // Try appending synthetic closing
  const synthetic = json.replace(/[^}\]]$/, '').trimEnd();
  const braces = countUnclosed(synthetic);
  if (braces > 0 && braces <= 5) {
    const closed = synthetic + '}'.repeat(braces);
    if (isValidJson(closed)) return closed;
  }

  return null;
}

function countUnclosed(json: string): number {
  let depth = 0;
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
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return Math.max(0, depth);
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
