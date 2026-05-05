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
});
