import { createChatSession, shouldUseInteractiveTui } from '../commands/chat';
import { applyEventToRunState, createInitialRunStateSnapshot } from '../agent/tui-state';
import { resolveCoreVisualProfile } from '../tui/core-visual-profile';
import { CORE_HEIGHT, CORE_WIDTH, modeColor, renderAiCore, renderDottedCore } from '../tui/ai-core';
import { renderAnsiTokenStreamFrame, tokenStreamFrameText } from '../tui/token-stream';
import { createInputParser, parseInputChunk } from '../tui/input';
import { renderSettings } from '../settings/settings-renderer';
import { createSettingsState, settingsReducer } from '../settings/settings-state';
import { classifyAgentEvent, semanticEventsFromDebugHistory } from '../tui/semantic-events';
import {
  latestExpandableEventId,
  activityLineActive,
  computeOrchestrationStepText,
  movePromptCursorVertically,
  resolveCtrlCBehavior,
  scrollArtifactHistory,
  shouldHideCompletionResultCard,
  slashAutocompleteItems,
} from '../tui/interactive-tui';
import { setPromptValue } from '../tui/key-handlers';
import {
  formatEventCrown,
  promptInputHeight,
  renderArtifactCard,
  renderArtifactRoot,
  renderSplashLogo,
} from '../tui/opentui-artifact-renderer';
import { detectColorFgBgTheme, getPalette } from '../tui/theme';
import {
  getWordAtCursor,
  isPathToken,
  isAtMention,
  detectCompletionContext,
  getPathCompletions,
  collectModelNames,
  getCompletions,
} from '../tui/autocomplete';
import type { EffectiveSynaxConfig } from '../config/schema';

type FakeOpenTuiNode = {
  type: string;
  props: Record<string, unknown>;
  children: FakeOpenTuiNode[];
};

function createFakeOpenTuiCore(): any {
  const node = (type: string, props: Record<string, unknown>, children: FakeOpenTuiNode[] = []): FakeOpenTuiNode => ({
    type,
    props,
    children,
  });
  const StyledText = class {
    chunks: { __isChunk: true; text: string }[];
    constructor(c: any[]) {
      this.chunks = c;
    }
  };
  const chunk = (text: string): { __isChunk: true; text: string } => ({
    __isChunk: true,
    text,
  });
  return {
    StyledText,
    italic: (input: string | { __isChunk: true; text: string }) => (typeof input === 'string' ? chunk(input) : input),
    dim: (input: string | { __isChunk: true; text: string }) => (typeof input === 'string' ? chunk(input) : input),
    Box: (props: Record<string, unknown>, ...children: FakeOpenTuiNode[]) => node('Box', props, children),
    ScrollBox: (props: Record<string, unknown>, ...children: FakeOpenTuiNode[]) => node('ScrollBox', props, children),
    Text: (props: Record<string, unknown>) => node('Text', props),
    TextareaRenderable: class TextareaRenderable {},
    h: (_renderable: unknown, props: Record<string, unknown>) => node('Textarea', props),
  };
}

function extractTextFromContent(content: unknown): string[] {
  if (!content || typeof content !== 'object') return [];
  const obj = content as any;
  if (obj.__isChunk) return [obj.text];
  if (Array.isArray(obj.chunks))
    return obj.chunks.filter((c: any) => c && typeof c === 'object' && c.__isChunk).map((c: any) => c.text);
  return [];
}

function collectTextContent(node: FakeOpenTuiNode): string[] {
  const here =
    node.type === 'Text'
      ? typeof node.props.content === 'string'
        ? [node.props.content]
        : extractTextFromContent(node.props.content)
      : [];
  return [...here, ...node.children.flatMap(collectTextContent)];
}

function findNodeById(node: FakeOpenTuiNode, id: string): FakeOpenTuiNode | undefined {
  if (node.props.id === id) return node;
  for (const child of node.children) {
    const found = findNodeById(child, id);
    if (found) return found;
  }
  return undefined;
}

