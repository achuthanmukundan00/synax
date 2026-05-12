import { execSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { type AgentEvent } from '../agent/events';
import { Session, type AgentClient, type AgentRunnerOptions } from '../session/Session';
import type { ChatOptions, ChatResponse } from '../llm/types';

const TMP = join(process.cwd(), 'tmp', 'synax-runner-tests');

/** Local shim — Session.startTurn with the old options+task signature. */
async function runTurn(opts: AgentRunnerOptions & { task: string }): Promise<ReturnType<Session['startTurn']>> {
  const { task, tools, ...rest } = opts;
  return new Session({ ...rest, bashEnabled: tools?.bashEnabled }).startTurn(task);
}

function resetTmp(): void {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

function fakeClient(
  responses: Array<{
    content?: string;
    reasoningContent?: string;
    toolCallFormat?: 'openai' | 'content_xml' | 'none';
    toolCalls?: ChatResponse['toolCalls'];
  }>,
): AgentClient & { requests: ChatOptions[] } {
  const requests: ChatOptions[] = [];
  return {
    requests,
    async chat(options) {
      requests.push(JSON.parse(JSON.stringify(options)));
      const next = responses.shift() ?? { content: 'done', toolCalls: [] };
      return {
        content: next.content ?? '',
        model: 'fake',
        finishReason: 'stop',
        reasoningContent: next.reasoningContent,
        toolCallFormat: next.toolCallFormat,
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

    const result = await runTurn({ repoRoot: TMP, task: 'hello', client });

    expect(result.terminalState).toBe('completed');
    expect((client.requests[0].tools ?? []).map((tool: { name: string }) => tool.name)).toEqual([
      'read',
      'write',
      'edit',
      'bash',
      'search_memory',
      'view_image',
    ]);
  });

  it('does not store empty tool_calls on final assistant messages', async () => {
    const conversation = Session.createConversation();
    const firstClient = fakeClient([{ content: 'first answer' }]);

    await runTurn({ repoRoot: TMP, task: 'first task', client: firstClient, conversation });

    const finalAssistant = conversation.messages.at(-1) as { role: string; tool_calls?: unknown };
    expect(finalAssistant).toMatchObject({ role: 'assistant' });
    expect(finalAssistant.tool_calls).toBeUndefined();

    const secondClient = fakeClient([{ content: 'second answer' }]);
    await runTurn({ repoRoot: TMP, task: 'second task', client: secondClient, conversation });

    const secondRequest = secondClient.requests[0].messages as Array<{ role: string; tool_calls?: unknown }>;
    const priorFinal = secondRequest.find((message) => message.role === 'assistant');
    expect(priorFinal?.tool_calls).toBeUndefined();
  });

  it('keeps the system prompt focused on the four model-facing tools', async () => {
    const client = fakeClient([{ content: 'done' }]);

    await runTurn({ repoRoot: TMP, task: 'hello', client });

    const system = client.requests[0].messages[0].content as string;
    expect(system).toContain('Tools: read, write, edit, bash, search_memory, view_image.');
    expect(system).not.toContain('GIT WORKFLOWS');
    expect(system).not.toContain('git tool');
  });

  it('constrains read-only and verify modes to read and bash tools', async () => {
    expect(Session.buildModelTools({ mode: 'read-only', bashEnabled: true }).map((tool) => tool.name)).toEqual([
      'read',
      'bash',
      'search_memory',
      'view_image',
    ]);
    expect(Session.buildModelTools({ mode: 'verify', bashEnabled: true }).map((tool) => tool.name)).toEqual([
      'read',
      'bash',
      'search_memory',
      'view_image',
    ]);
  });

  it('does not expose a legacy git surface when bash is disabled', async () => {
    expect(Session.buildModelTools({ bashEnabled: false }).map((tool) => tool.name)).toEqual([
      'read',
      'write',
      'edit',
      'search_memory',
      'view_image',
    ]);
    expect(Session.buildModelTools({ bashEnabled: true }).map((tool) => tool.name)).toEqual([
      'read',
      'write',
      'edit',
      'bash',
      'search_memory',
      'view_image',
    ]);
  });

  it('sends bash to the model when session policy explicitly enables it', async () => {
    const client = fakeClient([{ content: 'done' }]);

    await runTurn({ repoRoot: TMP, task: 'hello', client, tools: { bashEnabled: true } });

    expect((client.requests[0].tools ?? []).map((tool: { name: string }) => tool.name)).toEqual([
      'read',
      'write',
      'edit',
      'bash',
      'search_memory',
      'view_image',
    ]);
  });

  it('blocks writes and edits in read-only mode before mutating files', async () => {
    const client = fakeClient([
      { toolCalls: [{ id: 'call_1', name: 'write', arguments: { path: 'docs/demo.md', content: '# Demo\n' } }] },
      { content: 'should not be reached' },
    ]);

    const result = await runTurn({ repoRoot: TMP, task: 'create docs/demo.md', client, mode: 'read-only' });

    expect(result).toMatchObject({
      terminalState: 'tool_error',
      error: 'read-only mode does not allow writes',
    });
    expect(existsSync(join(TMP, 'docs', 'demo.md'))).toBe(false);
  });

  it('blocks writes to non-doc paths in docs mode', async () => {
    const client = fakeClient([
      { toolCalls: [{ id: 'call_1', name: 'write', arguments: { path: 'src/demo.md', content: '# Demo\n' } }] },
      { content: 'should not be reached' },
    ]);

    const result = await runTurn({ repoRoot: TMP, task: 'create src/demo.md', client, mode: 'docs' });

    expect(result).toMatchObject({
      terminalState: 'tool_error',
      error: 'docs mode only allows documentation files: src/demo.md',
    });
    expect(existsSync(join(TMP, 'src', 'demo.md'))).toBe(false);
  });

  it('rejects broad self-development prompts instead of executing them', async () => {
    const client = fakeClient([{ content: 'should not be reached' }]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'implement all of v1',
      client,
    });

    expect(result.terminalState).toBe('blocked');
    expect(result.error).toContain('Task is too broad');
    expect(result.finalAnswer).toContain('Suggested first step');
    expect(client.requests).toHaveLength(0);
  });

  it('blocks commit/push intent when bash is disabled', async () => {
    const client = fakeClient([{ content: 'should not be reached' }]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'Please commit the unstaged changes with a commit message that makes sense.',
      client,
      tools: { bashEnabled: false },
    });

    expect(result.terminalState).toBe('blocked');
    expect(result.error).toContain('cannot create commits');
    expect(result.finalAnswer).toContain('Suggested first step');
    expect(client.requests).toHaveLength(0);
  });

  it('executes bash tool commands', async () => {
    const client = fakeClient([{ toolCalls: [{ id: 'call_1', name: 'bash', arguments: { command: 'echo synax' } }] }]);

    const result = await runTurn({ repoRoot: TMP, task: 'run tests', client });

    expect(result.toolCalls).toContainEqual({ name: 'bash', success: true, error: undefined });
  });

  it('lets the model recover from failed bash commands', async () => {
    execSync('git init', { cwd: TMP, stdio: 'ignore' });
    execSync('git config user.email "synax@example.test"', { cwd: TMP, stdio: 'ignore' });
    execSync('git config user.name "Synax Test"', { cwd: TMP, stdio: 'ignore' });

    const client = fakeClient([
      { toolCalls: [{ id: 'call_1', name: 'bash', arguments: { command: 'git commit -m "missing stage"' } }] },
      { toolCalls: [{ id: 'call_2', name: 'bash', arguments: { command: 'git status --short' } }] },
      { content: 'reported commit precondition failure' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'commit the unstaged changes',
      client,
      maxSteps: 4,
    });

    expect(result).toMatchObject({
      terminalState: 'completed',
      finalAnswer: 'reported commit precondition failure',
    });
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]).toMatchObject({ name: 'bash', success: false });
    expect(result.toolCalls[1]).toMatchObject({ name: 'bash', success: true });
    expect(client.requests).toHaveLength(3);
  });

  it('preserves provider reasoning metadata across tool-call turns', async () => {
    const client = fakeClient([
      {
        reasoningContent: 'private reasoning payload',
        toolCalls: [{ id: 'call_1', name: 'bash', arguments: { command: 'printf ok' } }],
      },
      { content: 'continued after tool result' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'run command',
      client,
      maxSteps: 4,
    });

    expect(result.terminalState).toBe('completed');
    const secondRequestAssistant = client.requests[1].messages.find(
      (message: { role: string; tool_calls?: unknown }) => message.role === 'assistant' && message.tool_calls,
    );
    expect(secondRequestAssistant).toMatchObject({
      reasoning_content: 'private reasoning payload',
    });
  });

  it('runs bash command bodies when the model prepends a stale missing cd', async () => {
    const staleWorkspace = join(TMP, 'missing-workspace');
    const client = fakeClient([
      {
        toolCalls: [
          { id: 'call_1', name: 'bash', arguments: { command: `cd ${staleWorkspace} && pwd` } },
          { id: 'call_2', name: 'bash', arguments: { command: `cd ${staleWorkspace} && printf two` } },
          { id: 'call_3', name: 'bash', arguments: { command: `cd ${staleWorkspace} && printf three` } },
        ],
      },
      { content: 'continued after stale cwd recovery' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'run commands despite stale cwd',
      client,
      maxSteps: 4,
    });

    expect(result).toMatchObject({
      terminalState: 'completed',
      finalAnswer: 'continued after stale cwd recovery',
    });
    expect(result.toolCalls).toEqual([
      { name: 'bash', success: true, error: undefined },
      { name: 'bash', success: true, error: undefined },
      { name: 'bash', success: true, error: undefined },
    ]);
    const toolMessages = result.conversation.messages.filter((message) => message.role === 'tool');
    expect(toolMessages[0].content).toContain('stale leading cd target did not exist');
    expect(toolMessages[0].content).toContain(TMP);
  });

  it('runs bash command bodies from repo root when a leading absolute cd points outside the repo', async () => {
    const outsideWorkspace = mkdtempSync(join(tmpdir(), 'synax-runner-outside-existing-workspace-'));
    execSync('git init', { cwd: TMP, stdio: 'ignore' });
    const client = fakeClient([
      {
        toolCalls: [
          { id: 'call_1', name: 'bash', arguments: { command: `cd ${outsideWorkspace} && git status --short` } },
          { id: 'call_2', name: 'bash', arguments: { command: `cd ${outsideWorkspace} && git diff --stat` } },
          { id: 'call_3', name: 'bash', arguments: { command: `cd ${outsideWorkspace} && git diff --cached --stat` } },
        ],
      },
      { content: 'continued after stale cwd recovery' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'inspect git state despite stale cwd',
      client,
      maxSteps: 4,
    });

    expect(result).toMatchObject({
      terminalState: 'completed',
      finalAnswer: 'continued after stale cwd recovery',
    });
    expect(result.toolCalls).toEqual([
      { name: 'bash', success: true, error: undefined },
      { name: 'bash', success: true, error: undefined },
      { name: 'bash', success: true, error: undefined },
    ]);
    const toolMessages = result.conversation.messages.filter((message) => message.role === 'tool');
    expect(toolMessages[0].content).toContain('stale leading cd target was outside the repository root');
    expect(toolMessages[0].content).toContain(TMP);
    rmSync(outsideWorkspace, { recursive: true, force: true });
  });

  it('treats successful git commits as completed work even when no files are edited by Synax', async () => {
    execSync('git init', { cwd: TMP, stdio: 'ignore' });
    execSync('git config user.email "synax@example.test"', { cwd: TMP, stdio: 'ignore' });
    execSync('git config user.name "Synax Test"', { cwd: TMP, stdio: 'ignore' });
    writeFileSync(join(TMP, 'a.txt'), 'hello\n', 'utf-8');
    const client = fakeClient([
      {
        toolCalls: [
          {
            id: 'call_1',
            name: 'bash',
            arguments: { command: 'git add a.txt && git commit -m "Add a.txt"' },
          },
        ],
      },
      { content: 'completed successfully' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'commit the unstaged changes',
      client,
      maxSteps: 2,
    });

    expect(result.terminalState).toBe('completed');
    expect(execSync('git rev-list --count HEAD', { cwd: TMP, encoding: 'utf-8' }).trim()).toBe('1');
  });

  it('completes after model finishes its planned tool sequence following git commit', async () => {
    execSync('git init', { cwd: TMP, stdio: 'ignore' });
    execSync('git config user.email "synax@example.test"', { cwd: TMP, stdio: 'ignore' });
    execSync('git config user.name "Synax Test"', { cwd: TMP, stdio: 'ignore' });
    writeFileSync(join(TMP, 'a.txt'), 'hello\n', 'utf-8');
    const client = fakeClient([
      {
        toolCalls: [
          {
            id: 'call_1',
            name: 'bash',
            arguments: { command: 'git add a.txt && git commit -m "Add a.txt"' },
          },
        ],
      },
      { toolCalls: [{ id: 'call_2', name: 'bash', arguments: { command: 'git status --short' } }] },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'commit the unstaged changes',
      client,
      maxSteps: 32,
    });

    // Model completes after exhausting its planned tool sequence (3 turns:
    // commit, status check, then content-only response from exhausted fakeClient).
    expect(result.terminalState).toBe('completed');
    expect(result.steps).toBe(3);
    expect(result.toolCalls).toHaveLength(2);
    expect(execSync('git rev-list --count HEAD', { cwd: TMP, encoding: 'utf-8' }).trim()).toBe('1');
  });

  it('treats successful gh publishing commands as completed work', async () => {
    const client = fakeClient([
      {
        toolCalls: [
          {
            id: 'call_1',
            name: 'bash',
            arguments: { command: 'gh() { return 0; }; gh pr create --draft --fill' },
          },
        ],
      },
      { content: 'completed successfully' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'open a draft pull request',
      client,
      maxSteps: 2,
    });

    expect(result.terminalState).toBe('completed');
  });

  it('adds a safety warning for dangerous bash commands while still executing', async () => {
    const client = fakeClient([
      { toolCalls: [{ id: 'call_1', name: 'bash', arguments: { command: 'echo "rm -rf ."' } }] },
    ]);

    const result = await runTurn({ repoRoot: TMP, task: 'danger test', client });
    expect(result.toolCalls[0]).toMatchObject({ name: 'bash', success: true });
    const toolMessage = result.conversation.messages.find((m) => m.role === 'tool' && m.name === 'bash');
    expect(toolMessage).toBeDefined();
    const parsed = JSON.parse(toolMessage?.content ?? '{}');
    expect(parsed.output.safetyWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining('destructive delete of current directory')]),
    );
  });

  it('executes a requested tool, appends the result, then continues', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a.txt' } }] },
      { content: 'read it' },
    ]);

    const result = await runTurn({ repoRoot: TMP, task: 'read a.txt', client });

    expect(result.terminalState).toBe('completed');
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1].messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'tool', tool_call_id: 'call_1', name: 'read' })]),
    );
    expect(client.requests[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: JSON.stringify({ path: 'a.txt' }) },
            },
          ],
        }),
      ]),
    );
    expect(client.requests[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'call_1',
          name: 'read',
          content: expect.stringContaining('"path":"a.txt"'),
        }),
      ]),
    );
  });

  it('executes all tool calls from one assistant response and appends all matching tool results', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'alpha\n', 'utf-8');
    writeFileSync(join(TMP, 'b.txt'), 'beta\n', 'utf-8');
    const client = fakeClient([
      {
        toolCalls: [
          { id: 'call_a', name: 'read', arguments: { path: 'a.txt' } },
          { id: 'call_b', name: 'read', arguments: { path: 'b.txt' } },
        ],
      },
      { content: 'done' },
    ]);

    const result = await runTurn({ repoRoot: TMP, task: 'read both files', client });

    expect(result.terminalState).toBe('completed');
    expect(client.requests).toHaveLength(2);
    expect(result.toolCalls).toEqual([
      { name: 'read', success: true, error: undefined },
      { name: 'read', success: true, error: undefined },
    ]);
    const secondRequestMessages = client.requests[1].messages as Array<Record<string, unknown>>;
    const assistantWithToolCalls = secondRequestMessages.find((message) => message.role === 'assistant');
    expect(assistantWithToolCalls).toMatchObject({
      role: 'assistant',
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'a.txt' }) } },
        { id: 'call_b', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'b.txt' }) } },
      ],
    });
    const toolMessages = secondRequestMessages.filter((message) => message.role === 'tool');
    expect(toolMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'call_a',
          name: 'read',
          content: expect.stringContaining('"path":"a.txt"'),
        }),
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'call_b',
          name: 'read',
          content: expect.stringContaining('"path":"b.txt"'),
        }),
      ]),
    );
  });

  it('preserves content-parsed XML tool calls and returns Qwen-style tool responses', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'alpha\n', 'utf-8');
    const toolCallContent = '<tool_call>\n{"name":"read","arguments":{"path":"a.txt"}}\n</tool_call>';
    const client = fakeClient([
      {
        content: toolCallContent,
        toolCallFormat: 'content_xml',
        toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a.txt' } }],
      },
      { content: 'done' },
    ]);

    const result = await runTurn({ repoRoot: TMP, task: 'read a.txt', client });

    expect(result.terminalState).toBe('completed');
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: toolCallContent,
        }),
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('<tool_response>'),
        }),
      ]),
    );
    expect(client.requests[1].messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'tool', tool_call_id: 'call_1' })]),
    );
    expect(client.requests[1].messages.at(-1)?.content).toContain('"path":"a.txt"');
  });

  it('groups multiple content-parsed tool results into one Qwen-style response message', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'alpha\n', 'utf-8');
    writeFileSync(join(TMP, 'b.txt'), 'beta\n', 'utf-8');
    const client = fakeClient([
      {
        content:
          '<tool_call>\n{"name":"read","arguments":{"path":"a.txt"}}\n</tool_call>\n<tool_call>\n{"name":"read","arguments":{"path":"b.txt"}}\n</tool_call>',
        toolCallFormat: 'content_xml',
        toolCalls: [
          { id: 'call_1', name: 'read', arguments: { path: 'a.txt' } },
          { id: 'call_2', name: 'read', arguments: { path: 'b.txt' } },
        ],
      },
      { content: 'done' },
    ]);

    const result = await runTurn({ repoRoot: TMP, task: 'read both', client });

    expect(result.terminalState).toBe('completed');
    // P1+P3: Each XML tool result is now flushed individually so the
    // per-tool budget check sees every result. Two calls → two messages.
    const toolResponseMessages = (client.requests[1].messages as Array<{ role: string; content: string }>).filter(
      (message) => message.role === 'user' && message.content.includes('<tool_response>'),
    );
    expect(toolResponseMessages).toHaveLength(2);
    expect(toolResponseMessages[0].content.match(/<tool_response>/g)).toHaveLength(1);
    expect(toolResponseMessages[1].content.match(/<tool_response>/g)).toHaveLength(1);
    expect(toolResponseMessages[0].content).toContain('"path":"a.txt"');
    expect(toolResponseMessages[1].content).toContain('"path":"b.txt"');
  });

  it('does not end in tool_error when the model reads the repository root', async () => {
    writeFileSync(join(TMP, 'README.md'), '# Synax\n', 'utf-8');
    writeFileSync(join(TMP, 'package.json'), '{"scripts":{"synax":"node dist/cli.js"}}\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: '.' } }] },
      { content: 'Available CLI commands are documented in the repository.' },
    ]);

    const result = await runTurn({
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

    const result = await runTurn({
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

    const result = await runTurn({ repoRoot: TMP, task: 'inspect missing files', client });

    expect(result).toMatchObject({
      terminalState: 'tool_error',
      error: 'too many consecutive recoverable tool errors: 3',
    });
    expect(result.toolCalls).toHaveLength(3);
    expect(result.toolCalls.every((call) => call.success === false)).toBe(true);
    expect(client.requests).toHaveLength(3);
  });

  it('allows parent-relative read paths', async () => {
    writeFileSync(join(TMP, '..', 'outside.ts'), 'export const outside = true;\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: '../outside.ts' } }] },
      { content: 'Read the parent-relative file.' },
    ]);

    const result = await runTurn({ repoRoot: TMP, task: 'read outside repo', client });

    expect(result).toMatchObject({
      terminalState: 'completed',
      finalAnswer: 'Read the parent-relative file.',
    });
    expect(result.toolCalls).toEqual([{ name: 'read', success: true, error: undefined }]);
    expect(client.requests).toHaveLength(2);
    rmSync(join(TMP, '..', 'outside.ts'), { force: true });
  });

  it('stops when assistant returns no tool calls', async () => {
    const client = fakeClient([{ content: 'final answer' }]);

    const result = await runTurn({ repoRoot: TMP, task: 'answer', client });

    expect(result).toMatchObject({ terminalState: 'completed', finalAnswer: 'final answer', steps: 1 });
  });

  it('fails closed on ambiguous mixed output with tool calls and final text', async () => {
    const client = fakeClient([
      { content: 'The answer is that everything looks good.', toolCalls: [{ id: '1', name: 'read', arguments: {} }] },
    ]);
    const result = await runTurn({ repoRoot: TMP, task: 'read', client });
    expect(result).toMatchObject({
      terminalState: 'model_error',
      error: 'model emitted ambiguous mixed output (tool calls plus final text)',
    });
    expect(result.toolCalls).toHaveLength(0);
  });

  it('accepts a short safe preamble before tool calls', async () => {
    writeFileSync(join(TMP, 'README.md'), '# Synax\n', 'utf-8');
    const client = fakeClient([
      {
        content: 'Let me inspect the repository.',
        toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'README.md' } }],
      },
      {
        content: 'Inspected successfully.',
        toolCalls: [],
      },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'Inspect the repo. Do not modify files.',
      client,
    });

    expect(result.terminalState).toBe('completed');
    expect(result.toolCalls).toEqual([{ name: 'read', success: true, error: undefined }]);
    expect(result.finalAnswer).toBe('Inspected successfully.');
  });

  it('accepts begin-by inspection preambles before tool calls', async () => {
    writeFileSync(join(TMP, 'README.md'), '# Synax\n', 'utf-8');
    const client = fakeClient([
      {
        content:
          "I'll begin by mapping the repository structure and understanding the codebase architecture. Let me start with a comprehensive inspection.",
        toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'README.md' } }],
      },
      {
        content: 'Inspected successfully.',
        toolCalls: [],
      },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'Inspect the repo. Do not modify files.',
      client,
    });

    expect(result.terminalState).toBe('completed');
    expect(result.toolCalls).toEqual([{ name: 'read', success: true, error: undefined }]);
  });

  it('accepts start-by inspection preambles before tool calls', async () => {
    writeFileSync(join(TMP, 'README.md'), '# Synax\n', 'utf-8');
    const client = fakeClient([
      {
        content: "I'll start by mapping the entire repository structure and understanding the codebase architecture.",
        toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'README.md' } }],
      },
      {
        content: 'Inspected successfully.',
        toolCalls: [],
      },
    ]);

    const result = await runTurn({ repoRoot: TMP, task: 'Inspect the repo. Do not modify files.', client });
    expect(result.terminalState).toBe('completed');
    expect(result.toolCalls).toEqual([{ name: 'read', success: true, error: undefined }]);
  });

  it('still fails closed on substantive mixed output before tool calls', async () => {
    const client = fakeClient([
      {
        content: 'The answer is that the repo is safe.',
        toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'README.md' } }],
      },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'Inspect the repo. Do not modify files.',
      client,
    });

    expect(result).toMatchObject({
      terminalState: 'model_error',
      error: 'model emitted ambiguous mixed output (tool calls plus final text)',
    });
    expect(result.toolCalls).toHaveLength(0);
  });

  it('fails closed on mixed prose plus content-parsed tool calls', async () => {
    const client = fakeClient([
      {
        content: 'The answer is complete.\n<tool_call>{"name":"read","arguments":{"path":"README.md"}}</tool_call>',
        toolCallFormat: 'content_xml',
        toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'README.md' } }],
      },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'Inspect the repo. Do not modify files.',
      client,
    });

    expect(result).toMatchObject({
      terminalState: 'model_error',
      error: 'model emitted ambiguous mixed output (tool calls plus final text)',
    });
    expect(result.toolCalls).toHaveLength(0);
  });

  it('continues past maxSteps until the model completes', async () => {
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: {} }] },
      { content: 'done after inspection' },
    ]);

    const result = await runTurn({ repoRoot: TMP, task: 'loop', client, maxSteps: 1 });

    expect(result).toMatchObject({
      terminalState: 'completed',
      finalAnswer: 'done after inspection',
      steps: 2,
    });
  });

  it('blocks provider calls when request is over context budget and compaction cannot save it', async () => {
    const client = fakeClient([{ content: 'should not be reached' }]);
    const conversation = Session.createConversation();
    for (let index = 0; index < 8; index += 1) {
      conversation.messages.push({ role: 'user', content: `history ${index} ${'x'.repeat(500)}` });
      conversation.messages.push({ role: 'assistant', content: `reply ${index} ${'y'.repeat(500)}` });
    }
    const hugeTask = 'x'.repeat(8000);

    const result = await runTurn({
      repoRoot: TMP,
      task: hugeTask,
      client,
      conversation,
      contextBudget: {
        contextWindowTokens: 1200,
        reservedOutputTokens: 200,
        keepRecentTokens: 600,
      },
    });

    expect(result.terminalState).toBe('budget_exhausted');
    expect(result.error).toContain('context budget exceeded before model call');
    expect(client.requests).toHaveLength(0);
  });

  it('uses compaction and then calls provider with summary plus recent tail', async () => {
    const conversation = Session.createConversation();
    for (let index = 0; index < 12; index += 1) {
      conversation.messages.push({ role: 'user', content: `older user ${index} ${'x'.repeat(300)}` });
      conversation.messages.push({ role: 'assistant', content: `older assistant ${index} ${'y'.repeat(300)}` });
    }
    const client = fakeClient([{ content: 'done' }]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'final request',
      client,
      conversation,
      contextBudget: {
        contextWindowTokens: 3000,
        reservedOutputTokens: 900,
        keepRecentTokens: 600,
      },
    });

    expect(result.terminalState).toBe('completed');
    expect(client.requests).toHaveLength(1);
    expect(result.conversation.latestCompaction).not.toBeNull();
    expect((client.requests[0].messages as Array<{ role: string; content: string }>)[1]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('Compacted session summary'),
    });
  });

  it('keeps assistant tool-call and tool-result pairs intact after compaction', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello\n', 'utf-8');
    const conversation = Session.createConversation();
    for (let index = 0; index < 8; index += 1) {
      conversation.messages.push({ role: 'user', content: `filler ${index} ${'x'.repeat(300)}` });
      conversation.messages.push({ role: 'assistant', content: `filler-reply ${index}` });
    }
    conversation.messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_pair', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'a.txt' }) } },
      ],
    });
    conversation.messages.push({ role: 'tool', tool_call_id: 'call_pair', name: 'read', content: '{"ok":true}' });
    const client = fakeClient([{ content: 'done' }]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'continue',
      client,
      conversation,
      contextBudget: {
        contextWindowTokens: 6500,
        reservedOutputTokens: 1000,
        keepRecentTokens: 1000,
      },
    });

    expect(result.terminalState).toBe('completed');
    const messages = client.requests[0].messages as Array<{
      role: string;
      tool_call_id?: string;
      tool_calls?: unknown;
    }>;
    const hasAssistantCall = messages.some(
      (message) => message.role === 'assistant' && Array.isArray(message.tool_calls),
    );
    const hasToolResult = messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_pair');
    expect(hasAssistantCall).toBe(true);
    expect(hasToolResult).toBe(true);
  });

  it('fails on the fourth identical read in one turn with actionable guidance', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '3', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '4', name: 'read', arguments: { path: 'a.txt' } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({ repoRoot: TMP, task: 'loop read', client, maxSteps: 8 });

    // Read-loop errors are recoverable: the model sees the error and can adapt.
    // The agent completes with the model's final answer rather than dying.
    expect(result.terminalState).toBe('completed');
    expect(result.finalAnswer).toBe('done');
    expect(result.toolCalls).toEqual([
      { name: 'read', success: true, error: undefined },
      { name: 'read', success: true, error: undefined },
      { name: 'read', success: true, error: undefined },
      { name: 'read', success: false, error: expect.stringContaining('Read loop detected') },
    ]);
    // The error message (with orientation) was delivered to the model as a tool result
    const allToolMessages = client.requests.flatMap((r) =>
      ((r.messages ?? []) as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool'),
    );
    const loopErrorMsg = allToolMessages.find((m) => m.content.includes('Read loop detected'));
    expect(loopErrorMsg).toBeDefined();
    const msg = loopErrorMsg as NonNullable<typeof loopErrorMsg>;
    expect(msg.content).toContain('WORKING CONTEXT');
  });

  it('allows absolute read paths', async () => {
    const outside = join(TMP, '..', 'absolute-outside.txt');
    writeFileSync(outside, 'absolute outside\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: outside } }] },
      { content: 'Read the absolute file.' },
    ]);

    const result = await runTurn({ repoRoot: TMP, task: 'read absolute', client, maxSteps: 4 });

    expect(result.terminalState).toBe('completed');
    expect(result.toolCalls).toEqual([{ name: 'read', success: true, error: undefined }]);
    expect(client.requests).toHaveLength(2);
    rmSync(outside, { force: true });
  });

  it('warns the model after the third full-file read instead of silently re-reading', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '3', name: 'read', arguments: { path: 'a.txt' } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({ repoRoot: TMP, task: 're-read', client, maxSteps: 6 });

    // Reads 1-3 succeed (limit is 4), read 3 should carry a guidance nudge.
    expect(result.terminalState).toBe('completed');
    const toolMsgs = (client.requests[3].messages as Array<{ role: string; content: string }>).filter(
      (m) => m.role === 'tool',
    );
    expect(toolMsgs.length).toBeGreaterThanOrEqual(1);
    // The third read (tool_call_id '3') result should contain guidance.
    const read3 = toolMsgs.find((m) => (m as { tool_call_id?: string }).tool_call_id === '3');
    expect(read3).toBeDefined();
    const r3 = read3 as NonNullable<typeof read3>;
    expect(r3.content).toContain('guidance');
    expect(r3.content).toContain('search');
  });

  it('treats different line ranges as distinct reads, not repetitions', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello\nworld\nagain\nfourth\nfifth\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt', startLine: 1, endLine: 1 } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'a.txt', startLine: 2, endLine: 2 } }] },
      { toolCalls: [{ id: '3', name: 'read', arguments: { path: 'a.txt', startLine: 3, endLine: 3 } }] },
      { toolCalls: [{ id: '4', name: 'read', arguments: { path: 'a.txt', startLine: 4, endLine: 4 } }] },
      { toolCalls: [{ id: '5', name: 'read', arguments: { path: 'a.txt', startLine: 5, endLine: 5 } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({ repoRoot: TMP, task: 'read ranges', client, maxSteps: 8 });

    // Different line ranges are distinct reads — all should succeed.
    expect(result.terminalState).toBe('completed');
    expect(result.toolCalls).toEqual([
      { name: 'read', success: true, error: undefined },
      { name: 'read', success: true, error: undefined },
      { name: 'read', success: true, error: undefined },
      { name: 'read', success: true, error: undefined },
      { name: 'read', success: true, error: undefined },
    ]);
  });

  it('returns a clear tool error when total read calls exceed the per-turn limit', async () => {
    mkdirSync(join(TMP, 'src'), { recursive: true });
    const NUM_READS = 65;
    for (let index = 0; index < NUM_READS; index += 1) {
      writeFileSync(join(TMP, 'src', `file-${index}.ts`), `export const v${index} = ${index};\n`, 'utf-8');
    }

    const toolCallResponses = Array.from({ length: NUM_READS }, (_, index) => ({
      toolCalls: [{ id: String(index + 1), name: 'read', arguments: { path: `src/file-${index}.ts` } }],
    }));
    const client = fakeClient([...toolCallResponses, { content: 'should not be reached' }]);

    const result = await runTurn({ repoRoot: TMP, task: 'inspect many files', client, maxModelSteps: 70 });

    // Read-limit errors are recoverable: the model sees the error and can adapt.
    // The agent completes with the model's final answer rather than dying.
    expect(result.terminalState).toBe('completed');
    expect(result.finalAnswer).toBe('should not be reached');
    expect(result.toolCalls).toHaveLength(NUM_READS);
    expect(result.toolCalls.slice(0, 64).every((call) => call.success === true)).toBe(true);
    expect(result.toolCalls[64]).toEqual({
      name: 'read',
      success: false,
      error: 'total read limit reached for this turn: 64',
    });
    // One extra request: the final step where the model sees the limit error and answers
    expect(client.requests).toHaveLength(NUM_READS + 1);
  });

  it('truncates large read outputs before they enter model history', async () => {
    writeFileSync(join(TMP, 'big.txt'), `${'line\n'.repeat(8000)}`, 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'big.txt' } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read large file',
      client,
      contextBudget: { maxSingleReadResultTokens: 400 },
    });

    expect(result.terminalState).toBe('completed');
    const toolMessage = (client.requests[1].messages as Array<{ role: string; content: string }>).find(
      (message) => message.role === 'tool',
    );
    expect(toolMessage?.content).toContain('"truncated":true');
    expect(toolMessage?.content).toContain('targeted read/search');
  });

  it('enforces per-turn total read-result token budget', async () => {
    writeFileSync(join(TMP, 'a.txt'), `${'a\n'.repeat(5000)}`, 'utf-8');
    writeFileSync(join(TMP, 'b.txt'), `${'b\n'.repeat(5000)}`, 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'b.txt' } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read both files',
      client,
      contextBudget: {
        maxSingleReadResultTokens: 5000,
        maxTotalReadResultTokensPerTurn: 700,
      },
    });

    expect(result.terminalState).toBe('completed');
    const secondToolMessage = (
      client.requests[2].messages as Array<{ role: string; tool_call_id?: string; content: string }>
    ).find((message) => message.role === 'tool' && message.tool_call_id === '2');
    expect(secondToolMessage?.content).toContain('"estimatedReturnedTokens":0');
    expect(secondToolMessage?.content).toContain('turn token budget exceeded');
  });

  it('allows exact replacement edits even when prior read was truncated', async () => {
    writeFileSync(join(TMP, 'a.txt'), `target\n${'hello\n'.repeat(6000)}`, 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '2', name: 'edit', arguments: { path: 'a.txt', oldStr: 'target', newStr: 'changed' } }] },
      { content: 'edited' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read and edit',
      client,
      contextBudget: { maxSingleReadResultTokens: 300 },
    });

    expect(result.terminalState).toBe('completed');
    expect(readFileSync(join(TMP, 'a.txt'), 'utf-8').startsWith('changed\n')).toBe(true);
  });

  it('terminates deterministically at maxToolCalls', async () => {
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: {} }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: {} }] },
    ]);

    const result = await runTurn({ repoRoot: TMP, task: 'loop', client, maxSteps: 4, maxToolCalls: 1 });

    expect(result).toMatchObject({ terminalState: 'budget_exhausted', error: 'max tool calls exceeded: 1' });
    expect(result.toolCalls).toHaveLength(1);
  });

  it('stops repeated identical bash commands before exhausting model steps', async () => {
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'bash', arguments: { command: 'git status --short' } }] },
      { toolCalls: [{ id: '2', name: 'bash', arguments: { command: 'git status --short' } }] },
      { toolCalls: [{ id: '3', name: 'bash', arguments: { command: 'git status --short' } }] },
      { toolCalls: [{ id: '4', name: 'bash', arguments: { command: 'git status --short' } }] },
      { content: 'should not be reached' },
    ]);

    const result = await runTurn({ repoRoot: TMP, task: 'commit all unstaged changes', client, maxSteps: 32 });

    expect(result).toMatchObject({
      terminalState: 'tool_error',
      error: expect.stringContaining('Bash loop detected'),
    });
    expect(result.steps).toBeLessThan(32);
  });

  it('continues after stale edit mismatches and allows a corrected retry', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'edit', arguments: { path: 'a.txt', oldStr: 'helo', newStr: 'hi' } }] },
      { toolCalls: [{ id: '2', name: 'edit', arguments: { path: 'a.txt', oldStr: 'hello', newStr: 'hi' } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({ repoRoot: TMP, task: 'update greeting', client, maxSteps: 6 });

    expect(result.terminalState).toBe('completed');
    expect(readFileSync(join(TMP, 'a.txt'), 'utf-8')).toBe('hi\n');
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]).toMatchObject({
      name: 'edit',
      success: false,
      error: expect.stringContaining('oldStr no longer matches'),
    });
    expect(result.toolCalls[1]).toMatchObject({ name: 'edit', success: true });
  });

  it('continues after large bash output when the model-facing context can compact it', async () => {
    const client = fakeClient([
      {
        toolCalls: [
          {
            id: 'call_1',
            name: 'bash',
            arguments: { command: 'node -e "console.log(\'x\'.repeat(10000))"' },
          },
        ],
      },
      { content: 'reviewed the shell output' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'inspect shell output and summarize it',
      client,
      maxSteps: 4,
      contextBudget: {
        contextWindowTokens: 1500,
        reservedOutputTokens: 300,
        keepRecentTokens: 200,
        maxSingleReadResultTokens: 6000,
        keepRecentToolTurns: 1,
      },
    });

    expect(result).toMatchObject({
      terminalState: 'completed',
      finalAnswer: 'reviewed the shell output',
    });
    expect(client.requests).toHaveLength(2);
    const secondRequest = client.requests[1].messages as Array<{ role: string; name?: string; content: string }>;
    const bashResult = secondRequest.find((message) => message.role === 'tool' && message.name === 'bash');
    expect(bashResult?.content).toContain('"_compacted":true');
    expect(bashResult?.content).toContain('"command"');
    expect(bashResult?.content).not.toContain('x'.repeat(1000));
  });

  it('does not inject a forced final-answer prompt at maxSteps', async () => {
    writeFileSync(join(TMP, 'package.json'), '{}\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'package.json' } }] },
      { content: 'final from inspected context' },
    ]);

    const result = await runTurn({ repoRoot: TMP, task: 'explain package', client, maxSteps: 2 });
    const finalRequest = client.requests[1];

    expect(result).toMatchObject({
      terminalState: 'completed',
      finalAnswer: 'final from inspected context',
      steps: 2,
    });
    expect(finalRequest.messages.at(-1)).toMatchObject({ role: 'tool' });
    expect(
      finalRequest.messages.some(
        (message) => typeof message.content === 'string' && message.content.includes('Final step: answer now'),
      ),
    ).toBe(false);
  });

  it('executes tool calls requested after maxSteps', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt' } }] },
      { content: '', toolCalls: [{ id: '2', name: 'read', arguments: {} }] },
      { content: 'done after retry' },
    ]);

    const result = await runTurn({ repoRoot: TMP, task: 'loop', client, maxSteps: 2 });

    expect(result).toMatchObject({
      terminalState: 'completed',
      finalAnswer: 'done after retry',
      steps: 3,
    });
    expect(result.toolCalls.map((call) => call.name)).toEqual(['read', 'read']);
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

    const result = await runTurn({ repoRoot: TMP, task: 'explain flow', client, maxSteps: 4 });

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

    const result = await runTurn({ repoRoot: TMP, task: 'create docs/demo.md', client, mode: 'docs' });

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

    const result = await runTurn({
      repoRoot: TMP,
      task: 'edit a.txt',
      client,
      mode: 'patch',
      onEvent: (event) => events.push(event),
    });

    expect(result.terminalState).toBe('completed');
    expect(readFileSync(join(TMP, 'a.txt'), 'utf-8')).toBe('hi\n');
    expect(events.map((event) => event.type)).toEqual([
      'model_step_started',
      'tool_started',
      'tool_finished',
      'model_step_started',
      'tool_started',
      'patch_preview',
      'tool_finished',
      'model_step_started',
    ]);
    expect(events[5]).toMatchObject({
      type: 'patch_preview',
      toolCallId: 'call_2',
      path: 'a.txt',
      diff: '--- a.txt\n+++ a.txt\n-hello\n+hi',
    });
  });

  it('edits after inspecting a file through bash cat', async () => {
    writeFileSync(join(TMP, '.synax.toml'), 'model = "qwen"\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: 'call_1', name: 'bash', arguments: { command: 'cat .synax.toml' } }] },
      {
        toolCalls: [
          {
            id: 'call_2',
            name: 'edit',
            arguments: { path: '.synax.toml', oldStr: 'model = "qwen"', newStr: 'model = "deepseek-v4-pro"' },
          },
        ],
      },
      { content: 'configured' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'configure .synax.toml',
      client,
      mode: 'patch',
    });

    expect(result.terminalState).toBe('completed');
    expect(result.changedFiles).toEqual(['.synax.toml']);
    expect(readFileSync(join(TMP, '.synax.toml'), 'utf-8')).toBe('model = "deepseek-v4-pro"\n');
  });

  it('rejects a previewed edit when patch approval rejects it', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello\n', 'utf-8');
    const events: AgentEvent[] = [];
    const client = fakeClient([
      { toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: 'call_2', name: 'edit', arguments: { path: 'a.txt', oldStr: 'hello', newStr: 'hi' } }] },
      { content: 'should not be reached' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'edit a.txt',
      client,
      mode: 'patch',
      onEvent: (event) => events.push(event),
      approvePatch: () => 'reject',
    });

    expect(result).toMatchObject({
      terminalState: 'user_input_required',
      changedFiles: [],
      error: 'patch rejected for a.txt',
    });
    expect(readFileSync(join(TMP, 'a.txt'), 'utf-8')).toBe('hello\n');
    expect(events.map((event) => event.type)).toEqual([
      'model_step_started',
      'tool_started',
      'tool_finished',
      'model_step_started',
      'tool_started',
      'patch_preview',
      'tool_finished',
    ]);
    expect(client.requests).toHaveLength(2);
  });

  it('preserves conversation across turns', async () => {
    const conversation = Session.createConversation();
    const client = fakeClient([{ content: 'first' }, { content: 'second' }]);

    await runTurn({ repoRoot: TMP, task: 'one', client, conversation });
    await runTurn({ repoRoot: TMP, task: 'two', client, conversation });

    expect(
      conversation.messages.filter((message) => message.role === 'user').map((message) => message.content),
    ).toEqual(['one', 'two']);
  });

  it('compacts large read results even in recent turns to bound prompt growth', async () => {
    // Create a file large enough to trigger recent-turn compaction (>4000 tokens ≈ 14000 chars)
    writeFileSync(join(TMP, 'large.txt'), 'a'.repeat(15000) + '\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'large.txt' } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read large file',
      client,
      contextBudget: { maxSingleReadResultTokens: 8000, assemblyCompactionThreshold: 0 },
    });

    expect(result.terminalState).toBe('completed');

    // The second model request should have compacted the large read result
    const secondRequest = client.requests[1];
    const toolMessages = (secondRequest.messages as Array<{ role: string; content: string }>).filter(
      (m) => m.role === 'tool',
    );

    // At least one tool message should be compacted (the large file read)
    const hasCompacted = toolMessages.some((m) => m.content.includes('"_compacted":true'));
    expect(hasCompacted).toBe(true);
  });

  it('keeps small read results verbatim in recent turns for edit correctness', async () => {
    writeFileSync(join(TMP, 'small.txt'), 'hello world\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'small.txt' } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read small file',
      client,
      contextBudget: { maxSingleReadResultTokens: 8000 },
    });

    expect(result.terminalState).toBe('completed');

    // The second model request should keep the small read verbatim
    const secondRequest = client.requests[1];
    const toolMessages = (secondRequest.messages as Array<{ role: string; content: string }>).filter(
      (m) => m.role === 'tool',
    );

    // No tool message should be compacted (small file stays verbatim)
    const hasCompacted = toolMessages.some((m) => m.content.includes('"_compacted":true'));
    expect(hasCompacted).toBe(false);
  });

  it('accepts read-only investigation completion without file changes', async () => {
    writeFileSync(join(TMP, 'README.md'), '# Test\n', 'utf-8');
    // Model reads a file, investigates, and correctly concludes no changes are needed.
    // Read-only investigations should be accepted without a verification nudge.
    const client = fakeClient([
      { toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'README.md' } }] },
      { content: 'Verified passed. All tests pass.' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'fix the broken test in README.md',
      client,
      mode: 'patch',
      maxSteps: 5,
    });

    // Read-only investigations complete without a verification-contract nudge.
    expect(result.terminalState).toBe('completed');
    expect(client.requests).toHaveLength(2);
    expect(result.finalAnswer).toBe('Verified passed. All tests pass.');
  });

  it('accepts legitimate read-only completion without changes', async () => {
    writeFileSync(join(TMP, 'README.md'), '# A repo\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'README.md' } }] },
      { content: 'The README says "A repo". There are no issues to fix.' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'check the README for issues',
      client,
      mode: 'read-only',
      maxSteps: 4,
    });

    // Read-only mode should never block completion claims
    expect(result.terminalState).toBe('completed');
    expect(result.finalAnswer).toContain('no issues to fix');
  });

  it('allows completion after files were changed (legitimate completion)', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'old\n', 'utf-8');
    const client = fakeClient([
      { toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: 'call_2', name: 'edit', arguments: { path: 'a.txt', oldStr: 'old', newStr: 'new' } }] },
      { content: 'Edit applied. Verified passed.' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'change old to new in a.txt',
      client,
      mode: 'patch',
      maxSteps: 5,
    });

    // After making changes, the premature completion gate should NOT block
    expect(result.terminalState).toBe('completed');
    expect(result.changedFiles).toContain('a.txt');
  });
});
