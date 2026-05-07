import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { PassThrough, Writable } from 'stream';

const TMP = join(process.cwd(), 'tmp', 'synax-chat-tests');
const requests: unknown[] = [];
let responses: Array<{ content: string; toolCalls?: unknown[] }> = [];
const mockCreateInterface = jest.fn();

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

jest.mock('node:readline/promises', () => ({
  createInterface: mockCreateInterface,
}));

import {
  createChatSession,
  createInlinePasteInputSession,
  classifyInlineSubmission,
  draftContainsPaste,
  draftPlainText,
  flattenInlinePasteDraft,
  promptInteractiveLine,
  runInlinePasteChat,
  type ChatSession,
} from '../commands/chat';
import { writeLastEditRecord } from '../agent/safety';

class FakeTtyInput extends PassThrough {
  isTTY = true;
  rawMode = false;
  setRawMode(mode: boolean): void {
    this.rawMode = mode;
  }
}

class CapturingWritable extends Writable {
  public chunks: string[] = [];

  constructor() {
    super();
  }

  _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    callback();
  }

  text(): string {
    return this.chunks.join('');
  }
}

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

  it('buffers multiline input until /end and submits one message', async () => {
    const session = createInlinePasteInputSession();
    session.handleText('take a look at this ');
    session.handlePasteStart();
    session.handlePasteChunk('first line\nsecond line');
    session.handlePasteEnd();
    session.handleText(' and modify the twelfth line');

    expect(session.getPreview()).toBe('take a look at this [pasted: 2 lines, 22 chars] and modify the twelfth line');
    expect(draftContainsPaste(session.getDraft())).toBe(true);
    expect(draftPlainText(session.getDraft())).toBe('take a look at this  and modify the twelfth line');
    expect(flattenInlinePasteDraft(session.getDraft())).toBe(
      'take a look at this \n\n--- BEGIN PASTED CONTENT 1: 2 lines, 22 chars ---\n\nfirst line\nsecond line\n\n--- END PASTED CONTENT 1 ---\n\n and modify the twelfth line',
    );
  });

  it('keeps existing one-line chat and slash commands working', async () => {
    const session = createChatSession({
      repoRoot: TMP,
      config: { provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' } },
    });
    await session.handleUserMessage('hello there');
    expect(
      session.conversation.messages.filter((message) => message.role === 'user').map((message) => message.content),
    ).toEqual(['hello there']);
    const report = await session.handleSlashCommand('/clear');

    expect(report.output).toContain('cleared');
  });

  it('treats pasted slash commands as literal content while typed slash commands still execute', async () => {
    const session = createInlinePasteInputSession();
    session.handlePasteStart();
    session.handlePasteChunk('/clear');
    session.handlePasteEnd();
    session.handleText(' typed');
    expect(session.getPreview()).toBe('[pasted: 1 lines, 6 chars] typed');
    expect(flattenInlinePasteDraft(session.getDraft())).toBe(
      '--- BEGIN PASTED CONTENT 1: 1 lines, 6 chars ---\n\n/clear\n\n--- END PASTED CONTENT 1 ---\n\n typed',
    );
    expect(classifyInlineSubmission(session.getDraft())).toBe('message');

    const plain = createInlinePasteInputSession();
    plain.handleText('/clear');
    expect(classifyInlineSubmission(plain.getDraft())).toBe('slash');
  });

  it('merges multiple paste attachments into one deterministic block', async () => {
    const session = createInlinePasteInputSession();
    session.handleText('before ');
    session.handlePasteStart();
    session.handlePasteChunk('first');
    session.handlePasteEnd();
    session.handleText(' middle ');
    session.handlePasteStart();
    session.handlePasteChunk('second');
    session.handlePasteEnd();
    session.handleText(' after');

    expect(session.getPreview()).toBe('before [pasted: 2 lines, 12 chars] middle  after');
    const flattened = flattenInlinePasteDraft(session.getDraft());
    expect(flattened).toContain('--- BEGIN PASTED CONTENT 1: 2 lines, 12 chars ---');
    expect(flattened).toContain('first');
    expect(flattened).toContain('second');
    expect(flattened).toContain('before');
    expect(flattened).toContain('middle');
    expect(flattened).toContain('after');
  });

  it('truncates large pasted content in the canonical submission text', async () => {
    const session = createInlinePasteInputSession();
    session.handlePasteStart();
    session.handlePasteChunk('x'.repeat(12050));
    session.handlePasteEnd();

    const flattened = flattenInlinePasteDraft(session.getDraft());
    expect(flattened).toContain('--- BEGIN PASTED CONTENT 1:');
    expect(flattened).toContain('[truncated]');
    expect(flattened.length).toBeLessThan(13050);
  });

  it('treats whitespace-only pasted content as an attachment and not a slash command', async () => {
    const session = createInlinePasteInputSession();
    session.handlePasteStart();
    session.handlePasteChunk('   ');
    session.handlePasteEnd();

    expect(classifyInlineSubmission(session.getDraft())).toBe('message');
  });

  it('masks pasted body in rendered prompt/status', async () => {
    const session = createInlinePasteInputSession();
    session.handleText('before ');
    session.handlePasteStart();
    session.handlePasteChunk('secret\ncontent');
    session.handlePasteEnd();

    expect(session.getPreview()).toBe('before [pasted: 2 lines, 14 chars]');
    expect(session.getVisibleBody()).not.toContain('secret');
    expect(session.getVisibleBody()).not.toContain('content');
  });

  it('removes the pasted attachment with backspace at the paste boundary', async () => {
    const session = createInlinePasteInputSession();
    session.handlePasteStart();
    session.handlePasteChunk('line one\nline two');
    session.handlePasteEnd();

    expect(session.getPreview()).toBe('[pasted: 2 lines, 17 chars]');
    session.handleBackspace();
    expect(session.getPreview()).toBe('');
    expect(draftContainsPaste(session.getDraft())).toBe(false);
  });

  it('keeps prompt editable after a rejected mixed-output turn', async () => {
    const input = new FakeTtyInput();
    const output = new CapturingWritable();
    const session: ChatSession = {
      handleUserMessage: jest.fn(async () => ({
        terminalState: 'model_error' as const,
        finalAnswer: "I'll begin by checking the repository.",
        changedFiles: [],
        steps: 1,
        error: 'model emitted ambiguous mixed output (tool calls plus final text)',
      })),
      handleSlashCommand: jest.fn(async () => ({ handled: true, output: '', exit: false })),
      conversation: createChatSession({
        repoRoot: TMP,
        config: { provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' } },
      }).conversation,
    };

    const runPromise = runInlinePasteChat(session, { stdin: input as never, stdout: output });
    input.write(Buffer.from('fix this\n', 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    input.write(Buffer.from('a', 'utf8'));
    input.write(Buffer.from('\x7f', 'utf8'));
    input.write(Buffer.from('\u0003', 'utf8'));
    await runPromise;

    const terminal = output.text();
    expect(terminal).toContain(
      '[synax] model response rejected: model emitted ambiguous mixed output (tool calls plus final text)',
    );
    expect(terminal).toContain('synax> a');
    expect(terminal).not.toContain('\x7f');
    expect(terminal).not.toContain('a\x7f');
    expect(session.handleUserMessage).toHaveBeenCalledTimes(1);
  });

  it('exits cleanly on Ctrl+C after an error turn', async () => {
    const input = new FakeTtyInput();
    const output = new CapturingWritable();
    const session: ChatSession = {
      handleUserMessage: jest.fn(async () => ({
        terminalState: 'model_error' as const,
        finalAnswer: '',
        changedFiles: [],
        steps: 1,
        error: 'boom',
      })),
      handleSlashCommand: jest.fn(async () => ({ handled: true, output: '', exit: false })),
      conversation: createChatSession({
        repoRoot: TMP,
        config: { provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' } },
      }).conversation,
    };

    const runPromise = runInlinePasteChat(session, { stdin: input as never, stdout: output });
    input.write(Buffer.from('oops\n', 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    input.write(Buffer.from('\u0003', 'utf8'));
    await runPromise;

    expect(output.text()).toContain('[synax] exiting');
  });

  it('does not submit a bracketed paste until Enter after the paste boundary', async () => {
    const input = new FakeTtyInput();
    const output = new CapturingWritable();
    let resolveSubmitted: (() => void) | undefined;
    const submitted = new Promise<void>((resolve) => {
      resolveSubmitted = resolve;
    });
    const session: ChatSession = {
      handleUserMessage: jest.fn(async () => {
        resolveSubmitted?.();
        return {
          terminalState: 'completed' as const,
          finalAnswer: 'ok',
          changedFiles: [],
          steps: 1,
          error: undefined,
        };
      }),
      handleSlashCommand: jest.fn(async () => ({ handled: true, output: '', exit: false })),
      conversation: createChatSession({
        repoRoot: TMP,
        config: { provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' } },
      }).conversation,
    };

    const runPromise = runInlinePasteChat(session, { stdin: input as never, stdout: output });
    try {
      input.write(Buffer.from('\x1b[200~first line\nsecond line\x1b[201~\n', 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(session.handleUserMessage).not.toHaveBeenCalled();

      input.write(Buffer.from('\n', 'utf8'));
      await submitted;

      expect(session.handleUserMessage).toHaveBeenCalledTimes(1);
      expect(session.handleUserMessage).toHaveBeenCalledWith(
        '--- BEGIN PASTED CONTENT 1: 2 lines, 22 chars ---\n\nfirst line\nsecond line\n\n--- END PASTED CONTENT 1 ---',
      );
      expect(output.text().match(/first line/g) ?? []).toHaveLength(0);
      expect(output.text().match(/second line/g) ?? []).toHaveLength(0);
    } finally {
      input.write(Buffer.from('\u0003', 'utf8'));
      await runPromise;
    }
  });

  it('renders only placeholder for multiline paste with surrounding typed text', async () => {
    const input = new FakeTtyInput();
    const output = new CapturingWritable();
    let resolveSubmitted: (() => void) | undefined;
    const submitted = new Promise<void>((resolve) => {
      resolveSubmitted = resolve;
    });
    const session: ChatSession = {
      handleUserMessage: jest.fn(async () => {
        resolveSubmitted?.();
        return {
          terminalState: 'completed' as const,
          finalAnswer: 'ok',
          changedFiles: [],
          steps: 1,
          error: undefined,
        };
      }),
      handleSlashCommand: jest.fn(async () => ({ handled: true, output: '', exit: false })),
      conversation: createChatSession({
        repoRoot: TMP,
        config: { provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' } },
      }).conversation,
    };

    const runPromise = runInlinePasteChat(session, { stdin: input as never, stdout: output });
    input.write(Buffer.from('prefix ', 'utf8'));
    input.write(Buffer.from('\x1b[200~line one\nline two\x1b[201~', 'utf8'));
    input.write(Buffer.from(' suffix\n', 'utf8'));
    await submitted;
    input.write(Buffer.from('\u0003', 'utf8'));
    await runPromise;

    const terminal = output.text();
    expect(terminal).toContain('[pasted: 2 lines, 17 chars]');
    expect(terminal).not.toContain('line one');
    expect(terminal).not.toContain('line two');
    expect(session.handleUserMessage).toHaveBeenCalledWith(
      'prefix \n\n--- BEGIN PASTED CONTENT 1: 2 lines, 17 chars ---\n\nline one\nline two\n\n--- END PASTED CONTENT 1 ---\n\n suffix',
    );
    expect(session.handleUserMessage).toHaveBeenCalledTimes(1);
  });

  it('/verify quick invokes configured verification', async () => {
    const session = createChatSession({
      repoRoot: TMP,
      config: {
        provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' },
        verification: { defaultCommand: 'true' },
      },
    });

    const report = await session.handleSlashCommand('/verify quick');

    expect(report.verification?.state).toBe('passed');
    expect(report.output).toContain('verification (quick)');
    expect(report.output).toContain('true');
  });

  it('/verify full uses bounded verification output settings', async () => {
    const session = createChatSession({
      repoRoot: TMP,
      config: {
        provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' },
        verification: { defaultCommand: 'false' },
      },
    });

    const report = await session.handleSlashCommand('/verify full');

    expect(report.verification?.state).toBe('failed');
    expect(report.output).toContain('verification (full)');
    expect(report.output).toContain('false');
  });

  it('/undo-last-edit restores last Synax-owned edit marker', async () => {
    mkdirSync(join(TMP, '.synax'), { recursive: true });
    writeFileSync(join(TMP, 'a.txt'), 'after\n', 'utf-8');
    await writeLastEditRecord(TMP, {
      path: 'a.txt',
      before: 'before\n',
      after: 'after\n',
      timestamp: new Date().toISOString(),
    });
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
        maxModelSteps: 64,
        maxToolCalls: 192,
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

    expect(budget.output).toContain('Max tool calls:   12');
    expect(header.output).toContain('provider.header.Authorization updated');
    expect(header.output).not.toContain('secret-token');
    expect(settings.output).not.toContain('secret-token');
  });

  it('/settings set rejects invalid paths and numeric values without mutation', async () => {
    const session = createChatSession({
      repoRoot: TMP,
      config: {
        provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' },
        maxModelSteps: 64,
      },
    });

    const badPath = await session.handleSlashCommand('/settings set provider.unknown value');
    const badNumber = await session.handleSlashCommand('/settings set agent.max_model_steps nope');
    const budget = await session.handleSlashCommand('/budget');

    expect(badPath.output).toContain('Invalid settings path');
    expect(badPath.output).toContain('provider.endpoint');
    expect(badNumber.output).toContain('must be a positive integer');
    expect(budget.output).toContain('Model steps:      unlimited');
  });

  it('/status includes context and checkpoint visibility', async () => {
    mkdirSync(join(TMP, '.synax', 'checkpoints'), { recursive: true });
    writeFileSync(join(TMP, '.synax', 'checkpoints', '2026-05-05T12-00-00-000Z.status.txt'), 'status\n', 'utf-8');
    writeFileSync(join(TMP, '.synax', 'checkpoints', '2026-05-05T12-00-00-000Z.diff.patch'), 'diff\n', 'utf-8');
    execFileSync('git', ['init'], { cwd: TMP });
    const session = createChatSession({
      repoRoot: TMP,
      config: {
        provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' },
        contextBudgetTokens: 64000,
        maxModelSteps: 24,
        maxToolCalls: 48,
      },
    });

    session.conversation.inspectionLedger.recordFileRead('README.md', 1, 1, '# Synax');
    const report = await session.handleSlashCommand('/status');

    expect(report.output).toContain('Context budget: (no model calls yet)');
    expect(report.output).toContain('Model steps: unlimited');
    expect(report.output).toContain('Max tool calls: 48');
    expect(report.output).toContain('Files read this session:');
    expect(report.output).toContain('Latest checkpoint: 2026-05-05T12-00-00-000Z');
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

  it('does not allocate readline in the TTY raw-input path', async () => {
    const input = new FakeTtyInput();
    const output = new CapturingWritable();
    const session: ChatSession = {
      handleUserMessage: jest.fn(async () => ({
        terminalState: 'completed' as const,
        finalAnswer: 'ok',
        changedFiles: [],
        steps: 1,
        error: undefined,
      })),
      handleSlashCommand: jest.fn(async () => ({ handled: true, output: '', exit: false })),
      conversation: createChatSession({
        repoRoot: TMP,
        config: { provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' } },
      }).conversation,
    };

    const runPromise = runInlinePasteChat(session, { stdin: input as never, stdout: output });
    input.write(Buffer.from('\u0003', 'utf8'));
    await runPromise;

    expect(mockCreateInterface).not.toHaveBeenCalled();
  });
});
