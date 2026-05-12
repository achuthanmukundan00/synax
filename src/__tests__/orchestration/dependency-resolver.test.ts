import { resolveTaskDependencies, DependencyCycleError } from '../../orchestration/dependency-resolver';
import type { SubTask } from '../../session/types';

function makeTask(id: string, deps: string[] = [], fileScope: string[] = []): SubTask {
  return {
    id,
    description: `Task ${id}`,
    estimatedBudget: 1000,
    fileScope,
    dependencies: deps,
    verification: { level: 'none', label: 'no verification' },
  };
}

describe('dependency-resolver', () => {
  describe('resolveTaskDependencies', () => {
    it('handles empty array', () => {
      const groups = resolveTaskDependencies([]);
      expect(groups).toEqual([]);
    });

    it('handles single task with no dependencies', () => {
      const groups = resolveTaskDependencies([makeTask('t1')]);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toHaveLength(1);
      expect(groups[0][0].id).toBe('t1');
    });

    it('returns single group for independent tasks', () => {
      const tasks = [makeTask('t1'), makeTask('t2'), makeTask('t3')];
      const groups = resolveTaskDependencies(tasks);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toHaveLength(3);
    });

    it('orders tasks by dependency chain', () => {
      const tasks = [makeTask('t3', ['t2']), makeTask('t2', ['t1']), makeTask('t1', [])];

      const groups = resolveTaskDependencies(tasks);
      // Should produce 3 groups: [t1], [t2], [t3]
      expect(groups).toHaveLength(3);
      expect(groups[0].map((t) => t.id)).toEqual(['t1']);
      expect(groups[1].map((t) => t.id)).toEqual(['t2']);
      expect(groups[2].map((t) => t.id)).toEqual(['t3']);
    });

    it('groups independent tasks at same level', () => {
      const tasks = [makeTask('t1', []), makeTask('t2', []), makeTask('t3', ['t1', 't2'])];

      const groups = resolveTaskDependencies(tasks);
      // t1 and t2 can run in parallel, t3 after both
      expect(groups).toHaveLength(2);
      expect(groups[0].map((t) => t.id).sort()).toEqual(['t1', 't2']);
      expect(groups[1].map((t) => t.id)).toEqual(['t3']);
    });

    it('handles complex dependency graph', () => {
      // t1, t2 independent → t3 depends on t1 → t4 depends on t2, t3
      const tasks = [makeTask('t4', ['t2', 't3']), makeTask('t3', ['t1']), makeTask('t2', []), makeTask('t1', [])];

      const groups = resolveTaskDependencies(tasks);
      // Group 0: [t1, t2], Group 1: [t3], Group 2: [t4]
      expect(groups).toHaveLength(3);
      expect(groups[0].map((t) => t.id).sort()).toEqual(['t1', 't2']);
      expect(groups[1].map((t) => t.id)).toEqual(['t3']);
      expect(groups[2].map((t) => t.id)).toEqual(['t4']);
    });

    it('detects simple cycle (A → B → A)', () => {
      const tasks = [makeTask('a', ['b']), makeTask('b', ['a'])];

      expect(() => resolveTaskDependencies(tasks)).toThrow(DependencyCycleError);
    });

    it('detects three-node cycle', () => {
      const tasks = [makeTask('a', ['c']), makeTask('b', ['a']), makeTask('c', ['b'])];

      expect(() => resolveTaskDependencies(tasks)).toThrow(DependencyCycleError);
    });

    it('throws for unknown dependency reference', () => {
      const tasks = [makeTask('t1', ['nonexistent'])];

      expect(() => resolveTaskDependencies(tasks)).toThrow(/depends on unknown task "nonexistent"/);
    });

    it('self-dependency is a cycle', () => {
      const tasks = [makeTask('t1', ['t1'])];
      expect(() => resolveTaskDependencies(tasks)).toThrow(DependencyCycleError);
    });

    it('cycle error includes the cycle path', () => {
      const tasks = [makeTask('a', ['b']), makeTask('b', ['a'])];

      try {
        resolveTaskDependencies(tasks);
        fail('Expected DependencyCycleError');
      } catch (error) {
        expect(error).toBeInstanceOf(DependencyCycleError);
        expect((error as DependencyCycleError).cycle).toContain('a');
        expect((error as DependencyCycleError).cycle).toContain('b');
        expect((error as DependencyCycleError).message).toContain('a');
        expect((error as DependencyCycleError).message).toContain('b');
      }
    });
  });
});
