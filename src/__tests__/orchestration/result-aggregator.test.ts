import { aggregateResults } from '../../orchestration/result-aggregator';
import type { SubAgentResult, OrchestrationPlan } from '../../session/types';

function makePlan(subTaskCount: number): OrchestrationPlan {
  return {
    planId: 'plan-test',
    subTasks: Array.from({ length: subTaskCount }, (_, i) => ({
      id: `task-${i + 1}`,
      description: `Task ${i + 1}`,
      estimatedBudget: 500,
      fileScope: [`src/file-${i + 1}.ts`],
      dependencies: [],
      verification: { level: 'none' as const, label: 'no verification' },
    })),
    strategy: 'orchestrate',
    estimatedTotalTokens: subTaskCount * 500,
    repoMetadata: { fileCount: 10, totalKB: 100, sourceKB: 80 },
    contextWindowTokens: 131072,
  };
}

function makeResult(
  subTaskId: string,
  changedFiles: string[],
  terminalState: import('../../session/types').AgentTerminalState = 'completed',
  toolCalls = changedFiles.length * 2,
  error?: string,
  finalAnswer?: string,
): SubAgentResult {
  return { subTaskId, terminalState, changedFiles, toolCalls, error, finalAnswer };
}

describe('result-aggregator', () => {
  describe('aggregateResults', () => {
    it('aggregates single completed result', () => {
      const plan = makePlan(1);
      const results = [makeResult('task-1', ['src/a.ts'])];

      const aggregated = aggregateResults(plan, results);

      expect(aggregated.plan).toBe(plan);
      expect(aggregated.results).toHaveLength(1);
      expect(aggregated.terminalState).toBe('completed');
      expect(aggregated.changedFiles).toEqual(['src/a.ts']);
      expect(aggregated.toolCalls).toBe(2);
      expect(aggregated.error).toBeUndefined();
      expect(aggregated.conclusion).toContain('completed');
      expect(aggregated.conclusion).toContain('task-1');
    });

    it('aggregates multiple completed results with deduplication', () => {
      const plan = makePlan(3);
      const results = [
        makeResult('task-1', ['src/a.ts', 'src/shared.ts']),
        makeResult('task-2', ['src/b.ts', 'src/shared.ts']),
        makeResult('task-3', ['src/c.ts']),
      ];

      const aggregated = aggregateResults(plan, results);

      expect(aggregated.terminalState).toBe('completed');
      expect(aggregated.changedFiles.sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/shared.ts'].sort());
      expect(aggregated.toolCalls).toBe(10); // task-1: 4 (2 files), task-2: 4 (2 files), task-3: 2 (1 file)
    });

    it('propagates worst terminal state', () => {
      const plan = makePlan(3);
      const results = [
        makeResult('task-1', ['src/a.ts'], 'completed'),
        makeResult('task-2', [], 'model_error', 0, 'crashed'),
        makeResult('task-3', ['src/c.ts'], 'completed'),
      ];

      const aggregated = aggregateResults(plan, results);
      expect(aggregated.terminalState).toBe('model_error');
      expect(aggregated.error).toContain('task-2');
    });

    it('includes conflict info in conclusion', () => {
      const plan = makePlan(2);
      const results = [makeResult('task-1', ['src/a.ts']), makeResult('task-2', ['src/a.ts'])];

      const conflicts = [{ file: 'src/a.ts', reason: 'Modified by 2 sub-agents', children: ['task-1', 'task-2'] }];
      const aggregated = aggregateResults(plan, results, conflicts);

      expect(aggregated.conclusion).toContain('Conflicts Detected');
      expect(aggregated.conclusion).toContain('src/a.ts');
    });

    it('includes remaining work for failed tasks', () => {
      const plan = makePlan(3);
      const results = [
        makeResult('task-1', ['src/a.ts'], 'completed'),
        makeResult('task-2', [], 'blocked', 0, 'could not proceed'),
        makeResult('task-3', [], 'completed'),
      ];

      const aggregated = aggregateResults(plan, results);
      expect(aggregated.conclusion).toContain('Remaining Work');
      expect(aggregated.conclusion).toContain('task-2');
    });

    it('handles empty results', () => {
      const plan = makePlan(0);
      const aggregated = aggregateResults(plan, []);
      expect(aggregated.terminalState).toBe('completed');
      expect(aggregated.changedFiles).toEqual([]);
      expect(aggregated.toolCalls).toBe(0);
    });

    it('conclusion reflects partial state', () => {
      const plan = makePlan(2);
      const results = [
        makeResult('task-1', ['src/a.ts'], 'completed'),
        makeResult('task-2', [], 'blocked', 0, 'blocked'),
      ];

      const aggregated = aggregateResults(plan, results);
      expect(aggregated.terminalState).toBe('blocked');
      expect(aggregated.conclusion).toContain('1/2');
      expect(aggregated.conclusion).toContain('blocked');
    });

    it('conclusion section headers are present', () => {
      const plan = makePlan(1);
      const results = [makeResult('task-1', ['src/a.ts'])];

      const aggregated = aggregateResults(plan, results);
      expect(aggregated.conclusion).toContain('Sub-task Results');
      expect(aggregated.conclusion).toContain('Files Changed');
      expect(aggregated.conclusion).toContain('src/a.ts');
    });

    it('includes findings from child finalAnswer', () => {
      const plan = makePlan(1);
      const results = [
        makeResult(
          'tui-inspect',
          [],
          'completed',
          25,
          undefined,
          [
            'Found buffer overflow in parseRawInput() on multi-byte sequences.',
            'Race condition in finalize() during cleanup.',
          ].join('\n'),
        ),
      ];

      const aggregated = aggregateResults(plan, results);
      expect(aggregated.conclusion).toContain('Findings:');
      expect(aggregated.conclusion).toContain('buffer overflow');
      expect(aggregated.conclusion).toContain('Race condition');
      expect(aggregated.conclusion).toContain('parseRawInput');
    });

    it('includes findings for multiple children', () => {
      const plan = makePlan(2);
      const results = [
        makeResult('tui-inspect', [], 'completed', 25, undefined, 'Found TUI bug.'),
        makeResult('session-inspect', [], 'completed', 27, undefined, 'Found Session bug.'),
      ];

      const aggregated = aggregateResults(plan, results);
      // Both child IDs should appear
      expect(aggregated.conclusion).toContain('tui-inspect');
      expect(aggregated.conclusion).toContain('session-inspect');
      // Both findings should appear
      expect(aggregated.conclusion).toContain('Found TUI bug.');
      expect(aggregated.conclusion).toContain('Found Session bug.');
      // Summary should show 2/2
      expect(aggregated.conclusion).toContain('2/2');
    });

    it('truncates long child findings', () => {
      const plan = makePlan(1);
      const longFindings = 'A'.repeat(600);
      const results = [makeResult('task-1', [], 'completed', 10, undefined, longFindings)];

      const aggregated = aggregateResults(plan, results);
      // Should be truncated (400 limit) — 400 chars + '...' = 403
      expect(aggregated.conclusion).toContain('...');
      expect(aggregated.conclusion).not.toContain('A'.repeat(500));
    });

    it('limits findings to 5 lines', () => {
      const plan = makePlan(1);
      const manyLines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join('\n');
      const results = [makeResult('task-1', [], 'completed', 10, undefined, manyLines)];

      const aggregated = aggregateResults(plan, results);
      expect(aggregated.conclusion).toContain('Line 1');
      expect(aggregated.conclusion).toContain('Line 5');
      expect(aggregated.conclusion).not.toContain('Line 6');
      expect(aggregated.conclusion).toContain('...');
    });

    it('uses finished wording for partial completion', () => {
      const plan = makePlan(2);
      const results = [
        makeResult('task-1', ['src/a.ts'], 'completed'),
        makeResult('task-2', [], 'blocked', 0, 'blocked'),
      ];

      const aggregated = aggregateResults(plan, results);
      expect(aggregated.conclusion).toContain('Orchestration finished');
      expect(aggregated.conclusion).toContain('1/2');
      expect(aggregated.conclusion).not.toContain('Orchestration completed');
    });

    it('uses completed wording for full success', () => {
      const plan = makePlan(2);
      const results = [
        makeResult('task-1', ['src/a.ts'], 'completed'),
        makeResult('task-2', ['src/b.ts'], 'completed'),
      ];

      const aggregated = aggregateResults(plan, results);
      expect(aggregated.conclusion).toContain('Orchestration completed');
      expect(aggregated.conclusion).toContain('2/2');
    });

    it('skips findings section when finalAnswer is absent', () => {
      const plan = makePlan(1);
      const results = [makeResult('task-1', ['src/a.ts'], 'completed', 5)];

      const aggregated = aggregateResults(plan, results);
      expect(aggregated.conclusion).not.toContain('Findings:');
      expect(aggregated.conclusion).toContain('Sub-task Results');
    });
  });
});
