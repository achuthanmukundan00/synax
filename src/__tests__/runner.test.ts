import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

import { createAgentConversation, runAgentTurn, type AgentClient } from '../agent/runner';

const TMP = join(process.cwd(), 'tmp', 'synax-runner-tests');

function resetTmp(): void {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

function fakeClient(responses: Array<{ content?: string; toolCalls?: any[] }>): AgentClient & { requests: any[] } {
  const requests: any[] = [];
  return {
    requests,
    async chat(options) {
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
  };
}

describe('shared bounded agent runner', () => {
  beforeEach(() => resetTmp());
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it('sends model requests with available tools', async () => {
    const client = fakeClient([{ content: 'done' }]);

    const result = await runAgentTurn({ repoRoot: TMP, task: 'hello', client });

    expect(result.terminalState).toBe('completed');
    expect(client.requests[0].tools.map((tool: { name: string }) => tool.name)).toEqual([
      'read',
      'write',
      'edit',
      'bash',
      'git',
    ]);
  });

  it('executes a requested tool, appends the result, then continues', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a.txt' } }] },
      { content: 'read it' },
    ]);

    const result = await runAgentTurn({ repoRoot: TMP, task: 'read a.txt', client });

    expect(result.terminalState).toBe('completed');
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1].messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'tool', tool_call_id: 'call_1', name: 'read' })]),
    );
  });

  it('stops when assistant returns no tool calls', async () => {
    const client = fakeClient([{ content: 'final answer' }]);

    const result = await runAgentTurn({ repoRoot: TMP, task: 'answer', client });

    expect(result).toMatchObject({ terminalState: 'completed', finalAnswer: 'final answer', steps: 1 });
  });

  it('terminates deterministically at maxSteps', async () => {
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: {} }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: {} }] },
    ]);

    const result = await runAgentTurn({ repoRoot: TMP, task: 'loop', client, maxSteps: 1 });

    expect(result).toMatchObject({ terminalState: 'budget_exhausted', error: 'max steps exceeded: 1' });
  });

  it('terminates deterministically at maxToolCalls', async () => {
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: {} }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: {} }] },
    ]);

    const result = await runAgentTurn({ repoRoot: TMP, task: 'loop', client, maxSteps: 4, maxToolCalls: 1 });

    expect(result).toMatchObject({ terminalState: 'budget_exhausted', error: 'max tool calls exceeded: 1' });
    expect(result.toolCalls).toHaveLength(1);
  });

  it('asks for a final answer on the final allowed model step', async () => {
    writeFileSync(join(TMP, 'package.json'), '{}\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'package.json' } }] },
      { content: 'final from inspected context' },
    ]);

    const result = await runAgentTurn({ repoRoot: TMP, task: 'explain package', client, maxSteps: 2 });
    const finalRequest = client.requests[1];

    expect(result).toMatchObject({
      terminalState: 'completed',
      finalAnswer: 'final from inspected context',
      steps: 2,
    });
    expect(finalRequest.messages.at(-1)).toMatchObject({
      role: 'system',
      content: expect.stringContaining('Do not call tools'),
    });
  });

  it('does not execute tool calls requested on the final allowed model step', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt' } }] },
      { content: '', toolCalls: [{ id: '2', name: 'read', arguments: {} }] },
    ]);

    const result = await runAgentTurn({ repoRoot: TMP, task: 'loop', client, maxSteps: 2 });

    expect(result).toMatchObject({
      terminalState: 'budget_exhausted',
      error: 'max steps exceeded: 2',
    });
    expect(result.toolCalls.map((call) => call.name)).toEqual(['read']);
  });

  it('finalizes before exceeding budget after a bounded inspection sequence', async () => {
    writeFileSync(join(TMP, 'package.json'), '{"scripts":{"synax":"node dist/cli.js"}}\n', 'utf-8');
    mkdirSync(join(TMP, 'src', 'commands'), { recursive: true });
    writeFileSync(join(TMP, 'src', 'cli.ts'), 'cli\n', 'utf-8');
    writeFileSync(join(TMP, 'src', 'commands', 'chat.ts'), 'chat\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'package.json' } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'src/cli.ts' } }] },
      { toolCalls: [{ id: '3', name: 'read', arguments: { path: 'src/commands/chat.ts' } }] },
      { content: 'npm run synax invokes the CLI, which dispatches chat.' },
    ]);

    const result = await runAgentTurn({ repoRoot: TMP, task: 'explain flow', client, maxSteps: 4 });

    expect(result).toMatchObject({
      terminalState: 'completed',
      finalAnswer: 'npm run synax invokes the CLI, which dispatches chat.',
      steps: 4,
    });
    expect(result.toolCalls).toHaveLength(3);
  });

  it('creates a new repo-local file through the agent tool', async () => {
    const client = fakeClient([
      {
        toolCalls: [{ id: 'call_1', name: 'write', arguments: { path: 'docs/demo.md', content: '# Demo\n' } }],
      },
      { content: 'created' },
    ]);

    const result = await runAgentTurn({ repoRoot: TMP, task: 'create docs/demo.md', client });

    expect(result.terminalState).toBe('completed');
    expect(result.changedFiles).toEqual(['docs/demo.md']);
    expect(readFileSync(join(TMP, 'docs', 'demo.md'), 'utf-8')).toBe('# Demo\n');
  });

  it('preserves conversation across turns', async () => {
    const conversation = createAgentConversation();
    const client = fakeClient([{ content: 'first' }, { content: 'second' }]);

    await runAgentTurn({ repoRoot: TMP, task: 'one', client, conversation });
    await runAgentTurn({ repoRoot: TMP, task: 'two', client, conversation });

    expect(
      conversation.messages.filter((message) => message.role === 'user').map((message) => message.content),
    ).toEqual(['one', 'two']);
  });
});
