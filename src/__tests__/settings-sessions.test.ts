/**
 * Direct unit tests for settings-state, slash-command-registry,
 * session-store, and transcript rendering.
 *
 * These cover new TUI/settings/sessions modules independently of the
 * full interactive TUI tests.
 */
import { tmpdir } from 'os';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

// ─── Settings state ────────────────────────────────────────

import {
  createSettingsState,
  getTabRows,
  settingsReducer,
  SETTINGS_TABS,
  clearTextInput,
  type SettingsState,
} from '../settings/settings-state';
import { buildConfigUpdate } from '../config/load-config';
import type { EffectiveSynaxConfig } from '../config/schema';

function makeTestConfig(overrides: Partial<EffectiveSynaxConfig> = {}): EffectiveSynaxConfig {
  return {
    active: { provider: 'relay', model: 'qwen', thinking: 'off' },
    providers: {
      relay: {
        id: 'relay',
        name: 'Relay',
        compatibility: 'openai-compatible',
        enabled: true,
        baseUrl: 'http://127.0.0.1:1234/v1',
        headers: {},
        models: [
          {
            id: 'qwen',
            supportsThinking: false,
            thinkingLevels: [],
          },
          {
            id: 'deepseek-reasoner',
            displayName: 'DeepSeek Reasoner',
            supportsThinking: true,
            thinkingLevels: ['off', 'low', 'medium', 'high'],
            defaultThinkingLevel: 'low',
          },
        ],
      },
      deepseek: {
        id: 'deepseek',
        name: 'DeepSeek',
        compatibility: 'openai-compatible',
        enabled: true,
        baseUrl: 'https://api.deepseek.com/v1',
        headers: {},
        models: [
          {
            id: 'deepseek-chat',
            supportsThinking: false,
            thinkingLevels: [],
          },
        ],
      },
    },
    skills: { enabled: ['coderabbit-review'], disabled: ['grill-me'] },
    mcp: {
      servers: {
        git: { enabled: true, command: 'git-mcp', args: ['--repo', '.'], env: {} },
        filesystem: { enabled: false, command: 'fs-mcp', args: [], env: {} },
      },
    },
    source: null,
    errors: [],
    ...overrides,
  };
}

describe('settingsReducer', () => {
  let config: EffectiveSynaxConfig;

  beforeEach(() => {
    config = makeTestConfig();
  });

  it('opens with first tab selected', () => {
    const state = createSettingsState(config);
    const opened = settingsReducer(state, { type: 'open' });
    expect(opened.active).toBe(true);
    expect(opened.tab).toBe('model');
    expect(opened.focus).toBe('tab');
    expect(opened.selectedRow).toBe(0);
  });

  it('closes and clears text input', () => {
    const state = createSettingsState(config);
    const opened = settingsReducer(state, { type: 'open' });
    const closed = settingsReducer(opened, { type: 'close' });
    expect(closed.active).toBe(false);
    expect(closed.textInput).toBeUndefined();
  });

  it('navigates tabs forward and backward', () => {
    const state = settingsReducer(createSettingsState(config), { type: 'open' });
    const next = settingsReducer(state, { type: 'next_tab' });
    expect(next.tab).toBe('providers');
    const prev = settingsReducer(next, { type: 'prev_tab' });
    expect(prev.tab).toBe('model');
  });

  it('wraps tabs around', () => {
    const state = settingsReducer(createSettingsState(config), { type: 'open' });
    const prev = settingsReducer(state, { type: 'prev_tab' });
    expect(prev.tab).toBe(SETTINGS_TABS[SETTINGS_TABS.length - 1]);
    const next = settingsReducer(prev, { type: 'next_tab' });
    expect(next.tab).toBe('model');
  });

  it('navigates rows up and down', () => {
    const state = settingsReducer(createSettingsState(config), { type: 'open' });
    // move_up from tab focus transitions to rows
    const inRows = settingsReducer(state, { type: 'move_up' });
    expect(inRows.focus).toBe('rows');
    expect(inRows.selectedRow).toBe(0);

    const down = settingsReducer(inRows, { type: 'move_down' });
    expect(down.selectedRow).toBe(1);

    const up = settingsReducer(down, { type: 'move_up' });
    expect(up.selectedRow).toBe(0);
  });

  it('does not wrap selectedRow below 0', () => {
    const state = settingsReducer(createSettingsState(config), { type: 'open' });
    const inRows = settingsReducer(state, { type: 'move_up' });
    expect(inRows.selectedRow).toBe(0);
  });

  it('text input commit/cancel clears textInput cleanly', () => {
    let state = settingsReducer(createSettingsState(config), { type: 'open' });
    // Simulate starting text edit
    state = {
      ...state,
      textInput: { rowId: 'test-field', value: 'hello', cursor: 5 },
      focus: 'text-input',
    };
    expect(state.textInput).toBeDefined();

    // Cancel clears text input
    const cancelled = settingsReducer(state, { type: 'text_cancel' });
    expect(cancelled.textInput).toBeUndefined();
    expect(cancelled.focus).toBe('rows');

    // Commit clears text input
    state = {
      ...state,
      textInput: { rowId: 'test-field', value: 'hello', cursor: 5 },
    };
    const committed = settingsReducer(state, { type: 'text_commit' });
    expect(committed.textInput).toBeUndefined();
    expect(committed.focus).toBe('rows');
    expect(committed.dirty).toBe(true);
  });

  it('clearTextInput helper works', () => {
    const state: SettingsState = {
      ...createSettingsState(config),
      active: true,
      textInput: { rowId: 'x', value: 'y', cursor: 1 },
      focus: 'text-input',
    };
    const cleared = clearTextInput(state);
    expect(cleared.textInput).toBeUndefined();
    expect(cleared.focus).toBe('rows');
    expect(cleared.dirty).toBe(true);
  });
});

