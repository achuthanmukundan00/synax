import { DebugRenderer, JsonlRenderer, NormalRenderer, QuietRenderer } from '../agent/renderers';
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
    expect(output.stdout).toContain('budgets: context=100 model_steps=2 tool_calls=3');
    expect(output.stdout).toContain('tool: read args=');
    expect(output.stdout).toContain('content: raw content preview');
    expect(output.stdout).toContain('terminal: completed');
    expect(output.stdout).not.toContain('{"type"');
    expect(output.stdout).not.toContain('secret');
  });
});
