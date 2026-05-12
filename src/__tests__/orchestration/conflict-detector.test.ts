import { detectConflicts, areFileScopesDisjoint } from '../../orchestration/conflict-detector';
import type { SubAgentResult } from '../../session/types';

describe('conflict-detector', () => {
  function makeResult(
    subTaskId: string,
    changedFiles: string[],
    terminalState: import('../../session/types').AgentTerminalState = 'completed',
  ): SubAgentResult {
    return {
      subTaskId,
      terminalState,
      changedFiles,
      toolCalls: changedFiles.length * 3,
      error: terminalState === 'completed' ? undefined : 'mock error',
    };
  }

  describe('detectConflicts', () => {
    it('returns no conflicts when file scopes are disjoint', () => {
      const results = [
        makeResult('task-1', ['src/a.ts', 'src/b.ts']),
        makeResult('task-2', ['src/c.ts']),
        makeResult('task-3', ['docs/readme.md']),
      ];

      const conflicts = detectConflicts(results);
      expect(conflicts).toEqual([]);
    });

    it('detects conflict when two children modify the same file', () => {
      const results = [makeResult('task-1', ['src/a.ts']), makeResult('task-2', ['src/a.ts'])];

      const conflicts = detectConflicts(results);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].file).toBe('src/a.ts');
      expect(conflicts[0].children).toContain('task-1');
      expect(conflicts[0].children).toContain('task-2');
    });

    it('detects multiple conflicts', () => {
      const results = [
        makeResult('task-1', ['src/a.ts', 'src/shared.ts']),
        makeResult('task-2', ['src/b.ts', 'src/shared.ts']),
      ];

      const conflicts = detectConflicts(results);
      expect(conflicts).toHaveLength(1); // Only shared.ts is conflicted
      expect(conflicts[0].file).toBe('src/shared.ts');
    });

    it('handles three-way conflict', () => {
      const results = [
        makeResult('task-1', ['src/a.ts']),
        makeResult('task-2', ['src/a.ts']),
        makeResult('task-3', ['src/a.ts']),
      ];

      const conflicts = detectConflicts(results);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].children).toHaveLength(3);
    });

    it('returns empty array for no results', () => {
      expect(detectConflicts([])).toEqual([]);
    });

    it('returns empty array for single result', () => {
      const conflicts = detectConflicts([makeResult('task-1', ['src/a.ts'])]);
      expect(conflicts).toEqual([]);
    });

    it('filters out empty file strings', () => {
      const results = [makeResult('task-1', ['src/a.ts', '']), makeResult('task-2', ['src/a.ts'])];

      const conflicts = detectConflicts(results);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].file).toBe('src/a.ts');
    });

    it('handles results with no changed files', () => {
      const results = [makeResult('task-1', []), makeResult('task-2', ['src/a.ts'])];

      const conflicts = detectConflicts(results);
      expect(conflicts).toEqual([]);
    });
  });

  describe('areFileScopesDisjoint', () => {
    it('returns true for disjoint scopes', () => {
      const a = makeResult('task-1', ['src/a.ts']);
      const b = makeResult('task-2', ['src/b.ts']);
      expect(areFileScopesDisjoint(a, b)).toBe(true);
    });

    it('returns false for overlapping scopes', () => {
      const a = makeResult('task-1', ['src/a.ts', 'src/shared.ts']);
      const b = makeResult('task-2', ['src/b.ts', 'src/shared.ts']);
      expect(areFileScopesDisjoint(a, b)).toBe(false);
    });

    it('returns true when both have no changed files', () => {
      const a = makeResult('task-1', []);
      const b = makeResult('task-2', []);
      expect(areFileScopesDisjoint(a, b)).toBe(true);
    });
  });
});
