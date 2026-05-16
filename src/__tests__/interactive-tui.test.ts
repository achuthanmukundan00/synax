import { createChatSession, shouldUseInteractiveTui } from '../commands/chat';
import { applyEventToRunState, createInitialRunStateSnapshot } from '../agent/tui-state';
import { resolveCoreVisualProfile } from '../tui/core-visual-profile';
import { CORE_HEIGHT, CORE_WIDTH, modeColor, renderAiCore, renderDottedCore } from '../tui/ai-core';
import { DiffRenderer } from '../tui/diff-renderer';
import { LayerStack } from '../tui/layer-manager';
import { maxHistoryScrollOffset, renderLayout } from '../tui/layout';
import { createInputParser, parseInputChunk } from '../tui/input';
import { createTerminalSession } from '../tui/terminal';
import { renderSettings } from '../settings/settings-renderer';
import { createSettingsState, settingsReducer } from '../settings/settings-state';
import { classifyAgentEvent, semanticEventsFromDebugHistory } from '../tui/semantic-events';
import {
  latestExpandableEventId,
  movePromptCursorVertically,
  resolveCtrlCBehavior,
  scrollArtifactHistory,
  slashAutocompleteItems,
} from '../tui/interactive-tui';
import { setPromptValue } from '../tui/key-handlers';
import { formatEventCrown, promptInputHeight, renderSplashLogo } from '../tui/opentui-artifact-renderer';
import { detectColorFgBgTheme, getPalette } from '../tui/theme';
import type { EffectiveSynaxConfig } from '../config/schema';
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

  text(): string {
    return this.chunks.join('');
  }
}

function createTtyInput(): PassThrough & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
  resume: () => void;
  pause: () => void;
} {
  const stdin = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
    resume: () => void;
    pause: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = jest.fn();
  return stdin;
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
  it('parses submit/backspace/exit via Ctrl+D', () => {
    const events = parseInputChunk('a\x7f\n\u0004');
    expect(events.map((e) => e.type)).toEqual(['text', 'backspace', 'submit', 'exit']);
  });

  it('emits ctrl_c on Ctrl+C and newline on Shift+Enter', () => {
    expect(parseInputChunk('\u0003').map((e) => e.type)).toEqual(['ctrl_c']);
    expect(parseInputChunk('\x1b[13;2u').map((e) => e.type)).toEqual(['newline']);
  });

  it('ignores Ctrl+L instead of inserting a form-feed glyph', () => {
    expect(parseInputChunk('\u000c')).toEqual([]);
  });

  it('parses history scroll keys', () => {
    const events = parseInputChunk('\x1b[5~\x1b[6~');
    expect(events).toEqual([{ type: 'scroll_history_up' }, { type: 'scroll_history_down' }]);
  });

  it('parses SGR mouse wheel events as history scrolling', () => {
    const events = parseInputChunk('\x1b[<64;12;8M\x1b[<65;12;8M');
    expect(events).toEqual([{ type: 'scroll_history_up' }, { type: 'scroll_history_down' }]);
  });

  it.each([
    ['arrow up', '\x1b[A'],
    ['arrow down', '\x1b[B'],
    ['arrow right', '\x1b[C'],
    ['arrow left', '\x1b[D'],
    ['delete', '\x1b[3~'],
    ['home', '\x1b[H'],
    ['end', '\x1b[F'],
    ['home tilde', '\x1b[1~'],
    ['end tilde', '\x1b[4~'],
    ['function key SS3', '\x1bOP'],
    ['raw lone escape', '\x1b'],
    ['null byte', '\u0000'],
    ['unsupported control character', '\u0001'],
    ['unsupported C1 control character', '\u009b'],
  ])('discards unsupported terminal input for %s', (_name, input) => {
    if (input === '\x1b[A') {
      expect(parseInputChunk(input)).toEqual([{ type: 'arrow_up' }]);
      return;
    }
    if (input === '\x1b[B') {
      expect(parseInputChunk(input)).toEqual([{ type: 'arrow_down' }]);
      return;
    }
    if (input === '\x1b[C') {
      expect(parseInputChunk(input)).toEqual([{ type: 'arrow_right' }]);
      return;
    }
    if (input === '\x1b[D') {
      expect(parseInputChunk(input)).toEqual([{ type: 'arrow_left' }]);
      return;
    }
    if (input === '\x1b[H' || input === '\x1b[1~') {
      expect(parseInputChunk(input)).toEqual([{ type: 'home' }]);
      return;
    }
    if (input === '\x1b[F' || input === '\x1b[4~') {
      expect(parseInputChunk(input)).toEqual([{ type: 'end' }]);
      return;
    }
    if (input === '\x1b') {
      expect(parseInputChunk(input)).toEqual([{ type: 'escape' }]);
      return;
    }
    expect(parseInputChunk(input)).toEqual([]);
  });

  it('discards bracketed paste delimiters if the terminal sends them', () => {
    const events = parseInputChunk('\x1b[200~paste\x1b[201~');
    const pasteEvent = events.find((e) => e.type === 'paste');
    expect(pasteEvent?.value).toBe('paste');
  });

  it('keeps bracketed paste state across terminal chunks', () => {
    const parser = createInputParser();

    expect(parser.parse('\x1b[200~first line\n')).toEqual([]);
    expect(parser.parse('second line')).toEqual([]);
    expect(parser.parse('\x1b[201~ after\n')).toEqual([
      { type: 'paste', value: 'first line\nsecond line' },
      { type: 'text', value: ' ' },
      { type: 'text', value: 'a' },
      { type: 'text', value: 'f' },
      { type: 'text', value: 't' },
      { type: 'text', value: 'e' },
      { type: 'text', value: 'r' },
      { type: 'submit' },
    ]);
  });
});

