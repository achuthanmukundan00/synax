import { createChatSession, shouldUseInteractiveTui, type ChatSession } from '../commands/chat';
import { createInitialRunStateSnapshot } from '../agent/tui-state';
import { CORE_HEIGHT, CORE_WIDTH, modeColor, renderAiCore, renderDottedCore } from '../tui/ai-core';
import { DiffRenderer } from '../tui/diff-renderer';
import { runInteractiveTui } from '../tui/interactive-tui';
import { maxHistoryScrollOffset, renderLayout } from '../tui/layout';
import { parseInputChunk } from '../tui/input';
import { createTerminalSession } from '../tui/terminal';
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
  it('parses submit/backspace/exit', () => {
    const events = parseInputChunk('a\x7f\n\u0003');
    expect(events.map((e) => e.type)).toEqual(['text', 'backspace', 'submit', 'exit']);
  });

  it('parses history scroll keys', () => {
    const events = parseInputChunk('\x1b[5~\x1b[6~');
    expect(events).toEqual([{ type: 'scroll_history_up' }, { type: 'scroll_history_down' }]);
  });

  it('parses SGR mouse wheel events as history scrolling', () => {
    const events = parseInputChunk('\x1b[<64;12;8M\x1b[<65;12;8M');
    expect(events).toEqual([{ type: 'scroll_history_up' }, { type: 'scroll_history_down' }]);
  });
});

