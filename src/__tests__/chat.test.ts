import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

const TMP = join(process.cwd(), 'tmp', 'synax-chat-tests');
const requests: unknown[] = [];
let responses: Array<{ content: string; toolCalls?: unknown[] }> = [];

jest.mock('../llm/client', () => ({
  createOpenAICompatibleClient: () => ({
    chat: async (options: unknown) => {
      requests.push(options);
      const next = responses.shift() ?? { content: 'ok', toolCalls: [] };
      return {
        content: next.content,
        model: 'fake',
        finishReason: 'stop',
        toolCalls: next.toolCalls ?? [],
        usage: null,
      };
    },
  }),
}));

import { createChatSession, promptInteractiveLine } from '../commands/chat';

function resetTmp(): void {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  requests.splice(0, requests.length);
  responses = [];
}

describe('chat session', () => {
  beforeEach(() => resetTmp());
  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(TMP, { recursive: true, force: true });
  });

  it('uses the shared runner and preserves conversation across turns', async () => {
    responses = [{ content: 'first' }, { content: 'second' }];
    const session = createChatSession({
      repoRoot: TMP,
      config: { provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' } },
    });

    await session.handleUserMessage('one');
    await session.handleUserMessage('two');

    expect(
      session.conversation.messages.filter((message) => message.role === 'user').map((message) => message.content),
    ).toEqual(['one', 'two']);
    expect(requests).toHaveLength(2);
  });

  it('/clear resets conversation', async () => {
    responses = [{ content: 'first' }];
    const session = createChatSession({
      repoRoot: TMP,
      config: { provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' } },
    });

    await session.handleUserMessage('one');
    const report = await session.handleSlashCommand('/clear');

    expect(report.output).toContain('cleared');
    expect(session.conversation.messages).toHaveLength(1);
    expect(session.conversation.messages[0].role).toBe('system');
  });

  it('/verify invokes configured verification', async () => {
    writeFileSync(join(TMP, 'verify.js'), 'process.exit(0)\n', 'utf-8');
    const session = createChatSession({
      repoRoot: TMP,
      config: {
        provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' },
        verification: { defaultCommand: 'node verify.js' },
      },
    });

    const report = await session.handleSlashCommand('/verify');

    expect(report.verification?.state).toBe('passed');
    expect(report.output).toContain('node verify.js');
  });

  it('/undo-last-edit restores last Synax-owned edit marker', async () => {
    mkdirSync(join(TMP, '.synax'), { recursive: true });
    writeFileSync(join(TMP, 'a.txt'), 'after\n', 'utf-8');
    writeFileSync(
      join(TMP, '.synax', 'last-edit.json'),
      JSON.stringify({ path: 'a.txt', before: 'before\n', after: 'after\n', timestamp: new Date().toISOString() }),
      'utf-8',
    );
    const session = createChatSession({
      repoRoot: TMP,
      config: { provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' } },
    });
    const report = await session.handleSlashCommand('/undo-last-edit');
    expect(report.output).toContain('restored a.txt');
    expect(readFileSync(join(TMP, 'a.txt'), 'utf-8')).toBe('before\n');
  });

  it('/settings renders readable panel', async () => {
    const session = createChatSession({
      repoRoot: TMP,
      config: {
        provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake', preset: 'relay-local' },
        contextBudgetTokens: 131072,
        maxModelSteps: 32,
        maxToolCalls: 96,
      },
    });
    const report = await session.handleSlashCommand('/settings');
    expect(report.output).toContain('Settings');
    expect(report.output).toContain('Provider');
    expect(report.output).toContain('Tools');
  });

  it('/help renders command descriptions and session-setting examples', async () => {
    const session = createChatSession({
      repoRoot: TMP,
      config: { provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' } },
    });

    const report = await session.handleSlashCommand('/help');

    expect(report.output).toContain('Chat Commands');
    expect(report.output).toContain('/settings set <path> <value>');
    expect(report.output).toContain('Change a supported setting for the current session');
    expect(report.output).toContain('/settings set provider.endpoint http://127.0.0.1:1234/v1');
    expect(report.output).toContain('/exit, /quit');
  });

  it('/settings set mutates current session config and redacts secret headers', async () => {
    const session = createChatSession({
      repoRoot: TMP,
      config: { provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' } },
    });

    await expect(session.handleSlashCommand('/settings set agent.max_tool_calls 12')).resolves.toMatchObject({
      output: expect.stringContaining('current session only'),
    });
    const header = await session.handleSlashCommand('/settings set provider.header.Authorization Bearer secret-token');
    const budget = await session.handleSlashCommand('/budget');
    const settings = await session.handleSlashCommand('/settings');

    expect(budget.output).toContain('Max tool calls: 12');
    expect(header.output).toContain('provider.header.Authorization updated');
    expect(header.output).not.toContain('secret-token');
    expect(settings.output).not.toContain('secret-token');
  });

  it('/settings set rejects invalid paths and numeric values without mutation', async () => {
    const session = createChatSession({
      repoRoot: TMP,
      config: {
        provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' },
        maxModelSteps: 32,
      },
    });

    const badPath = await session.handleSlashCommand('/settings set provider.unknown value');
    const badNumber = await session.handleSlashCommand('/settings set agent.max_model_steps nope');
    const budget = await session.handleSlashCommand('/budget');

    expect(badPath.output).toContain('Invalid settings path');
    expect(badPath.output).toContain('provider.endpoint');
    expect(badNumber.output).toContain('must be a positive integer');
    expect(budget.output).toContain('Max model steps: 32');
  });

  it('/test-provider reports ready when models and chat work', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const target = String(url);
      if (target.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'fake' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }), {
        status: 200,
      });
    });
    const session = createChatSession({
      repoRoot: TMP,
      config: { provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1?token=secret', model: 'fake' } },
    });

    const report = await session.handleSlashCommand('/test-provider');

    expect(report.output).toContain('Status:      ready');
    expect(report.output).toContain('Endpoint:    http://localhost/v1');
    expect(report.output).not.toContain('secret');
  });

  it('/test-provider reports degraded when model listing is unavailable but chat works', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const target = String(url);
      if (target.endsWith('/models')) {
        return new Response('not found', { status: 404 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }), {
        status: 200,
      });
    });
    const session = createChatSession({
      repoRoot: TMP,
      config: { provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' } },
    });

    const report = await session.handleSlashCommand('/test-provider');

    expect(report.output).toContain('Status:      degraded');
  });

  it('/test-provider reports blocked for missing config or auth errors', async () => {
    const missing = createChatSession({
      repoRoot: TMP,
      config: { provider: { kind: 'openai-compatible', base_url: '' } },
    });
    const missingReport = await missing.handleSlashCommand('/test-provider');
    expect(missingReport.output).toContain('Status:      blocked');

    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const auth = createChatSession({
      repoRoot: TMP,
      config: { provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' } },
    });
    const authReport = await auth.handleSlashCommand('/test-provider');
    expect(authReport.output).toContain('Status:      blocked');
  });

  it('/test-provider reports failed when chat smoke fails for non-auth reasons', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const target = String(url);
      if (target.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'fake' }] }), { status: 200 });
      }
      return new Response('server error', { status: 500 });
    });
    const session = createChatSession({
      repoRoot: TMP,
      config: { provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' } },
    });

    const report = await session.handleSlashCommand('/test-provider');

    expect(report.output).toContain('Status:      failed');
  });

  it('stops prompting cleanly when readline was already closed', async () => {
    const rl = {
      question: jest.fn(async () => {
        const error = new Error('readline was closed') as Error & { code: string };
        error.code = 'ERR_USE_AFTER_CLOSE';
        throw error;
      }),
    };

    await expect(promptInteractiveLine(rl)).resolves.toBeNull();
    expect(rl.question).toHaveBeenCalledWith('synax> ');
  });

  it('rethrows unexpected readline prompt errors', async () => {
    const error = new Error('boom');
    const rl = {
      question: jest.fn(async () => {
        throw error;
      }),
    };

    await expect(promptInteractiveLine(rl)).rejects.toThrow(error);
  });
});
