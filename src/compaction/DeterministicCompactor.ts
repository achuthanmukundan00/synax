/**
 * DeterministicCompactor — zero-token structural compression.
 *
 * Tier 1 of the compaction pipeline. Applies regex/structural techniques
 * to reduce token count without calling an LLM. Techniques are composable
 * and measured independently so we can report savings.
 *
 * Technique priority order (least destructive first):
 *   1. stripAnsiCodes       — remove terminal color escapes
 *   2. stripStackTraces     — collapse node_modules/... lines in errors
 *   3. stripDuplicateLines  — collapse repeated stdout (npm install spam)
 *   4. dedupRepeatedPatterns — merge identical compiler/linter messages
 *   5. collapseWhitespace   — merge blank lines, trim indentation
 */

import type { AgentMessage } from '../session/Session';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CompactionStats {
  originalTokens: number;
  savedTokens: number;
  afterTokens: number;
  techniques: string[];
  /** Per-technique token savings. */
  breakdown: Record<string, number>;
}

export interface DeterministicCompactorOptions {
  /** Maximum token budget after compaction. Compaction stops when under this. */
  tokenBudget?: number;
  /** Skip all compaction (e.g., for 'none' strategy). */
  disabled?: boolean;
}

// ─── Technique type ──────────────────────────────────────────────────────────

type Technique = (text: string) => { text: string; changed: boolean };

// ─── Technique implementations ───────────────────────────────────────────────

/** Remove ANSI escape codes (terminal colors, cursor movement). */
function stripAnsiCodes(text: string): { text: string; changed: boolean } {
  // Matches common ANSI sequences: SGR (colors), cursor movement, erase
  const ansiRegex = /\x1b\[[0-9;]*[a-zA-Z]/g;
  const cleaned = text.replace(ansiRegex, '');
  return { text: cleaned, changed: cleaned.length < text.length };
}

/** Collapse node_modules stack trace lines into a compact summary. */
function stripStackTraces(text: string): { text: string; changed: boolean } {
  const lines = text.split('\n');
  let inStack = false;
  let nodeModulesCount = 0;
  let otherStackCount = 0;
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Detect start of stack trace
    if (
      /^\s*at\s/.test(trimmed) ||
      trimmed.startsWith('Error:') ||
      trimmed.startsWith('TypeError:') ||
      trimmed.startsWith('ReferenceError:')
    ) {
      inStack = true;
      if (trimmed.includes('node_modules/')) {
        nodeModulesCount++;
        if (nodeModulesCount <= 2) {
          result.push(line);
        }
        continue;
      }
      otherStackCount++;
      if (otherStackCount <= 5) {
        result.push(line);
      }
      continue;
    }

    // Exit stack trace on non-stack lines
    if (inStack && trimmed.length > 0 && !/^\s*at\s/.test(trimmed) && !trimmed.startsWith('Error:')) {
      inStack = false;
    }

    result.push(line);
  }

  // Add summary if we collapsed anything
  if (nodeModulesCount > 2) {
    result.push(`  [... ${nodeModulesCount - 2} more node_modules frames omitted]`);
  }

  const output = result.join('\n');
  return { text: output, changed: output.length < text.length };
}

/** Collapse repeated identical lines (npm install spam, test output). */
function stripDuplicateLines(text: string): { text: string; changed: boolean } {
  const lines = text.split('\n');
  const seen = new Map<string, number>();
  const result: string[] = [];
  let skipped = 0;

  for (const line of lines) {
    seen.set(line, (seen.get(line) ?? 0) + 1);
  }

  // Second pass: collapse repeated lines
  const collapsed = new Map<string, boolean>();
  for (const line of lines) {
    const count = seen.get(line) ?? 1;
    if (count > 3 && collapsed.has(line)) {
      skipped++;
      continue;
    }
    if (count > 3) {
      collapsed.set(line, true);
      result.push(`${line}  [repeated ${count} times]`);
      skipped += count - 1;
    } else {
      result.push(line);
    }
  }

  const output = result.join('\n');
  return { text: output, changed: skipped > 0 };
}

/**
 * Deduplicate repeated compiler/linter error patterns.
 * E.g., "error TS2322: Type 'X' is not assignable..." repeated 50 times
 * becomes a single line with count.
 */