describe('terminal session', () => {
  it('enables mouse reporting so trackpad scroll does not move terminal scrollback', () => {
    const stdout = new CapturingWritable();
    const stdin = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
      resume: () => void;
      pause: () => void;
    };
    stdin.isTTY = true;
    stdin.setRawMode = jest.fn();
    const terminal = createTerminalSession({ stdin, stdout });

    terminal.start();
    terminal.stop();

    const output = stdout.chunks.join('');
    expect(output).toContain('\u001b[?1000h');
    expect(output).toContain('\u001b[?1006h');
    expect(output).toContain('\u001b[?1006l');
    expect(output).toContain('\u001b[?1000l');
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

  it('clears stale characters when a changed line gets shorter', () => {
    const diff = new DiffRenderer();
    diff.render(['abcdef'], 8, 1);

    const out = diff.render(['xy'], 8, 1);

    expect(out).toContain('\u001b[1;1Hxy      ');
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
    expect(modeColor('verifying')).toBe('\u001b[32m');
    expect(modeColor('completed')).toBe('\u001b[32m');
    expect(modeColor('planning')).toBe('\u001b[34m');
  });

  it('keeps normal running work out of warning amber', () => {
    const runningModes = ['tool_execution', 'bash', 'verifying'] as const;

    for (const mode of runningModes) {
      const colors = extractTrueColors(renderAiCore(mode, 0.4).join(''));
      expect(colors.some(isWarningAmber)).toBe(false);
    }

    expect(extractTrueColors(renderAiCore('blocked', 0.4).join('')).some(isWarningAmber)).toBe(true);
  });

  it('uses restrained truecolor inside the containment field', () => {
    const core = renderAiCore('thinking', 1).join('');
    // eslint-disable-next-line no-control-regex
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
  it('keeps the core large only for the empty idle surface', () => {
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
    expect(plain).not.toContain('Field');
    expect(plain).not.toContain('contained local intelligence runtime');
    expect(plain).toMatch(/[.·•○◎╱╲]/);
    expect(plain).toContain('Core        Unloaded');
  });

  it('renders read, command, edit, verification, and final summary blocks as the main surface', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      runId: 'run-1',
      phase: 'completed' as const,
      providerLabel: 'qwen @ http://127.0.0.1:1234/v1',
      objective: {
        label: 'Improve TUI observability',
        currentPhase: 'completed' as const,
        nextCheckpoint: 'run finalized',
      },
      statusNote: 'completed: 3 model steps, 4 tool calls, 2 files changed',
      lastModelOutput: 'Implemented the transcript layout and verified focused tests.',
      changes: {
        items: [
          { path: 'src/tui/layout.ts', op: 'edit' as const },
          { path: 'src/__tests__/interactive-tui.test.ts', op: 'edit' as const },
        ],
        overflowCount: 0,
      },
      filesChangedThisRun: ['src/tui/layout.ts', 'src/__tests__/interactive-tui.test.ts'],
      workingTreeClean: true,
      toolInvocationCount: 3,
      verification: {
        ...createInitialRunStateSnapshot(0).verification,
        state: 'passed' as const,
        checksPassed: 1,
        summary: 'all tests passed (1.2s)',
        currentCheckLabel: 'npm test src/__tests__/interactive-tui.test.ts',
      },
      patchPreview: {
        path: 'src/tui/layout.ts',
        diff: '@@ -1,2 +1,2 @@\n-old dashboard\n+new transcript',
      },
      debugHistory: [
        {
          atMs: 1,
          kind: 'model' as const,
          summary: 'Inspecting TUI runtime state and renderer boundaries.',
          detail: '<thinking>hidden chain</thinking>Inspecting TUI runtime state and renderer boundaries.',
        },
        {
          atMs: 2,
          kind: 'tool_call' as const,
          summary: 'read call',
          detail: 'read\n{"path":"src/tui/layout.ts","startLine":1,"endLine":120}',
        },
        {
          atMs: 3,
          kind: 'tool_result' as const,
          summary: 'read ok',
          detail: 'export function renderLayout(...) { ... }',
        },
        {
          atMs: 4,
          kind: 'tool_call' as const,
          summary: 'bash call',
          detail: 'bash\n{"command":"npm test src/__tests__/interactive-tui.test.ts"}',
        },
        {
          atMs: 5,
          kind: 'tool_result' as const,
          summary: 'bash ok',
          detail: 'exit code: 0\nduration: 1.2s\nPASS src/__tests__/interactive-tui.test.ts',
        },
        {
          atMs: 6,
          kind: 'tool_call' as const,
          summary: 'edit call',
          detail: 'edit\n{"path":"src/tui/layout.ts"}',
        },
      ],
    };
    const lines = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'completed',
        nowMs: 2000,
      },
      120,
      46,
    );
    const plain = lines.map((line) => stripAnsi(line)).join('\n');

    expect(plain).not.toContain('model qwen');
    expect(plain).not.toContain('tools 3');
    expect(plain).not.toContain('files 2');
    expect(plain).toContain('Model       qwen');
    expect(plain).toContain('Provider    Relay');
    expect(plain).toContain('Context');
    expect(plain).toContain('Inspecting TUI runtime state and renderer boundaries.');
    expect(plain).not.toContain('hidden chain');
    expect(plain).toContain('read  src/tui/layout.ts:1-120');
    expect(plain).toContain('$ npm test src/__tests__/interactive-tui.test.ts');
    expect(plain).toContain('exit 0');
    expect(plain).toContain('1.2s');
    expect(plain).toContain('edit  src/tui/layout.ts');
    expect(plain).toContain('-old dashboard');
    expect(plain).toContain('+new transcript');
    expect(plain).toContain('verify  passed');
    expect(plain).toContain('Final summary');
    expect(plain).toContain('objective: Improve TUI observability');
    expect(plain).toContain('Changed this run: 2 files');
    expect(plain).toContain('Working tree: clean');
    expect(plain).toContain('tool invocations: 3');
    expect(plain).toContain('commands run: npm test src/__tests__/interactive-tui.test.ts');
  });

  it('renders failed command output and blocker in the transcript summary', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      phase: 'verifying' as const,
      terminal: 'failed' as const,
      terminalIssue: 'verification failed: Jest assertion failed',
      riskLine: 'verification failed: Jest assertion failed',
      objective: {
        label: 'Fix TUI transcript',
        currentPhase: 'verifying' as const,
        nextCheckpoint: 'inspect terminal issue',
      },
      verification: {
        ...createInitialRunStateSnapshot(0).verification,
        state: 'failed' as const,
        checksFailed: 1,
        summary: 'Expected transcript to contain read block',
        currentCheckLabel: 'npm test',
      },
      debugHistory: [
        {
          atMs: 1,
          kind: 'tool_call' as const,
          summary: 'bash call',
          detail: 'bash\n{"command":"npm test"}',
        },
        {
          atMs: 2,
          kind: 'tool_result' as const,
          summary: 'bash error',
          detail:
            'exit code: 1\nduration: 4.4s\nFAIL src/__tests__/interactive-tui.test.ts\nExpected transcript to contain read block',
        },
      ],
    };
    const plain = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'failure',
        nowMs: 5000,
      },
      100,
      30,
    )
      .map((line) => stripAnsi(line))
      .join('\n');

    expect(plain).toContain('$ npm test');
    expect(plain).toContain('exit 1');
    expect(plain).toContain('FAIL src/__tests__/interactive-tui.test.ts');
    expect(plain).toContain('verify  failed');
    expect(plain).toContain('blockers: verification failed: Jest assertion failed');
    expect(plain).toContain('next: Expected transcript to contain read block');
  });

  it('preserves git diff ANSI colors in command output', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      debugHistory: [
        {
          atMs: 1,
          kind: 'tool_call' as const,
          summary: 'bash call',
          detail: 'bash\n{"command":"git diff src/tui/transcript.ts"}',
        },
        {
          atMs: 2,
          kind: 'tool_result' as const,
          summary: 'bash ok',
          detail:
            'exit code: 1\n\u001b[1mdiff --git a/src/tui/transcript.ts b/src/tui/transcript.ts\u001b[0m\n\u001b[31m-old line\u001b[0m\n\u001b[32m+new line\u001b[0m',
        },
      ],
    };

    const rendered = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'thinking',
        nowMs: 2000,
      },
      100,
      30,
    ).join('\n');

    expect(rendered).toContain('\u001b[31m-old line\u001b[0m');
    expect(rendered).toContain('\u001b[32m+new line\u001b[0m');
  });

  it('does not color command exit codes red in the transcript', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      debugHistory: [
        {
          atMs: 1,
          kind: 'tool_call' as const,
          summary: 'bash call',
          detail: 'bash\n{"command":"git diff --quiet"}',
        },
        {
          atMs: 2,
          kind: 'tool_result' as const,
          summary: 'bash changed',
          detail: 'exit code: 1\nworking tree differs',
        },
      ],
    };

    const rendered = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'thinking',
        nowMs: 2000,
      },
      100,
      30,
    ).join('\n');

    expect(rendered).toContain('exit 1');
    expect(rendered).not.toContain('\u001b[1;31mexit 1\u001b[0m');
  });

  it('parses camelCase command exit codes as successful results', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      phase: 'completed' as const,
      terminal: 'completed' as const,
      debugHistory: [
        {
          atMs: 1,
          kind: 'tool_call' as const,
          summary: 'bash call',
          detail: 'bash\n{"command":"npm test"}',
        },
        {
          atMs: 2,
          kind: 'tool_result' as const,
          summary: 'bash ok',
          detail: 'stdout:\nPASS src/__tests__/interactive-tui.test.ts\nexitCode: 0',
        },
      ],
    };
    const plain = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'completed',
        nowMs: 5000,
      },
      100,
      30,
    )
      .map((line) => stripAnsi(line))
      .join('\n');

    expect(plain).toContain('exit 0');
    expect(plain).not.toContain('exit 1');
  });

  it('switches to compact core mode after the first run event and hides it on small terminals', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      phase: 'thinking' as const,
      debugHistory: [
        { atMs: 1, kind: 'model' as const, summary: 'model response', detail: 'Inspecting files before editing.' },
      ],
    };

    const mediumPlain = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'thinking',
        nowMs: 2000,
      },
      92,
      24,
    )
      .map((line) => stripAnsi(line))
      .join('\n');
    const smallPlain = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'thinking',
        nowMs: 2000,
      },
      56,
      18,
    )
      .map((line) => stripAnsi(line))
      .join('\n');

    expect(mediumPlain).toContain('core');
    expect(mediumPlain).toContain('Inspecting files before editing.');
    expect(smallPlain).toContain('Synax');
    expect(smallPlain).toContain('Inspecting files before editing.');
    expect(smallPlain).not.toMatch(/[·•◎╱╲◆━×]/);
  });

  it('renders a closed input dock with cwd and branch instead of model id', () => {
    const run = createInitialRunStateSnapshot(0);
    run.lastModelOutput = 'The renderer now keeps the prompt inside a proper box.';
    const lines = renderLayout(
      {
        run,
        objectiveInput: 'Implement fixed-footprint reactor core rendering',
        coreMode: 'thinking',
        nowMs: 2000,
        lastModelOutput: 'raw parser chatter should stay out of default TUI',
        modelLabel: 'Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf',
        cwdLabel: '~/workspace/git/.worktrees/synax-tui',
        gitBranch: 'dev/tui',
      },
      90,
      28,
    );
    const plain = lines.map((line) => stripAnsi(line)).join('\n');
    const dock = lines.slice(-4).map(stripAnsi);

    expect(plain).not.toContain('Directive');
    expect(plain).toContain('The renderer now keeps the prompt inside a proper box.');
    expect(plain).not.toContain('Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf');
    expect(dock[0]).toMatch(/^┌─+ ~\/workspace\/git\/\.worktrees\/synax-tui  dev\/tui ┐\s*$/);
    expect(dock[1]).toMatch(/^│ Implement fixed-footprint reactor core rendering\s+│\s*$/);
    expect(dock[2]).toMatch(/^│\s+│\s*$/);
    expect(dock[3]).toMatch(/^└ Enter submit \| Ctrl\+C exit \| \/help ─+┘\s*$/);
  });

  it('renders unloaded core as inert and still', () => {
    const first = renderDottedCore({ mode: 'unloaded', frame: 1, width: 20, height: 7 });
    const second = renderDottedCore({ mode: 'unloaded', frame: 20, width: 20, height: 7 });

    expect(first.map(stripAnsi)).toEqual(second.map(stripAnsi));
    expect(first.join('')).not.toContain('\u001b[38;2;');

    const run = createInitialRunStateSnapshot(0);
    const plain = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'unloaded',
        nowMs: 2000,
      },
      120,
      28,
    )
      .map((line) => stripAnsi(line))
      .join('\n');

    expect(plain).toContain('Core        Unloaded');
    expect(plain).toContain('Model       none');
    expect(plain).toContain('Provider    none');
  });

  it('renders core telemetry as a structured module panel', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      phase: 'completed' as const,
      providerLabel: 'Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf @ http://127.0.0.1:1234/v1',
      providerName: 'llama.cpp',
      modelId: 'Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf',
      coreLoaded: true,
      contextUsedTokens: 8192,
      contextWindowTokens: 131072,
      thinkingEnabled: undefined,
      sessionSpendLabel: undefined,
      toolInvocationCount: 1,
      statusNote: 'completed: 13 model steps, 1 tool call, 0 files changed',
      debugHistory: [
        {
          atMs: 1,
          kind: 'tool_call' as const,
          summary: 'bash call',
          detail: 'bash\n{"command":"git status --short"}',
        },
      ],
    };

    const plain = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'completed',
        nowMs: 2000,
      },
      120,
      30,
    )
      .map((line) => stripAnsi(line))
      .join('\n');

    expect(plain).toContain('Core Module');
    expect(plain).toContain('Runtime');
    expect(plain).toContain('Session');
    expect(plain).toContain('Core        Loaded');
    expect(plain).toContain('Model       Qwen3.6-35B-A3…XS.gguf');
    expect(plain).toContain('Provider    llama.cpp');
    expect(plain).toContain('Context     8.2k / 131.1k');
    expect(plain).toContain('Thinking    unknown');
    expect(plain).toContain('Spend       unknown');
    expect(plain).toContain('Tools       bash');
    expect(plain).toContain('Steps       13');
    expect(plain).not.toContain('Core loaded');
    expect(plain).not.toContain('Session $');
    expect(plain).not.toContain('tools used bash');
  });

  it('summarizes diff stat command output into semantic file change rows', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      debugHistory: [
        {
          atMs: 1,
          kind: 'tool_call' as const,
          summary: 'bash call',
          detail: 'bash\n{"command":"git diff --stat"}',
        },
        {
          atMs: 2,
          kind: 'tool_result' as const,
          summary: 'bash ok',
          detail:
            'exit code: 0\nsrc/__tests__/interactive-tui.test.ts | 46 +++++++++++++++++++++\nsrc/tui/layout.ts | 12 ++++++',
        },
      ],
    };

    const plain = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'thinking',
        nowMs: 2000,
      },
      100,
      30,
    )
      .map((line) => stripAnsi(line))
      .join('\n');

    expect(plain).toContain('changed  src/__tests__/interactive-tui.test.ts  +46 lines');
    expect(plain).not.toContain('+++++++++++++++++++++');
  });

  it('surfaces compact operational summaries with the latest model reply', () => {
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
    expect(plain).toContain('Updated the TUI state and verified the focused tests.');
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

  it('renders debug history as segmented transcript blocks', () => {
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

    expect(plain).toContain('Transcript');
    expect(plain).toContain('model');
    expect(plain).toContain('I will check git status.');
    expect(plain).toContain('$ git status --short');
    expect(plain).toContain('M src/tui/layout.ts');
  });

  it('clamps transcript scroll offsets at the oldest and newest entries', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      phase: 'thinking' as const,
      debugHistory: Array.from({ length: 16 }, (_, index) => ({
        atMs: index,
        kind: 'model' as const,
        summary: `model event ${index}`,
        detail: `model event ${index}`,
      })),
    };

    const oldestPlain = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'thinking',
        nowMs: 2000,
        historyScrollOffset: 999,
      },
      90,
      24,
    )
      .map((line) => stripAnsi(line))
      .join('\n');
    const newestPlain = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'thinking',
        nowMs: 2000,
        historyScrollOffset: -999,
      },
      90,
      24,
    )
      .map((line) => stripAnsi(line))
      .join('\n');

    expect(oldestPlain).toContain('model event 0');
    expect(oldestPlain).toContain('model event 8');
    expect(oldestPlain).not.toContain('model event 15');
    expect(newestPlain).toContain('model event 15');
    expect(newestPlain).not.toContain('model event 0');
    expect(
      maxHistoryScrollOffset(
        {
          run,
          objectiveInput: '',
          coreMode: 'thinking',
          nowMs: 2000,
        },
        90,
        24,
      ),
    ).toBeGreaterThanOrEqual(0);
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

function extractTrueColors(input: string): Array<{ r: number; g: number; b: number }> {
  // eslint-disable-next-line no-control-regex
  return Array.from(input.matchAll(/\u001b\[38;2;(\d+);(\d+);(\d+)m/g), ([, r, g, b]) => ({
    r: Number(r),
    g: Number(g),
    b: Number(b),
  }));
}

function isWarningAmber(color: { r: number; g: number; b: number }): boolean {
  return color.r >= 150 && color.g >= 95 && color.g > color.b * 1.35 && color.r > color.b * 2;
}
