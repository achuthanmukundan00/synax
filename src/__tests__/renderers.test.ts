import { DebugRenderer, JsonlRenderer, NormalRenderer, QuietRenderer } from '../agent/renderers';
import { applyEventToRunState, createInitialRunStateSnapshot } from '../agent/tui-state';
import type { AgentEvent } from '../agent/events';

function captureWrites(fn: () => void): { stdout: string; stderr: string } {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown as (chunk: string) => boolean) = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as unknown as typeof process.stdout.write;
  (process.stderr.write as unknown as (chunk: string) => boolean) = ((chunk: string) => {
    err.push(chunk);
    return true;
  }) as unknown as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { stdout: out.join(''), stderr: err.join('') };
}

describe('renderers', () => {
  it('normal renderer handles verification lifecycle events', () => {
    const output = captureWrites(() => {
      const renderer = new NormalRenderer();
      renderer.onEvent({
        type: 'task_started',
        timestamp: new Date().toISOString(),
        mode: 'patch',
        profile: 'default',
        endpoint: 'http://127.0.0.1:1234/v1',
        model: 'x',
        contextBudgetTokens: 1,
        maxModelSteps: 2,
        maxToolCalls: 3,
        tools: ['read'],
        task: 'inspect package.json',
      });
      renderer.onEvent({
        type: 'verification_planned',
        timestamp: new Date().toISOString(),
        checkId: 'chk-1',
        checkLabel: 'npm test',
        command: 'npm test',
        summary: '3 file(s) changed',
      });
      renderer.onEvent({
        type: 'verification_started',
        timestamp: new Date().toISOString(),
        checkId: 'chk-1',
        checkLabel: 'npm test',
        command: 'npm test',
      });
      renderer.onEvent({
        type: 'verification_passed',
        timestamp: new Date().toISOString(),
        checkId: 'chk-1',
        checkLabel: 'npm test',
        summary: 'all tests passed',
        durationMs: 1234,
      });
      renderer.onEvent({
        type: 'verification_failed',
        timestamp: new Date().toISOString(),
        checkId: 'chk-2',
        checkLabel: 'npm run lint',
        summary: '2 lint errors',
        severity: 'S2',
        durationMs: 500,
      });
      renderer.onEvent({
        type: 'verification_skipped',
        timestamp: new Date().toISOString(),
        checkId: 'chk-3',
        checkLabel: 'npm run build',
        summary: 'skipped by config',
      });
    });
    expect(output.stdout).toContain('Verif plan:');
    expect(output.stdout).toContain('Verif start:');
    expect(output.stdout).toContain('Verif ✓:');
    expect(output.stdout).toContain('Verif ✗:');
    expect(output.stdout).toContain('Verif skip:');
  });

  it('tui state handles long objective and check labels without throwing', () => {
    const longText = 'A'.repeat(500);
    let state = createInitialRunStateSnapshot(0);
    state = applyEventToRunState(
      state,
      {
        type: 'task_started',
        timestamp: new Date(0).toISOString(),
        mode: 'patch',
        profile: 'default',
        endpoint: 'http://127.0.0.1:1234/v1',
        model: 'qwen',
        contextBudgetTokens: 1000,
        maxModelSteps: 10,
        maxToolCalls: 10,
        tools: ['read'],
        task: longText,
      },
      1,
    );
    // Should not throw; label is clipped internally
    expect(state.objective.label.length).toBeLessThanOrEqual(longText.length);

    state = applyEventToRunState(
      state,
      {
        type: 'verification_planned',
        timestamp: new Date(2).toISOString(),
        checkId: 'chk-1',
        checkLabel: 'npm run ' + 'x'.repeat(200),
        summary: 'very long check label',
      },
      3,
    );
    // Should not throw
    expect(state.verification.currentCheckLabel).toBeTruthy();
  });

  it('tui state clips status and risk lines without expanding layout', () => {
    let state = createInitialRunStateSnapshot(0);
    const longError = 'E'.repeat(500);
    state = applyEventToRunState(
      state,
      {
        type: 'error',
        timestamp: new Date(0).toISOString(),
        message: longError,
      },
      1,
    );
    // Status note and risk line should be clipped at reasonable lengths
    expect(state.riskLine.length).toBeLessThanOrEqual(123);
    expect(state.statusNote.length).toBeLessThanOrEqual(123);
  });

  it('normal renderer emits readable sections and avoids raw objects', () => {
    const output = captureWrites(() => {
      const renderer = new NormalRenderer();
      renderer.onEvent({
        type: 'task_started',
        timestamp: new Date().toISOString(),
        mode: 'patch',
        profile: 'default',
        endpoint: 'http://127.0.0.1:1234/v1',
        model: 'x',
        contextBudgetTokens: 1,
        maxModelSteps: 2,
        maxToolCalls: 3,
        tools: ['read'],
        task: 'inspect package.json',
      });
      renderer.onEvent({
        type: 'task_finished',
        timestamp: new Date().toISOString(),
        status: 'completed',
        toolCalls: 0,
        maxToolCalls: 3,
        modelSteps: 1,
        maxModelSteps: 2,
        changedFiles: [],
        verification: 'not run',
      });
    });
    expect(output.stdout).toContain('Synax Task');
    expect(output.stdout).toContain('Result');
    expect(output.stdout).not.toContain('{"type"');
  });

  it('quiet renderer suppresses traces and prints final answer only', () => {
    const output = captureWrites(() => {
      const renderer = new QuietRenderer();
      renderer.onEvent({
        type: 'tool_started',
        timestamp: new Date().toISOString(),
        toolCallId: '1',
        toolName: 'read',
        summary: 'package.json',
      } as AgentEvent);
      renderer.onEvent({ type: 'assistant_message', timestamp: new Date().toISOString(), content: 'synax-ok' });
    });
    expect(output.stdout.trim()).toBe('synax-ok');
  });

  it('json renderer emits parseable JSONL', () => {
    const output = captureWrites(() => {
      const renderer = new JsonlRenderer();
      renderer.onEvent({ type: 'assistant_message', timestamp: new Date().toISOString(), content: 'ok' });
    });
    const line = output.stdout.trim();
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it('debug renderer is expanded diagnostics, not JSONL', () => {
    const output = captureWrites(() => {
      const renderer = new DebugRenderer();
      renderer.onEvent({
        type: 'task_started',
        timestamp: new Date().toISOString(),
        mode: 'patch',
        profile: 'default',
        endpoint: 'http://example.test/v1?api_key=secret',
        model: 'x',
        contextBudgetTokens: 100,
        maxModelSteps: 2,
        maxToolCalls: 3,
        tools: ['read', 'write'],
        task: 'inspect token secret',
      });
      renderer.onEvent({
        type: 'tool_started',
        timestamp: new Date().toISOString(),
        stepIndex: 1,
        toolCallId: '1',
        toolName: 'read',
        summary: '{"path":"package.json","Authorization":"Bearer secret"}',
      });
      renderer.onEvent({
        type: 'assistant_message',
        timestamp: new Date().toISOString(),
        content: 'raw content preview',
      });
      renderer.onEvent({
        type: 'task_finished',
        timestamp: new Date().toISOString(),
        status: 'completed',
        toolCalls: 1,
        maxToolCalls: 3,
        modelSteps: 1,
        maxModelSteps: 2,
        changedFiles: [],
        verification: 'not run',
      });
    });

    expect(output.stdout).toContain('[debug] event: task_started');
    expect(output.stdout).toContain('budgets: context=100 model_steps=unlimited tool_calls=3');
    expect(output.stdout).toContain('tool: read args=');
    expect(output.stdout).toContain('content: raw content preview');
    expect(output.stdout).toContain('terminal: completed');
    expect(output.stdout).not.toContain('{"type"');
    expect(output.stdout).not.toContain('secret');
  });
});