describe('prompt value helpers', () => {
  it('moves the cursor to the end after programmatic prompt updates', () => {
    const input = {
      cursorOffset: 0,
      value: '',
      setText(text: string): void {
        this.value = text;
      },
    };

    setPromptValue(input, '/settings');

    expect(input.value).toBe('/settings');
    expect(input.cursorOffset).toBe('/settings'.length);
  });
});

describe('terminal session', () => {
  it('does not emit mouse-enable sequences by default (copy-safe)', () => {
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

    const output = stdout.chunks.join('');
    expect(output).not.toContain('\u001b[?1000h');
    expect(output).not.toContain('\u001b[?1006h');
    expect(output).not.toContain('\u001b[?1002h');
    expect(output).not.toContain('\u001b[?1003h');
  });

  it('cleanup defensively emits mouse-disable sequences', () => {
    const stdout = new CapturingWritable();
    const stdin = createTtyInput();
    const terminal = createTerminalSession({ stdin, stdout });

    terminal.start();
    const startOutput = stdout.chunks.join('');
    // Even without mouse enabled, cleanup emits disable sequences (defensive).
    expect(startOutput).not.toContain('\u001b[?1000h');

    terminal.stop();
    const fullOutput = stdout.chunks.join('');
    expect(fullOutput).toContain('\u001b[?1006l');
    expect(fullOutput).toContain('\u001b[?1000l');
  });

  it('enables mouse reporting when enableMouse option is true', () => {
    const stdout = new CapturingWritable();
    const stdin = createTtyInput();
    const terminal = createTerminalSession({ stdin, stdout }, { enableMouse: true });

    terminal.start();

    const output = stdout.chunks.join('');
    expect(output).toContain('\u001b[?1000h');
    expect(output).toContain('\u001b[?1006h');
  });

  it('runtime enableMouse/disableMouse toggles emit correct sequences', () => {
    const stdout = new CapturingWritable();
    const stdin = createTtyInput();
    const terminal = createTerminalSession({ stdin, stdout });

    terminal.start();
    stdout.chunks = []; // reset

    terminal.enableMouse();
    let output = stdout.chunks.join('');
    expect(output).toContain('\u001b[?1000h');
    expect(output).toContain('\u001b[?1006h');

    stdout.chunks = [];
    terminal.disableMouse();
    output = stdout.chunks.join('');
    expect(output).toContain('\u001b[?1006l');
    expect(output).toContain('\u001b[?1000l');
  });

  it('enableMouse is idempotent (does not emit duplicates)', () => {
    const stdout = new CapturingWritable();
    const stdin = createTtyInput();
    const terminal = createTerminalSession({ stdin, stdout });

    terminal.start();
    terminal.enableMouse();
    const first = stdout.chunks.join('');
    // eslint-disable-next-line no-control-regex
    const count1000h = (first.match(/\u001b\[\?1000h/g) || []).length;
    expect(count1000h).toBe(1);
  });

  it('enables bracketed paste for the TUI input dock', () => {
    const stdout = new CapturingWritable();
    const stdin = createTtyInput();
    const terminal = createTerminalSession({ stdin, stdout });

    terminal.start();
    terminal.stop();

    const output = stdout.chunks.join('');
    expect(output).toContain('\u001b[?2004h');
    expect(output).toContain('\u001b[?2004l');
  });
});

describe('OpenTUI artifact scrolling', () => {
  it('scrolls the artifact history with OpenTUI delta as the first argument', () => {
    const scrollBy = jest.fn();
    const scrollBox = { scrollBy, stickyScroll: true };
    const renderer = {
      root: {
        findDescendantById: jest.fn((id: string) => (id === 'synax-artifacts' ? scrollBox : undefined)),
      },
    };

    expect(scrollArtifactHistory(renderer, -9)).toBe(true);

    expect(scrollBy).toHaveBeenCalledWith(-9);
    expect(scrollBy).not.toHaveBeenCalledWith(0, -9);
    expect(scrollBox.stickyScroll).toBe(false);
  });

  it('returns false when the artifact scroll box is unavailable', () => {
    const renderer = {
      root: {
        findDescendantById: jest.fn(() => undefined),
      },
    };

    expect(scrollArtifactHistory(renderer, 9)).toBe(false);
  });
});

describe('OpenTUI polish helpers', () => {
  it('adds breathing room around event crown glyphs and labels', () => {
    expect(formatEventCrown('assistant_text')).toBe('  →  Note  ');
    expect(formatEventCrown('prompt')).toBe('  ↳  Prompt  ');
    expect(formatEventCrown('tool_result')).toBe('  ✓  Result  ');
    expect(formatEventCrown('result_error')).toBe('  ✗  Result  ');
    expect(formatEventCrown('command')).toBe('  ⌘  Command  ');
    expect(formatEventCrown('error')).toBe('  ✗  Error  ');
  });

  it('expands prompt height for multiline input without capping at 6', () => {
    expect(promptInputHeight('one line')).toBe(1);
    expect(promptInputHeight('one\ntwo\nthree')).toBe(3);
    expect(promptInputHeight('1\n2\n3\n4\n5\n6\n7')).toBe(7);
    expect(promptInputHeight('wrap '.repeat(30), 40)).toBeGreaterThan(1);
  });

  it('renders an AI morphology splash fallback instead of plain text only', () => {
    const logo = renderSplashLogo(2, { color: false });
    const plain = logo.join('\n');

    expect(logo.length).toBeGreaterThan(4);
    expect(plain).toMatch(/[. ]/);
    expect(plain.toLowerCase()).not.toContain('synax');
  });

  it('keeps old Ctrl+C prompt behavior before quitting', () => {
    expect(resolveCtrlCBehavior({ prompt: 'draft', busy: false, previousPressAtMs: null, nowMs: 1000 })).toBe(
      'clear_prompt',
    );
    expect(resolveCtrlCBehavior({ prompt: '', busy: true, previousPressAtMs: null, nowMs: 1000 })).toBe('interrupt');
    expect(resolveCtrlCBehavior({ prompt: '', busy: false, previousPressAtMs: null, nowMs: 1000 })).toBe('arm_quit');
    expect(resolveCtrlCBehavior({ prompt: '', busy: false, previousPressAtMs: 500, nowMs: 1000 })).toBe('quit');
  });

  it('finds the latest expandable artifact for keyboard expansion', () => {
    expect(
      latestExpandableEventId([
        {
          id: 'note',
          class: 'assistant_text',
          timestamp: 0,
          artifact: { type: 'text', title: 'Note', body: 'plain' },
          metadata: {},
        },
        {
          id: 'result',
          class: 'tool_result',
          timestamp: 1,
          artifact: { type: 'tool_result', title: 'read ok', summary: 'completed', output: 'line one\nline two' },
          metadata: {},
        },
      ]),
    ).toBe('result');
  });

  it('refreshes slash autocomplete from the registry as input changes', () => {
    expect(slashAutocompleteItems('/')).toContain('/settings');
    expect(slashAutocompleteItems('/').length).toBeGreaterThan(10);
    expect(slashAutocompleteItems('/sett')).toContain('/settings');
    expect(slashAutocompleteItems('/set')).toContain('/settings');
    expect(slashAutocompleteItems('/skill')).toContain('/skills');
    expect(slashAutocompleteItems('plain')).toEqual([]);
  });

  it('moves multiline prompt cursor vertically before history scrolling', () => {
    const input = {
      plainText: 'alpha\nbeta',
      cursorOffset: 'alpha\nbeta'.length,
      moveCursorUp: jest.fn(() => false),
      moveCursorDown: jest.fn(() => false),
    };

    expect(movePromptCursorVertically(input, 'up')).toBe(true);
    expect(input.cursorOffset).toBe(6);
    expect(movePromptCursorVertically(input, 'down')).toBe(true);
    expect(input.cursorOffset).toBe('alpha\nbeta'.length);
  });

  it('detects common light terminal backgrounds when theme query is unavailable', () => {
    expect(detectColorFgBgTheme('0;15')).toBe('light');
    expect(detectColorFgBgTheme('15;0')).toBe('dark');
    expect(getPalette('light').text).toBe('#1a1a1a');
  });
});

describe('diff renderer', () => {
  it('clips render scope to viewport height', () => {
    const diff = new DiffRenderer();
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
    const out = diff.render(lines, 20, 5);
    expect(out).toContain('\u001b[5;1H\u001b[0m\u001b[2Kline-4');
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

    expect(out).toContain('\u001b[1;1H\u001b[0m\u001b[2Kxy\u001b[0m');
  });

  it('avoids writing into the last terminal column to prevent prompt autowrap', () => {
    const diff = new DiffRenderer();
    const out = diff.render(['abcdefgh'], 8, 1);

    expect(out).toContain('\u001b[1;1H\u001b[0m\u001b[2Kabcdefg\u001b[0m');
    expect(out).not.toContain('\u001b[1;1Habcdefgh');
  });

  it('can invalidate cached lines after an external alternate-screen renderer runs', () => {
    const diff = new DiffRenderer();
    diff.render(['same'], 10, 1);
    expect(diff.render(['same'], 10, 1)).toBe('');

    diff.reset();
    const out = diff.render(['same'], 10, 1);

    expect(out).toContain('\u001b[2J');
    expect(out).toContain('same');
  });
});

describe('settings renderer', () => {
  it('shows Tab as the settings tab navigation key', () => {
    const config: EffectiveSynaxConfig = {
      active: { provider: 'relay', model: 'qwen-local', thinking: 'off' },
      providers: {},
      skills: { enabled: [], disabled: [] },
      mcp: { servers: {} },
      source: null,
      errors: [],
    };
    const state = settingsReducer(createSettingsState(config), { type: 'open' });

    const plain = renderSettings(state, 100, 24).map(stripAnsi).join('\n');

    expect(plain).toContain('Tab tabs');
    expect(plain).not.toContain('←/→ tabs');
    expect(plain).toContain('Settings  Model | Providers | Skills | MCP | Config | Help');
    expect(renderSettings(state, 100, 24).join('\n')).toContain('\u001b[7m Model \u001b[0m');
  });
});

describe('autocomplete overlay renderer', () => {
  it('renders commands list when no input is focused', () => {
    // Autocomplete rendering is now handled by LayerStack composition
    // in the paint() function. The overlay lines are module-private.
    // This test validates that LayerStack correctly composes overlays.
    const stack = new LayerStack();
    const baseLines = Array.from({ length: 18 }, (_, i) => `line-${i}`);
    stack.set('base', 0, { render: () => baseLines });
    stack.set('overlay', 1, {
      render: () => ['  -- commands --', '    /settings - Open settings menu', '    /model - Select model'],
      region: { start: 15, end: 18 },
    });
    const result = stack.render(18, 40);
    expect(result).toHaveLength(18);
    expect(result[15]).toContain('-- commands --');
    // Base lines should be preserved outside the overlay region
    expect(result[0].trimEnd()).toBe(baseLines[0]);
  });
});

describe('ai core renderer', () => {
  it('resolves model-aware core visual profiles from model IDs only', () => {
    expect(resolveCoreVisualProfile('Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf').id).toBe('qwen');
    expect(resolveCoreVisualProfile('gpt-5.5-thinking').id).toBe('openai');
    expect(resolveCoreVisualProfile('OPENAI/local-compatible').id).toBe('openai');
    expect(resolveCoreVisualProfile('claude-sonnet-4.5').id).toBe('claude');
    expect(resolveCoreVisualProfile('deepseekv4-pro').id).toBe('deepseek');
    expect(resolveCoreVisualProfile('gemini-2.5-pro').id).toBe('gemini');
    expect(resolveCoreVisualProfile('local-unknown-model.gguf').id).toBe('default');
  });

  it('renders distinct inner morphology for qwen, claude, and default profiles in the same state', () => {
    const base = { mode: 'thinking' as const, frame: 8, width: 24, height: 9, unicode: true };
    const qwen = renderDottedCore({ ...base, profile: resolveCoreVisualProfile('qwen3-local') })
      .map(stripAnsi)
      .join('\n');
    const claude = renderDottedCore({ ...base, profile: resolveCoreVisualProfile('claude-sonnet-4.5') })
      .map(stripAnsi)
      .join('\n');
    const fallback = renderDottedCore({ ...base, profile: resolveCoreVisualProfile('unknown-local') })
      .map(stripAnsi)
      .join('\n');

    expect(qwen).not.toEqual(claude);
    expect(qwen).not.toEqual(fallback);
    expect(claude).not.toEqual(fallback);
    expect(qwen).toMatch(/[╱╲]/);
    expect(claude).toMatch(/[○◉]/);
    expect(fallback).toMatch(/[●◎•]/);
  });

  it('renders a stable inner containment chamber across model profiles', () => {
    const base = { mode: 'idle' as const, frame: 4, width: 24, height: 9, unicode: true };
    const openai = renderDottedCore({ ...base, profile: resolveCoreVisualProfile('gpt-5') })
      .map(stripAnsi)
      .join('\n');
    const claude = renderDottedCore({ ...base, profile: resolveCoreVisualProfile('claude-sonnet-4.5') })
      .map(stripAnsi)
      .join('\n');

    for (const rendered of [openai, claude]) {
      expect(rendered).toMatch(/[╭╮╰╯]/);
      expect(rendered).toMatch(/[─│]/);
    }

    expect(openai).not.toEqual(claude);
    expect(openai).not.toMatch(/[╱╲]/);
    expect(claude).toMatch(/[○◉]/);
  });

  it('renders prominent model-specific morphology signatures', () => {
    const base = { mode: 'thinking' as const, frame: 8, width: 26, height: 9, unicode: true };
    const profiles = {
      qwen: renderDottedCore({ ...base, profile: resolveCoreVisualProfile('qwen3-local') })
        .map(stripAnsi)
        .join('\n'),
      openai: renderDottedCore({ ...base, profile: resolveCoreVisualProfile('gpt-5') })
        .map(stripAnsi)
        .join('\n'),
      claude: renderDottedCore({ ...base, profile: resolveCoreVisualProfile('claude-sonnet-4.5') })
        .map(stripAnsi)
        .join('\n'),
      deepseek: renderDottedCore({ ...base, profile: resolveCoreVisualProfile('deepseek-v4') })
        .map(stripAnsi)
        .join('\n'),
      gemini: renderDottedCore({ ...base, profile: resolveCoreVisualProfile('gemini-2.5-pro') })
        .map(stripAnsi)
        .join('\n'),
    };

    expect(new Set(Object.values(profiles)).size).toBe(Object.values(profiles).length);
    expect(profiles.qwen).toMatch(/[╱╲]/);
    expect(profiles.openai).toMatch(/[◎●]/);
    expect(profiles.openai).not.toMatch(/[╱╲]/);
    expect(profiles.claude).toMatch(/[○◉]/);
    expect(profiles.deepseek).toMatch(/[═━◆◈]/);
    expect(profiles.gemini).toMatch(/●[\s\S]*●/);
    expect(profiles.gemini).toMatch(/│/);
  });

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
    expect(modeColor('verifying')).toBe('\u001b[34m');
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
  it('matches the idle large-core render snapshot', () => {
    const lines = renderLayout(
      {
        run: createInitialRunStateSnapshot(0),
        objectiveInput: '',
        coreMode: 'idle',
        nowMs: 2000,
      },
      80,
      24,
    );

    expect(snapshotText(lines)).toMatchSnapshot();
  });

  it('matches the active docked-core render snapshot', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      phase: 'tool_execution' as const,
      modelId: 'qwen-local',
      providerName: 'Relay',
      coreLoaded: true,
      debugHistory: [
        { atMs: 1, kind: 'model' as const, summary: 'model response', detail: 'Inspecting files before editing.' },
        {
          atMs: 2,
          kind: 'tool_call' as const,
          summary: 'bash call',
          detail: 'bash\n{"command":"npm test -- src/__tests__/interactive-tui.test.ts"}',
        },
        { atMs: 3, kind: 'tool_result' as const, summary: 'bash ok', detail: 'exit code: 0\nPASS' },
      ],
    };

    expect(
      snapshotText(
        renderLayout(
          {
            run,
            objectiveInput: 'continue polishing the feed',
            coreMode: 'bash',
            nowMs: 2000,
          },
          120,
          32,
        ),
      ),
    ).toMatchSnapshot();
  });

  it('matches the completed render snapshot', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      phase: 'completed' as const,
      terminal: 'completed' as const,
      statusNote: 'completed: 3 model steps, 4 tool calls, 2 files changed',
      filesChangedThisRun: ['src/tui/transcript.ts', 'src/tui/layout.ts'],
      toolInvocationCount: 4,
      workingTreeClean: false,
      verification: {
        ...createInitialRunStateSnapshot(0).verification,
        state: 'passed' as const,
        summary: 'focused tests passed',
        currentCheckLabel: 'npm test -- src/__tests__/interactive-tui.test.ts',
      },
    };

    expect(
      snapshotText(
        renderLayout(
          {
            run,
            objectiveInput: '',
            coreMode: 'completed',
            nowMs: 2000,
          },
          120,
          32,
        ),
      ),
    ).toMatchSnapshot();
  });

  it('freezes the header timer after a run reaches a terminal state', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      phase: 'completed' as const,
      terminal: 'completed' as const,
      nowMs: 25_000,
    };

    const plain = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'completed',
        nowMs: 90_000,
      },
      100,
      24,
    )
      .map(stripAnsi)
      .join('\n');

    expect(plain).toContain(`Ready  0:25`);
  });

  it('renders terminal-state status bars in the header without redundant final summary blocks', () => {
    const success = {
      ...createInitialRunStateSnapshot(0),
      phase: 'completed' as const,
      terminal: 'completed' as const,
    };
    const blocked = {
      ...createInitialRunStateSnapshot(0),
      phase: 'blocked' as const,
      terminal: 'blocked' as const,
      terminalIssue: 'operator input required',
    };
    const failed = {
      ...createInitialRunStateSnapshot(0),
      phase: 'error' as const,
      terminal: 'failed' as const,
      terminalIssue: 'runtime error',
    };

    // Header phase label renders terminal state (no synthetic final summary block).
    const successPlain = renderLayout({ run: success, objectiveInput: '', coreMode: 'completed', nowMs: 0 }, 100, 24)
      .map((line) => stripAnsi(line))
      .join('\n');
    const blockedPlain = renderLayout({ run: blocked, objectiveInput: '', coreMode: 'blocked', nowMs: 0 }, 100, 24)
      .map((line) => stripAnsi(line))
      .join('\n');
    const failedPlain = renderLayout({ run: failed, objectiveInput: '', coreMode: 'failure', nowMs: 0 }, 100, 24)
      .map((line) => stripAnsi(line))
      .join('\n');

    expect(successPlain).toContain('Ready');
    expect(blockedPlain).toContain('Blocked');
    expect(failedPlain).toContain('Error');
    // No synthetic final summary block rendered.
    expect(successPlain).not.toContain('final      completed');
    expect(blockedPlain).not.toContain('final      blocked');
    expect(failedPlain).not.toContain('final      failed');
  });

  it('matches the blocked budget-exhausted render snapshot', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      phase: 'budget_exhausted' as const,
      terminal: 'blocked' as const,
      terminalIssue: 'max steps exceeded: 32',
      statusNote: 'blocked: 32/32 model steps, 10 tool calls',
    };

    expect(
      snapshotText(
        renderLayout(
          {
            run,
            objectiveInput: '',
            coreMode: 'blocked',
            nowMs: 2000,
          },
          120,
          32,
        ),
      ),
    ).toMatchSnapshot();
  });

  it('matches the narrow terminal fallback snapshot', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      phase: 'thinking' as const,
      debugHistory: [
        { atMs: 1, kind: 'model' as const, summary: 'model response', detail: 'Inspecting files before editing.' },
      ],
    };

    expect(
      snapshotText(
        renderLayout(
          {
            run,
            objectiveInput: 'short task',
            coreMode: 'thinking',
            nowMs: 2000,
          },
          56,
          18,
        ),
      ),
    ).toMatchSnapshot();
  });

  it('wraps long model notes instead of clipping them with ellipses', () => {
    const longInstruction =
      'Read the configuration file, then update the provider model setting, then run typecheck and report the exact command result so the user can follow the instruction without guessing. TAIL_MARKER';
    const run = {
      ...createInitialRunStateSnapshot(0),
      phase: 'thinking' as const,
      debugHistory: [{ atMs: 1, kind: 'model' as const, summary: 'model response', detail: longInstruction }],
    };

    const plain = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'thinking',
        nowMs: 5000,
      },
      72,
      24,
    )
      .map(stripAnsi)
      .join('\n');

    const noteLines = plain
      .split('\n')
      .filter(
        (line) =>
          (line.includes('Read the configuration') || line.includes('TAIL_MARKER')) && !line.includes('working'),
      );

    expect(noteLines.join('\n')).toContain('TAIL_MARKER');
    // Model notes now use pink star glyph and bold 'note' label, but prose wraps without ellipsis truncation.
    expect(noteLines.join('\n')).not.toContain('…');
  });

  it('uses the compact core on the empty idle surface at medium widths', () => {
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
    expect(plain).not.toContain('Field');
    expect(plain).not.toContain('contained local intelligence runtime');
    expect(plain).toMatch(/[.·•○◎╱╲]/);
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
    expect(plain).toContain('hidden chain');
    expect(plain).toContain('read, bash');
    expect(plain).toContain('read src/tui/layout.ts');
    expect(plain).toContain('npm test src/__tests__/interactive-tui.test.ts');
    expect(plain).toContain('edit       src/tui/layout.ts');
    expect(plain).toContain('-old dashboard');
    expect(plain).toContain('+new transcript');
    // Final summary block is not rendered; completion is in the header and runtime panel.
    expect(plain).not.toContain('final      completed');
    expect(plain).not.toContain('objective  Improve TUI observability');
    expect(plain).not.toContain('changed    2 files');
    expect(plain).not.toContain('tools      3 calls');
    expect(plain).not.toContain('commands   npm test src/__tests__/interactive-tui.test.ts');
  });

  it('strips terminal control sequences from command output before rendering', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      phase: 'tool_execution' as const,
      debugHistory: [
        {
          atMs: 1,
          kind: 'tool_call' as const,
          summary: 'bash call',
          detail: 'bash\n{"command":"clear"}',
        },
        {
          atMs: 2,
          kind: 'tool_result' as const,
          summary: 'bash ok',
          detail: 'exit code: 0\nstdout:\n\u001b[H\u001b[2J\u001b[3J',
        },
      ],
    };

    const rendered = renderLayout({ run, objectiveInput: '', coreMode: 'bash', nowMs: 2000 }, 100, 24).join('\n');

    expect(rendered).not.toContain('\u001b[H');
    expect(rendered).not.toContain('\u001b[2J');
    expect(rendered).not.toContain('\u001b[3J');
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

    expect(plain).toContain('FAIL src/__tests__/interactive-tui.test.ts');
    // Verification state and blocker are in the runtime panel, not a synthetic final-summary block.
    expect(plain).not.toContain('verify     failed');
    expect(plain).not.toContain('blocker    verification failed: Jest assertion failed');
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

  it('adds ANSI colors to plain git diff command output', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      debugHistory: [
        {
          atMs: 1,
          kind: 'tool_call' as const,
          summary: 'bash call',
          detail: 'bash\n{"command":"git diff -- src/tui/transcript.ts | head -60"}',
        },
        {
          atMs: 2,
          kind: 'tool_result' as const,
          summary: 'bash changed',
          detail:
            'exit code: 0\ndiff --git a/src/tui/transcript.ts b/src/tui/transcript.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line',
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

    expect(rendered).toContain('\u001b[1;37mdiff --git a/src/tui/transcript.ts b/src/tui/transcript.ts\u001b[0m');
    expect(rendered).toContain('\u001b[36m@@ -1,2 +1,2 @@\u001b[0m');
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

    // Successful exit 0 is suppressed from command display.
    expect(plain).toContain('npm test');
    expect(plain).not.toContain('exit 0');
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

    expect(mediumPlain).toContain('Inspecting files before editing.');
    expect(smallPlain).toContain('Synax');
    expect(smallPlain).toContain('Inspecting files before editing.');
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
    // Flat dock: blank, hr line, prompt line, continuation, no box borders or metadata
    expect(dock[0].trim()).toBe('');
    expect(dock[1].trimStart().startsWith('─')).toBe(true);
    expect(dock[2].trimStart().startsWith('>')).toBe(true);
  });

  it('keeps the input dock inside the terminal write-safe column', () => {
    const lines = renderLayout(
      {
        run: createInitialRunStateSnapshot(0),
        objectiveInput: 'Inspect the prompt border',
        coreMode: 'idle',
        nowMs: 2000,
        cwdLabel: '~/workspace/git/.worktrees/synax-tui',
        gitBranch: 'dev/tui',
      },
      90,
      24,
    ).map(stripAnsi);
    const dock = lines.slice(-4);

    expect(lines).toHaveLength(24);
    expect(lines.every((line) => line.length === 90)).toBe(true);
    // Flat dock: blank line, hr line, prompt line, continuation line
    expect(dock[1].trimStart().startsWith('─')).toBe(true);
    expect(dock[2].trimStart().startsWith('>')).toBe(true);
    expect(dock.every((line) => line.length === 90)).toBe(true);
  });

  it('reserves a blank gutter between long transcript output and the input dock', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      phase: 'completed' as const,
      debugHistory: Array.from({ length: 32 }, (_, index) => ({
        atMs: index,
        kind: 'model' as const,
        summary: `model event ${index}`,
        detail: `model event ${index}`,
      })),
    };
    const lines = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'completed',
        nowMs: 2000,
        historyScrollOffset: 0,
      },
      90,
      24,
    ).map(stripAnsi);

    expect(lines.at(-4)?.trim()).toBe('');
    expect(lines.at(-2)?.trimStart().startsWith('─')).toBe(true);
    // Empty input now shows a placeholder instead of blank line.
    expect(lines.at(-1)).toContain('Ask Synax');
  });

  it('renders unloaded core as inert and still', () => {
    const first = renderDottedCore({ mode: 'unloaded', frame: 1, width: 20, height: 7 });
    const second = renderDottedCore({ mode: 'unloaded', frame: 20, width: 20, height: 7 });

    expect(first.map(stripAnsi)).toEqual(second.map(stripAnsi));
    expect(first.join('')).not.toContain('\u001b[38;2;');
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

    expect(plain).not.toContain('unknown');
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
    expect(lines.join('\n')).toContain('\u001b[31m-old\u001b[0m');
    expect(lines.join('\n')).toContain('\u001b[32m+new\u001b[0m');
  });

  it('renders edit tool result diffs with ANSI colors', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      debugHistory: [
        {
          atMs: 1,
          kind: 'tool_call' as const,
          summary: 'edit call',
          detail: 'edit\n{"path":"src/tui/layout.ts","oldStr":"old","newStr":"new"}',
        },
        {
          atMs: 2,
          kind: 'tool_result' as const,
          summary: 'edit ok',
          detail: JSON.stringify(
            {
              success: true,
              toolName: 'edit',
              output: {
                path: 'src/tui/layout.ts',
                diff: '--- src/tui/layout.ts\n+++ src/tui/layout.ts\n-old\n+new',
              },
            },
            null,
            2,
          ),
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
      32,
    ).join('\n');

    expect(rendered).toContain('\u001b[31m-old\u001b[0m');
    expect(rendered).toContain('\u001b[32m+new\u001b[0m');
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

    expect(plain).not.toContain('Transcript');
    expect(plain).toContain('I will check git status.');
    expect(plain).toContain('$ git status --short');
    // No exit code in tool result — suppressed from display.
    expect(plain).not.toContain('exit 1');
    expect(plain).toContain('M src/tui/layout.ts');
  });

  it('keeps completed run summaries above the next submitted prompt', () => {
    let run = createInitialRunStateSnapshot(0);
    run = applyEventToRunState(
      run,
      {
        type: 'task_started',
        timestamp: '2026-05-06T12:00:00.000Z',
        mode: 'interactive',
        profile: 'default',
        endpoint: 'http://127.0.0.1:1234/v1',
        model: 'local-model',
        providerName: 'Relay',
        contextBudgetTokens: 0,
        maxModelSteps: 0,
        maxToolCalls: 0,
        tools: [],
        task: 'first task',
      },
      1,
    );
    run = applyEventToRunState(
      run,
      {
        type: 'assistant_message',
        timestamp: '2026-05-06T12:00:01.000Z',
        content: 'Finished the first task.',
      },
      2,
    );
    run = applyEventToRunState(
      run,
      {
        type: 'task_finished',
        timestamp: '2026-05-06T12:00:02.000Z',
        status: 'completed',
        toolCalls: 0,
        maxToolCalls: 0,
        modelSteps: 1,
        maxModelSteps: 1,
        changedFiles: [],
        workingTreeClean: true,
        verification: 'passed',
      },
      3,
    );
    run = applyEventToRunState(
      run,
      {
        type: 'task_started',
        timestamp: '2026-05-06T12:00:03.000Z',
        mode: 'interactive',
        profile: 'default',
        endpoint: 'http://127.0.0.1:1234/v1',
        model: 'local-model',
        providerName: 'Relay',
        contextBudgetTokens: 0,
        maxModelSteps: 0,
        maxToolCalls: 0,
        tools: [],
        task: 'second task should be visible',
      },
      4,
    );

    const plain = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'thinking',
        nowMs: 4000,
        historyScrollOffset: 0,
      },
      100,
      32,
    )
      .map((line) => stripAnsi(line))
      .join('\n');

    // No synthetic final summary block; the model review output appears for the
    // completed run and the next user prompt follows.
    const reviewIndex = plain.indexOf('Finished the first task.');
    const nextPromptIndex = plain.indexOf('second task should be visible');

    expect(run.terminal).toBe('running');
    expect(reviewIndex).toBeGreaterThanOrEqual(0);
    expect(nextPromptIndex).toBeGreaterThan(reviewIndex);
    expect(plain.match(/final {6}completed/g) || []).toHaveLength(0);
  });

  it('renders wrapped user prompts with the prompt label only on the first line', () => {
    let run = createInitialRunStateSnapshot(0);
    run = applyEventToRunState(
      run,
      {
        type: 'task_started',
        timestamp: '2026-05-06T12:00:00.000Z',
        mode: 'interactive',
        profile: 'default',
        endpoint: 'http://127.0.0.1:1234/v1',
        model: 'local-model',
        providerName: 'Relay',
        contextBudgetTokens: 0,
        maxModelSteps: 0,
        maxToolCalls: 0,
        tools: [],
        task: 'can you please commit the unstaged work on the branch into an organized set of commits? one swath of work is for the documentation and another is for settings UI/TUI bug fixes.',
      },
      1,
    );

    const plain = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'thinking',
        nowMs: 2000,
      },
      100,
      28,
    )
      .map((line) => stripAnsi(line))
      .join('\n');

    expect(plain).toContain('user prompt');
    // The prompt text wraps cleanly within the box.
    expect(plain).toContain('settings UI/TUI');
    expect(plain).toContain('bug fixes.');
  });

  it('uses the compact core visual on the welcome screen at medium widths', () => {
    const mediumPlain = renderLayout(
      {
        run: createInitialRunStateSnapshot(0),
        objectiveInput: '',
        coreMode: 'idle',
        nowMs: 2000,
      },
      92,
      24,
    )
      .map((line) => stripAnsi(line))
      .join('\n');

    expect(mediumPlain).toMatch(/[·•◎╱╲]/);
  });

  it('renders multi-line slash command output without 3-line cap', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      debugHistory: [
        {
          atMs: 1,
          kind: 'command' as const,
          summary: '/help',
          detail: [
            'Chat Commands',
            '-------------',
            '/help                      Show this help panel',
            '/settings                  Show provider, agent, tool, and verification settings',
            '/tools                     Show model-facing tools',
            '/budget                    Show context and loop limits',
            '/test-provider             Probe provider models and chat endpoints',
          ].join('\n'),
        },
      ],
    };
    const plain = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'idle',
        nowMs: 2000,
      },
      100,
      30,
    )
      .map((line) => stripAnsi(line))
      .join('\n');

    expect(plain).toContain('Show this help panel');
    expect(plain).toContain('Show provider, agent, tool, and');
    expect(plain).toContain('verification settings');
    expect(plain).toContain('Show model-facing tools');
    expect(plain).toContain('Show context and loop limits');
    expect(plain).toContain('Probe provider models and chat endpoints');
  });

  it('truncates long paths and commands without wrapping artifacts', () => {
    const longPath =
      'src/components/surfaces/very/deeply/nested/local-model-runtime-feed-event-renderer-with-extra-detail.tsx';
    const longCommand =
      'npm test -- src/__tests__/interactive-tui.test.ts --runInBand --verbose --detectOpenHandles --testNamePattern "renders a compact semantic operational feed"';
    const run = {
      ...createInitialRunStateSnapshot(0),
      debugHistory: [
        {
          atMs: 1,
          kind: 'tool_call' as const,
          summary: 'read call',
          detail: `read\n{"path":"${longPath}","startLine":1,"endLine":240}`,
        },
        { atMs: 2, kind: 'tool_result' as const, summary: 'read ok', detail: 'ok' },
        {
          atMs: 3,
          kind: 'tool_call' as const,
          summary: 'bash call',
          detail: `bash\n{"command":"${longCommand.replace(/"/g, '\\"')}"}`,
        },
        { atMs: 4, kind: 'tool_result' as const, summary: 'bash ok', detail: 'exit code: 0\nPASS' },
      ],
    };
    const lines = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'thinking',
        nowMs: 2000,
      },
      82,
      30,
    ).map(stripAnsi);
    const plain = lines.join('\n');

    expect(plain).toContain('read       src/components/surfaces');
    expect(plain).toContain('…');
    expect(plain).toContain('$ npm test');
    expect(lines.every((line) => line.length === 82)).toBe(true);
  });

  it('renders blocked budget exhaustion with current step budget when available', () => {
    const run = {
      ...createInitialRunStateSnapshot(0),
      phase: 'budget_exhausted' as const,
      terminal: 'blocked' as const,
      terminalIssue: 'max steps exceeded: 32',
      objective: {
        label: 'read project files',
        currentPhase: 'budget_exhausted' as const,
        nextCheckpoint: 'context budget exhausted',
      },
      statusNote: 'blocked: 32/32 model steps, 10 tool calls',
    };
    const plain = renderLayout(
      {
        run,
        objectiveInput: '',
        coreMode: 'blocked',
        nowMs: 2000,
      },
      120,
      30,
    )
      .map(stripAnsi)
      .join('\n');

    expect(plain).toContain('Budget exhausted');
    // Final summary block is not rendered; budget-exhausted state is in header.
    expect(plain).not.toContain('final      blocked');
    expect(plain).not.toContain('blocker    max steps exceeded: 32');
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
    expect(oldestPlain).toContain('model event 4');
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

  it('allows scrolling through a single long completed transcript entry', () => {
    const longFinalAnswer = Array.from(
      { length: 80 },
      (_, index) => `completed transcript paragraph ${index} with enough prose to wrap in the terminal viewport`,
    ).join('\n');
    const run = {
      ...createInitialRunStateSnapshot(0),
      phase: 'completed' as const,
      terminal: 'completed' as const,
      debugHistory: [
        {
          atMs: 1,
          kind: 'model' as const,
          summary: 'final answer',
          detail: longFinalAnswer,
        },
      ],
    };

    const maxOffset = maxHistoryScrollOffset(
      {
        run,
        objectiveInput: '',
        coreMode: 'completed',
        nowMs: 2000,
      },
      90,
      24,
    );

    expect(maxOffset).toBeGreaterThan(40);
  });
});

