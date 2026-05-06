import { createChatSession, shouldUseInteractiveTui, type ChatSession } from '../commands/chat';
import { createInitialRunStateSnapshot } from '../agent/tui-state';
import { CORE_HEIGHT, CORE_WIDTH, modeColor, renderAiCore, renderDottedCore } from '../tui/ai-core';
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

  it('parses history scroll keys', () => {
    const events = parseInputChunk('\x1b[5~\x1b[6~');
    expect(events).toEqual([{ type: 'scroll_history_up' }, { type: 'scroll_history_down' }]);
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
  it('renders an unboxed containment field with consistent footprint', () => {
    const idle = renderAiCore('idle', 0);
    const thinking = renderAiCore('thinking', 0.25);
    const tool = renderAiCore('tool_execution', 0.4);
    const verifying = renderAiCore('verifying', 0.5);
    const failure = renderAiCore('failure', 0.75);

    expect(CORE_WIDTH).toBeGreaterThanOrEqual(24);
    expect(CORE_WIDTH).toBeLessThanOrEqual(34);
    expect(CORE_HEIGHT).toBeGreaterThanOrEqual(10);
    expect(CORE_HEIGHT).toBeLessThanOrEqual(14);

    expect(idle).toHaveLength(CORE_HEIGHT);
    expect(idle.every((line) => stripAnsi(line).length === CORE_WIDTH)).toBe(true);
    expect(thinking.every((line) => stripAnsi(line).length === CORE_WIDTH)).toBe(true);
    expect(tool.every((line) => stripAnsi(line).length === CORE_WIDTH)).toBe(true);
    expect(verifying.every((line) => stripAnsi(line).length === CORE_WIDTH)).toBe(true);
    expect(failure.every((line) => stripAnsi(line).length === CORE_WIDTH)).toBe(true);

    expect(stripAnsi(idle[0])).not.toMatch(/^┌─+┐$/);
    expect(stripAnsi(idle[idle.length - 1])).not.toMatch(/^└─+┘$/);
    expect(stripAnsi(idle.join('\n'))).toMatch(/[.·•○◎╱╲─│]/);
    expect(idle.join('\n')).toContain('\u001b[38;2;');

    expect(thinking.join('\n')).not.toEqual(idle.join('\n'));
    expect(stripAnsi(tool.join('\n'))).toMatch(/[◆◈]/);
    expect(stripAnsi(verifying.join('\n'))).toMatch(/[━╋]/);
    expect(stripAnsi(failure.join('\n'))).toMatch(/[×╳]/);
  });

  it('keeps material state color selection stable', () => {
    expect(modeColor('blocked')).toBe('\u001b[33m');
    expect(modeColor('failure')).toBe('\u001b[31m');
    expect(modeColor('verifying')).toBe('\u001b[33m');
    expect(modeColor('completed')).toBe('\u001b[32m');
    expect(modeColor('planning')).toBe('\u001b[34m');
  });

  it('uses restrained truecolor inside the containment field', () => {
    const core = renderAiCore('thinking', 1).join('');
    const colors = Array.from(core.matchAll(/\u001b\[38;2;(\d+);(\d+);(\d+)m/g));

    expect(colors.length).toBeGreaterThan(6);
    expect(core).not.toContain('\u001b[35m');
    expect(core).not.toContain('\u001b[36m\u001b[33m');
  });

  it('changes deterministic animation frames over time', () => {
    const first = renderAiCore('thinking', 1).map(stripAnsi);
    const second = renderAiCore('thinking', 1.5).map(stripAnsi);

    expect(second).not.toEqual(first);
    expect(second).toHaveLength(first.length);
    expect(second.every((line) => line.length === CORE_WIDTH)).toBe(true);
  });

  it('falls back to ascii-safe dotted marks', () => {
    const fallback = renderDottedCore({ mode: 'thinking', frame: 3, width: 18, height: 8, unicode: false });
    const plain = fallback.map(stripAnsi).join('');

    expect(fallback).toHaveLength(8);
    expect(fallback.every((line) => stripAnsi(line).length === 18)).toBe(true);
    expect(plain).toMatch(/[.ox]/);
    expect(plain).not.toMatch(/[·•×]/);
  });
});

describe('interactive layout visual agreements', () => {
  it('anchors the composition around a dominant central core field', () => {
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
    const plain = lines.map((line) => stripAnsi(line)).join('\n');
    expect(plain).toContain('Synax');
    expect(plain).toContain('Field');
    expect(plain).toMatch(/[.·•○◎╱╲]/);
    expect(plain).not.toContain('Files touched:');
    expect(plain).not.toContain('History');
  });

  it('renders an integrated directive dock and hides raw model output chatter', () => {
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
    expect(plain).toContain('▁');
    expect(plain).not.toContain('Model output');
    expect(plain).not.toContain('raw parser chatter');
  });

  it('surfaces compact operational summaries without model transcript text', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      phase: 'completed' as const,
      statusNote: 'completed: 2 model steps, 1 tool call, 1 file changed',
      lastModelOutput: 'Updated the TUI state and verified the focused tests.',
    };
    const lines = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'completed',
        nowMs: 2000,
      },
      100,
      28,
    );
    const plain = lines.map((line) => stripAnsi(line)).join('\n');

    expect(plain).toContain('Completed · 2 model steps, 1 tool call, 1 file changed');
    expect(plain).not.toContain('Updated the TUI state and verified the focused tests.');
  });

  it('surfaces patch preview diffs from run state', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      patchPreview: {
        path: 'src/tui/layout.ts',
        diff: '--- src/tui/layout.ts\n+++ src/tui/layout.ts\n-old\n+new',
      },
    };
    const lines = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'thinking',
        nowMs: 2000,
      },
      100,
      32,
    );
    const plain = lines.map((line) => stripAnsi(line)).join('\n');

    expect(plain).toContain('Diff preview: src/tui/layout.ts');
    expect(plain).toContain('--- src/tui/layout.ts');
    expect(plain).toContain('+++ src/tui/layout.ts');
    expect(plain).toContain('-old');
    expect(plain).toContain('+new');
  });

  it('keeps scrollable debug history off the primary visual surface', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      debugHistory: [
        { atMs: 1, kind: 'model' as const, summary: 'model response', detail: 'I will check git status.' },
        {
          atMs: 2,
          kind: 'tool_call' as const,
          summary: 'bash call',
          detail: 'bash\n{"command":"git status --short"}',
        },
        {
          atMs: 3,
          kind: 'tool_result' as const,
          summary: 'bash ok',
          detail: 'stdout:\n M src/tui/layout.ts',
        },
      ],
    };
    const lines = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'thinking',
        nowMs: 2000,
        historyScrollOffset: 0,
      },
      100,
      36,
    );
    const plain = lines.map((line) => stripAnsi(line)).join('\n');

    expect(plain).not.toContain('History');
    expect(plain).not.toContain('Model: I will check git status.');
    expect(plain).not.toContain('Tool call: bash');
    expect(plain).not.toContain('git status --short');
    expect(plain).not.toContain('Tool result: stdout:');
    expect(plain).not.toContain('M src/tui/layout.ts');
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