function dedupRepeatedPatterns(text: string): { text: string; changed: boolean } {
  const lines = text.split('\n');
  const patterns = new Map<string, number>();

  // Build pattern frequency
  for (const line of lines) {
    const normalized = normalizePattern(line);
    if (normalized.length > 10) {
      patterns.set(normalized, (patterns.get(normalized) ?? 0) + 1);
    }
  }

  // Deduplicate
  const result: string[] = [];
  const emitted = new Map<string, boolean>();
  let skipped = 0;

  for (const line of lines) {
    const normalized = normalizePattern(line);
    const count = patterns.get(normalized) ?? 1;

    if (normalized.length > 10 && count > 3) {
      if (emitted.has(normalized)) {
        skipped++;
        continue;
      }
      emitted.set(normalized, true);
      result.push(`${line}  [${count} similar instances]`);
      skipped += count - 1;
    } else {
      result.push(line);
    }
  }

  const output = result.join('\n');
  return { text: output, changed: skipped > 0 };
}

/**
 * Normalize a line for pattern matching.
 * Replaces variable parts (paths, numbers, identifiers in quotes) with placeholders.
 */
function normalizePattern(line: string): string {
  return line
    .replace(/'.*?'/g, "'...'")
    .replace(/".*?"/g, '"..."')
    .replace(/`.*?`/g, '`...`')
    .replace(/\/[^\s]+\/[^\s]*/g, '/PATH/...')
    .replace(/\d+/g, 'N')
    .trim();
}

/** Collapse multiple blank lines and trim excessive indentation. */
function collapseWhitespace(text: string): { text: string; changed: boolean } {
  const lines = text.split('\n');
  const result: string[] = [];
  let blankCount = 0;

  for (const line of lines) {
    if (line.trim().length === 0) {
      blankCount++;
      if (blankCount <= 2) {
        result.push('');
      }
    } else {
      blankCount = 0;
      // Trim leading whitespace but preserve indent structure (keep at most 8 spaces)
      const trimmed = line.replace(/^ {9,}/, '        ');
      result.push(trimmed);
    }
  }

  const output = result.join('\n');
  return { text: output, changed: output.length < text.length };
}

// ─── Chars-to-tokens estimation ──────────────────────────────────────────────

const CHARS_PER_TOKEN = 3;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateMessageTokens(msg: AgentMessage): number {
  const content = msg.content || '';
  const reasoning = (msg as unknown as Record<string, unknown>).reasoning_content as string | undefined;
  let total = estimateTokens(content);
  if (reasoning) total += estimateTokens(reasoning);
  if (msg.tool_calls) total += estimateTokens(JSON.stringify(msg.tool_calls));
  return total;
}

function estimateTotalTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

// ─── DeterministicCompactor ──────────────────────────────────────────────────

export class DeterministicCompactor {
  private techniques: Technique[];

  constructor(options: DeterministicCompactorOptions = {}) {
    if (options.disabled) {
      this.techniques = [];
    } else {
      this.techniques = [
        stripAnsiCodes,
        stripStackTraces,
        stripDuplicateLines,
        dedupRepeatedPatterns,
        collapseWhitespace,
      ];
    }
  }

  /**
   * Apply deterministic compaction to a set of agent messages.
   *
   * Processes messages in-place: each message's content is compressed.
   * Measures token savings for reporting.
   *
   * @param messages - Agent messages to compact.
   * @returns Updated messages and compaction statistics.
   */
  compact(messages: AgentMessage[]): { messages: AgentMessage[]; stats: CompactionStats } {
    const originalTokens = estimateTotalTokens(messages);
    const breakdown: Record<string, number> = {};
    const techniques: string[] = [];
    let totalSaved = 0;

    // Compact each message's content
    for (const msg of messages) {
      if (!msg.content) continue;

      let text = msg.content;
      let msgChanged = false;

      for (const technique of this.techniques) {
        const before = estimateTokens(text);
        const result = technique(text);
        const after = estimateTokens(result.text);

        if (result.changed) {
          text = result.text;
          msgChanged = true;
          const saved = before - after;
          totalSaved += saved;
          const tname = technique.name;
          breakdown[tname] = (breakdown[tname] ?? 0) + saved;
          if (!techniques.includes(tname)) techniques.push(tname);
        }
      }

      if (msgChanged) {
        msg.content = text;
      }
    }

    const afterTokens = originalTokens - totalSaved;

    return {
      messages,
      stats: {
        originalTokens,
        savedTokens: totalSaved,
        afterTokens,
        techniques,
        breakdown,
      },
    };
  }
}

/**
 * Create a DeterministicCompactor configured for the given strategy.
 * For 'light' and 'none' strategies, returns a no-op compactor.
 */
export function createCompactor(strategy?: string): DeterministicCompactor {
  if (strategy === 'none' || strategy === 'off' || strategy === 'light') {
    return new DeterministicCompactor({ disabled: true });
  }
  return new DeterministicCompactor();
}