describe('artifact-first tui event model', () => {
  it('classifies task, tool, patch, and completion events as semantic artifacts', () => {
    let state = createInitialRunStateSnapshot(0);

    const taskEvent = {
      type: 'task_started' as const,
      timestamp: new Date(0).toISOString(),
      mode: 'patch' as const,
      profile: 'default',
      endpoint: 'http://localhost/v1',
      model: 'qwen',
      contextBudgetTokens: 1000,
      maxModelSteps: 10,
      maxToolCalls: 10,
      tools: ['edit'],
      task: 'add artifact renderer',
    };
    state = applyEventToRunState(state, taskEvent, 1);
    expect(classifyAgentEvent(taskEvent, state, 1)[0]?.class).toBe('plan');

    const promptEvent = {
      type: 'user_message' as const,
      timestamp: new Date(1).toISOString(),
      content: 'please fix the tui',
    };
    const prompt = classifyAgentEvent(promptEvent, state, 1)[0];
    expect(prompt?.class).toBe('prompt');
    expect(prompt?.artifact).toEqual(expect.objectContaining({ type: 'text', title: 'Prompt' }));

    const toolEvent = {
      type: 'tool_started' as const,
      timestamp: new Date(1).toISOString(),
      toolCallId: 'call-1',
      toolName: 'bash',
      summary: '{"command":"npm test -- tui"}',
    };
    state = applyEventToRunState(state, toolEvent, 2);
    const command = classifyAgentEvent(toolEvent, state, 2)[0];
    expect(command?.class).toBe('command');
    expect(command?.metadata.riskLevel).toBe('medium');

    const patchEvent = {
      type: 'patch_preview' as const,
      timestamp: new Date(2).toISOString(),
      toolCallId: 'call-2',
      toolName: 'edit',
      path: 'src/tui/interactive-tui.ts',
      diff: '@@ renderer\n-old\n+new',
    };
    state = applyEventToRunState(state, patchEvent, 3);
    const diff = classifyAgentEvent(patchEvent, state, 3)[0];
    expect(diff?.class).toBe('diff');
    expect(diff?.artifact.type).toBe('diff');

    const finishedEvent = {
      type: 'task_finished' as const,
      timestamp: new Date(3).toISOString(),
      status: 'completed' as const,
      toolCalls: 2,
      maxToolCalls: 10,
      modelSteps: 1,
      maxModelSteps: 10,
      changedFiles: ['src/tui/interactive-tui.ts'],
      workingTreeClean: false,
      verification: 'typecheck passed',
    };
    state = applyEventToRunState(state, finishedEvent, 4);
    const result = classifyAgentEvent(finishedEvent, state, 4)[0];
    expect(result?.class).toBe('tool_result');
    expect(result?.artifact).toEqual(expect.objectContaining({ type: 'text', title: 'Result' }));
  });

  it('can derive artifact cards from preserved debug history', () => {
    let state = createInitialRunStateSnapshot(0);
    state = applyEventToRunState(
      state,
      {
        type: 'assistant_message',
        timestamp: new Date(1).toISOString(),
        content: '<thinking>hidden</thinking>\nI will inspect the renderer.',
      },
      1,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'tool_started',
        timestamp: new Date(2).toISOString(),
        toolCallId: 'call-1',
        toolName: 'read',
        summary: '{"path":"src/tui/interactive-tui.ts"}',
      },
      2,
    );

    const events = semanticEventsFromDebugHistory(state);
    expect(events.map((event) => event.class)).toEqual(['tool_result', 'command']);
    expect(JSON.stringify(events)).not.toContain('<thinking>');
  });

  it('resets state and conversation on /new command', async () => {
    const repoRoot = process.cwd();
    const config = {
      provider: { kind: 'openai-compatible' as const, base_url: 'http://localhost/v1', model: 'fake' },
    };
    const session = createChatSession({ repoRoot, config, tui: true });

    // Verify /new resets conversation and returns newSession flag
    const report = await session.handleSlashCommand('/new');
    expect(report.handled).toBe(true);
    expect(report.newSession).toBe(true);
    expect(report.output).toContain('new session');

    // Verify conversation was cleared — subsequent /clear should produce same result
    const clearReport = await session.handleSlashCommand('/clear');
    expect(clearReport.output).toContain('conversation cleared');
  });
});

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}

function snapshotText(lines: string[]): string {
  return lines.map((line) => stripAnsi(line).trimEnd()).join('\n');
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
