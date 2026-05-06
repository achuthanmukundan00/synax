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
});
