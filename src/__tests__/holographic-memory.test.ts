/**
 * Tests for HolographicMemory — FTS5-backed semantic memory store.
 */

import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { HolographicMemory } from '../memory/HolographicMemory';
import { CREATE_MEMORY_FTS_TABLE } from '../store/schema';
import { loadBetterSqlite3, type Database } from '../store/sqlite-loader';

const TMP = join(process.cwd(), 'tmp', 'synax-memory-tests');
const DB_PATH = join(TMP, 'memory-test.db');

function openTestDb(): Database.Database | null {
  const SQLite = loadBetterSqlite3();
  if (!SQLite) return null;
  if (existsSync(DB_PATH)) rmSync(DB_PATH, { force: true });
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
  const db = new SQLite(DB_PATH);
  db.exec(CREATE_MEMORY_FTS_TABLE);
  return db;
}

function seedMemory(mem: HolographicMemory): void {
  const entries = [
    {
      sessionId: 's1',
      turnId: 1,
      role: 'user' as const,
      content: 'Fix the login form validation error',
    },
    {
      sessionId: 's1',
      turnId: 1,
      role: 'assistant' as const,
      content:
        "I'll check the login form. The error TS2322: Type 'string' is not assignable to type 'number' appears in src/LoginForm.tsx.",
    },
    {
      sessionId: 's1',
      turnId: 1,
      role: 'tool' as const,
      toolName: 'read',
      filePaths: ['src/LoginForm.tsx'],
      content: 'Line 42: const age: number = "twenty"; // error here',
    },
    {
      sessionId: 's1',
      turnId: 2,
      role: 'user' as const,
      content: 'Now add a submit handler',
    },
    {
      sessionId: 's1',
      turnId: 2,
      role: 'assistant' as const,
      content: "I'll add a submit handler to the form. Using handleSubmit function with validation.",
    },
    {
      sessionId: 's1',
      turnId: 2,
      role: 'tool' as const,
      toolName: 'edit',
      filePaths: ['src/LoginForm.tsx'],
      content: 'Added handleSubmit function to src/LoginForm.tsx',
    },
    {
      sessionId: 's1',
      turnId: 3,
      role: 'tool' as const,
      toolName: 'bash',
      content:
        'npm test: FAIL src/LoginForm.test.ts\n  ● LoginForm › validates email format\n    Expected: true, Received: false',
    },
  ];

  for (const entry of entries) {
    mem.store(entry);
  }
}