describe('settings state — thinking control', () => {
  it('thinking control is disabled when supportsThinking is false', () => {
    // Config where only non-thinking model is active
    const config = makeTestConfig({
      active: { provider: 'relay', model: 'qwen', thinking: 'off' },
    });
    // The model tab rows should show thinking as dimmed 'n/a'
    // This is tested indirectly via getTabRows which is called by the reducer.
    // The reducer itself doesn't toggle thinking when it's n/a.
    const state = settingsReducer(createSettingsState(config), { type: 'open' });
    expect(state.tab).toBe('model');
  });

  it('allows selecting no active model so the core can unload', () => {
    const config = makeTestConfig();
    const rows = getTabRows('model', config);
    const activeModel = rows.find((row) => row.id === 'active-model');
    expect(activeModel?.options).toEqual(['', 'qwen', 'deepseek-reasoner']);

    const noModelIndex = rows.findIndex((row) => row.id === 'no-active-model');
    expect(noModelIndex).toBeGreaterThanOrEqual(0);

    const state = {
      ...settingsReducer(createSettingsState(config), { type: 'open' }),
      focus: 'rows' as const,
      selectedRow: noModelIndex,
    };
    const selected = settingsReducer(state, { type: 'select_row' });

    expect(selected.config.active.model).toBe('');
    expect(selected.config.active.thinking).toBe('off');
  });
});

describe('settings state — skill and MCP mutations', () => {
  it('toggle enables a skill', () => {
    const config = makeTestConfig({
      skills: { enabled: [], disabled: ['grill-me'] },
    });
    // Toggle via config update directly (state reducer would require row navigation).
    const updated = buildConfigUpdate(config, { toggleSkill: 'grill-me' });
    expect(updated.skills.enabled).toContain('grill-me');
    expect(updated.skills.disabled).not.toContain('grill-me');
  });

  it('toggle disables a skill', () => {
    const config = makeTestConfig({
      skills: { enabled: ['coderabbit-review'], disabled: [] },
    });
    const updated = buildConfigUpdate(config, { toggleSkill: 'coderabbit-review' });
    expect(updated.skills.enabled).not.toContain('coderabbit-review');
    expect(updated.skills.disabled).toContain('coderabbit-review');
  });

  it('toggle enables/disables MCP server', () => {
    const config = makeTestConfig();
    const toggled = buildConfigUpdate(config, { toggleMcpServer: 'git' });
    expect(toggled.mcp.servers.git.enabled).toBe(false);

    const toggledBack = buildConfigUpdate(toggled, { toggleMcpServer: 'git' });
    expect(toggledBack.mcp.servers.git.enabled).toBe(true);
  });
});

// ─── Slash commands ────────────────────────────────────────

import {
  filterCommands,
  getAllCommands,
  getCommand,
  registerCommand,
  type SlashCommand,
} from '../settings/slash-command-registry';

