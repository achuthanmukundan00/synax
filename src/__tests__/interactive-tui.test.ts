import { createChatSession, shouldUseInteractiveTui, type ChatSession } from '../commands/chat';
import { createInitialRunStateSnapshot } from '../agent/tui-state';
import { renderAiCore } from '../tui/ai-core';
import { DiffRenderer } from '../tui/diff-renderer';
import { runInteractiveTui } from '../tui/interactive-tui';
import { renderLayout } from '../tui/layout';
import { parseInputChunk } from '../tui/input';
import { PassThrough, Writable } from 'stream';

class CapturingWritable extends Writable {
  public chunks: string[] = [];
  isTTY = true;
  columns = 80;
  rows = 24;

  _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    callback();
  }
}

describe('interactive tui wiring', () => {
  it('uses TUI by default on tty', () => {
    expect(shouldUseInteractiveTui({ plain: false, stdinIsTTY: true, stdoutIsTTY: true })).toBe(true);
  });

  it('respects --plain fallback', () => {
    expect(shouldUseInteractiveTui({ plain: true, stdinIsTTY: true, stdoutIsTTY: true })).toBe(false);
  });

  it('falls back when not tty', () => {
    expect(shouldUseInteractiveTui({ plain: false, stdinIsTTY: false, stdoutIsTTY: true })).toBe(false);
  });
});

describe('tui input parser', () => {
  it('parses submit/backspace/exit/redraw', () => {
    const events = parseInputChunk('a\x7f\n\u0003\u000c');
    expect(events.map((e) => e.type)).toEqual(['text', 'backspace', 'submit', 'exit', 'redraw']);
  });
});

describe('diff renderer', () => {
  it('clips render scope to viewport height', () => {
    const diff = new DiffRenderer();
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
    const out = diff.render(lines, 20, 5);
    expect(out).toContain('\u001b[5;1Hline-4');
    expect(out).not.toContain('line-8');
  });

  it('clips by visible width instead of raw ansi length', () => {
    const diff = new DiffRenderer();
    const line = '\u001b[1;37mSynax\u001b[0m idle 0:13';
    const out = diff.render([line], 16, 1);
    expect(out).toContain('\u001b[1;37mSynax\u001b[0m');
    expect(out).toContain('idle 0:13');
  });
});

describe('ai core renderer', () => {
  it('renders a stable amp-inspired matrix with consistent footprint', () => {
    const idle = renderAiCore('idle', 0);
    const thinking = renderAiCore('thinking', 0.25);
    const verifying = renderAiCore('verifying', 0.5);

    expect(idle).toHaveLength(6);
    expect(idle.every((line) => line.length === 14)).toBe(true);
    expect(idle.join('\n')).toContain('╭────────────╮');
    expect(idle.join('\n')).toContain('⟐');

    expect(thinking.join('\n')).not.toEqual(idle.join('\n'));
    expect(verifying.join('\n')).toContain('┼');
  });
});

describe('interactive layout visual agreements', () => {
  it('keeps a stable right-edge core region and full-width lines', () => {
    const run = createInitialRunStateSnapshot(0);
    const lines = renderLayout(
      {
        run,
        objectiveInput: 'Refine TUI core alignment',
        coreMode: 'idle',
        nowMs: 1500,
      },
      80,
      24,
    );

    expect(lines).toHaveLength(24);
    for (const line of lines) {
      expect(stripAnsi(line).length).toBe(80);
    }
    expect(stripAnsi(lines[0])).toContain('╭────────────╮');
    expect(stripAnsi(lines[0]).endsWith('╮')).toBe(true);
  });

  it('renders a framed directive panel and hides raw model output chatter', () => {
    const run = createInitialRunStateSnapshot(0);
    const lines = renderLayout(
      {
        run,
        objectiveInput: 'Implement fixed-footprint reactor core rendering',
        coreMode: 'thinking',
        nowMs: 2000,
        lastModelOutput: 'raw parser chatter should stay out of default TUI',
      },
      90,
      28,
    );
    const plain = lines.map((line) => stripAnsi(line)).join('\n');
    expect(plain).toContain('Directive');
    expect(plain).toContain('┌');
    expect(plain).not.toContain('Model output');
    expect(plain).not.toContain('raw parser chatter');
  });
});

describe('interactive tui runtime', () => {
  it('listens to the default stdin when no custom stdin is provided', async () => {
    const stdout = new CapturingWritable();
    const session: ChatSession = {
      conversation: createChatSession({
        repoRoot: process.cwd(),
        config: { provider: { kind: 'openai-compatible', base_url: 'http://localhost/v1', model: 'fake' } },
      }).conversation,
      handleUserMessage: jest.fn(),
      handleSlashCommand: jest.fn(),
    };
    const stdin = process.stdin as unknown as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
      resume: () => void;
      pause: () => void;
    };

    const originalIsTTY = stdin.isTTY;
    const originalSetRawMode = stdin.setRawMode;
    const setRawMode = jest.fn();
    stdin.isTTY = true;
    stdin.setRawMode = setRawMode;

    const runPromise = runInteractiveTui(session, { stdout });
    await new Promise((resolve) => setTimeout(resolve, 10));
    stdin.emit('data', Buffer.from('\u0003', 'utf8'));

    await expect(
      Promise.race([
        runPromise.then(() => 'resolved'),
        new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 100)),
      ]),
    ).resolves.toBe('resolved');

    expect(setRawMode).toHaveBeenCalledWith(true);
    expect(setRawMode).toHaveBeenLastCalledWith(false);

    stdin.isTTY = originalIsTTY;
    stdin.setRawMode = originalSetRawMode;
  });
});

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}
