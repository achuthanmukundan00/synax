/**
 * HolographicMemory — SQLite FTS5-backed semantic memory for agent context.
 *
 * Architecture:
 *   Every turn → INSERT into FTS5 (fire-and-forget, non-blocking)
 *   Agent needs history → search("error from 5 turns ago") → relevant rows
 *   Context exhausted → handoff() → structured manifest for child agent
 *
 * This is the architectural differentiator from the SOTA review:
 * zero tokens burned, zero information loss, agent queries what it needs.
 *
 * Shares the SQLite connection with EventStore. If SQLite is unavailable,
 * all operations are safe no-ops.
 */

import type { Database } from '../store/sqlite-loader';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  sessionId: string;
  turnId: number;
  role: 'user' | 'assistant' | 'tool';
  toolName?: string;
  filePaths?: string[];
  content: string;
}

export interface MemorySearchResult {
  turnId: number;
  sessionId: string;
  role: string;
  toolName: string | null;
  filePaths: string | null;
  content: string;
  /** FTS5 rank (lower = more relevant). */
  rank: number;
}

export interface HandoffManifest {
  sessionId: string;
  /** Last N turns summarized as key findings. */
  keyFindings: string[];
  /** Files that were read or changed. */
  filesTouched: string[];
  /** Suggested FTS5 search terms for the next agent. */
  suggestedSearchTerms: string[];
  /** Number of turns stored. */
  turnCount: number;
  /** Total entries in memory. */
  entryCount: number;
}

// ─── HolographicMemory ───────────────────────────────────────────────────────

export class HolographicMemory {
  private db: Database.Database | null;
  private insertStmt: Database.Statement | null = null;
  /** Count of store errors since construction. Non-zero means FTS5 is silently failing. */
  storeErrorCount = 0;
  private _storeErrorWarned = false;

  constructor(db: Database.Database | null) {
    this.db = db;
    if (db) {
      try {
        this.insertStmt = db.prepare(`
          INSERT INTO memory_fts (turn_id, session_id, role, tool_name, file_paths, content)
          VALUES (@turnId, @sessionId, @role, @toolName, @filePaths, @content)
        `);
      } catch {
        // FTS5 table may not exist yet — will be created by EventStore migration
        this.insertStmt = null;
      }
    }
  }

  get isAvailable(): boolean {
    return this.db !== null && this.insertStmt !== null;
  }

  // ── Write ──────────────────────────────────────────────────────────────

  /**
   * Store a memory entry in FTS5.
   * Fire-and-forget — errors are caught, never thrown.
   * Target: <5ms per store.
   */
  store(entry: MemoryEntry): void {
    if (!this.isAvailable || !this.insertStmt) return;
    try {
      this.insertStmt.run({
        turnId: entry.turnId,
        sessionId: entry.sessionId,
        role: entry.role,
        toolName: entry.toolName ?? null,
        filePaths: entry.filePaths ? entry.filePaths.join(',') : null,
        content: entry.content.slice(0, 8000), // cap at 8K chars per entry
      });
    } catch {
      // Fire-and-forget: never crash the agent on memory failures
      this.storeErrorCount += 1;
      if (!this._storeErrorWarned && this.storeErrorCount >= 3) {
        this._storeErrorWarned = true;
        // Log to stderr as a last resort — logger may not be available
        console.error(
          `[synax] HolographicMemory: ${this.storeErrorCount} store() failures. FTS5 may be unavailable or corrupt.`,
        );
      }
    }
  }

  // ── Search ─────────────────────────────────────────────────────────────