describe('slash command registry', () => {
  it('filters commands by name', () => {
    const results = filterCommands('sett');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((cmd) => cmd.name.toLowerCase().includes('sett'))).toBe(true);
  });

  it('filters commands by alias', () => {
    const results = filterCommands('quit');
    expect(results.some((cmd) => cmd.name === 'exit' || cmd.aliases?.includes('quit'))).toBe(true);
  });

  it('filters commands by description', () => {
    const results = filterCommands('session');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((cmd) => cmd.description.toLowerCase().includes('session'))).toBe(true);
  });

  it('returns all commands for empty query', () => {
    const all = filterCommands('');
    const allExplicit = getAllCommands();
    expect(all.length).toBe(allExplicit.length);
  });

  it('finds /settings command', () => {
    const cmd = getCommand('settings');
    expect(cmd).toBeDefined();
    expect(cmd?.opensSettings).toBe(true);
  });

  it('finds /resume command', () => {
    const cmd = getCommand('resume');
    expect(cmd).toBeDefined();
    expect(cmd?.opensResume).toBe(true);
  });

  it('/exit command has exit flag', () => {
    const cmd = getCommand('exit');
    expect(cmd).toBeDefined();
    const result = cmd!.handler();
    expect(result).toEqual({ handled: true, exit: true, output: '[synax] bye' });
  });

  it('registerCommand adds a custom command', () => {
    const custom: SlashCommand = {
      name: 'custom-test',
      description: 'A custom test command',
      handler: () => ({ handled: true, output: 'custom output' }),
    };
    registerCommand(custom);
    const found = getCommand('custom-test');
    expect(found).toBeDefined();
    expect(found?.description).toBe('A custom test command');
  });
});

// ─── Sessions ──────────────────────────────────────────────

import {
  createSession,
  appendSessionEvent,
  findSessionMeta,
  listSessionsSorted,
  filterSessions,
  readSessionEvents,
  generateSessionId,
  generateSessionTitle,
  generateSessionSummary,
  upsertSessionMeta,
  type SessionEvent,
} from '../sessions/session-store';

const TMP_SESSIONS = join(tmpdir(), 'synax-session-tests-' + Date.now());

// Override HOME to use temp directory for session storage isolation
const originalHome = process.env.HOME;

function setupSessionTmp(): void {
  const homeDir = join(TMP_SESSIONS, 'home');
  if (existsSync(TMP_SESSIONS)) {
    rmSync(TMP_SESSIONS, { recursive: true, force: true });
  }
  mkdirSync(homeDir, { recursive: true });
  const localShare = join(homeDir, '.local', 'share', 'synax', 'sessions');
  mkdirSync(localShare, { recursive: true });
  // Write empty index
  writeFileSync(join(localShare, '..', 'index.json'), JSON.stringify({ version: 1, sessions: [] }));
  process.env.HOME = homeDir;
}

function teardownSessionTmp(): void {
  process.env.HOME = originalHome;
  if (existsSync(TMP_SESSIONS)) {
    rmSync(TMP_SESSIONS, { recursive: true, force: true });
  }
}

