/**
 * Tests for recovery recipes and RecoveryManager.
 */

import { RecoveryManager } from '../recovery/RecoveryManager';
import { RecoverableError } from '../recovery/types';
import { classifyResultForRecovery } from '../session/message-assembly';
import type { RecoveryConversation } from '../recovery/types';

function makeConversation(): RecoveryConversation {
  return {
    messages: [
      { role: 'system', content: 'You are Synax.' },
      { role: 'user', content: 'fix the build' },
    ],
  };
}

describe('RecoveryManager', () => {
  let manager: RecoveryManager;

  beforeEach(() => {
    manager = new RecoveryManager();
  });

  test('empty_response recipe injects a nudge message', async () => {
    const conv = makeConversation();
    const result = await manager.attemptRecovery({
      scenario: 'empty_response',
      conversation: conv,
      task: 'fix the build',
      attempt: 0,
    });

    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.recovered).toBe(true);
    expect(r.injectedMessage).toContain('empty');
    expect(conv.messages.length).toBe(3); // system + user + nudge
    expect(conv.messages[2].role).toBe('user');
  });

  test('bash_failure recipe feeds stderr back', async () => {
    const conv = makeConversation();
    const result = await manager.attemptRecovery({
      scenario: 'bash_failure',
      conversation: conv,
      task: 'run tests',
      attempt: 0,
      stderr: 'npm ERR! test failed',
    });

    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.recovered).toBe(true);
    expect(r.injectedMessage).toContain('npm ERR! test failed');
    expect(conv.messages.length).toBe(3);
  });

  test('context_exhaustion recipe injects compaction nudge', async () => {
    const conv = makeConversation();
    const result = await manager.attemptRecovery({
      scenario: 'context_exhaustion',
      conversation: conv,
      task: 'refactor module',
      attempt: 0,
    });

    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.recovered).toBe(true);
    expect(r.injectedMessage).toContain('Context budget');
    expect(conv.messages.length).toBe(3);
  });

  test('infinite_loop recipe injects steering message', async () => {
    const conv = makeConversation();
    const result = await manager.attemptRecovery({
      scenario: 'infinite_loop',
      conversation: conv,
      task: 'fix test',
      attempt: 0,
      repeatedAction: 'reading the same file',
    });

    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.recovered).toBe(true);
    expect(r.injectedMessage).toContain('stuck repeating');
    expect(r.injectedMessage).toContain('reading the same file');
    expect(conv.messages.length).toBe(3);
  });

  test('malformed_tool_call recipe injects format correction nudge', async () => {
    const conv = makeConversation();
    const result = await manager.attemptRecovery({
      scenario: 'malformed_tool_call',
      conversation: conv,
      task: 'read docs',
      attempt: 0,
      details: 'Qwen tool_call block missing <function=...> wrapper',
    });

    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.recovered).toBe(true);
    expect(r.injectedMessage).toContain('formatting error');
    expect(r.injectedMessage).toContain('<function=');
    expect(r.injectedMessage).toContain('REQUIRED');
    expect(r.injectedMessage).toContain('missing <function=');
    expect(conv.messages.length).toBe(3);
  });

  test('malformed_tool_call recipe uses fallback details when none provided', async () => {
    const conv = makeConversation();
    const result = await manager.attemptRecovery({
      scenario: 'malformed_tool_call',
      conversation: conv,
      task: 'read docs',
      attempt: 0,
    });

    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.recovered).toBe(true);
    expect(r.injectedMessage).toContain('unknown parse error');
  });

  test('recovery is exhausted after max attempts', async () => {
    const conv = makeConversation();
    // empty_response has max 2 attempts
    await manager.attemptRecovery({ scenario: 'empty_response', conversation: conv, task: 'test', attempt: 0 });
    await manager.attemptRecovery({ scenario: 'empty_response', conversation: conv, task: 'test', attempt: 1 });
    const third = await manager.attemptRecovery({
      scenario: 'empty_response',
      conversation: conv,
      task: 'test',
      attempt: 2,
    });

    expect(third).toBeNull(); // exhausted
  });

  test('resetForTurn resets the per-turn attempt counter', async () => {
    const conv = makeConversation();
    // Use up all attempts
    await manager.attemptRecovery({ scenario: 'empty_response', conversation: conv, task: 'test', attempt: 0 });
    await manager.attemptRecovery({ scenario: 'empty_response', conversation: conv, task: 'test', attempt: 1 });
    await manager.attemptRecovery({ scenario: 'empty_response', conversation: conv, task: 'test', attempt: 2 });

    manager.resetForTurn();

    // Should work again
    const fresh = await manager.attemptRecovery({
      scenario: 'empty_response',
      conversation: makeConversation(),
      task: 'test',
      attempt: 0,
    });
    expect(fresh).not.toBeNull();
    const f = fresh as NonNullable<typeof fresh>;
    expect(f.recovered).toBe(true);
  });

  test('returns null for unrecognized scenario', async () => {
    const result = await manager.attemptRecovery({
      scenario: 'missing_api_key',
      conversation: makeConversation(),
      task: 'test',
      attempt: 0,
    });
    expect(result).toBeNull();
  });

  test('total attempts per turn is capped', async () => {
    const conv = makeConversation();
    // 3 total recovery attempts per turn
    await manager.attemptRecovery({ scenario: 'empty_response', conversation: conv, task: 'test', attempt: 0 });
    await manager.attemptRecovery({ scenario: 'bash_failure', conversation: conv, task: 'test', attempt: 0 });
    await manager.attemptRecovery({ scenario: 'context_exhaustion', conversation: conv, task: 'test', attempt: 0 });
    const fourth = await manager.attemptRecovery({
      scenario: 'infinite_loop',
      conversation: conv,
      task: 'test',
      attempt: 0,
    });

    expect(fourth).toBeNull(); // total cap hit
  });
});

