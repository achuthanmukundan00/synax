/**
 * Acceptance tests for the Morphology TUI presentation layer.
 *
 * Validates renderer output against visual contract requirements:
 * no vertical box-drawing characters, memory conflict rendering,
 * swarm agent pane layout, ASCII fallback, orchestration sub-agents,
 * and handoff packet rendering.
 */

import {
  createInitialPresentationState,
  createMorphologyTheme,
  createAsciiTheme,
  renderAnsi,
  renderPlainText,
} from '../presentation';
import type { PresentationState } from '../presentation/types';

// ─── Helpers ────────────────────────────────────────────────────────────

/** Strip ANSI escape sequences from a string. */
/* eslint-disable no-control-regex */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Characters that must never appear in any renderer output. */
const VERTICAL_BOX_CHARS = [
  '│',
  '┃',
  '╎',
  '┆',
  '┊',
  '║',
  '╭',
  '╮',
  '╰',
  '╯',
  '┌',
  '┐',
  '└',
  '┘',
  '├',
  '┤',
  '┬',
  '┴',
  '┼',
];

function assertNoVerticalBoxChars(output: string): void {
  for (const ch of VERTICAL_BOX_CHARS) {
    expect(output).not.toContain(ch);
  }
}

/** Build a state with all block kinds represented. */
function richState(): PresentationState {
  return {
    blocks: [
      { kind: 'runtime_status', label: 'model', value: 'qwen-7b @ local', priority: 'line' },
      { kind: 'runtime_status', label: 'mode', value: 'patch', priority: 'line' },
      {
        kind: 'orchestration',
        mode: 'parallel',
        phase: 'active',
        summary: '3 sub-tasks planned',
        subAgents: [
          { id: 'a1', task: 'Scan files', phase: 'completed', changedFiles: ['src/index.ts'] },
          { id: 'a2', task: 'Fix bugs', phase: 'active' },
          { id: 'a3', task: 'Run tests', phase: 'pending' },
        ],
      },
      { kind: 'tool_activity', toolName: 'read', phase: 'started', summary: 'Reading file' },
      { kind: 'tool_activity', toolName: 'read', phase: 'completed', summary: 'completed (420 bytes)' },
      { kind: 'model_output', role: 'primary', text: 'Task completed successfully.' },
      {
        kind: 'runtime_status',
        label: 'summary',
        value: 'completed · 3 tool calls · 1 file changed',
        priority: 'line',
      },
      { kind: 'debug_detail', tag: 'lifecycle', text: 'session started' },
    ],
    streamingText: '',
    agentPanes: [
      { id: 'agent-1', role: 'scout', model: 'qwen-7b', phase: 'completed', lastAction: 'done', finding: 'ok' },
      { id: 'agent-2', role: 'fixer', model: 'qwen-7b', phase: 'active', lastAction: 'editing' },
    ],
    memoryDecisions: [{ label: 'project:synax/tui', disposition: 'used', reason: 'relevant', provenance: 'today' }],
    handoffPackets: [
      {
        source: 'qwen-32b',
        target: 'qwen-7b',
        reason: 'budget',
        summary: 'Cleanup',
        includedContext: [],
        excludedContext: [],
      },
    ],
    liveRepoState: { cwd: '/tmp/test', branch: 'main', repo: 'test' },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('Morphology TUI acceptance', () => {
  describe('vertical box-drawing characters', () => {
    it('plain text output contains no vertical box-drawing characters', () => {
      const state = richState();
      const output = renderPlainText(state, { showToolActivity: true, showRuntimeStatus: true });
      assertNoVerticalBoxChars(output);
    });

    it('ANSI output (stripped) contains no vertical box-drawing characters', () => {
      const state = richState();
      const theme = createMorphologyTheme();
      const ansi = renderAnsi(state, theme, {
        terminalWidth: 80,
        showHeader: true,
        showMemory: true,
        showHandoff: true,
        showAgentPanes: true,
      });
      const stripped = stripAnsi(ansi);
      assertNoVerticalBoxChars(stripped);
    });
  });

  describe('memory conflict rendering', () => {
    it('renders rejected stale cwd memory', () => {
      const state: PresentationState = {
        ...createInitialPresentationState(),
        blocks: [{ kind: 'runtime_status', label: 'model', value: 'frontier @ api', priority: 'line' }],
        memoryDecisions: [
          {
            label: 'cwd',
            disposition: 'rejected',
            reason: 'stale — live pwd differs',
            provenance: 'old-session / 2d ago',
            stale: true,
            conflict: true,
          },
          { label: 'project:synax/config', disposition: 'used', reason: 'matched', provenance: 'session-abc' },
        ],
        liveRepoState: { cwd: '/Users/dev/workspace/git/synax', branch: 'main' },
      };

      const theme = createMorphologyTheme();
      const ansi = renderAnsi(state, theme, {
        terminalWidth: 80,
        showHeader: true,
        showMemory: true,
        showHandoff: false,
        showAgentPanes: false,
      });
      const stripped = stripAnsi(ansi);

      // Memory section should mention rejection and stale cwd
      expect(stripped).toContain('memory');
      expect(stripped).toContain('rejected');
      expect(stripped).toContain('cwd');
      expect(stripped).toContain('stale');
      // Live state should show the real cwd
      expect(stripped).toContain('/Users/dev/workspace/git/synax');
    });

    it('plain text also renders rejected cwd', () => {
      const state: PresentationState = {
        ...createInitialPresentationState(),
        memoryDecisions: [
          { label: 'cwd', disposition: 'rejected', reason: 'stale', provenance: 'old', stale: true, conflict: true },
        ],
        liveRepoState: { cwd: '/live/path' },
      };

      const plain = renderPlainText(state, { showToolActivity: false, showRuntimeStatus: false, showMemory: true });
      expect(plain).toContain('rejected');
      expect(plain).toContain('cwd');
    });
  });

  describe('swarm fixture', () => {
    it('renders 9 agent panes', () => {
      const agentPanes = Array.from({ length: 9 }, (_, i) => ({
        id: `agent-${i + 1}`,
        role: `role-${i + 1}`,
        model: 'qwen-7b',
        phase: (i < 4 ? 'completed' : i < 7 ? 'active' : 'pending') as 'completed' | 'active' | 'pending',
        lastAction: `action-${i + 1}`,
      }));

      const state: PresentationState = {
        ...createInitialPresentationState(),
        blocks: [
          { kind: 'runtime_status', label: 'model', value: 'qwen-7b', priority: 'line' },
          { kind: 'runtime_status', label: 'mode', value: 'swarm (9 agents)', priority: 'line' },
        ],
        agentPanes,
      };

      const theme = createMorphologyTheme();
      const ansi = renderAnsi(state, theme, {
        terminalWidth: 80,
        showHeader: true,
        showMemory: false,
        showHandoff: false,
        showAgentPanes: true,
      });
      const stripped = stripAnsi(ansi);

      // Each agent ID should appear in the output
      for (let i = 1; i <= 9; i++) {
        expect(stripped).toContain(`agent-${i}`);
      }
    });
  });

  describe('ASCII fallback (color=false, unicode=false)', () => {
    it('renders without Unicode glyphs when using ASCII theme', () => {
      const state: PresentationState = {
        ...createInitialPresentationState(),
        blocks: [
          { kind: 'runtime_status', label: 'model', value: 'test-model', priority: 'line' },
          { kind: 'model_output', role: 'primary', text: 'Done.' },
          { kind: 'tool_activity', toolName: 'read', phase: 'completed', summary: 'ok' },
        ],
        memoryDecisions: [{ label: 'project:synax', disposition: 'used', reason: 'relevant', provenance: 'today' }],
        handoffPackets: [
          { source: 'm1', target: 'm2', reason: 'test', summary: 'test', includedContext: [], excludedContext: [] },
        ],
      };

      const asciiTheme = createAsciiTheme();
      const ansi = renderAnsi(state, asciiTheme, {
        terminalWidth: 80,
        showHeader: true,
        showMemory: true,
        showHandoff: true,
        showAgentPanes: false,
      });
      const stripped = stripAnsi(ansi);

      // ASCII theme uses text labels, not Unicode glyphs
      // Unicode glyphs to check absence of (main glyphs only):
      const unicodeGlyphs = ['›', '✦', '◇', '✶', '◆', '↳'];
      for (const glyph of unicodeGlyphs) {
        expect(stripped).not.toContain(glyph);
      }

      // Should contain ASCII-style labels instead
      expect(stripped).toContain('result');
      expect(stripped).toContain('tool');
      expect(stripped).toContain('memory');
      expect(stripped).toContain('handoff');
    });

    it('plain text renderer is also ASCII-safe', () => {
      const state: PresentationState = {
        ...createInitialPresentationState(),
        blocks: [{ kind: 'model_output', role: 'primary', text: 'Hello.' }],
      };
      const plain = renderPlainText(state, { showToolActivity: false, showRuntimeStatus: false });
      const unicodeGlyphs = ['›', '✦', '◇', '✶', '◆', '↳'];
      for (const glyph of unicodeGlyphs) {
        expect(plain).not.toContain(glyph);
      }
    });
  });

  describe('orchestration block rendering', () => {
    it('renders sub-agents with different phases', () => {
      const state: PresentationState = {
        ...createInitialPresentationState(),
        blocks: [
          {
            kind: 'orchestration',
            mode: 'parallel',
            phase: 'active',
            summary: '3 sub-tasks',
            subAgents: [
              { id: 'a1', task: 'Extract constants', phase: 'completed', changedFiles: ['src/const.ts'] },
              { id: 'a2', task: 'Update imports', phase: 'active' },
              { id: 'a3', task: 'Run tests', phase: 'pending' },
            ],
          },
        ],
      };

      const theme = createMorphologyTheme();
      const ansi = renderAnsi(state, theme, {
        terminalWidth: 80,
        showHeader: true,
        showMemory: false,
        showHandoff: false,
        showAgentPanes: false,
      });
      const stripped = stripAnsi(ansi);

      expect(stripped).toContain('Extract constants');
      expect(stripped).toContain('Update imports');
      expect(stripped).toContain('Run tests');
      expect(stripped).toContain('a1');
      expect(stripped).toContain('a2');
      expect(stripped).toContain('a3');
    });
  });

  describe('handoff packets rendered', () => {
    it('renders handoff packet with source, target, reason', () => {
      const state: PresentationState = {
        ...createInitialPresentationState(),
        blocks: [{ kind: 'runtime_status', label: 'model', value: 'qwen-32b', priority: 'line' }],
        handoffPackets: [
          {
            source: 'qwen2.5-coder-32b',
            target: 'deepseek-coder-6.7b',
            reason: 'budget exhausted — handoff to cheaper model',
            summary: 'Core work done, delegate cleanup',
            includedContext: ['changed files', 'test results'],
            excludedContext: ['raw outputs'],
          },
        ],
      };

      const theme = createMorphologyTheme();
      const ansi = renderAnsi(state, theme, {
        terminalWidth: 80,
        showHeader: true,
        showMemory: false,
        showHandoff: true,
        showAgentPanes: false,
      });
      const stripped = stripAnsi(ansi);

      expect(stripped).toContain('qwen2.5-coder-32b');
      expect(stripped).toContain('deepseek-coder-6.7b');
      expect(stripped).toContain('budget exhausted');
      expect(stripped).toContain('Core work done');
    });
  });

  describe('horizontal rules present', () => {
    it('ANSI output uses horizontal rule separators', () => {
      const state = richState();
      const theme = createMorphologyTheme();
      const ansi = renderAnsi(state, theme, {
        terminalWidth: 80,
        showHeader: true,
        showMemory: true,
        showHandoff: true,
        showAgentPanes: true,
      });
      // Should contain horizontal rule characters (─ or ═)
      expect(ansi).toMatch(/─|═/);
    });
  });
});
