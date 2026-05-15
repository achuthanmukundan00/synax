import { parseOrchestrationPlan } from '../../orchestration/plan-parser';

describe('plan-parser', () => {
  it('parses a valid orchestration plan', () => {
    const raw = JSON.stringify({
      planId: 'plan-xyz',
      subtasks: [
        {
          id: 'task-1',
          description: 'do the thing',
          fileScope: ['src/a.ts'],
          dependencies: [],
        },
      ],
    });

    const result = parseOrchestrationPlan(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.plan.planId).toBe('plan-xyz');
      expect(result.plan.subtasks).toHaveLength(1);
      expect(result.plan.subTasks).toEqual([
        expect.objectContaining({
          id: 'task-1',
          description: 'do the thing',
          estimatedBudget: 4000,
          fileScope: ['src/a.ts'],
          dependencies: [],
        }),
      ]);
    }
  });

  it('parses safely back to inline for { inline: true }', () => {
    const raw = JSON.stringify({ inline: true });

    const result = parseOrchestrationPlan(raw);

    expect(result.success).toBe(false);
    if (!result.success && 'inline' in result) {
      expect(result.inline).toBe(true);
    } else {
      fail('Expected inline fallback');
    }
  });

  it('repairs lightly malformed JSON', () => {
    // Missing closing bracket
    const raw = `
    {
      "planId": "plan-xyz",
      "subtasks": [
        {
          "id": "task-1",
          "description": "do the thing"
        }
    `;

    const result = parseOrchestrationPlan(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.plan.planId).toBe('plan-xyz');
    }
  });

  it('falls back to inline for unrepairable garbage', () => {
    const raw = `I am completely ignoring your schema. I think you should just run this code.`;

    const result = parseOrchestrationPlan(raw);

    expect(result.success).toBe(false);
    if (!result.success && 'inline' in result) {
      expect(result.inline).toBe(true);
    }
  });
});
