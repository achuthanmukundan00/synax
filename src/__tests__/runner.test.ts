import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

import { type AgentEvent } from '../agent/events';
import { buildModelFacingTools, createAgentConversation, runAgentTurn, type AgentClient } from '../agent/runner';

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
      'git',
    ]);
  });

  it('includes bash in model-facing tools only when explicitly enabled', async () => {
    expect(buildModelFacingTools({ bashEnabled: false }).map((tool) => tool.name)).toEqual([
      'read',
      'write',
      'edit',
      'git',
    ]);
    expect(buildModelFacingTools({ bashEnabled: true }).map((tool) => tool.name)).toEqual([
      'read',
      'write',
      'edit',
      'bash',
      'git',
    ]);
  });

  it('sends bash to the model when session policy explicitly enables it', async () => {
    const client = fakeClient([{ content: 'done' }]);

    await runAgentTurn({ repoRoot: TMP, task: 'hello', client, tools: { bashEnabled: true } });

    expect(client.requests[0].tools.map((tool: { name: string }) => tool.name)).toEqual([
      'read',
      'write',
      'edit',
      'bash',
      'git',
    ]);
  });

  it('still returns a clear tool error when disabled bash is called directly', async () => {
    const client = fakeClient([{ toolCalls: [{ id: 'call_1', name: 'bash', arguments: { command: 'npm test' } }] }]);

    const result = await runAgentTurn({ repoRoot: TMP, task: 'run tests', client });

    expect(result).toMatchObject({
      terminalState: 'tool_error',
      error: 'bash tool is not enabled in this scaffold',
    });
    expect(result.toolCalls).toEqual([
      { name: 'bash', success: false, error: 'bash tool is not enabled in this scaffold' },
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

  it('does not end in tool_error when the model reads the repository root', async () => {
    writeFileSync(join(TMP, 'README.md'), '# Synax\n', 'utf-8');
    writeFileSync(join(TMP, 'package.json'), '{"scripts":{"synax":"node dist/cli.js"}}\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: '.' } }] },
      { content: 'Available CLI commands are documented in the repository.' },
    ]);

    const result = await runAgentTurn({
      repoRoot: TMP,
      task: 'Inspect the repository and summarize the available CLI commands. Do not modify files.',
      client,
    });

    expect(result.terminalState).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(result.toolCalls).toEqual([{ name: 'read', success: true, error: undefined }]);
  });

  it('continues after a missing read path so the model can recover with another read', async () => {
    mkdirSync(join(TMP, 'src'), { recursive: true });
    writeFileSync(join(TMP, 'src', 'cli.ts'), 'export const cli = true;\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'src/cli' } }] },
      { toolCalls: [{ id: 'call_2', name: 'read', arguments: { path: 'src/cli.ts' } }] },
      { content: 'Recovered by reading src/cli.ts.' },
    ]);

    const result = await runAgentTurn({
      repoRoot: TMP,
      task: 'Inspect the repository and summarize the available CLI commands. Do not modify files.',
      client,
    });

    expect(result).toMatchObject({
      terminalState: 'completed',
      finalAnswer: 'Recovered by reading src/cli.ts.',
      changedFiles: [],
    });
    expect(result.toolCalls).toEqual([
      { name: 'read', success: false, error: expect.stringContaining('ENOENT') },
      { name: 'read', success: true, error: undefined },
    ]);
    expect(client.requests).toHaveLength(3);
    expect(client.requests[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'call_1',
          name: 'read',
          content: expect.stringContaining('ENOENT'),
        }),
      ]),
    );
  });

  it('terminates clearly after repeated recoverable read errors', async () => {
    const client = fakeClient([
      { toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'missing-1.ts' } }] },
      { toolCalls: [{ id: 'call_2', name: 'read', arguments: { path: 'missing-2.ts' } }] },
      { toolCalls: [{ id: 'call_3', name: 'read', arguments: { path: 'missing-3.ts' } }] },
      { content: 'should not be reached' },
    ]);

    const result = await runAgentTurn({ repoRoot: TMP, task: 'inspect missing files', client });

    expect(result).toMatchObject({
      terminalState: 'tool_error',
      error: 'too many consecutive recoverable tool errors: 3',
    });
    expect(result.toolCalls).toHaveLength(3);
    expect(result.toolCalls.every((call) => call.success === false)).toBe(true);
    expect(client.requests).toHaveLength(3);
  });

  it('terminates immediately on unsafe read paths', async () => {
    const client = fakeClient([
      { toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: '../outside.ts' } }] },
      { content: 'should not be reached' },
    ]);

    const result = await runAgentTurn({ repoRoot: TMP, task: 'read outside repo', client });

    expect(result).toMatchObject({
      terminalState: 'tool_error',
      error: 'paths must stay inside the repository',
    });
    expect(result.toolCalls).toEqual([
      { name: 'read', success: false, error: 'paths must stay inside the repository' },
    ]);
    expect(client.requests).toHaveLength(1);
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

  it('emits a patch preview before applying an edit', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello\n', 'utf-8');
    const events: AgentEvent[] = [];
    const client = fakeClient([
      { toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: 'call_2', name: 'edit', arguments: { path: 'a.txt', oldStr: 'hello', newStr: 'hi' } }] },
      { content: 'edited' },
    ]);

    const result = await runAgentTurn({
      repoRoot: TMP,
      task: 'edit a.txt',
      client,
      onEvent: (event) => events.push(event),
    });

    expect(result.terminalState).toBe('completed');
    expect(readFileSync(join(TMP, 'a.txt'), 'utf-8')).toBe('hi\n');
    expect(events.map((event) => event.type)).toEqual([
      'tool_started',
      'tool_finished',
      'tool_started',
      'patch_preview',
      'tool_finished',
    ]);
    expect(events[3]).toMatchObject({
      type: 'patch_preview',
      toolCallId: 'call_2',
      path: 'a.txt',
      diff: '--- a.txt\n+++ a.txt\n-hello\n+hi',
    });
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
