import { renderPlainText } from '../presentation/renderPlainText';
import type { PresentationState } from '../presentation/types';
import { createInitialPresentationState } from '../presentation/types';

function emptyState(): PresentationState {
  return createInitialPresentationState();
}

function stateWithBlocks(blocks: PresentationState['blocks']): PresentationState {
  return { ...createInitialPresentationState(), blocks: blocks.slice() };
}

describe('renderPlainText', () => {
  it('renders an empty state', () => {
    const output = renderPlainText(emptyState());
    expect(output).toBe('\n');
  });

  describe('model_output', () => {
    it('renders primary model output', () => {
      const output = renderPlainText(stateWithBlocks([{ kind: 'model_output', role: 'primary', text: 'Hello world' }]));
      expect(output).toContain('Hello world');
    });

    it('renders questions with a prefix', () => {
      const output = renderPlainText(stateWithBlocks([{ kind: 'model_output', role: 'question', text: 'Proceed?' }]));
      expect(output).toContain('Question: Proceed?');
    });

    it('hides notes by default', () => {
      const output = renderPlainText(stateWithBlocks([{ kind: 'model_output', role: 'note', text: 'internal note' }]));
      expect(output).toBe('\n');
    });

    it('shows notes in debug mode', () => {
      const output = renderPlainText(stateWithBlocks([{ kind: 'model_output', role: 'note', text: 'debug note' }]), {
        debugMode: true,
      });
      expect(output).toContain('# debug note');
    });

    it('hides model output when showModelOutput is false', () => {
      const output = renderPlainText(stateWithBlocks([{ kind: 'model_output', role: 'primary', text: 'secret' }]), {
        showModelOutput: false,
      });
      expect(output).toBe('\n');
    });

    it('clips long model output', () => {
      const longText = 'a'.repeat(1000);
      const output = renderPlainText(stateWithBlocks([{ kind: 'model_output', role: 'primary', text: longText }]), {
        maxLineLength: 50,
      });
      // Should be clipped and within maxBlockLines
      const trimmed = output.trim();
      expect(trimmed.length).toBeLessThan(longText.length);
    });

    it('limits block lines', () => {
      const manyLines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
      const output = renderPlainText(stateWithBlocks([{ kind: 'model_output', role: 'primary', text: manyLines }]), {
        maxBlockLines: 10,
      });
      const lines = output.trim().split('\n');
      expect(lines).toHaveLength(10);
    });
  });

  describe('tool_activity', () => {
    it('renders started phase', () => {
      const output = renderPlainText(
        stateWithBlocks([{ kind: 'tool_activity', toolName: 'read', phase: 'started', summary: 'Reading file' }]),
      );
      expect(output.trim()).toBe('[read] Reading file');
    });

    it('renders completed phase with indicator', () => {
      const output = renderPlainText(
        stateWithBlocks([{ kind: 'tool_activity', toolName: 'write', phase: 'completed', summary: 'ok' }]),
      );
      expect(output.trim()).toBe('[write] ok — completed');
    });

    it('renders failed phase', () => {
      const output = renderPlainText(
        stateWithBlocks([{ kind: 'tool_activity', toolName: 'bash', phase: 'failed', summary: 'exit code 1' }]),
      );
      expect(output.trim()).toBe('[bash] exit code 1 — failed');
    });

    it('hides verification when showVerification is false', () => {
      const output = renderPlainText(
        stateWithBlocks([
          { kind: 'tool_activity', toolName: 'run_verification', phase: 'completed', summary: 'npm test' },
        ]),
        { showVerification: false },
      );
      expect(output).toBe('\n');
    });

    it('hides all tool activity when showToolActivity is false', () => {
      const output = renderPlainText(
        stateWithBlocks([{ kind: 'tool_activity', toolName: 'read', phase: 'started', summary: 'f' }]),
        { showToolActivity: false },
      );
      expect(output).toBe('\n');
    });
  });

  describe('shell_command', () => {
    it('renders command with duration', () => {
      const output = renderPlainText(
        stateWithBlocks([
          {
            kind: 'shell_command',
            command: 'npm test',
            exitCode: 0,
            durationMs: 1500,
            stdout: 'PASS\nAll tests passed',
          },
        ]),
      );
      expect(output).toContain('$ npm test');
      expect(output).toContain('(1.5s)');
      expect(output).toContain('  PASS');
      expect(output).toContain('  All tests passed');
    });

    it('shows exit code on failure', () => {
      const output = renderPlainText(
        stateWithBlocks([
          {
            kind: 'shell_command',
            command: 'npm test',
            exitCode: 1,
            durationMs: 500,
            stdout: '',
            stderr: 'FAIL',
          },
        ]),
      );
      expect(output).toContain('[exit 1]');
      expect(output).toContain('  err: FAIL');
    });

    it('shows ms duration for short commands', () => {
      const output = renderPlainText(
        stateWithBlocks([
          {
            kind: 'shell_command',
            command: 'ls',
            exitCode: 0,
            durationMs: 50,
          },
        ]),
      );
      expect(output).toContain('(50ms)');
    });

    it('hides shell commands when showShellCommands is false', () => {
      const output = renderPlainText(
        stateWithBlocks([
          {
            kind: 'shell_command',
            command: 'rm -rf /',
            exitCode: 0,
            durationMs: 100,
          },
        ]),
        { showShellCommands: false },
      );
      expect(output).toBe('\n');
    });
  });

  describe('orchestration', () => {
    it('renders orchestration block with sub-agent summaries', () => {
      const output = renderPlainText(
        stateWithBlocks([
          {
            kind: 'orchestration',
            mode: 'parallel',
            phase: 'active',
            summary: '3 sub-tasks planned',
            subAgents: [
              { id: 'a', task: 'Do X', phase: 'completed' },
              { id: 'b', task: 'Do Y', phase: 'active' },
              { id: 'c', task: 'Do Z', phase: 'pending' },
            ],
          },
        ]),
      );
      expect(output).toContain('[orchestration] parallel');
      expect(output).toContain('1/3 done');
      expect(output).toContain('1 active');
      expect(output).toContain('1 pending');
      expect(output).toContain('[a] completed');
      expect(output).toContain('[b] active');
    });

    it('shows changed files for completed agents', () => {
      const output = renderPlainText(
        stateWithBlocks([
          {
            kind: 'orchestration',
            mode: 'sequential',
            phase: 'completed',
            summary: '2 sub-tasks planned',
            subAgents: [{ id: 'a', task: 'Do X', phase: 'completed', changedFiles: ['src/a.ts', 'src/b.ts'] }],
          },
        ]),
      );
      expect(output).toContain('src/a.ts, src/b.ts');
    });

    it('shows error for failed agents', () => {
      const output = renderPlainText(
        stateWithBlocks([
          {
            kind: 'orchestration',
            mode: 'sequential',
            phase: 'failed',
            summary: '1 sub-task',
            subAgents: [{ id: 'a', task: 'Do X', phase: 'failed', error: 'Connection refused' }],
          },
        ]),
      );
      expect(output).toContain('Connection refused');
    });
  });

  describe('runtime_status', () => {
    it('renders line priority by default', () => {
      const output = renderPlainText(
        stateWithBlocks([{ kind: 'runtime_status', label: 'model', value: 'claude-sonnet @ api', priority: 'line' }]),
      );
      expect(output).toContain('[model] claude-sonnet @ api');
    });

    it('hides detail priority by default', () => {
      const output = renderPlainText(
        stateWithBlocks([{ kind: 'runtime_status', label: 'tokens', value: 'in: 500, out: 200', priority: 'detail' }]),
      );
      expect(output).toBe('\n');
    });

    it('shows detail priority in debug mode', () => {
      const output = renderPlainText(
        stateWithBlocks([{ kind: 'runtime_status', label: 'tokens', value: 'in: 500', priority: 'detail' }]),
        { debugMode: true },
      );
      expect(output).toContain('[tokens] in: 500');
    });
  });

  describe('debug_detail', () => {
    it('hides debug detail by default', () => {
      const output = renderPlainText(stateWithBlocks([{ kind: 'debug_detail', tag: 'lifecycle', text: 'turn_start' }]));
      expect(output).toBe('\n');
    });

    it('shows debug detail in debug mode', () => {
      const output = renderPlainText(
        stateWithBlocks([{ kind: 'debug_detail', tag: 'lifecycle', text: 'turn_start' }]),
        { debugMode: true },
      );
      expect(output).toContain('# lifecycle: turn_start');
    });

    it('respects showPatchPreviews for patch_preview tag', () => {
      const output = renderPlainText(
        stateWithBlocks([{ kind: 'debug_detail', tag: 'patch_preview', text: 'src/foo.ts\n-old\n+new' }]),
        { debugMode: true, showPatchPreviews: false },
      );
      expect(output).toBe('\n');
    });
  });

  describe('composition and ordering', () => {
    it('renders multiple blocks in order with blank line separators', () => {
      const output = renderPlainText(
        stateWithBlocks([
          { kind: 'runtime_status', label: 'model', value: 'claude', priority: 'line' },
          { kind: 'tool_activity', toolName: 'read', phase: 'started', summary: 'Reading' },
          { kind: 'model_output', role: 'primary', text: 'Answer' },
        ]),
      );
      const lines = output.split('\n');
      // Should have blank lines between blocks
      expect(lines.filter((l) => l === '')).toHaveLength(3); // between blocks + trailing
    });
  });

  describe('determinism', () => {
    it('produces identical output for same state', () => {
      const state = stateWithBlocks([
        { kind: 'runtime_status', label: 'mode', value: 'patch', priority: 'line' },
        { kind: 'model_output', role: 'primary', text: 'Hello' },
        { kind: 'tool_activity', toolName: 'read', phase: 'completed', summary: 'ok' },
      ]);
      const a = renderPlainText(state);
      const b = renderPlainText(state);
      expect(a).toBe(b);
    });
  });
});