describe('recovery classification', () => {
  test('classifies bash stderr failures without requiring an exit-code marker', () => {
    expect(
      classifyResultForRecovery({
        terminalState: 'tool_error',
        finalAnswer: '',
        steps: 1,
        changedFiles: [],
        toolCalls: [{ name: 'bash', success: false, error: 'make: *** [test] Error 1' }],
        conversation: {} as never,
        error: 'make: *** [test] Error 1',
      }),
    ).toBe('bash_failure');
  });

  test('keeps repeated bash failures classified as an infinite loop', () => {
    expect(
      classifyResultForRecovery({
        terminalState: 'tool_error',
        finalAnswer: '',
        steps: 4,
        changedFiles: [],
        toolCalls: [{ name: 'bash', success: false, error: 'Bash loop detected' }],
        conversation: {} as never,
        error: 'too many consecutive recoverable tool errors: 3',
      }),
    ).toBe('infinite_loop');
  });

  test('classifies malformed tool call — missing function wrapper', () => {
    expect(
      classifyResultForRecovery({
        terminalState: 'model_error',
        finalAnswer: '',
        steps: 1,
        changedFiles: [],
        toolCalls: [],
        conversation: {} as never,
        error: 'Qwen tool_call block missing <function=...> wrapper',
      }),
    ).toBe('malformed_tool_call');
  });

  test('classifies malformed tool call — generic malformed error', () => {
    expect(
      classifyResultForRecovery({
        terminalState: 'model_error',
        finalAnswer: '',
        steps: 1,
        changedFiles: [],
        toolCalls: [],
        conversation: {} as never,
        error: 'model emitted malformed tool call output: bad JSON',
      }),
    ).toBe('malformed_tool_call');
  });

  test('classifies malformed tool call — contained malformed', () => {
    expect(
      classifyResultForRecovery({
        terminalState: 'model_error',
        finalAnswer: '',
        steps: 1,
        changedFiles: [],
        toolCalls: [],
        conversation: {} as never,
        error: 'tool_call block contained malformed <parameter=...>',
      }),
    ).toBe('malformed_tool_call');
  });

  test('does not classify non-malformed model_error as malformed_tool_call', () => {
    expect(
      classifyResultForRecovery({
        terminalState: 'model_error',
        finalAnswer: '',
        steps: 1,
        changedFiles: [],
        toolCalls: [],
        conversation: {} as never,
        error: 'context budget exceeded',
      }),
    ).toBeNull();
  });

  test('does not classify tool_error without malformed markers', () => {
    expect(
      classifyResultForRecovery({
        terminalState: 'tool_error',
        finalAnswer: '',
        steps: 1,
        changedFiles: [],
        toolCalls: [{ name: 'read', success: false, error: 'ENOENT: no such file' }],
        conversation: {} as never,
        error: 'ENOENT: no such file',
      }),
    ).toBeNull();
  });
});

describe('RecoverableError', () => {
  test('creates error with scenario and details', () => {
    const err = new RecoverableError({
      scenario: 'bash_failure',
      message: 'command failed',
      stderr: 'npm ERR!',
    });

    expect(err.name).toBe('RecoverableError');
    expect(err.scenario).toBe('bash_failure');
    expect(err.stderr).toBe('npm ERR!');
    expect(err.message).toBe('command failed');
  });
});