function collectNodes(node: FakeOpenTuiNode): FakeOpenTuiNode[] {
  return [node, ...node.children.flatMap(collectNodes)];
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

describe('OpenTUI startup layout', () => {
  it('keeps the initial empty session compact instead of filling the terminal', () => {
    const core = createFakeOpenTuiCore();
    const root = renderArtifactRoot(
      core,
      [],
      {
        model: 'qwen3-local',
        cwd: '~/workspace/git/synax',
        branch: 'main',
        filesTouched: [],
        uptimeLabel: '0:00',
      },
      {
        status: 'Ready.',
        prompt: '',
        placeholder: 'Ask Synax...',
        hints: 'Enter send',
        location: '~/workspace/git/synax',
      },
      100,
    ) as unknown as FakeOpenTuiNode;

    expect(root.props.height).toBe(29);
    expect(root.children[0].props.height).toBe(22);
    expect(findNodeById(root, 'synax-input-frame')?.props.height).toBe(3);
    expect(findNodeById(root, 'synax-location')).toBeUndefined();
  });

  it('uses a thin fixed card accent and stable prompt prefix', () => {
    const core = createFakeOpenTuiCore();
    const root = renderArtifactRoot(
      core,
      [],
      {
        model: 'qwen3-local',
        filesTouched: [],
        uptimeLabel: '0:00',
      },
      {
        status: 'Ready.',
        prompt: '',
        placeholder: 'Ask Synax...',
        hints: 'Enter send',
      },
      100,
    ) as unknown as FakeOpenTuiNode;
    const card = renderArtifactCard(core, {
      id: 'result-1',
      class: 'tool_result',
      timestamp: '2026-05-16T00:00:00.000Z',
      artifact: { type: 'text', title: 'Result', body: 'Done.' },
      metadata: {},
    } as any) as unknown as FakeOpenTuiNode;

    const inputFrame = findNodeById(root, 'synax-input-frame');
    const promptPrefix = inputFrame?.children[0];

    expect(promptPrefix?.props.width).toBe(2);
    expect(card.children[0]?.props.width).toBe(1);
  });

  it('gives card body text the available width instead of min-content wrapping', () => {
    const core = createFakeOpenTuiCore();
    const card = renderArtifactCard(core, {
      id: 'result-wrap',
      class: 'tool_result',
      timestamp: '2026-05-16T00:00:00.000Z',
      artifact: {
        type: 'text',
        title: 'Result',
        body: 'Deleted `src/__tests__/layout-input-dock.test.ts` and `src/__tests__/transcript.test.ts`.',
      },
      metadata: {},
    } as any) as unknown as FakeOpenTuiNode;
    const body = card.children[1];
    const textNodes = collectNodes(card).filter((node) => node.type === 'Text');

    expect(body?.props.flexBasis).toBe(0);
    expect(body?.props.minWidth).toBe(0);
    expect(textNodes.some((node) => node.props.width === '100%' && node.props.wrapMode === 'word')).toBe(true);
  });

  it('renders collapsed thinking cards as a cleaned sentence preview', () => {
    const core = createFakeOpenTuiCore();
    const card = renderArtifactCard(core, {
      id: 'thinking-1',
      class: 'thinking',
      timestamp: '2026-05-16T00:00:00.000Z',
      artifact: {
        type: 'text',
        title: 'Thinking',
        body: 'Let me also check the diff summary to understand what changes are pending.',
      },
      metadata: {},
    } as any) as unknown as FakeOpenTuiNode;
    const text = collectTextContent(card).join('\n');

    expect(text).toContain('Let me also check the diff summary');
    expect(text).not.toContain('\nme\n');
  });

  it('uses full-height feed layout once visible events exist', () => {
    const core = createFakeOpenTuiCore();
    const root = renderArtifactRoot(
      core,
      [
        {
          id: 'event-1',
          class: 'note',
          timestamp: '2026-05-16T00:00:00.000Z',
          artifact: { type: 'text', title: 'Note', body: 'hello' },
        } as any,
      ],
      {
        model: 'qwen3-local',
        filesTouched: [],
        uptimeLabel: '0:00',
      },
      {
        status: 'Ready.',
        prompt: '',
        placeholder: 'Ask Synax...',
        hints: 'Enter send',
      },
      100,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'qwen3-local',
      40,
    ) as unknown as FakeOpenTuiNode;

    expect(root.props.height).toBe(40);
    expect(root.children[0].props.flexGrow).toBe(1);
  });

  it('backs the settings overlay across the full terminal height', () => {
    const core = createFakeOpenTuiCore();
    const root = renderArtifactRoot(
      core,
      [
        {
          id: 'event-1',
          class: 'tool_result',
          timestamp: '2026-05-16T00:00:00.000Z',
          artifact: { type: 'text', title: 'Result', body: 'conversation behind settings' },
          metadata: {},
        } as any,
      ],
      {
        model: 'qwen3-local',
        filesTouched: [],
        uptimeLabel: '0:00',
      },
      {
        status: 'Ready.',
        prompt: '',
        placeholder: 'Ask Synax...',
        hints: 'Enter send',
      },
      100,
      undefined,
      undefined,
      undefined,
      undefined,
      ['┌ Settings ┐', '│ Model    │', '└ Esc close┘'],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      40,
    ) as unknown as FakeOpenTuiNode;
    const overlay = findNodeById(root, 'synax-settings');
    const backingRows = collectNodes(root).filter((node) =>
      String(node.props.id ?? '').startsWith('synax-settings-backdrop-'),
    );

    expect(overlay?.props.height).toBe(40);
    expect(overlay?.props.zIndex).toBe(100);
    expect(backingRows).toHaveLength(37);
    expect(backingRows.every((node) => node.type === 'Box' && node.props.width === '100%')).toBe(true);
    // The settings overlay must use the app background, not the lighter
    // surface color — a solid grey full-screen block clashes with the TUI.
    const palette = getPalette();
    expect(overlay?.props.backgroundColor).toBe(palette.background);
    expect(backingRows.every((node) => node.props.backgroundColor === palette.background)).toBe(true);
  });

  it('renders the autocomplete dropdown with a solid background so the transcript does not bleed through', () => {
    const core = createFakeOpenTuiCore();
    const root = renderArtifactRoot(
      core,
      [
        {
          id: 'event-1',
          class: 'note',
          timestamp: '2026-05-16T00:00:00.000Z',
          artifact: { type: 'text', title: 'Note', body: 'text behind the dropdown' },
          metadata: {},
        } as any,
      ],
      {
        model: 'qwen3-local',
        filesTouched: [],
        uptimeLabel: '0:00',
      },
      {
        status: 'Ready.',
        prompt: '/he',
        placeholder: 'Ask Synax...',
        hints: 'Enter send',
      },
      100,
      undefined,
      undefined,
      undefined,
      { visible: true, items: ['/help'], selectedIndex: 0 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'qwen3-local',
      40,
    ) as unknown as FakeOpenTuiNode;

    const dropdown = findNodeById(root, 'synax-autocomplete');
    expect(dropdown?.props.visible).toBe(true);
    expect(dropdown?.props.position).toBe('absolute');
    expect(dropdown?.props.backgroundColor).toBe(getPalette().surface);
  });

  it('moves the prompt dock to the bottom as soon as the first run starts', () => {
    const core = createFakeOpenTuiCore();
    const root = renderArtifactRoot(
      core,
      [],
      {
        model: 'deepseek-v4-pro',
        filesTouched: [],
        uptimeLabel: '0:00',
      },
      {
        status: 'Thinking',
        prompt: '',
        placeholder: 'Ask Synax...',
        hints: 'Ctrl+D quit',
      },
      100,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'deepseek-v4-pro',
      42,
    ) as unknown as FakeOpenTuiNode;

    expect(root.props.height).toBe(42);
    expect(root.children[0].props.flexGrow).toBe(1);
  });

  it('renders result markdown without leaking inline markers in fallback tests', () => {
    const core = createFakeOpenTuiCore();
    const card = renderArtifactCard(core, {
      id: 'result-1',
      class: 'tool_result',
      timestamp: '2026-05-16T00:00:00.000Z',
      artifact: {
        type: 'text',
        title: 'Result',
        body: [
          'Changed **bold**, *italic*, and `code`.',
          '',
          '| Commit | Message |',
          '| --- | --- |',
          '| `abc123` | **fix:** markdown |',
        ].join('\n'),
      },
      metadata: {},
    } as any) as unknown as FakeOpenTuiNode;

    const text = collectTextContent(card).join('\n');
    expect(text).toContain('Changed bold, italic, and code.');
    expect(text).toContain('abc123');
    expect(text).toContain('fix: markdown');
    expect(text).not.toContain('**bold**');
    expect(text).not.toContain('`abc123`');
  });

  it('renders fenced code blocks as distinct content regions', () => {
    const core = createFakeOpenTuiCore();
    const card = renderArtifactCard(core, {
      id: 'result-cb',
      class: 'tool_result',
      timestamp: '2026-05-16T00:00:00.000Z',
      artifact: {
        type: 'text',
        title: 'Result',
        body: [
          'Latest commits (top 5):',
          '',
          '```',
          '94336c3 Extract activityLineActive helper, keep spinner alive when busy',
          'b277ebf feat: add token-stream animation module',
          '```',
          '',
          'Done.',
        ].join('\n'),
      },
      metadata: {},
    } as any) as unknown as FakeOpenTuiNode;

    const text = collectTextContent(card).join('\n');
    // Code block content is rendered (not stripped)
    expect(text).toContain('94336c3 Extract activityLineActive helper');
    expect(text).toContain('b277ebf feat: add token-stream animation module');
    // Backtick fences are not shown
    expect(text).not.toContain('```');
    // Non-code content surrounding the block is preserved
    expect(text).toContain('Latest commits (top 5):');
    expect(text).toContain('Done.');
  });

  it('shows full tool results without truncation', () => {
    const core = createFakeOpenTuiCore();
    const body = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n');
    const card = renderArtifactCard(
      core,
      {
        id: 'result-long',
        class: 'tool_result',
        timestamp: '2026-05-16T00:00:00.000Z',
        artifact: { type: 'text', title: 'Result', body },
        metadata: {},
      } as any,
      false,
      jest.fn(),
    ) as unknown as FakeOpenTuiNode;

    const text = collectTextContent(card).join('\n');
    // All 80 lines are visible — no truncation.
    expect(text).toContain('line 1');
    expect(text).toContain('line 60');
    expect(text).toContain('line 80');
    expect(text).not.toContain('more lines (Enter to expand)');
  });

  it('shows full tool result identically when expanded', () => {
    const core = createFakeOpenTuiCore();
    const body = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n');
    const card = renderArtifactCard(
      core,
      {
        id: 'result-expanded',
        class: 'tool_result',
        timestamp: '2026-05-16T00:00:00.000Z',
        artifact: { type: 'text', title: 'Result', body },
        metadata: {},
      } as any,
      true,
      jest.fn(),
    ) as unknown as FakeOpenTuiNode;

    const text = collectTextContent(card).join('\n');
    expect(text).toContain('line 1');
    expect(text).toContain('line 80');
    // No collapse indicator — nothing was truncated.
    expect(text).not.toContain('Collapse (Enter)');
  });
});

describe('token stream activity indicator', () => {
  it('renders semantic token stream frames with plain and ANSI output', () => {
    expect(tokenStreamFrameText('default', 0)).toBe('˙·.:●:.·˙');
    expect(tokenStreamFrameText('qwen', 0)).toBe('╱·:●:·╲');
    expect(renderAnsiTokenStreamFrame('default', 0)).toContain('\x1b[38;5;230m●');
  });

  it('stays active immediately after submitting a follow-up prompt from a completed run', () => {
    const completed = {
      ...createInitialRunStateSnapshot(0),
      terminal: 'completed' as const,
      phase: 'completed' as const,
    };

    expect(activityLineActive(completed, true, '')).toBe(true);
    expect(activityLineActive(completed, false, '')).toBe(false);
  });

  it('computeOrchestrationStepText: sequential step 1/2 for 2-step plan, first step active', () => {
    expect(computeOrchestrationStepText('sequential', 1, 0, 2)).toBe('step 1/2 running');
  });

  it('computeOrchestrationStepText: sequential step 2/2 for 2-step plan, second step active', () => {
    expect(computeOrchestrationStepText('sequential', 1, 1, 2)).toBe('step 2/2 running');
  });

  it('computeOrchestrationStepText: parallel mode counts from active and returned', () => {
    expect(computeOrchestrationStepText('parallel', 2, 1, 0)).toBe('1/3 agents returned');
  });

  it('computeOrchestrationStepText: falls back to active+returned count when totalSteps is 0', () => {
    expect(computeOrchestrationStepText('sequential', 1, 0, 0)).toBe('step 1/1 running');
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

  it('preserves multi-line content inside bracketed paste without triggering submit on newlines', () => {
    const events = parseInputChunk('\x1b[200~line one\nline two\nline three\x1b[201~');
    const pasteEvent = events.find((e) => e.type === 'paste');
    expect(pasteEvent?.value).toBe('line one\nline two\nline three');
    // No submit events — newlines inside brackets are part of the paste text
    expect(events.every((e) => e.type !== 'submit')).toBe(true);
  });

  it('handles empty bracketed paste (no content between brackets)', () => {
    const events = parseInputChunk('\x1b[200~\x1b[201~');
    const pasteEvent = events.find((e) => e.type === 'paste');
    expect(pasteEvent?.value).toBe('');
  });

  it('preserves special characters inside bracketed paste verbatim', () => {
    const events = parseInputChunk('\x1b[200~code: "hello" & <world>\n  indent\there\x1b[201~');
    const pasteEvent = events.find((e) => e.type === 'paste');
    expect(pasteEvent?.value).toBe('code: "hello" & <world>\n  indent\there');
    // Tab, quotes, angle brackets, ampersand — all preserved literally
    expect(events.every((e) => e.type !== 'submit')).toBe(true);
  });

  it('preserves unicode characters inside bracketed paste', () => {
    const events = parseInputChunk('\x1b[200~emoji 🎉 unicode üöä chinese 你好\x1b[201~');
    const pasteEvent = events.find((e) => e.type === 'paste');
    expect(pasteEvent?.value).toBe('emoji 🎉 unicode üöä chinese 你好');
  });

  it('cancels bracketed paste on Ctrl+C and emits ctrl_c', () => {
    const events = parseInputChunk('\x1b[200~partial text\u0003');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('ctrl_c');
    // Paste text is discarded — no paste event emitted
  });

  it('resumes normal key handling after bracketed paste ends', () => {
    const parser = createInputParser();
    // Complete paste — emits a single paste event
    const pasteResult = parser.parse('\x1b[200~pasted content\x1b[201~');
    expect(pasteResult).toEqual([{ type: 'paste', value: 'pasted content' }]);
    // Normal typing afterward — newlines trigger submit again
    const result = parser.parse('hello\n');
    expect(result).toEqual([
      { type: 'text', value: 'h' },
      { type: 'text', value: 'e' },
      { type: 'text', value: 'l' },
      { type: 'text', value: 'l' },
      { type: 'text', value: 'o' },
      { type: 'submit' },
    ]);
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

  it('parses application keypad arrow keys (tmux extended-keys)', () => {
    expect(parseInputChunk('\x1bOA')).toEqual([{ type: 'arrow_up' }]);
    expect(parseInputChunk('\x1bOB')).toEqual([{ type: 'arrow_down' }]);
    expect(parseInputChunk('\x1bOC')).toEqual([{ type: 'arrow_right' }]);
    expect(parseInputChunk('\x1bOD')).toEqual([{ type: 'arrow_left' }]);
  });

  it('parses kitty CSI u arrow keys (tmux extended-keys)', () => {
    expect(parseInputChunk('\x1b[57352u')).toEqual([{ type: 'arrow_up' }]);
    expect(parseInputChunk('\x1b[57353u')).toEqual([{ type: 'arrow_down' }]);
    expect(parseInputChunk('\x1b[57354u')).toEqual([{ type: 'arrow_right' }]);
    expect(parseInputChunk('\x1b[57355u')).toEqual([{ type: 'arrow_left' }]);
  });

  it('parses CSI u Tab sequences (tmux extended-keys)', () => {
    expect(parseInputChunk('\x1b[9u')).toEqual([{ type: 'tab' }]);
    expect(parseInputChunk('\x1b[9;2u')).toEqual([{ type: 'shift_tab' }]);
  });

  it('parses standard Tab and Shift+Tab', () => {
    expect(parseInputChunk('\t')).toEqual([{ type: 'tab' }]);
    expect(parseInputChunk('\x1b[Z')).toEqual([{ type: 'shift_tab' }]);
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
    // stickyScroll stays enabled — the ScrollBox's built-in _hasManualScroll
    // handles pause/recovery without disabling sticky entirely.
    expect(scrollBox.stickyScroll).toBe(true);
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

describe('OpenTUI result card consolidation', () => {
  it('hides the completed status card when the turn already has an assistant result', () => {
    expect(
      shouldHideCompletionResultCard(
        {
          type: 'task_finished',
          timestamp: new Date(0).toISOString(),
          status: 'completed',
          toolCalls: 0,
          maxToolCalls: 10,
          modelSteps: 1,
          maxModelSteps: 10,
          changedFiles: [],
          workingTreeClean: false,
          verification: 'not run',
        },
        true,
      ),
    ).toBe(true);
  });

  it('keeps the completed status card as a fallback when no assistant result exists', () => {
    expect(
      shouldHideCompletionResultCard(
        {
          type: 'task_finished',
          timestamp: new Date(0).toISOString(),
          status: 'completed',
          toolCalls: 0,
          maxToolCalls: 10,
          modelSteps: 1,
          maxModelSteps: 10,
          changedFiles: [],
          workingTreeClean: false,
          verification: 'not run',
        },
        false,
      ),
    ).toBe(false);
  });
});

describe('OpenTUI polish helpers', () => {
  it('renders event crown glyphs and labels as a plain header (no border padding)', () => {
    expect(formatEventCrown('assistant_text')).toBe('→  Note');
    expect(formatEventCrown('prompt')).toBe('◆  Prompt');
    expect(formatEventCrown('tool_result')).toBe('◇  Result');
    expect(formatEventCrown('result_error')).toBe('✕  Result');
    expect(formatEventCrown('command')).toBe('⌘  Command');
    expect(formatEventCrown('error')).toBe('✕  Error');
  });

  it('expands prompt height for multiline input without capping at 6', () => {
    expect(promptInputHeight('one line')).toBe(1);
    expect(promptInputHeight('one\ntwo\nthree')).toBe(3);
    expect(promptInputHeight('1\n2\n3\n4\n5\n6\n7')).toBe(7);
    expect(promptInputHeight('wrap '.repeat(30), 40)).toBeGreaterThan(1);
  });

  it('simulates word-wrap to match TextareaRenderable wrapping', () => {
    // Short words: should all fit on one line.
    expect(promptInputHeight('hello world', 80)).toBe(1);
    // Long line that wraps: each word is short, should wrap at word boundaries.
    const manyWords = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    expect(promptInputHeight(manyWords, 80)).toBeGreaterThan(1);
    // Mixed hard newlines and soft wrapping.
    expect(promptInputHeight('short\n' + manyWords, 80)).toBeGreaterThan(2);
    // Empty line in the middle.
    expect(promptInputHeight('a\n\nb')).toBe(3);
    // Trailing newline.
    expect(promptInputHeight('a\n')).toBe(2);
    // Long unbreakable word: must be force-broken across multiple lines.
    const longWord = 'x'.repeat(50);
    const heightForLongWord = promptInputHeight(longWord, 30); // wrapColumns = 24
    expect(heightForLongWord).toBeGreaterThan(2);
    // Exact-width word fits on one visual line when it matches wrapColumns.
    const exactWord = 'y'.repeat(24);
    // 24 chars at wrapCols=24 (terminal 30): fits exactly, 1 line
    expect(promptInputHeight(exactWord, 30)).toBe(1);
    // One char longer forces a second line.
    expect(promptInputHeight('y'.repeat(25), 30)).toBe(2);
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

describe('ai core renderer', () => {
  it('resolves model-aware core visual profiles from model IDs only', () => {
    expect(resolveCoreVisualProfile('Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf').id).toBe('qwen');
    expect(resolveCoreVisualProfile('gpt-5.5-thinking').id).toBe('openai');
    expect(resolveCoreVisualProfile('OPENAI/local-compatible').id).toBe('openai');
    expect(resolveCoreVisualProfile('frontier-sonnet-4.5').id).toBe('frontier');
    expect(resolveCoreVisualProfile('deepseekv4-pro').id).toBe('deepseek');
    expect(resolveCoreVisualProfile('gemini-2.5-pro').id).toBe('gemini');
    expect(resolveCoreVisualProfile('local-unknown-model.gguf').id).toBe('default');
    expect(resolveCoreVisualProfile('qwen3-local').geometry).toBe('lattice');
    expect(resolveCoreVisualProfile('qwen3-local').motion.phaseStyle).toBe('snap');
    expect(resolveCoreVisualProfile('deepseek-r1').motion.scanStyle).toBe('beam');
  });

  it('renders distinct inner morphology for qwen, frontier, and default profiles in the same state', () => {
    const base = { mode: 'thinking' as const, frame: 8, width: 24, height: 9, unicode: true };
    const qwen = renderDottedCore({ ...base, profile: resolveCoreVisualProfile('qwen3-local') })
      .map(stripAnsi)
      .join('\n');
    const frontier = renderDottedCore({ ...base, profile: resolveCoreVisualProfile('frontier-sonnet-4.5') })
      .map(stripAnsi)
      .join('\n');
    const fallback = renderDottedCore({ ...base, profile: resolveCoreVisualProfile('unknown-local') })
      .map(stripAnsi)
      .join('\n');

    expect(qwen).not.toEqual(frontier);
    expect(qwen).not.toEqual(fallback);
    expect(frontier).not.toEqual(fallback);
    expect(qwen).toMatch(/[╱╲]/);
    expect(frontier).toMatch(/[◎◉]/);
    expect(fallback).toMatch(/[●◎]/);
  });

  it('renders a stable inner containment chamber across model profiles', () => {
    const base = { mode: 'idle' as const, frame: 4, width: 24, height: 9, unicode: true };
    const openai = renderDottedCore({ ...base, profile: resolveCoreVisualProfile('gpt-5') })
      .map(stripAnsi)
      .join('\n');
    const frontier = renderDottedCore({ ...base, profile: resolveCoreVisualProfile('frontier-sonnet-4.5') })
      .map(stripAnsi)
      .join('\n');

    for (const rendered of [openai, frontier]) {
      expect(rendered).toMatch(/[╭╮╰╯]/);
      expect(rendered).toMatch(/[─│]/);
    }

    expect(openai).not.toEqual(frontier);
    expect(openai).not.toMatch(/[╱╲]/);
    expect(frontier).toMatch(/[◎◉]/);
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
      frontier: renderDottedCore({ ...base, profile: resolveCoreVisualProfile('frontier-sonnet-4.5') })
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
    expect(profiles.frontier).toMatch(/[◎◉]/);
    expect(profiles.deepseek).toMatch(/[═━◎◉]/);
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
    expect(stripAnsi(idle.join('\n'))).toMatch(/[.·●◎╱╲─│]/);
    expect(idle.join('\n')).toContain('\u001b[38;2;');

    expect(thinking.join('\n')).not.toEqual(idle.join('\n'));
    expect(stripAnsi(tool.join('\n'))).toMatch(/[═◎◉]/);
    expect(stripAnsi(verifying.join('\n'))).toMatch(/[━]/);
    expect(stripAnsi(failure.join('\n'))).toMatch(/[×]/);
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

describe('orchestration semantic events', () => {
  it('classifyAgentEvent with orchestration_plan_generated returns empty (card removed)', () => {
    const state = createInitialRunStateSnapshot(0);
    const event = {
      type: 'orchestration_plan_generated' as const,
      timestamp: new Date(0).toISOString(),
      profile: 'default',
      payload: {
        sessionId: 'session-1',
        task: 'Fix all lint errors',
        plan: {
          planId: 'plan-1',
          strategy: 'orchestrate' as const,
          subTasks: [
            {
              id: 'agent-1',
              description: 'Fix src/a.ts',
              estimatedBudget: 1000,
              fileScope: ['src/a.ts'],
              dependencies: [],
              verification: { level: 'none' as const, label: 'none' },
            },
            {
              id: 'agent-2',
              description: 'Fix src/b.ts',
              estimatedBudget: 1000,
              fileScope: ['src/b.ts'],
              dependencies: [],
              verification: { level: 'none' as const, label: 'none' },
            },
          ],
          estimatedTotalTokens: 2000,
          repoMetadata: { fileCount: 10, totalKB: 100, sourceKB: 80 },
          contextWindowTokens: 131072,
        },
      },
    };
    const result = classifyAgentEvent(event, state, 1);
    expect(result).toHaveLength(0);
  });

  it('classifyAgentEvent with inline plan returns empty', () => {
    const state = createInitialRunStateSnapshot(0);
    const event = {
      type: 'orchestration_plan_generated' as const,
      timestamp: new Date(0).toISOString(),
      profile: 'default',
      payload: {
        sessionId: 'session-1',
        task: 'Simple fix',
        plan: { inline: true } as const,
      },
    } as const;
    const result = classifyAgentEvent(event as Parameters<typeof classifyAgentEvent>[0], state, 1);
    expect(result).toHaveLength(0);
  });

  it('classifyAgentEvent with child_session_spawned returns agent_status running', () => {
    const state = createInitialRunStateSnapshot(0);
    const event = {
      type: 'child_session_spawned' as const,
      timestamp: new Date(0).toISOString(),
      parentSessionId: 'parent-1',
      childSessionId: 'child-a1',
      subtaskId: 'agent-1',
    };
    const result = classifyAgentEvent(event, state, 1);
    expect(result).toHaveLength(1);
    expect(result[0].class).toBe('agent_status');
    if (result[0].artifact.type === 'text') {
      expect(result[0].artifact.body).toBe('running');
      expect(result[0].artifact.title).toBe('agent-1');
    }
  });

  it('classifyAgentEvent with child_session_completed returns agent_status with output', () => {
    const state = createInitialRunStateSnapshot(0);
    const event = {
      type: 'child_session_completed' as const,
      timestamp: new Date(0).toISOString(),
      parentSessionId: 'parent-1',
      childSessionId: 'child-a1',
      subtaskId: 'agent-1',
      result: {
        subTaskId: 'agent-1',
        terminalState: 'completed' as const,
        changedFiles: ['src/a.ts'],
        toolCalls: 4,
        finalAnswer: 'Fixed lint error #12 in src/a.ts',
      },
    };
    const result = classifyAgentEvent(event, state, 1);
    expect(result).toHaveLength(1);
    expect(result[0].class).toBe('agent_status');
    if (result[0].artifact.type === 'text') {
      expect(result[0].artifact.body).toContain('Fixed lint error');
      expect(result[0].artifact.title).toContain('returned');
    }
    expect(result[0].metadata.toolCalls).toBe(4);
    expect(result[0].metadata.filesTouched).toContain('src/a.ts');
  });

  it('classifyAgentEvent with child_session_failed returns agent_status with error', () => {
    const state = createInitialRunStateSnapshot(0);
    const event = {
      type: 'child_session_failed' as const,
      timestamp: new Date(0).toISOString(),
      parentSessionId: 'parent-1',
      childSessionId: 'child-a1',
      subtaskId: 'agent-1',
      error: 'Agent crashed',
      partialResult: {
        subTaskId: 'agent-1',
        terminalState: 'model_error' as const,
        changedFiles: [],
        toolCalls: 2,
      },
    };
    const result = classifyAgentEvent(event, state, 1);
    expect(result).toHaveLength(1);
    expect(result[0].class).toBe('agent_status');
    if (result[0].artifact.type === 'text') {
      expect(result[0].artifact.body).toContain('Failed:');
      expect(result[0].artifact.body).toContain('Agent crashed');
    }
  });

  it('child_session_completed without finalAnswer produces agent_status with fallback', () => {
    const state = createInitialRunStateSnapshot(0);
    const event = {
      type: 'child_session_completed' as const,
      timestamp: new Date(0).toISOString(),
      parentSessionId: 'parent-1',
      childSessionId: 'child-a1',
      subtaskId: 'agent-1',
      result: {
        subTaskId: 'agent-1',
        terminalState: 'completed' as const,
        changedFiles: [],
        toolCalls: 0,
      },
    };
    const result = classifyAgentEvent(event, state, 1);
    expect(result).toHaveLength(1);
    expect(result[0].class).toBe('agent_status');
    if (result[0].artifact.type === 'text') {
      expect(result[0].artifact.body).toBeTruthy();
    }
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

describe('dispatch card conciseness', () => {
  it('orchestration_plan_generated returns no visible card', () => {
    const state = createInitialRunStateSnapshot(0);
    const event: Parameters<typeof classifyAgentEvent>[0] = {
      type: 'orchestration_plan_generated' as const,
      timestamp: new Date(0).toISOString(),
      payload: {
        sessionId: 'session-1',
        task: 'Any mission text',
        plan: {
          planId: 'plan-1',
          strategy: 'orchestrate' as const,
          subTasks: [
            {
              id: 'agent-1',
              description: 'Fix src/a.ts',
              estimatedBudget: 1000,
              fileScope: ['src/a.ts'],
              dependencies: [],
              verification: { level: 'none' as const, label: 'none' },
            },
          ],
          estimatedTotalTokens: 1000,
          repoMetadata: { fileCount: 5, totalKB: 50, sourceKB: 40 },
          contextWindowTokens: 131072,
        },
      },
    };
    const result = classifyAgentEvent(event, state, 1);
    // Orchestration plan cards are removed — only dispatch_started creates the header.
    expect(result).toHaveLength(0);
  });

  it('dispatch_started returns compact card with no mission or task descriptions', () => {
    const state = createInitialRunStateSnapshot(0);
    const event: Parameters<typeof classifyAgentEvent>[0] = {
      type: 'dispatch_started' as const,
      timestamp: new Date(0).toISOString(),
      strategy: 'orchestrate',
      agentCount: 2,
      mode: 'parallel',
    };
    const result = classifyAgentEvent(event, state, 1);
    expect(result).toHaveLength(1);
    expect(result[0].class).toBe('dispatch');
    expect(result[0].artifact.type).toBe('text');
    if (result[0].artifact.type === 'text') {
      expect(result[0].artifact.title).toBe('Dispatch · 2 agents · parallel');
      // Body should be empty — no mission, no task descriptions
      expect(result[0].artifact.body).toBe('');
    }
  });

  it('dispatch_started returns compact card for sequential mode', () => {
    const state = createInitialRunStateSnapshot(0);
    const event: Parameters<typeof classifyAgentEvent>[0] = {
      type: 'dispatch_started' as const,
      timestamp: new Date(0).toISOString(),
      strategy: 'orchestrate',
      agentCount: 3,
      mode: 'sequential',
    };
    const result = classifyAgentEvent(event, state, 1);
    expect(result).toHaveLength(1);
    if (result[0].artifact.type === 'text') {
      expect(result[0].artifact.title).toBe('Sequential plan · 3 steps');
      expect(result[0].artifact.body).toBe('');
    }
  });

  it('dispatch_started with 1 agent normalizes to delegated', () => {
    const state = createInitialRunStateSnapshot(0);
    const event: Parameters<typeof classifyAgentEvent>[0] = {
      type: 'dispatch_started' as const,
      timestamp: new Date(0).toISOString(),
      strategy: 'orchestrate',
      agentCount: 1,
      mode: 'parallel',
    };
    const result = classifyAgentEvent(event, state, 1);
    expect(result).toHaveLength(1);
    if (result[0].artifact.type === 'text') {
      expect(result[0].artifact.title).toBe('Delegated · 1 agent');
      expect(result[0].artifact.body).toBe('');
    }
  });
});

describe('result card renderer display', () => {
  it('does not render a duplicate "Result" text when the card title is already "Result"', () => {
    const core = createFakeOpenTuiCore();
    const event = {
      id: 'result-1',
      class: 'tool_result',
      timestamp: 1715731200000,
      artifact: { type: 'text', title: 'Result', body: 'some output' },
      metadata: {},
    } as Parameters<typeof renderArtifactCard>[1];
    const card = renderArtifactCard(core, event) as unknown as FakeOpenTuiNode;
    const text = collectTextContent(card);
    // The card crown already shows "Result" — an inner text node duplicating
    // it would mean the string "Result" appears more than once.
    const resultCount = text.filter((t) => t.trim() === 'Result').length;
    expect(resultCount).toBe(0);
  });

  it('renders "Touched files: N" stat when filesTouched is set in metadata', () => {
    const core = createFakeOpenTuiCore();
    const event = {
      id: 'result-2',
      class: 'tool_result',
      timestamp: 1715731200000,
      artifact: { type: 'text', title: 'some result', body: 'finished work' },
      metadata: { filesTouched: ['src/a.ts', 'src/b.ts'] },
    } as Parameters<typeof renderArtifactCard>[1];
    const card = renderArtifactCard(core, event) as unknown as FakeOpenTuiNode;
    const text = collectTextContent(card).join(' ');
    expect(text).toContain('Touched files: 2');
    expect(text).not.toMatch(/\bFiles\s+2\b/);
  });

  it('omits the "Touched files" stat when filesTouched is empty', () => {
    const core = createFakeOpenTuiCore();
    const event = {
      id: 'result-3',
      class: 'tool_result',
      timestamp: 1715731200000,
      artifact: { type: 'text', title: 'some result', body: 'finished work' },
      metadata: {},
    } as Parameters<typeof renderArtifactCard>[1];
    const card = renderArtifactCard(core, event) as unknown as FakeOpenTuiNode;
    const text = collectTextContent(card).join(' ');
    expect(text).not.toContain('Touched files');
  });
});

describe('subagent result card visual semantics', () => {
  it('completed subagent card uses info/cyan color, not success/green', () => {
    const core = createFakeOpenTuiCore();
    const event = {
      id: 'sub-agent-returned',
      class: 'agent_status' as const,
      timestamp: 1715731200000,
      artifact: { type: 'text', title: 'step-1 returned', body: 'done' },
      metadata: { toolCalls: 2, filesTouched: ['a.ts'] },
    } as Parameters<typeof renderArtifactCard>[1];
    const card = renderArtifactCard(core, event) as unknown as FakeOpenTuiNode;

    // The completed agent_status card uses pal.info (#8be9fd cyan) not pal.success (#00ff87 green)
    const colorBar = card.children[0] as FakeOpenTuiNode;
    expect(colorBar.props.backgroundColor).toBe('#8be9fd');
    // Card crown header shows the subagent name, not generic "Result"
    const cardBody = card.children[1] as FakeOpenTuiNode;
    const crown = cardBody.children[0] as FakeOpenTuiNode;
    expect(String(crown.props.content)).toContain('step-1 returned');
    // Full cards are shaded (background surface), not bordered with box-drawing glyphs
    expect(cardBody.props.border).toBeUndefined();
    expect(cardBody.props.backgroundColor).toBeDefined();
  });

  it('final all-success result card remains success/green', () => {
    const core = createFakeOpenTuiCore();
    const event = {
      id: 'final-result',
      class: 'tool_result' as const,
      timestamp: 1715731200000,
      artifact: { type: 'text', title: 'Result', body: 'Status: completed\nAll sub-tasks done.' },
      metadata: {},
    } as Parameters<typeof renderArtifactCard>[1];
    const card = renderArtifactCard(core, event) as unknown as FakeOpenTuiNode;

    // The final result card uses pal.success (#00ff87 green)
    const colorBar = card.children[0] as FakeOpenTuiNode;
    expect(colorBar.props.backgroundColor).toBe('#00ff87');
  });

  it('failed agent_status card uses error/red color', () => {
    const core = createFakeOpenTuiCore();
    const event = {
      id: 'sub-agent-failed',
      class: 'agent_status' as const,
      timestamp: 1715731200000,
      artifact: { type: 'text', title: 'step-1', body: 'Failed: timed out' },
      metadata: {},
    } as Parameters<typeof renderArtifactCard>[1];
    const card = renderArtifactCard(core, event) as unknown as FakeOpenTuiNode;

    // Failed agent_status uses pal.error (#ff5555 red)
    const colorBar = card.children[0] as FakeOpenTuiNode;
    expect(colorBar.props.backgroundColor).toBe('#ff5555');
  });
});

describe('event sink stale card filter', () => {
  it('filters out a running agent_status card when a matching child_session_completed arrives', () => {
    const state = createInitialRunStateSnapshot(0);
    // Simulate what the event sink does: classify spawned → gets "running" card
    const spawned: Parameters<typeof classifyAgentEvent>[0] = {
      type: 'child_session_spawned' as const,
      timestamp: new Date(0).toISOString(),
      parentSessionId: 'p1',
      childSessionId: 'c1',
      subtaskId: 'agent-x',
    };
    const completed: Parameters<typeof classifyAgentEvent>[0] = {
      type: 'child_session_completed' as const,
      timestamp: new Date(100).toISOString(),
      parentSessionId: 'p1',
      childSessionId: 'c1',
      subtaskId: 'agent-x',
      result: {
        subTaskId: 'agent-x',
        terminalState: 'completed' as const,
        changedFiles: [],
        toolCalls: 2,
        finalAnswer: 'done',
      },
    };

    const runningEvents = classifyAgentEvent(spawned, state, 1);
    const completedEvents = classifyAgentEvent(completed, state, 101);
    const allEvents = [...runningEvents, ...completedEvents];

    // Apply the same filter the event sink uses
    const label = 'agent-x';
    const filtered = allEvents.filter(
      (ev) =>
        !(
          ev.class === 'agent_status' &&
          ev.artifact.type === 'text' &&
          ev.artifact.title === label &&
          ev.artifact.body === 'running'
        ),
    );

    // Should still have the "returned" card but not the "running" card
    expect(filtered).toHaveLength(1);
    expect(filtered[0].artifact).toEqual(
      expect.objectContaining({ type: 'text', title: expect.stringContaining('returned') }),
    );
  });

  it('filters out running card when child_session_failed arrives', () => {
    const state = createInitialRunStateSnapshot(0);
    const spawned: Parameters<typeof classifyAgentEvent>[0] = {
      type: 'child_session_spawned' as const,
      timestamp: new Date(0).toISOString(),
      parentSessionId: 'p1',
      childSessionId: 'c2',
      subtaskId: 'agent-y',
    };
    const failed: Parameters<typeof classifyAgentEvent>[0] = {
      type: 'child_session_failed' as const,
      timestamp: new Date(100).toISOString(),
      parentSessionId: 'p1',
      childSessionId: 'c2',
      subtaskId: 'agent-y',
      error: 'timed out',
      partialResult: {
        subTaskId: 'agent-y',
        terminalState: 'model_error' as const,
        changedFiles: [],
        toolCalls: 1,
      },
    };

    const runningEvents = classifyAgentEvent(spawned, state, 1);
    const failedEvents = classifyAgentEvent(failed, state, 101);
    const allEvents = [...runningEvents, ...failedEvents];

    const label = 'agent-y';
    const filtered = allEvents.filter(
      (ev) =>
        !(
          ev.class === 'agent_status' &&
          ev.artifact.type === 'text' &&
          ev.artifact.title === label &&
          ev.artifact.body === 'running'
        ),
    );

    expect(filtered).toHaveLength(1);
    if (filtered[0].artifact.type === 'text') {
      expect(filtered[0].artifact.body).toContain('Failed:');
    }
  });

  it('does not filter out running cards for a different sub-agent', () => {
    const state = createInitialRunStateSnapshot(0);
    const spawnedA: Parameters<typeof classifyAgentEvent>[0] = {
      type: 'child_session_spawned' as const,
      timestamp: new Date(0).toISOString(),
      parentSessionId: 'p1',
      childSessionId: 'c-a',
      subtaskId: 'agent-a',
    };
    const spawnedB: Parameters<typeof classifyAgentEvent>[0] = {
      type: 'child_session_spawned' as const,
      timestamp: new Date(0).toISOString(),
      parentSessionId: 'p1',
      childSessionId: 'c-b',
      subtaskId: 'agent-b',
    };
    const completedA: Parameters<typeof classifyAgentEvent>[0] = {
      type: 'child_session_completed' as const,
      timestamp: new Date(100).toISOString(),
      parentSessionId: 'p1',
      childSessionId: 'c-a',
      subtaskId: 'agent-a',
      result: {
        subTaskId: 'agent-a',
        terminalState: 'completed' as const,
        changedFiles: [],
        toolCalls: 1,
        finalAnswer: 'done a',
      },
    };

    const eventsA = classifyAgentEvent(spawnedA, state, 1);
    const eventsB = classifyAgentEvent(spawnedB, state, 2);
    const eventsCompleted = classifyAgentEvent(completedA, state, 101);
    const allEvents = [...eventsA, ...eventsB, ...eventsCompleted];

    // Filter out agent-a's running card (label = 'agent-a')
    const label = 'agent-a';
    const filtered = allEvents.filter(
      (ev) =>
        !(
          ev.class === 'agent_status' &&
          ev.artifact.type === 'text' &&
          ev.artifact.title === label &&
          ev.artifact.body === 'running'
        ),
    );

    // agent-b's running card should survive
    const runningB = filtered.filter(
      (ev) => ev.class === 'agent_status' && ev.artifact.type === 'text' && ev.artifact.body === 'running',
    );
    expect(runningB).toHaveLength(1);
    expect(runningB[0].artifact.type === 'text' ? runningB[0].artifact.title : '').toBe('agent-b');
  });
});

describe('autocomplete context detection', () => {
  it('detects slash command context', () => {
    expect(detectCompletionContext('/set', 4).kind).toBe('slash_command');
    expect(detectCompletionContext('/settings', 9).kind).toBe('slash_command');
    expect(detectCompletionContext('/', 1).kind).toBe('slash_command');
  });

  it('detects model name context after /model', () => {
    expect(detectCompletionContext('/model qw', 9).kind).toBe('model_name');
    expect(detectCompletionContext('/models qwe', 11).kind).toBe('model_name');
  });

  it('detects path token context', () => {
    expect(detectCompletionContext('./src', 5).kind).toBe('path');
    expect(detectCompletionContext('/usr/bin', 8).kind).toBe('path');
    expect(detectCompletionContext('../lib', 6).kind).toBe('path');
  });

  it('detects @-mention context', () => {
    expect(detectCompletionContext('@read', 5).kind).toBe('at_mention');
    expect(detectCompletionContext('@src/index', 10).kind).toBe('at_mention');
  });

  it('returns none for plain text', () => {
    expect(detectCompletionContext('hello', 5).kind).toBe('none');
    expect(detectCompletionContext('', 0).kind).toBe('none');
  });

  it('detects model name after /model even when token does not start with /', () => {
    // Input: "/model qwen" with cursor at position 10 (on "qwen")
    // The token "qwen" doesn't start with /, but the preceding word is "/model"
    const ctx = detectCompletionContext('/model qwen', 10);
    expect(ctx.kind).toBe('model_name');
    if (ctx.kind === 'model_name') {
      expect(ctx.prefix).toBe('qwen');
    }
  });
});

describe('autocomplete word boundary', () => {
  it('finds word at cursor', () => {
    expect(getWordAtCursor('hello world', 0)).toEqual({ start: 0, end: 5 });
    expect(getWordAtCursor('hello world', 4)).toEqual({ start: 0, end: 5 });
    expect(getWordAtCursor('hello world', 6)).toEqual({ start: 6, end: 11 });
    expect(getWordAtCursor('hello world', 11)).toEqual({ start: 6, end: 11 });
  });

  it('handles cursor at end of word', () => {
    expect(getWordAtCursor('/model qwen', 11)).toEqual({ start: 7, end: 11 });
  });
});

describe('autocomplete token helpers', () => {
  it('identifies path tokens', () => {
    expect(isPathToken('/usr/bin')).toBe(true);
    expect(isPathToken('./src')).toBe(true);
    expect(isPathToken('../lib')).toBe(true);
    expect(isPathToken('~/docs')).toBe(true);
    expect(isPathToken('plain')).toBe(false);
    expect(isPathToken('@file')).toBe(false);
  });

  it('identifies @-mention tokens', () => {
    expect(isAtMention('@file')).toBe(true);
    expect(isAtMention('@src/index')).toBe(true);
    expect(isAtMention('@a')).toBe(true);
    expect(isAtMention('@')).toBe(false);
    expect(isAtMention('plain')).toBe(false);
    expect(isAtMention('@file path')).toBe(false);
  });
});

describe('autocomplete getPathCompletions', () => {
  const cwd = process.cwd();

  it('returns completions for relative paths', () => {
    const result = getPathCompletions('./src/', 5, cwd);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.from).toBeLessThanOrEqual(result.to);
      // All items should start with './src/'
      for (const item of result.items) {
        expect(item).toContain('./src/');
      }
    }
  });

  it('returns null for non-path tokens', () => {
    expect(getPathCompletions('hello', 5, cwd)).toBeNull();
    expect(getPathCompletions('', 0, cwd)).toBeNull();
  });

  it('returns null for non-existent directories', () => {
    expect(getPathCompletions('/nonexistent/path/', 18, cwd)).toBeNull();
  });
});

describe('autocomplete collectModelNames', () => {
  it('returns empty array for undefined config', () => {
    expect(collectModelNames(undefined)).toEqual([]);
  });

  it('collects model IDs from config providers', () => {
    const config: EffectiveSynaxConfig = {
      active: { provider: 'relay', model: 'qwen-local', thinking: 'off' },
      providers: {
        relay: {
          id: 'relay',
          name: 'Relay',
          compatibility: 'openai-compatible' as const,
          enabled: true,
          baseUrl: 'http://localhost:8080',
          apiKey: 'sk-test',
          headers: {},
          models: [
            { id: 'qwen-local', supportsThinking: false, thinkingLevels: [] },
            { id: 'deepseek-coder', supportsThinking: false, thinkingLevels: [] },
            { id: 'llama3', supportsThinking: false, thinkingLevels: [] },
          ],
        },
      },
      skills: { enabled: [], disabled: [] },
      mcp: { servers: {} },
      source: null,
      errors: [],
    };
    const names = collectModelNames(config);
    expect(names).toContain('qwen-local');
    expect(names).toContain('deepseek-coder');
    expect(names).toContain('llama3');
  });

  it('deduplicates model IDs across providers', () => {
    const config: EffectiveSynaxConfig = {
      active: { provider: 'relay', model: 'qwen', thinking: 'off' },
      providers: {
        relay: {
          id: 'relay',
          name: 'Relay',
          compatibility: 'openai-compatible' as const,
          enabled: true,
          baseUrl: 'http://localhost:8080',
          apiKey: 'sk-test',
          headers: {},
          models: [{ id: 'qwen', supportsThinking: false, thinkingLevels: [] }],
        },
        openai: {
          id: 'openai',
          name: 'OpenAI',
          compatibility: 'openai-compatible' as const,
          enabled: true,
          baseUrl: 'https://api.openai.com',
          apiKey: 'sk-other',
          headers: {},
          models: [{ id: 'qwen', supportsThinking: false, thinkingLevels: [] }],
        },
      },
      skills: { enabled: [], disabled: [] },
      mcp: { servers: {} },
      source: null,
      errors: [],
    };
    const names = collectModelNames(config);
    expect(names).toEqual(['qwen']);
  });
});

describe('autocomplete getCompletions dispatch', () => {
  const cwd = process.cwd();
  const repoRoot = process.cwd();

  it('returns slash command completions for /-prefixed input', () => {
    const result = getCompletions('/set', 4, cwd, repoRoot);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.kind).toBe('slash_command');
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.some((item: string) => item.startsWith('/settings'))).toBe(true);
    }
  });

  it('returns path completions for path-like tokens', () => {
    const result = getCompletions('./src/', 5, cwd, repoRoot);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('path');
  });

  it('returns null for plain non-path text', () => {
    const result = getCompletions('hello world', 5, cwd, repoRoot);
    expect(result).toBeNull();
  });
});
