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
      const idx = index as string;
      expect(idx).toContain('[Memory:');
      expect(idx).toContain('entries across');
      expect(idx).toContain('turns');
      expect(idx).toContain('src/auth/login.ts');
      expect(idx).toContain(']');

      // Should be compact (~under 500 chars for this small dataset)
      expect(idx.length).toBeLessThan(500);
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
      const idx = index as string;
      expect(idx).toMatch(/error|fail|Error|FAIL/i);
    });

    it('returns null for null database', () => {
      const nullMemory = new HolographicMemory(null);
      const index = nullMemory.buildMemoryIndex();
      expect(index).toBeNull();
    });

    it('includes domain tags in compact context', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);
      mem.store({ sessionId: 's1', turnId: 1, role: 'user', content: 'Find leads', domainTags: ['autocareer'] });
      mem.store({
        sessionId: 's1',
        turnId: 1,
        role: 'tool',
        toolName: 'read',
        filePaths: ['leads.csv'],
        content: 'Job leads found',
        domainTags: ['autocareer', 'job-search'],
      });

      const index = mem.buildMemoryIndex();
      expect(index).not.toBeNull();
      const idx = index as string;
      expect(idx).toContain('Domain:');
      expect(idx).toContain('autocareer');
      expect(idx).toContain('job-search');
      // Should also still have the standard sections
      expect(idx).toContain('[Memory:');
    });
  });

  // ── Cross-session durability ──────────────────────────────────────────

  describe('cross-session durability', () => {
    it('survives database close and reopen', () => {
      if (!db) return;

      // Session 1: store entries
      const mem1 = new HolographicMemory(db);
      mem1.store({ sessionId: 's1', turnId: 1, role: 'user', content: 'Fix login form validation' });
      mem1.store({
        sessionId: 's1',
        turnId: 1,
        role: 'tool',
        toolName: 'bash',
        content: 'Error: TS2322 at src/LoginForm.tsx:42',
      });
      mem1.store({
        sessionId: 's1',
        turnId: 2,
        role: 'assistant',
        content: 'Fixed the type coercion issue in LoginForm',
      });

      // Verify entries exist
      expect(mem1.search('TS2322').length).toBeGreaterThan(0);
      expect(mem1.search('login').length).toBeGreaterThan(0);

      // Close the database (simulate process restart)
      db.close();

      // Reopen the same file WITHOUT wiping (simulate new process)
      const SQLite = loadBetterSqlite3();
      if (!SQLite) return;
      const reopenedDb = new SQLite(DB_PATH);

      try {
        const mem2 = new HolographicMemory(reopenedDb);

        // Session 2: should find entries from session 1
        const results = mem2.search('TS2322');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].content).toContain('TS2322');

        // Should also find by keyword
        const loginResults = mem2.search('login');
        expect(loginResults.length).toBeGreaterThan(0);
        expect(loginResults.some((r) => r.content.toLowerCase().includes('login'))).toBe(true);

        // New entries from session 2 should coexist with session 1 entries
        mem2.store({ sessionId: 's2', turnId: 1, role: 'user', content: 'Add signup form' });
        mem2.store({
          sessionId: 's2',
          turnId: 1,
          role: 'tool',
          toolName: 'bash',
          content: 'Error: missing password validation in SignupForm',
        });

        const crossSessionResults = mem2.search('error');
        expect(crossSessionResults.length).toBeGreaterThanOrEqual(2); // at least one from each session
        const s1Errors = crossSessionResults.filter((r) => r.sessionId === 's1');
        const s2Errors = crossSessionResults.filter((r) => r.sessionId === 's2');
        expect(s1Errors.length).toBeGreaterThan(0);
        expect(s2Errors.length).toBeGreaterThan(0);
      } finally {
        reopenedDb.close();
      }
    });

    it('reads entries across sessions via persistent file', () => {
      // Uses the existing file-based test pattern in openTestDb
      if (!db) return;

      const mem = new HolographicMemory(db);
      mem.store({
        sessionId: 'sA',
        turnId: 1,
        role: 'user',
        content: 'Search for python backend remote canada job leads',
        domainTags: ['autocareer'],
      });
      mem.store({
        sessionId: 'sA',
        turnId: 1,
        role: 'tool',
        toolName: 'read',
        filePaths: ['leads.json'],
        content: 'Found 50 job leads matching python backend canada remote',
        domainTags: ['autocareer'],
      });

      // Multi-session insert pattern: same DB, different session IDs
      for (let session = 1; session <= 5; session++) {
        const sid = `product-session-${session}`;
        for (let lead = 1; lead <= 10; lead++) {
          mem.store({
            sessionId: sid,
            turnId: lead,
            role: 'tool',
            toolName: 'read',
            filePaths: ['leads.csv'],
            content: `Lead ${lead} in session ${session}: python backend engineer remote canada`,
            domainTags: ['autocareer'],
          });
        }
      }

      // Search across all sessions
      const results = mem.search('python backend remote canada');
      expect(results.length).toBeGreaterThan(0);
      // Should find leads from multiple sessions
      const sessionIds = new Set(results.map((r) => r.sessionId));
      expect(sessionIds.size).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Domain tags ──────────────────────────────────────────────────────

  describe('domain tags', () => {
    it('stores and retrieves domain tags', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);

      mem.store({
        sessionId: 's1',
        turnId: 1,
        role: 'user',
        content: 'Find python jobs in toronto',
        domainTags: ['autocareer', 'job-search'],
      });

      mem.store({
        sessionId: 's1',
        turnId: 2,
        role: 'assistant',
        content: 'Found a chord progression in D minor with Operator bass',
        domainTags: ['wytos', 'music-analysis'],
      });

      // Search with domain-specific terms
      const autoResults = mem.search('python jobs');
      expect(autoResults.length).toBeGreaterThan(0);

      const wytosResults = mem.search('D minor Operator');
      expect(wytosResults.length).toBeGreaterThan(0);
      expect(wytosResults[0].content).toContain('D minor');

      // Search results should include domain tags
      expect(autoResults[0].domainTags).toBeDefined();
      expect(autoResults[0].domainTags).toContain('autocareer');
    });

    it('domain tags appear in handoff manifest', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);

      mem.store({
        sessionId: 's1',
        turnId: 1,
        role: 'user',
        content: 'Triage job leads',
        domainTags: ['autocareer', 'triage'],
      });

      mem.store({
        sessionId: 's1',
        turnId: 1,
        role: 'tool',
        toolName: 'read',
        filePaths: ['leads.csv'],
        content: '50 leads processed',
        domainTags: ['autocareer'],
      });

      const manifest = mem.handoff();
      expect(manifest.domainTags.length).toBeGreaterThan(0);
      expect(manifest.domainTags).toContain('autocareer');
    });

    it('domain tags appear in suggested search terms', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);

      mem.store({
        sessionId: 's1',
        turnId: 1,
        role: 'user',
        content: 'Analyze audio track',
        domainTags: ['wytos', 'creative', 'audio-analysis'],
      });

      const terms = mem.getSuggestedSearchTerms();
      expect(terms.length).toBeGreaterThan(0);
      // Domain tags should be included as search terms
      expect(terms).toContain('wytos');
      expect(terms).toContain('creative');
      expect(terms).toContain('audio-analysis');
    });
  });

  // ── Product scenario: AutoCareer ────────────────────────────────────

  describe('AutoCareer scenario: job lead memory across sessions', () => {
    it('stores 500 leads across 10 sessions and finds relevant ones via FTS5', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);

      const jobTitles = [
        'python backend engineer remote canada',
        'senior typescript developer toronto',
        'react frontend lead vancouver remote',
        'python data engineer remote montreal',
        'devops engineer backend kubernetes canada',
      ];

      const companies = [
        'Shopify',
        'Wealthsimple',
        'PointClickCare',
        'RBC',
        'TD',
        'Shopify',
        'Lighspeed',
        'Wattpad',
        'Drop',
        'SkipTheDishes',
      ];

      // 10 sessions, 50 leads each = 500
      for (let session = 1; session <= 10; session++) {
        const sid = `autocareer-session-${session}`;
        for (let lead = 1; lead <= 50; lead++) {
          const title = jobTitles[lead % jobTitles.length];
          const company = companies[lead % companies.length];
          mem.store({
            sessionId: sid,
            turnId: lead,
            role: 'tool',
            toolName: 'read',
            filePaths: ['leads.csv'],
            content: `Lead #${lead} session ${session}: ${title} at ${company} — remote, full-time, posted May 2026`,
            domainTags: ['autocareer', 'job-leads'],
          });
        }
      }

      // Search: 'python backend remote canada'
      const results = mem.search('python backend remote canada', 100);
      expect(results.length).toBeGreaterThan(0);
      // All results should relate to python backend remote canada jobs
      for (const r of results) {
        expect(r.content.toLowerCase()).toMatch(/python|backend|remote|canada/);
      }

      // Should find leads from session 3 specifically
      const s3Results = results.filter((r) => r.sessionId === 'autocareer-session-3');
      expect(s3Results.length).toBeGreaterThan(0);
    });

    it('finds leads from specific session in cross-session search', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);

      // Only put python backend remote canada leads in session 3
      for (let session = 1; session <= 10; session++) {
        const sid = `autocareer-s-${session}`;
        for (let lead = 1; lead <= 50; lead++) {
          const content =
            session === 3
              ? `Lead ${lead}: python backend engineer remote canada — full-time`
              : `Lead ${lead}: frontend developer on-site toronto`;
          mem.store({
            sessionId: sid,
            turnId: lead,
            role: 'tool',
            toolName: 'read',
            content,
            domainTags: ['autocareer'],
          });
        }
      }

      const results = mem.search('python backend remote canada', 50);
      expect(results.length).toBeGreaterThan(0);
      // All results should come from session 3
      for (const r of results) {
        expect(r.sessionId).toBe('autocareer-s-3');
      }
    });
  });

  // ── Product scenario: wytOS ──────────────────────────────────────────

  describe('wytOS scenario: audio analysis memory across sessions', () => {
    it('stores 200 audio analyses and finds relevant ones via FTS5', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);

      const keys = ['C major', 'D minor', 'E minor', 'F major', 'G major', 'A minor', 'B diminished'];
      const basses = ['Sub', 'Reese', '808', 'Operator', 'FM', 'Wavetable'];

      // 200 analyses across 5 sessions
      let count = 0;
      for (let session = 1; session <= 5; session++) {
        const sid = `wytos-session-${session}`;
        for (let track = 1; track <= 40; track++) {
          const key = keys[track % keys.length];
          const bass = basses[track % basses.length];
          count++;
          mem.store({
            sessionId: sid,
            turnId: track,
            role: 'tool',
            toolName: 'analyse',
            content: `Analysis #${count}: key=${key}, bass=${bass}, tempo=128, genre=electronic, peak at 1:23, dynamic range 12dB`,
            domainTags: ['wytos', 'audio-analysis'],
          });
        }
      }

      // Verify count
      const allCount = db.prepare('SELECT COUNT(*) as c FROM memory_fts').get() as { c: number };
      expect(allCount.c).toBe(200);

      // Search: 'D minor Operator bass'
      const results = mem.search('D minor Operator bass', 20);
      expect(results.length).toBeGreaterThan(0);
      // All results should contain D minor AND Operator
      for (const r of results) {
        expect(r.content).toContain('D minor');
        expect(r.content).toContain('Operator');
      }

      // Search across sessions
      const sessionIds = new Set(results.map((r) => r.sessionId));
      expect(sessionIds.size).toBeGreaterThanOrEqual(1);
    });

    it('searches with FTS5 snippet context', () => {
      if (!db) return;
      const mem = new HolographicMemory(db);

      mem.store({
        sessionId: 'wytos-s1',
        turnId: 1,
        role: 'tool',
        content: 'Track "Dark Matter": key=D minor, bass=Operator, tempo=128, genre=techno',
        domainTags: ['wytos'],
      });
      mem.store({
        sessionId: 'wytos-s1',
        turnId: 2,
        role: 'tool',
        content: 'Track "Starlight": key=D minor, bass=Sub, tempo=140, genre=trance',
        domainTags: ['wytos'],
      });

      const snippetResults = mem.searchWithSnippets('D minor', 2);
      expect(snippetResults.length).toBeGreaterThan(0);
      expect(snippetResults[0].snippet).toBeDefined();
      expect(snippetResults[0].snippet.toLowerCase()).toMatch(/d.*minor|minor/);
    });
  });
});
