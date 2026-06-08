/**
 * Generated-content store — tracks content the model or tools have produced
 * so it can be referenced by range later instead of being regenerated.
 *
 * Large command outputs and file payloads are regenerated repeatedly in
 * multi-turn conversations, wasting context budget. This store allows the
 * model to paste previously-generated content by range via the
 * `context_range_paste` tool.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeneratedContentEntry {
  /** Stable identifier for this content block (e.g. "cmd:git-diff", "file:src/foo.ts"). */
  id: string;
  /** Full raw content. */
  content: string;
  /** Cached split lines for efficient range lookups. */
  lines: string[];
  /** Approximate token count for budget tracking. */
  approximateTokens?: number;
  /** When the content was stored (ms since epoch). */
  timestamp: number;
}

export interface PastedRange {
  /** Matched content ID. */
  contentId: string;
  /** Total lines in the stored content. */
  totalLines: number;
  /** Requested lines with line numbers. */
  lines: Array<{ lineNumber: number; text: string }>;
  /** Whether the requested range exceeds the stored content. */
  truncated: boolean;
  /** Whether the startLine exceeded the stored content length. */
  startBeyondEnd: boolean;
}

export interface GeneratedContentStore {
  /** Store generated content under a stable id. Replaces any existing entry with the same id. */
  store(id: string, content: string, opts?: { approximateTokens?: number }): void;

  /** Retrieve a line-numbered range from a stored content block. */
  getRange(id: string, startLine: number, endLine: number): PastedRange | null;

  /** Check if content exists for an id. */
  has(id: string): boolean;

  /** List all stored content ids. */
  list(): string[];

  /** Remove a stored content block. */
  remove(id: string): void;

  /** Clear all stored content. */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createGeneratedContentStore(): GeneratedContentStore {
  const entries = new Map<string, GeneratedContentEntry>();

  function splitLines(text: string): string[] {
    const withoutFinalNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
    return withoutFinalNewline.length === 0 ? [] : withoutFinalNewline.split(/\r?\n/);
  }

  return {
    store(id: string, content: string, opts: { approximateTokens?: number } = {}): void {
      const lines = splitLines(content);
      entries.set(id, {
        id,
        content,
        lines,
        approximateTokens: opts.approximateTokens,
        timestamp: Date.now(),
      });
    },

    getRange(id: string, startLine: number, endLine: number): PastedRange | null {
      const entry = entries.get(id);
      if (!entry) return null;

      const totalLines = entry.lines.length;

      // If startLine is beyond the stored content, return empty with flag
      if (startLine > totalLines) {
        return {
          contentId: id,
          totalLines,
          lines: [],
          truncated: false,
          startBeyondEnd: true,
        };
      }

      const clampedEnd = Math.min(endLine, totalLines);
      const selected = entry.lines.slice(startLine - 1, clampedEnd).map((text, index) => ({
        lineNumber: startLine + index,
        text,
      }));

      return {
        contentId: id,
        totalLines,
        lines: selected,
        truncated: endLine > totalLines,
        startBeyondEnd: false,
      };
    },

    has(id: string): boolean {
      return entries.has(id);
    },

    list(): string[] {
      return [...entries.keys()].sort();
    },

    remove(id: string): void {
      entries.delete(id);
    },

    reset(): void {
      entries.clear();
    },
  };
}
