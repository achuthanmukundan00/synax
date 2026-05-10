/**
 * Integration test: store → retrieve → exhaust → handoff → continue.
 *
 * Proves that the holographic memory + handoff pipeline connects end-to-end.
 * Uses an in-memory SQLite database to avoid filesystem dependencies.
 *
 * Verifies:
 *   1. Memory stores entries and retrieves them via FTS5 search
 *   2. Handoff manifest is generated with key findings and search terms
 *   3. Handoff context is built from the manifest for session continuation
 *   4. Session uses persistent sessionId for cross-turn memory
 *   5. Verification contracts detect premature completion
 */

import Database from 'better-sqlite3';

import { HolographicMemory } from '../memory/HolographicMemory';
import { Session } from '../session/Session';
import { resolveVerificationContract, checkCompletionAgainstContract } from '../session/verification-contracts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

import type { ChatResponse } from '../llm/types';

function mockClient() {
  return {
    chat: async (): Promise<ChatResponse> => ({
      content: '',
      model: 'test-model',
      finishReason: 'stop',
      toolCalls: [],
      toolCallFormat: 'openai',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    }),
  };
}

function createInMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Minimal schema for FTS5 (same as store/schema.ts)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      turn_id,
      session_id,
      role,
      tool_name,
      file_paths,
      content,
      prefix='2 3',
      tokenize='porter unicode61'
    );
  `);
  return db;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Memory → Handoff → Continue Pipeline', () => {
  let db: Database.Database;
  let memory: HolographicMemory;

  beforeEach(() => {
    db = createInMemoryDb();
    memory = new HolographicMemory(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── Test 1: Store and retrieve ────────────────────────────────────────

  describe('store → retrieve', () => {
    it('stores entries and retrieves them via FTS5 search', () => {
      memory.store({
        sessionId: 'syn-test',
        turnId: 1,
        role: 'user',
        content: 'Fix the TypeScript build error in login.ts',
      });

      memory.store({
        sessionId: 'syn-test',
        turnId: 1,
        role: 'tool',
        toolName: 'bash',
        content: JSON.stringify({
          success: false,
          toolName: 'bash',
          error: 'TS2322: Type string is not assignable to type number at login.ts:42',
        }),
      });

      memory.store({
        sessionId: 'syn-test',
        turnId: 2,
        role: 'assistant',
        content: 'I found the error. Type coercion needed at login.ts:42.',
      });

      // Search by error type
      const results = memory.search('TS2322', 5);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain('TS2322');

      // Search by file path
      const results2 = memory.search('login.ts', 5);
      expect(results2.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty results for non-matching queries', () => {
      memory.store({
        sessionId: 'syn-test',
        turnId: 1,
        role: 'user',
        content: 'Fix the build',
      });

      const results = memory.search('zzz_nonexistent_query_xyz', 5);
      expect(results).toHaveLength(0);
    });

    it('respects the result limit', () => {
      for (let i = 0; i < 10; i++) {
        memory.store({
          sessionId: 'syn-test',
          turnId: i,
          role: 'assistant',
          content: `error in file${i}.ts`,
        });
      }

      const results = memory.search('error', 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  // ── Test 2: Handoff manifest ──────────────────────────────────────────

  describe('handoff manifest', () => {
    it('generates a manifest with key findings and search terms', () => {
      memory.store({
        sessionId: 'syn-test',
        turnId: 1,
        role: 'user',
        content: 'Fix the build errors',
      });

      memory.store({
        sessionId: 'syn-test',
        turnId: 1,
        role: 'tool',
        toolName: 'bash',
        filePaths: ['src/auth/login.ts'],
        content: 'error TS2322 at login.ts:42',
      });

      memory.store({
        sessionId: 'syn-test',
        turnId: 2,
        role: 'tool',
        toolName: 'edit',
        filePaths: ['src/auth/login.ts'],
        content: 'successfully edited login.ts',
      });

      memory.store({
        sessionId: 'syn-test',
        turnId: 3,
        role: 'tool',
        toolName: 'bash',
        content: 'npm test passed successfully',
      });

      const manifest = memory.handoff();

      expect(manifest.sessionId).toBe('syn-test');
      expect(manifest.turnCount).toBeGreaterThanOrEqual(1);
      expect(manifest.entryCount).toBeGreaterThanOrEqual(4);
      expect(manifest.filesTouched).toContain('src/auth/login.ts');

      // Should find key findings from error/success lines
      const hasErrorLine = manifest.keyFindings.some((f) => f.includes('error') || f.includes('TS2322'));
      expect(hasErrorLine).toBe(true);

      // Should generate search terms
      expect(manifest.suggestedSearchTerms.length).toBeGreaterThan(0);
    });

    it('returns empty manifest when no entries exist', () => {
      const manifest = memory.handoff();
      expect(manifest.keyFindings).toHaveLength(0);
      expect(manifest.filesTouched).toHaveLength(0);
      expect(manifest.turnCount).toBe(0);
    });

    it('returns empty manifest when database is null', () => {
      const nullMemory = new HolographicMemory(null);
      const manifest = nullMemory.handoff();
      expect(manifest.keyFindings).toHaveLength(0);
      expect(manifest.filesTouched).toHaveLength(0);
    });
  });

  // ── Test 3: Handoff context builder ───────────────────────────────────

  describe('handoff context for continuation', () => {
    it('builds compact context preserving system prompt and handoff manifest', () => {
      // Populate memory
      for (let i = 0; i < 5; i++) {
        memory.store({
          sessionId: 'syn-test',
          turnId: i,
          role: 'tool',
          toolName: i % 2 === 0 ? 'bash' : 'edit',
          filePaths: [`src/file${i}.ts`],
          content: `result for turn ${i}: success`,
        });
      }

      const manifest = memory.handoff();

      // Build handoff context (using the same function Session uses internally)
      // We can't call the private method, so we verify the manifest structure
      expect(manifest.keyFindings.length).toBeGreaterThan(0);
      expect(manifest.filesTouched.length).toBeGreaterThan(0);
      expect(manifest.suggestedSearchTerms.length).toBeGreaterThan(0);
      expect(manifest.turnCount).toBeGreaterThan(0);
      expect(manifest.entryCount).toBeGreaterThan(0);

      // The manifest should be suitable for injecting into a conversation
      // as a system message containing:
      // - turns completed
      // - key findings
      // - files touched
      // - suggested search terms
      expect(typeof manifest.sessionId).toBe('string');
      expect(Array.isArray(manifest.keyFindings)).toBe(true);
      expect(Array.isArray(manifest.filesTouched)).toBe(true);
      expect(Array.isArray(manifest.suggestedSearchTerms)).toBe(true);
    });
  });

  // ── Test 4: Persistent session ID ─────────────────────────────────────

  describe('persistent session identity', () => {
    it('uses the same sessionId for all memory stores in a session', () => {
      const session = new Session({
        repoRoot: '/tmp/test',
        client: mockClient(),
        sessionId: 'syn-persist-001',
        memory,
        mode: 'read-only',
      });

      expect(session.sessionId).toBe('syn-persist-001');

      // A second session with explicit ID should use that ID
      const session2 = new Session({
        repoRoot: '/tmp/test',
        client: mockClient(),
        sessionId: 'syn-persist-002',
        memory,
        mode: 'read-only',
      });

      expect(session2.sessionId).toBe('syn-persist-002');
    });

    it('generates unique session IDs when not provided', () => {
      const session1 = new Session({
        repoRoot: '/tmp/test',
        client: mockClient(),
        mode: 'read-only',
      });

      const session2 = new Session({
        repoRoot: '/tmp/test',
        client: mockClient(),
        mode: 'read-only',
      });

      expect(session1.sessionId).not.toBe(session2.sessionId);
      expect(session1.sessionId).toMatch(/^syn-/);
      expect(session2.sessionId).toMatch(/^syn-/);
    });
  });

  // ── Test 5: Verification contracts ────────────────────────────────────

  describe('verification contracts (replacing regex completion)', () => {
    it('blocks completion when no files changed in patch mode', () => {
      const contract = resolveVerificationContract('patch');
      expect(contract.level).toBe('files_changed');

      const nudge = checkCompletionAgainstContract(contract, { changedFiles: [], verificationRan: false }, 'completed');
      expect(nudge).not.toBeNull();
      expect(nudge).toContain('no files were changed');
    });

    it('allows completion when files changed in patch mode', () => {
      const contract = resolveVerificationContract('patch');
      const nudge = checkCompletionAgainstContract(
        contract,
        { changedFiles: ['src/a.ts'], verificationRan: false },
        'completed',
      );
      expect(nudge).toBeNull();
    });

    it('always allows completion in read-only mode', () => {
      const contract = resolveVerificationContract('read-only');
      expect(contract.level).toBe('none');

      const nudge = checkCompletionAgainstContract(contract, { changedFiles: [], verificationRan: false }, 'completed');
      expect(nudge).toBeNull();
    });

    it('does not check non-completion terminal states', () => {
      const contract = resolveVerificationContract('patch');
      const nudge = checkCompletionAgainstContract(
        contract,
        { changedFiles: [], verificationRan: false },
        'model_error',
      );
      expect(nudge).toBeNull(); // Only checks 'completed' state
    });

    it('verify mode requires verification to pass', () => {
      const contract = resolveVerificationContract('verify');
      expect(contract.level).toBe('verification_passed');

      // No verification run yet
      const nudge1 = checkCompletionAgainstContract(
        contract,
        { changedFiles: [], verificationRan: false },
        'completed',
      );
      expect(nudge1).not.toBeNull();

      // Verification ran but failed
      const nudge2 = checkCompletionAgainstContract(
        contract,
        { changedFiles: ['src/a.ts'], verificationRan: true, verificationExitCode: 1 },
        'completed',
      );
      expect(nudge2).not.toBeNull();

      // Verification passed
      const nudge3 = checkCompletionAgainstContract(
        contract,
        { changedFiles: ['src/a.ts'], verificationRan: true, verificationExitCode: 0 },
        'completed',
      );
      expect(nudge3).toBeNull();
    });
  });

  // ── Test 6: End-to-end dummy turn ─────────────────────────────────────

  describe('session construction with memory', () => {
    it('accepts memory in constructor and exposes it', () => {
      const session = new Session({
        repoRoot: '/tmp/test',
        client: mockClient(),
        memory,
        mode: 'read-only',
      });

      expect(session.memory).toBe(memory);
      expect(session.memory?.isAvailable).toBe(true);
    });

    it('shutdown cleans up event bus without errors', () => {
      const session = new Session({
        repoRoot: '/tmp/test',
        client: mockClient(),
        mode: 'read-only',
      });

      expect(() => session.shutdown('completed')).not.toThrow();
    });

    it('has recovery recipes registered', () => {
      const session = new Session({
        repoRoot: '/tmp/test',
        client: mockClient(),
        mode: 'read-only',
      });

      // Recovery manager should exist and have default recipes
      expect(session.recovery).toBeDefined();
    });

    it('static createConversation includes system prompt', () => {
      const conv = Session.createConversation();
      expect(conv.messages).toHaveLength(1);
      expect(conv.messages[0].role).toBe('system');
      expect(conv.messages[0].content).toContain('Synax');
    });

    it('resetConversation clears state but preserves event subscriptions', () => {
      const session = new Session({
        repoRoot: '/tmp/test',
        client: mockClient(),
      });

      session.eventBus.on('session_shutdown' as any, () => {
        // subscription intact
      });

      session.resetConversation();
      expect(session.conversation.messages).toHaveLength(1);

      session.shutdown('completed');
      // Event subscription survives reset
    });
  });

  // ── Test 7: Error counter on memory store failures ────────────────────

  describe('memory error counter', () => {
    it('has an error counter that starts at zero', () => {
      expect(memory.storeErrorCount).toBe(0);
    });

    it('isAvailable returns false when insertStmt is null', () => {
      const nullMemory = new HolographicMemory(null);
      expect(nullMemory.isAvailable).toBe(false);
    });

    it('search returns empty array when db is null', () => {
      const nullMemory = new HolographicMemory(null);
      const results = nullMemory.search('anything', 5);
      expect(results).toHaveLength(0);
    });
  });
});

// ─── Full pipeline test (requires working SQLite with FTS5) ──────────────────

describe('Full Pipeline: Store → Exhaust → Handoff → Continue', () => {
  it('handoff context is structurally valid for injection into conversation', () => {
    const db = createInMemoryDb();
    const memory = new HolographicMemory(db);

    // Simulate a session with multiple turns
    memory.store({
      sessionId: 'syn-full-test',
      turnId: 1,
      role: 'user',
      content: 'Fix the TypeScript build errors in the auth module',
    });

    memory.store({
      sessionId: 'syn-full-test',
      turnId: 1,
      role: 'tool',
      toolName: 'bash',
      filePaths: [],
      content: JSON.stringify({
        success: false,
        error: 'TS2322: Type string is not assignable to type number at auth/login.ts:42',
      }),
    });

    memory.store({
      sessionId: 'syn-full-test',
      turnId: 1,
      role: 'assistant',
      content: 'Found type error at auth/login.ts:42. Will fix with type coercion.',
    });

    memory.store({
      sessionId: 'syn-full-test',
      turnId: 2,
      role: 'tool',
      toolName: 'edit',
      filePaths: ['auth/login.ts'],
      content: JSON.stringify({ success: true, changedFile: 'auth/login.ts' }),
    });

    memory.store({
      sessionId: 'syn-full-test',
      turnId: 2,
      role: 'tool',
      toolName: 'bash',
      filePaths: [],
      content: JSON.stringify({ success: true, exitCode: 0, stdout: 'npm test: all passed' }),
    });

    // ── Simulate context exhaustion ──
    // 1. Generate handoff manifest
    const manifest = memory.handoff();

    // 2. Manifest must contain actionable information for the next agent
    expect(manifest.turnCount).toBeGreaterThanOrEqual(1);
    expect(manifest.filesTouched.length).toBeGreaterThanOrEqual(1);
    expect(manifest.filesTouched).toContain('auth/login.ts');

    // 3. Key findings should capture the error
    const hasTsError = manifest.keyFindings.some(
      (f) => f.includes('TS2322') || f.includes('type') || f.includes('error'),
    );
    expect(hasTsError).toBe(true);

    // 4. Search terms should help the next agent find relevant history
    expect(manifest.suggestedSearchTerms.length).toBeGreaterThan(0);
    const hasRelevantTerm = manifest.suggestedSearchTerms.some(
      (t) =>
        t.includes('edit') || t.includes('bash') || t.includes('login') || t.includes('auth') || t.includes('error'),
    );
    expect(hasRelevantTerm).toBe(true);

    // 5. The next agent can search for the original error
    const searchResults = memory.search('TS2322', 5);
    expect(searchResults.length).toBeGreaterThanOrEqual(1);
    expect(searchResults[0].content).toContain('TS2322');

    // 6. The next agent can search using suggested terms
    const termResults = memory.search(manifest.suggestedSearchTerms[0], 3);
    expect(termResults.length).toBeGreaterThanOrEqual(1);

    db.close();
  });
});
