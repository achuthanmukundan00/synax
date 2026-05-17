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

  it('does not create checkpoints for blocked broad-task runs', async () => {
    const report = await runAgentTask({
      repoRoot: TMP,
      task: 'rewrite the TUI',
    });

    expect(report.terminalState).toBe('blocked');
    expect(report.checkpoint).toBeNull();
    expect(existsSync(join(TMP, '.synax', 'checkpoints'))).toBe(false);
  });

  it('blocks broad self-development prompts before calling the model', async () => {
    const report = await runAgentTask({
      repoRoot: TMP,
      task: 'rewrite the TUI',
    });

    expect(report.terminalState).toBe('blocked');
    expect(report.error).toContain('Task is too broad');
    expect(report.finalAnswer).toContain('Suggested first step');
    expect(requests).toHaveLength(0);
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
});