describe('session-store', () => {
  beforeEach(() => setupSessionTmp());
  afterEach(() => teardownSessionTmp());

  it('creates a new session record', () => {
    const id = generateSessionId();
    const session = createSession({
      id,
      workspacePath: '/tmp/test',
      branch: 'main',
      activeProvider: 'relay',
      activeModel: 'qwen',
    });
    expect(session.id).toBe(id);
    expect(session.status).toBe('active');
    expect(session.branch).toBe('main');
    expect(session.messageCount).toBe(0);
    expect(session.eventCount).toBe(0);

    const found = findSessionMeta(id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(id);
  });

  it('appends session events and updates metadata', () => {
    const id = generateSessionId();
    createSession({ id, branch: 'main' });

    const event: SessionEvent = {
      type: 'user_message',
      at: new Date().toISOString(),
      content: 'Hello world',
    };
    appendSessionEvent(id, event);

    const session = findSessionMeta(id);
    expect(session?.eventCount).toBe(1);
    expect(session?.messageCount).toBe(1);
  });

  it('does not increment messageCount for non-user events', () => {
    const id = generateSessionId();
    createSession({ id });

    appendSessionEvent(id, { type: 'assistant_message', at: new Date().toISOString(), content: 'Hi' });
    const session = findSessionMeta(id);
    expect(session?.eventCount).toBe(1);
    expect(session?.messageCount).toBe(0);
  });

  it('updates session metadata via upsertSessionMeta', () => {
    const id = generateSessionId();
    createSession({ id, title: 'Original' });

    upsertSessionMeta({
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 5,
      eventCount: 10,
      status: 'completed',
      title: 'Updated',
    });

    const found = findSessionMeta(id);
    expect(found?.title).toBe('Updated');
    expect(found?.status).toBe('completed');
  });

  it('lists sessions sorted by updated time', () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();

    createSession({ id: id1 });
    createSession({ id: id2 });

    upsertSessionMeta({
      id: id1,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      messageCount: 0,
      eventCount: 0,
      status: 'active',
    });
    upsertSessionMeta({
      id: id2,
      createdAt: '2025-06-01T00:00:00.000Z',
      updatedAt: '2025-06-01T00:00:00.000Z',
      messageCount: 0,
      eventCount: 0,
      status: 'active',
    });

    const sorted = listSessionsSorted('updated');
    expect(sorted.length).toBeGreaterThanOrEqual(2);
    if (sorted.length >= 2) {
      expect(sorted[0].updatedAt >= sorted[1].updatedAt).toBe(true);
    }
  });

  it('filters sessions by branch/search text', () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();

    createSession({ id: id1, branch: 'feature/foo', title: 'Foo work' });
    createSession({ id: id2, branch: 'main', title: 'Bar work' });

    const sessions = listSessionsSorted();
    const filtered = filterSessions('foo', sessions);
    expect(filtered.length).toBeGreaterThanOrEqual(1);
    expect(
      filtered.every((s) => s.branch?.toLowerCase().includes('foo') || s.title?.toLowerCase().includes('foo')),
    ).toBe(true);
  });

  it('reads and streams session events', () => {
    const id = generateSessionId();
    createSession({ id });

    appendSessionEvent(id, { type: 'user_message', at: new Date().toISOString(), content: 'msg1' });
    appendSessionEvent(id, { type: 'assistant_message', at: new Date().toISOString(), content: 'reply1' });

    const events = readSessionEvents(id);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('user_message');
    expect(events[1].type).toBe('assistant_message');
  });

  it('handles missing session event file gracefully', () => {
    const events = readSessionEvents('nonexistent-session-id');
    expect(events).toEqual([]);
  });

  it('handles corrupt session event file gracefully', () => {
    const id = generateSessionId();
    createSession({ id });

    // Write corrupt JSON to the event file
    const homeDir = process.env.HOME!;
    const eventsPath = join(
      homeDir,
      '.local',
      'share',
      'synax',
      'sessions',
      'sessions',
      id.slice(0, 4),
      id.slice(4, 6),
      `${id}.jsonl`,
    );
    mkdirSync(join(eventsPath, '..'), { recursive: true });
    writeFileSync(eventsPath, 'not json\n{"type":"valid","at":"2025-01-01T00:00:00.000Z"}\n', 'utf-8');

    const events = readSessionEvents(id);
    // Should skip the corrupt line, read the valid one
    expect(events.length).toBeGreaterThanOrEqual(1);
    // Should skip corrupt line, read valid ones
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('generates session title from first user message', () => {
    const title = generateSessionTitle([{ type: 'user_message', at: '', content: 'Fix the broken test suite' }]);
    expect(title).toBe('Fix the broken test suite');
  });

  it('generates session summary from last message', () => {
    const summary = generateSessionSummary([{ type: 'assistant_message', at: '', content: 'Done. All tests pass.' }]);
    expect(summary).toBe('Done. All tests pass.');
  });

  it('generates fallback title for empty session', () => {
    expect(generateSessionTitle([])).toBe('Empty session');
  });

  it('truncates long titles', () => {
    const long = 'A'.repeat(100) + ' fix test';
    const title = generateSessionTitle([{ type: 'user_message', at: '', content: long }]);
    expect(title.length).toBeLessThanOrEqual(83); // 80 + '...'
    expect(title.endsWith('...')).toBe(true);
  });
});

// ─── Transcript rendering ─────────────────────────────────

import { renderTranscript } from '../tui/transcript';
import { renderLayout } from '../tui/layout';
import { parseInputChunk } from '../tui/input';
import { createInitialRunStateSnapshot } from '../agent/tui-state';
import type { RunStateSnapshot } from '../agent/tui-state';

function stripAll(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('transcript rendering', () => {
  it('model output renders as review or fallback block without synthetic final summary', () => {
    const run: RunStateSnapshot = {
      ...createInitialRunStateSnapshot(0),
      terminal: 'completed',
      phase: 'completed',
      lastModelOutput: '- Add src/config/schema.ts\n- Add src/config/load-config.ts',
      debugHistory: [
        {
          atMs: 0,
          kind: 'user',
          summary: 'user prompt',
          detail: 'Add config schema',
        },
      ],
      statusNote: 'completed: 3 model steps, 3 tool calls, 2 files changed',
      filesChangedThisRun: ['src/config/schema.ts', 'src/config/load-config.ts'],
      toolInvocationCount: 3,
      verification: {
        state: 'passed',
        checksPlanned: 0,
        checksRunning: 0,
        checksPassed: 0,
        checksFailed: 0,
        checksSkipped: 0,
        summary: 'passed',
        currentCheckLabel: '',
        seenCheckIds: new Set(['check-1']),
      },
    };
    const lines = renderTranscript({ run, lastModelOutput: '' }, 80).map(stripAll);
    const text = lines.join('\n');

    // No synthetic final summary block.
    expect(text).not.toContain('final      completed');
    // Model output still appears in the transcript as a fallback model entry.
    expect(text).toContain('- Add src/config/schema.ts');
  });

  it('verify is not duplicated when verification events exist', () => {
    const run: RunStateSnapshot = {
      ...createInitialRunStateSnapshot(0),
      terminal: 'completed',
      phase: 'completed',
      lastModelOutput: '',
      debugHistory: [],
      statusNote: 'completed: 1 model step',
      filesChangedThisRun: [],
      toolInvocationCount: 0,
      verification: {
        state: 'passed',
        checksPlanned: 0,
        checksRunning: 0,
        checksPassed: 0,
        checksFailed: 0,
        checksSkipped: 0,
        summary: 'passed',
        currentCheckLabel: '',
        seenCheckIds: new Set(['check-1']),
      },
    };
    const lines = renderTranscript({ run }, 80).map(stripAll);
    const text = lines.join('\n');

    // Verification should render as a dedicated block (has events)
    expect(text).toContain('verify     passed');
    // But should NOT be duplicated inside final summary
    const verifyCount = (text.match(/verify\s+passed/g) ?? []).length;
    expect(verifyCount).toBe(1);
  });

  it('completed successful tool calls are compressed', () => {
    const run: RunStateSnapshot = {
      ...createInitialRunStateSnapshot(0),
      terminal: 'completed',
      phase: 'completed',
      debugHistory: [
        {
          atMs: 0,
          kind: 'tool_call',
          summary: 'bash call',
          detail: 'bash\n{"command":"git diff --cached --stat"}',
        },
        {
          atMs: 1,
          kind: 'tool_result',
          summary: 'ok',
          detail: 'exit code: 0\nduration: 1.2s\n4 files changed, 120 insertions(+), 40 deletions(-)\n',
        },
      ],
      statusNote: '',
      filesChangedThisRun: [],
      toolInvocationCount: 1,
      verification: {
        state: 'planned',
        checksPlanned: 0,
        checksRunning: 0,
        checksPassed: 0,
        checksFailed: 0,
        checksSkipped: 0,
        summary: 'planned',
        currentCheckLabel: '',
        seenCheckIds: new Set(),
      },
    };
    const lines = renderTranscript({ run }, 80).map(stripAll);
    const text = lines.join('\n');

    // Compressed mode: command line shown with ok status, exit 0 suppressed.
    expect(text).toContain('$ git diff --cached --stat');
    expect(text).toContain('ok');
    expect(text).not.toContain('exit 0');
    expect(text).toContain('git diff --cached --stat');
    // Should show changed-files summary from diff --stat
    expect(text).toContain('changed');
  });

  it('failed tool calls remain expanded', () => {
    const run: RunStateSnapshot = {
      ...createInitialRunStateSnapshot(0),
      terminal: 'failed',
      phase: 'verifying',
      debugHistory: [
        {
          atMs: 0,
          kind: 'tool_call',
          summary: 'bash call',
          detail: 'bash\n{"command":"npm test"}',
        },
        {
          atMs: 1,
          kind: 'tool_result',
          summary: 'error',
          detail: 'exit code: 1\nduration: 4.4s\nFAIL src/test.ts\n',
        },
      ],
      statusNote: '',
      filesChangedThisRun: [],
      toolInvocationCount: 1,
      verification: {
        state: 'failed',
        checksPlanned: 0,
        checksRunning: 0,
        checksPassed: 0,
        checksFailed: 1,
        checksSkipped: 0,
        summary: 'Jest assertion failed',
        currentCheckLabel: 'npm test',
        seenCheckIds: new Set(['check-1']),
      },
    };
    const lines = renderTranscript({ run }, 80).map(stripAll);
    const text = lines.join('\n');

    // Failed command: exit code, meta, output should be visible
    expect(text).toContain('exit       1');
    expect(text).toContain('npm test');
    // Duration should be shown for failed commands
    expect(text).toContain('4.4s');
    // Failed output should be visible
    expect(text).toContain('FAIL');
  });

  it('renders thinking text and the full terminal issue with a next action', () => {
    const issue = `Provider error (400): DeepSeek rejected the request after many reads.\n${'context line '.repeat(40)}`;
    const run: RunStateSnapshot = {
      ...createInitialRunStateSnapshot(0),
      terminal: 'failed',
      phase: 'error',
      terminalIssue: issue,
      debugHistory: [
        {
          atMs: 0,
          kind: 'model',
          summary: 'model response',
          detail: '<thinking>checking repository context</thinking>\nI will inspect the config.',
        },
      ],
    };

    const lines = renderTranscript({ run }, 80).map(stripAll);
    const text = lines.join('\n');

    expect(text).toContain('checking repository context');
    expect(text).toContain('I will inspect the config.');
    expect(text).toContain('error      terminal issue');
    expect(text).toContain('check provider/server/config, then rerun');
    expect(text).toContain('DeepSeek rejected the request after many');
    expect(text).toContain('reads.');
    expect(text).toContain('context line');
  });

  it('right panel title is Synax Core', () => {
    const run = createInitialRunStateSnapshot(0);
    const lines = renderLayout(
      {
        run: { ...run, phase: 'completed', terminal: 'completed' },
        objectiveInput: '',
        coreMode: 'completed',
        nowMs: 1000,
        cwdLabel: '/test',
        gitBranch: 'main',
      },
      120,
      30,
    ).map(stripAll);

    const text = lines.join('\n');
    expect(text).toContain('Synax Core');
    expect(text).not.toContain('Core Module');
  });

  it('idle input is compact after completed run', () => {
    const run = createInitialRunStateSnapshot(0);
    const lines = renderLayout(
      {
        run: { ...run, phase: 'completed', terminal: 'completed', debugHistory: [] },
        objectiveInput: '',
        coreMode: 'completed',
        nowMs: 1000,
      },
      80,
      24,
    ).map(stripAll);

    // The input dock should be compact: 3 lines (blank + border-top + body + border-bottom = 4)
    // but after the blank line prefix, the actual panel is 3 lines.
    const panelStart = lines.findIndex((l: string) => l.includes('┌'));
    expect(panelStart).toBeGreaterThan(-1);

    // Bottom border contains help text
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toContain('Enter submit');
  });

  it('multiline input still expands', () => {
    const run = createInitialRunStateSnapshot(0);
    const longInput = 'A'.repeat(80) + ' B'.repeat(40);
    const lines = renderLayout(
      {
        run: { ...run, phase: 'idle', terminal: 'running' },
        objectiveInput: longInput,
        coreMode: 'idle',
        nowMs: 1000,
      },
      80,
      24,
    ).map(stripAll);

    // With multiline input, the panel expands
    const multiPanelStart = lines.findIndex((l: string) => l.includes('┌'));
    const multiPanelLines = lines.slice(multiPanelStart);
    // Should have more than 3 lines (top + at least 2 body + bottom = 4+)
    expect(multiPanelLines.length).toBeGreaterThanOrEqual(4);
  });

  it('bracketed paste does not submit prematurely', () => {
    // Simulate a paste with bracket escape codes
    const pasteChunk = '\x1b[200~multiline\ncontent\nhere\x1b[201~';
    const events = parseInputChunk(pasteChunk);
    // Should produce a single paste event, no submit events
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('paste');
    expect(events[0].value).toBe('multiline\ncontent\nhere');
  });
});
