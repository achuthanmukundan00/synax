import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
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

import { createChatSession } from '../commands/chat';

function resetTmp(): void {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  requests.splice(0, requests.length);
  responses = [];
}

describe('chat session', () => {
  beforeEach(() => resetTmp());
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

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
});