  /**
   * Full-text search over stored memory entries.
   *
   * Uses FTS5 with Porter stemming — "login form" matches "login forms".
   * Results ranked by FTS5 relevance (bm25).
   *
   * @param query - FTS5 search query (supports AND, OR, NOT, prefix*).
   * @param limit - Maximum results to return (default 10).
   */
  search(query: string, limit: number = 10): MemorySearchResult[] {
    if (!this.db) return [];

    // Sanitize query for FTS5: escape special characters, only allow safe tokens
    const safeQuery = query.replace(/[^\w\s*\-"()]/g, ' ').trim();
    if (!safeQuery) return [];

    try {
      const rows = this.db
        .prepare(
          `SELECT turn_id, session_id, role, tool_name, file_paths, content, rank
         FROM memory_fts
         WHERE memory_fts MATCH @query
         ORDER BY rank
         LIMIT @limit`,
        )
        .all({ query: safeQuery, limit }) as Array<{
        turn_id: number;
        session_id: string;
        role: string;
        tool_name: string | null;
        file_paths: string | null;
        content: string;
        rank: number;
      }>;

      return rows.map((r) => ({
        turnId: r.turn_id,
        sessionId: r.session_id,
        role: r.role,
        toolName: r.tool_name,
        filePaths: r.file_paths,
        content: r.content,
        rank: r.rank,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Search with snippet context (FTS5 snippet()).
   * Returns matching fragments with surrounding text for readability.
   */
  searchWithSnippets(query: string, limit: number = 5): Array<MemorySearchResult & { snippet: string }> {
    if (!this.db) return [];

    const safeQuery = query.replace(/[^\w\s*\-"()]/g, ' ').trim();
    if (!safeQuery) return [];

    try {
      const rows = this.db
        .prepare(
          `SELECT turn_id, session_id, role, tool_name, file_paths,
                  snippet(memory_fts, 1, '<mark>', '</mark>', '...', 32) AS snippet,
                  content, rank
         FROM memory_fts
         WHERE memory_fts MATCH @query
         ORDER BY rank
         LIMIT @limit`,
        )
        .all({ query: safeQuery, limit }) as Array<{
        turn_id: number;
        session_id: string;
        role: string;
        tool_name: string | null;
        file_paths: string | null;
        snippet: string;
        content: string;
        rank: number;
      }>;

      return rows.map((r) => ({
        turnId: r.turn_id,
        sessionId: r.session_id,
        role: r.role,
        toolName: r.tool_name,
        filePaths: r.file_paths,
        content: r.content,
        rank: r.rank,
        snippet: r.snippet,
      }));
    } catch {
      return [];
    }
  }

  // ── Handoff ────────────────────────────────────────────────────────────

  /**
   * Generate a structured handoff manifest for context exhaustion scenarios.
   *
   * Contains:
   *   - Key findings from recent turns
   *   - Files touched (read or changed)
   *   - Suggested search terms for the next agent
   *   - Turn/entry counts
   */
  handoff(): HandoffManifest {
    if (!this.db) {
      return {
        sessionId: '',
        keyFindings: [],
        filesTouched: [],
        suggestedSearchTerms: [],
        turnCount: 0,
        entryCount: 0,
      };
    }

    try {
      // Get recent entries (last 20)
      const recent = this.db
        .prepare(
          `SELECT turn_id, session_id, role, tool_name, file_paths, content
         FROM memory_fts
         ORDER BY rowid DESC
         LIMIT 20`,
        )
        .all() as Array<{
        turn_id: number;
        session_id: string;
        role: string;
        tool_name: string | null;
        file_paths: string | null;
        content: string;
      }>;

      // Extract key findings: error messages, tool outputs with "error", "fail", "success"
      const keyFindings: string[] = [];
      const filesTouched = new Set<string>();
      const seenFindings = new Set<string>();

      for (const entry of recent) {
        if (entry.file_paths) {
          for (const fp of entry.file_paths.split(',')) {
            const trimmed = fp.trim();
            if (trimmed) filesTouched.add(trimmed);
          }
        }

        // Extract error/failure lines as key findings
        const lines = entry.content.split('\n');
        for (const line of lines) {
          const lower = line.toLowerCase();
          if (
            (lower.includes('error') || lower.includes('fail') || lower.includes('success')) &&
            line.length > 20 &&
            line.length < 500 &&
            !seenFindings.has(line)
          ) {
            seenFindings.add(line);
            keyFindings.push(line.trim());
            if (keyFindings.length >= 10) break;
          }
        }
        if (keyFindings.length >= 10) break;
      }

      // Get counts
      const sessionId = recent.length > 0 ? recent[0].session_id : '';
      const turnCount = this.db
        .prepare(`SELECT COUNT(DISTINCT turn_id) as count FROM memory_fts WHERE session_id = ?`)
        .get(sessionId) as { count: number } | undefined;

      const entryCount = this.db
        .prepare(`SELECT COUNT(*) as count FROM memory_fts WHERE session_id = ?`)
        .get(sessionId) as { count: number } | undefined;

      return {
        sessionId,
        keyFindings,
        filesTouched: Array.from(filesTouched).sort(),
        suggestedSearchTerms: this.getSuggestedSearchTerms(),
        turnCount: turnCount?.count ?? 0,
        entryCount: entryCount?.count ?? 0,
      };
    } catch {
      return {
        sessionId: '',
        keyFindings: [],
        filesTouched: [],
        suggestedSearchTerms: [],
        turnCount: 0,
        entryCount: 0,
      };
    }
  }

  /**
   * Generate suggested FTS5 search terms from recent memory.
   *
   * Extracts:
   *   - File paths mentioned in content
   *   - Error/diagnostic keywords
   *   - Tool names from recent tool calls
   */
  getSuggestedSearchTerms(): string[] {
    if (!this.db) return [];

    try {
      // Get distinct tool names from recent entries
      const tools = this.db
        .prepare(
          `SELECT DISTINCT tool_name FROM memory_fts
         WHERE tool_name IS NOT NULL
         ORDER BY rowid DESC
         LIMIT 10`,
        )
        .all() as Array<{ tool_name: string }>;

      // Get common words from recent content (simple frequency analysis)
      const recentContent = this.db
        .prepare(
          `SELECT content FROM memory_fts
         WHERE role != 'user'
         ORDER BY rowid DESC
         LIMIT 10`,
        )
        .all() as Array<{ content: string }>;

      const wordFreq = new Map<string, number>();
      const stopWords = new Set([
        'the',
        'is',
        'at',
        'which',
        'on',
        'a',
        'an',
        'and',
        'or',
        'but',
        'in',
        'with',
        'to',
        'for',
        'of',
        'this',
        'that',
        'it',
        'be',
        'was',
        'are',
      ]);

      for (const row of recentContent) {
        const words = row.content.toLowerCase().split(/\W+/);
        for (const word of words) {
          if (word.length > 3 && !stopWords.has(word)) {
            wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
          }
        }
      }

      // Top frequent words
      const topWords = Array.from(wordFreq.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([word]) => word);

      // Combine: tool names + frequent words (deduped)
      const terms = new Set<string>();
      for (const t of tools) terms.add(t.tool_name);
      for (const w of topWords) terms.add(w);

      return Array.from(terms).slice(0, 20);
    } catch {
      return [];
    }
  }
}