describe('HolographicMemory', () => {
  let db: Database.Database | null = null;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    if (db) db.close();
    if (existsSync(DB_PATH)) rmSync(DB_PATH, { force: true });
  });

  describe('store', () => {
    it('stores entries in FTS5', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);
      expect(mem.isAvailable).toBe(true);

      mem.store({
        sessionId: 's1',
        turnId: 1,
        role: 'user',
        content: 'Fix the bug',
      });

      const count = db.prepare('SELECT COUNT(*) as c FROM memory_fts').get() as { c: number };
      expect(count.c).toBe(1);
    });

    it('is safe when db is null', () => {
      const mem = new HolographicMemory(null);
      expect(mem.isAvailable).toBe(false);

      // Should not throw
      mem.store({ sessionId: 's1', turnId: 1, role: 'user', content: 'test' });
    });

    it('truncates content at 8000 characters', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);
      const longContent = 'x'.repeat(10000);

      mem.store({ sessionId: 's1', turnId: 1, role: 'assistant', content: longContent });

      const row = db.prepare('SELECT content FROM memory_fts LIMIT 1').get() as { content: string };
      expect(row.content.length).toBeLessThanOrEqual(8000);
    });
  });

  describe('search', () => {
    it('finds entries by keyword', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);
      seedMemory(mem);

      const results = mem.search('login');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.content.toLowerCase().includes('login'))).toBe(true);
    });

    it('ranks results by relevance', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);
      seedMemory(mem);

      const results = mem.search('login form');
      expect(results.length).toBeGreaterThan(0);
      // Results should be ordered by rank (ascending)
      for (let i = 1; i < results.length; i++) {
        expect(results[i].rank).toBeGreaterThanOrEqual(results[i - 1].rank);
      }
    });

    it('handles Porter stemming (matching word variants)', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);
      mem.store({ sessionId: 's1', turnId: 1, role: 'assistant', content: 'Validating the login forms' });
      mem.store({ sessionId: 's1', turnId: 1, role: 'assistant', content: 'Added form validation' });

      const results = mem.search('validate');
      // Should find both entries due to stemming (validating, validation)
      expect(results.length).toBeGreaterThan(0);
    });

    it('returns empty array for no matches', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);
      seedMemory(mem);

      const results = mem.search('xyznonexistent');
      expect(results).toEqual([]);
    });

    it('sanitizes FTS5 special characters', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);
      seedMemory(mem);

      // Should not throw on special characters
      const results = mem.search('login; DROP TABLE--');
      expect(Array.isArray(results)).toBe(true);
    });

    it('returns empty array when db is null', () => {
      const mem = new HolographicMemory(null);
      const results = mem.search('test');
      expect(results).toEqual([]);
    });
  });

  describe('searchWithSnippets', () => {
    it('returns snippets with match markers', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);
      seedMemory(mem);

      const results = mem.searchWithSnippets('login');
      expect(results.length).toBeGreaterThan(0);
      if (results.length > 0) {
        expect(results[0].snippet).toBeDefined();
      }
    });
  });

  describe('handoff', () => {
    it('returns structured manifest with key findings', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);
      seedMemory(mem);

      const manifest = mem.handoff();
      expect(manifest.sessionId).toBe('s1');
      expect(manifest.turnCount).toBeGreaterThan(0);
      expect(manifest.entryCount).toBeGreaterThan(0);
      expect(manifest.filesTouched).toContain('src/LoginForm.tsx');
    });

    it('extracts key findings from errors and failures', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);
      mem.store({
        sessionId: 's1',
        turnId: 1,
        role: 'tool',
        toolName: 'bash',
        content: 'Error: Cannot find module "./missing"',
      });
      mem.store({
        sessionId: 's1',
        turnId: 1,
        role: 'tool',
        toolName: 'bash',
        content: 'Test failed: Expected true but got false',
      });

      const manifest = mem.handoff();
      expect(manifest.keyFindings.length).toBeGreaterThan(0);
    });

    it('returns empty manifest when db is null', () => {
      const mem = new HolographicMemory(null);
      const manifest = mem.handoff();
      expect(manifest.sessionId).toBe('');
      expect(manifest.keyFindings).toEqual([]);
    });
  });

  describe('getSuggestedSearchTerms', () => {
    it('returns tool names and frequent words', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);
      seedMemory(mem);

      const terms = mem.getSuggestedSearchTerms();
      expect(terms.length).toBeGreaterThan(0);
      // Should include tool names
      expect(terms).toContain('read');
      expect(terms).toContain('edit');
    });

    it('returns empty array when db is null', () => {
      const mem = new HolographicMemory(null);
      expect(mem.getSuggestedSearchTerms()).toEqual([]);
    });
  });

  describe('integration', () => {
    it('handles rapid fire-and-forget stores without errors', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);
      for (let i = 0; i < 50; i++) {
        mem.store({
          sessionId: 's1',
          turnId: Math.floor(i / 3),
          role: i % 3 === 0 ? 'user' : i % 3 === 1 ? 'assistant' : 'tool',
          toolName: i % 3 === 2 ? 'bash' : undefined,
          content: `Entry ${i}: some content for testing purposes`,
        });
      }

      const count = db.prepare('SELECT COUNT(*) as c FROM memory_fts').get() as { c: number };
      expect(count.c).toBe(50);
    });
  });

  describe('buildMemoryIndex', () => {
    it('returns null when memory is empty', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);
      const index = mem.buildMemoryIndex();
      expect(index).toBeNull();
    });

    it('returns a compact index string with entries', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);
      mem.store({ sessionId: 's1', turnId: 1, role: 'user', content: 'Fix the build' });
      mem.store({
        sessionId: 's1',
        turnId: 1,
        role: 'tool',
        toolName: 'bash',
        filePaths: ['src/auth/login.ts'],
        content: 'error TS2322 at login.ts:42',
      });
      mem.store({
        sessionId: 's1',
        turnId: 2,
        role: 'tool',
        toolName: 'edit',
        filePaths: ['src/auth/login.ts'],
        content: 'successfully changed login.ts',
      });

      const index = mem.buildMemoryIndex();
      expect(index).not.toBeNull();
      expect(index!).toContain('[Memory:');
      expect(index!).toContain('entries across');
      expect(index!).toContain('turns');
      expect(index!).toContain('src/auth/login.ts');
      expect(index!).toContain(']');

      // Should be compact (~under 500 chars for this small dataset)
      expect(index!.length).toBeLessThan(500);
    });

    it('includes error snippets when errors exist', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);
      mem.store({ sessionId: 's1', turnId: 1, role: 'user', content: 'Fix bugs' });
      mem.store({
        sessionId: 's1',
        turnId: 1,
        role: 'tool',
        toolName: 'bash',
        content: 'Error: something went wrong with the build process',
      });
      mem.store({
        sessionId: 's1',
        turnId: 1,
        role: 'tool',
        toolName: 'bash',
        content: 'Failure: test suite failed with 3 errors',
      });

      const index = mem.buildMemoryIndex();
      expect(index).not.toBeNull();
      // Should contain error/failure hints
      expect(index!).toMatch(/error|fail|Error|FAIL/i);
    });

    it('returns null for null database', () => {
      const nullMemory = new HolographicMemory(null);
      const index = nullMemory.buildMemoryIndex();
      expect(index).toBeNull();
    });
  });
});
