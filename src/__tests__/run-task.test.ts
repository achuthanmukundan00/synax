import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

import { type AgentEvent } from '../agent/events';

const TMP = join(process.cwd(), 'tmp', 'synax-run-task-tests');
const requests: unknown[] = [];
let responses: Array<{ content?: string; toolCalls?: unknown[] }> = [];

jest.mock('../llm/client', () => ({
  createOpenAICompatibleClient: () => ({
    chat: async (options: unknown) => {
      requests.push(options);
      const next = responses.shift() ?? { content: 'done', toolCalls: [] };
      return {
        content: next.content ?? '',
        model: 'fake',
        finishReason: 'stop',
        toolCalls: next.toolCalls ?? [],
        usage: null,
      };
    },
  }),
}));

jest.mock('../orchestration/OrchestrationManager', () => ({
  OrchestrationManager: {
    execute: jest.fn().mockImplementation(() =>
      Promise.resolve({
        terminalState: 'completed',
        conclusion: 'All sub-tasks completed.',
        results: [
          {
            subTaskId: 'task-1',
            terminalState: 'completed',
            changedFiles: ['src/foo.ts'],
            toolCalls: 3,
            finalAnswer: 'Found the bug in src/foo.ts',
          },
          {
            subTaskId: 'task-2',
            terminalState: 'completed',
            changedFiles: [],
            toolCalls: 2,
            finalAnswer: 'Everything looks good in src/bar.ts',
          },
        ],
        changedFiles: ['src/foo.ts'],
        toolCalls: 5,
      }),
    ),
  },
}));

import { runAgentTask } from '../agent/run-task';

function resetTmp(): void {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(
    join(TMP, '.synax.toml'),
    ['[provider]', 'kind = "openai-compatible"', 'base_url = "http://localhost/v1"', 'model = "fake"'].join('\n'),
    'utf-8',
  );
  requests.splice(0, requests.length);
  responses = [];
}

describe('runAgentTask patch approval', () => {
  beforeEach(() => resetTmp());
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it('rejects previewed edits in non-interactive run unless --yes is set', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello\n', 'utf-8');
    const events: AgentEvent[] = [];
    responses = [
      { toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: 'call_2', name: 'edit', arguments: { path: 'a.txt', oldStr: 'hello', newStr: 'hi' } }] },
      { content: 'should not be reached' },
    ];

    const report = await runAgentTask({
      repoRoot: TMP,
      task: 'edit a.txt',
      onEvent: (event) => events.push(event),
    });

    expect(report).toMatchObject({
      terminalState: 'user_input_required',
      filesChanged: [],
      error: 'patch rejected for a.txt',
    });
    expect(readFileSync(join(TMP, 'a.txt'), 'utf-8')).toBe('hello\n');
    expect(events.map((event) => event.type)).toContain('patch_preview');
  });

  it('reports context ledger and checkpoint details once a mutation is approved', async () => {
    execSync('git init', { cwd: TMP, stdio: 'ignore' });
    execSync('git config user.email "synax@example.test"', { cwd: TMP, stdio: 'ignore' });
    execSync('git config user.name "Synax Test"', { cwd: TMP, stdio: 'ignore' });
    responses = [
      { toolCalls: [{ id: 'call_1', name: 'write', arguments: { path: 'notes/demo.md', content: '# Demo\n' } }] },
      { content: 'done' },
    ];

    const report = await runAgentTask({
      repoRoot: TMP,
      task: 'Create notes/demo.md',
      yes: true,
    });

    expect(report.mode).toBe('patch');
    expect(report.filesChanged).toEqual(['notes/demo.md']);
    expect(report.checkpoint?.id).toBeTruthy();
    expect(report.contextBudgetTokens).toBeGreaterThan(0);
    expect(report.maxModelSteps).toBeGreaterThan(0);
    expect(report.maxToolCalls).toBeGreaterThan(0);
  });

  it('does not create checkpoints for read-only runs with no mutations', async () => {
    execSync('git init', { cwd: TMP, stdio: 'ignore' });
    execSync('git config user.email "synax@example.test"', { cwd: TMP, stdio: 'ignore' });
    execSync('git config user.name "Synax Test"', { cwd: TMP, stdio: 'ignore' });
    writeFileSync(join(TMP, 'README.md'), '# Synax\n', 'utf-8');
    responses = [{ content: 'done' }];

    const report = await runAgentTask({
      repoRoot: TMP,
      task: 'Inspect README.md',
      mode: 'read-only',
    });

    expect(report.terminalState).toBe('completed');
    expect(report.checkpoint).toBeNull();
    expect(existsSync(join(TMP, '.synax', 'checkpoints'))).toBe(false);
  });

  it('allows broad self-development task prompts', async () => {
    const report = await runAgentTask({
      repoRoot: TMP,
      task: 'rewrite the TUI',
    });

    expect(report.terminalState).not.toBe('blocked');
    expect(existsSync(join(TMP, '.synax', 'checkpoints'))).toBe(false);
  });

  it('does not silently fall back to inline when explicit parallel sub-agents plan inline', async () => {
    const events: AgentEvent[] = [];
    responses = [{ content: JSON.stringify({ inline: true }) }];

    const report = await runAgentTask({
      repoRoot: TMP,
      task: 'use parallel sub-agents to read docs and specs',
      onEvent: (event) => events.push(event),
    });

    expect(report.terminalState).toBe('blocked');
    expect(report.finalAnswer).toContain('Explicit orchestrate (parallel) was requested');
    expect(report.finalAnswer).toContain('Refusing to continue inline');
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain('Do not return');
    expect(JSON.stringify(requests[0])).toContain('use parallel sub-agents to read docs and specs');
    expect(events.map((event) => event.type)).toContain('orchestration_plan_generated');
    expect(events.map((event) => event.type)).toContain('assistant_message');
  });

  it('bridges sub-agent results into parent conversation context via orchestration', async () => {
    const events: AgentEvent[] = [];
    // LLM planner returns a valid decomposition plan → orchestration executes
    responses = [
      {
        content: JSON.stringify({
          planId: 'test-plan',
          subtasks: [
            {
              id: 'task-1',
              description: 'first task',
              fileScope: ['src/'],
              dependencies: [],
              estimatedTokens: 8000,
            },
          ],
          strategy: 'orchestrate',
        }),
      },
    ];

    const report = await runAgentTask({
      repoRoot: TMP,
      task: 'use parallel sub-agents to investigate',
      onEvent: (event) => events.push(event),
    });

    expect(report.terminalState).toBe('completed');
    expect(report.finalAnswer).toBe('All sub-tasks completed.');
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('dispatch_started');
    expect(eventTypes).toContain('dispatch_workers_completed');
    // assistant_message should carry the orchestration conclusion
    const assistantMsgs = events.filter((e) => e.type === 'assistant_message');
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    expect((assistantMsgs[assistantMsgs.length - 1] as any).content).toBe('All sub-tasks completed.');
  });

  it('emits verification lifecycle events in correct order', async () => {
    // Configure a verification command in the project config
    writeFileSync(
      join(TMP, '.synax.toml'),
      [
        '[provider]',
        'kind = "openai-compatible"',
        'base_url = "http://localhost/v1"',
        'model = "fake"',
        '',
        '[verification]',
        'default_command = "echo tests passed"',
      ].join('\n'),
      'utf-8',
    );
    mkdirSync(join(TMP, 'src'), { recursive: true });
    const events: AgentEvent[] = [];
    responses = [
      {
        toolCalls: [
          { id: 'call_1', name: 'write', arguments: { path: 'src/app.ts', content: 'console.log("hello");\n' } },
        ],
      },
      { content: 'Created src/app.ts' },
    ];

    const report = await runAgentTask({
      repoRoot: TMP,
      task: 'Create src/app.ts',
      yes: true,
      recordRunArtifacts: false,
      onEvent: (event) => events.push(event),
    });

    const eventTypes = events.map((e) => e.type);
    // Should contain verification lifecycle events
    expect(eventTypes).toContain('verification_planned');
    expect(eventTypes).toContain('verification_started');

    const passedOrFailed = eventTypes.includes('verification_passed') || eventTypes.includes('verification_failed');
    expect(passedOrFailed).toBe(true);

    // Verification planned should come before started
    const plannedIdx = eventTypes.indexOf('verification_planned');
    const startedIdx = eventTypes.indexOf('verification_started');
    expect(plannedIdx).toBeLessThan(startedIdx);

    // task_finished should come last
    const finishedIdx = eventTypes.indexOf('task_finished');
    expect(finishedIdx).toBeGreaterThan(startedIdx);

    expect(report.verification.state).toBe('passed');
  });

  it('emits verification skipped when no command is configured even with changes', async () => {
    const events: AgentEvent[] = [];
    mkdirSync(join(TMP, 'src'), { recursive: true });
    responses = [
      {
        toolCalls: [
          { id: 'call_1', name: 'write', arguments: { path: 'src/app.ts', content: 'console.log("hello");\n' } },
        ],
      },
      { content: 'Created src/app.ts' },
    ];

    const report = await runAgentTask({
      repoRoot: TMP,
      task: 'Create src/app.ts',
      yes: true,
      recordRunArtifacts: false,
      onEvent: (event) => events.push(event),
    });

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('verification_skipped');
    expect(report.verification.state).toBe('skipped');
  });

  it('fails with failed_verification when model completes without changing files in patch mode', async () => {
    // Model responds with content only, no tool calls — claims completion without
    // ever attempting a write/edit. The files_changed contract must catch this.
    responses = [{ content: 'Everything looks fine, no changes needed.' }];

    const report = await runAgentTask({
      repoRoot: TMP,
      task: 'fix the bug',
      recordRunArtifacts: false,
    });

    expect(report.terminalState).toBe('failed_verification');
    expect(report.filesChanged).toEqual([]);
    expect(report.verification.state).toBe('skipped');
  });

  it('emits verification_failed event when contract is not satisfied (no files changed)', async () => {
    // Model completes without changing files. The contract check must emit
    // explicit verification_failed event rather than silently skipping.
    responses = [{ content: 'All done, nothing to fix.' }];

    const events: AgentEvent[] = [];
    const report = await runAgentTask({
      repoRoot: TMP,
      task: 'fix the bug',
      recordRunArtifacts: false,
      onEvent: (event) => events.push(event),
    });

    expect(report.terminalState).toBe('failed_verification');

    // Must emit verification_failed for the contract failure
    const failedEvents = events.filter((e) => e.type === 'verification_failed');
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);

    // The failure should reference the contract label
    const failure = failedEvents[0] as any;
    expect(failure.checkLabel).toBeTruthy();
    expect(failure.severity).toBe('S2');
  });

  it('triggers repair loop when contract is not satisfied (no files changed in patch mode)', async () => {
    // Model completes without changing files. The contract failure should
    // trigger at least one repair attempt to let the model fix it.
    // Use repairAttempts: 2 to verify the repair loop runs.
    writeFileSync(
      join(TMP, '.synax.toml'),
      [
        '[provider]',
        'kind = "openai-compatible"',
        'base_url = "http://localhost/v1"',
        'model = "fake"',
        '',
        '[verification]',
        'default_command = "echo ok"',
      ].join('\n'),
      'utf-8',
    );
    mkdirSync(join(TMP, 'src'), { recursive: true });

    // First turn: model claims completion without changing files (contract fails)
    // Repair turn: model still doesn't change files (just reads)
    // Both turns consume responses from the queue
    responses = [
      { content: 'Everything is fine, no changes needed.' },
      // Repair turn — model doesn't change files either
      { toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'src/app.ts' } }] },
      { content: 'Confirmed, no changes needed.' },
    ];

    const events: AgentEvent[] = [];
    const report = await runAgentTask({
      repoRoot: TMP,
      task: 'fix the bug',
      repairAttempts: 2,
      recordRunArtifacts: false,
      onEvent: (event) => events.push(event),
    });

    // Contract was never satisfied — should fail
    expect(report.terminalState).toBe('failed_verification');

    // Should emit repair-related verification events
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('verification_planned');
    expect(eventTypes).toContain('verification_failed');
  });
});
