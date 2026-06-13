import type { ParsedToolCall } from '../llm/tool-calls';
import {
  assistantVisibleContent,
  formatModelResponseActivity,
  isRecoverableToolError,
  isSafeToolPreamble,
  isWriteRecoverableError,
  isEnoentError,
  isReadPolicyLimitError,
  isBashLoopError,
} from '../session/formatting';

function call(name: string): ParsedToolCall {
  return { id: `call-${name}`, name, arguments: {} };
}

function successResult() {
  return { success: true };
}

function errorResult(error: string) {
  return { success: false, error };
}

// ─── Write tool ────────────────────────────────────────────────

describe('write recoverable error', () => {
  it('is recoverable for "file already exists"', () => {
    expect(isWriteRecoverableError('file already exists: src/foo.ts')).toBe(true);
  });

  it('is not recoverable for other errors', () => {
    expect(isWriteRecoverableError('permission denied')).toBe(false);
    expect(isWriteRecoverableError('disk full')).toBe(false);
    expect(isWriteRecoverableError('ENOENT: no such file')).toBe(false);
  });

  it('is not recoverable for undefined error', () => {
    expect(isWriteRecoverableError(undefined)).toBe(false);
  });
});

describe('assistant-visible content sanitization', () => {
  it('removes stray closing think tags and tool-call markup', () => {
    const content =
      '</think>\n\n<tool_call>\n<function=read>\n<parameter=path>\npackage.json\n</parameter>\n</function>\n</tool_call>';

    expect(assistantVisibleContent(content)).toBe('');
  });

  it('keeps prose around stripped tool-call markup', () => {
    const content =
      'I will inspect package.json.\n<tool_call>{"name":"read","arguments":{"path":"package.json"}}</tool_call>';

    expect(assistantVisibleContent(content)).toBe('I will inspect package.json.');
  });

  it('does not treat raw content-XML tool calls as unsafe final-answer prose', () => {
    const content =
      '</think>\n\n<tool_call>\n<function=read>\n<parameter=path>\npackage.json\n</parameter>\n</function>\n</tool_call>';

    expect(isSafeToolPreamble(content)).toBe(true);
  });

  it('does not render raw tool-call markup as model activity text', () => {
    const activity = formatModelResponseActivity(
      {
        content: '</think>\n\n<tool_call>{"name":"read","arguments":{"path":"package.json"}}</tool_call>',
        toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'package.json' } }],
        toolCallFormat: 'content_xml',
        model: 'fake',
        finishReason: 'stop',
        usage: null,
      },
      1,
    );

    expect(activity.message).not.toContain('</think>');
    expect(activity.message).not.toContain('<tool_call>');
    expect(activity.message).toContain('1 tool call(s): read');
  });
});

// ─── isRecoverableToolError aggregation ────────────────────────

describe('isRecoverableToolError', () => {
  it('returns false for successful results', () => {
    expect(isRecoverableToolError(call('write'), successResult())).toBe(false);
    expect(isRecoverableToolError(call('bash'), successResult())).toBe(false);
    expect(isRecoverableToolError(call('edit'), successResult())).toBe(false);
    expect(isRecoverableToolError(call('read'), successResult())).toBe(false);
  });

  // write
  it('write + "file already exists" is recoverable', () => {
    expect(isRecoverableToolError(call('write'), errorResult('file already exists'))).toBe(true);
  });

  it('write + other error is not recoverable', () => {
    expect(isRecoverableToolError(call('write'), errorResult('permission denied'))).toBe(false);
  });

  // bash
  it('bash + non-loop error is recoverable', () => {
    expect(isRecoverableToolError(call('bash'), errorResult('command failed'))).toBe(true);
  });

  it('bash + bash loop error is not recoverable', () => {
    expect(isRecoverableToolError(call('bash'), errorResult('Bash loop detected'))).toBe(false);
  });

  // edit
  it('edit + "oldStr" mismatch is recoverable', () => {
    expect(isRecoverableToolError(call('edit'), errorResult('oldStr must match exactly once'))).toBe(true);
    expect(isRecoverableToolError(call('edit'), errorResult('oldStr no longer matches content'))).toBe(true);
  });

  it('edit + other error is not recoverable', () => {
    expect(isRecoverableToolError(call('edit'), errorResult('file not found'))).toBe(false);
  });

  // invalid argument names (any tool) — the "Re-emit the tool call" path
  it('invalid-arguments error is recoverable for any tool', () => {
    const msg =
      'invalid arguments for edit: received [newStr, path]. Expected: path, oldStr, newStr. ' +
      'Re-emit the tool call with the correct argument names.';
    expect(isRecoverableToolError(call('edit'), errorResult(msg))).toBe(true);
    expect(isRecoverableToolError(call('write'), errorResult('invalid arguments for write: received [(none)]'))).toBe(
      true,
    );
    expect(isRecoverableToolError(call('view_image'), errorResult('invalid arguments for view_image'))).toBe(true);
  });

  // replace_in_file (aliased to edit rules)
  it('replace_in_file + "oldStr" mismatch is recoverable', () => {
    expect(isRecoverableToolError(call('replace_in_file'), errorResult('oldStr must match exactly once'))).toBe(true);
  });

  it('replace_in_file + other error is not recoverable', () => {
    expect(isRecoverableToolError(call('replace_in_file'), errorResult('file not found'))).toBe(false);
  });

  // read
  it('read + ENOENT is recoverable', () => {
    expect(isRecoverableToolError(call('read'), errorResult('ENOENT: no such file, open /missing.txt'))).toBe(true);
  });

  it('read + policy limit is recoverable', () => {
    expect(isRecoverableToolError(call('read'), errorResult('total read limit reached'))).toBe(true);
    expect(isRecoverableToolError(call('read'), errorResult('Read loop detected'))).toBe(true);
  });

  it('read + other error is not recoverable', () => {
    expect(isRecoverableToolError(call('read'), errorResult('permission denied'))).toBe(false);
  });

  // unknown tool
  it('unknown tool + error is not recoverable', () => {
    expect(isRecoverableToolError(call('unknown_tool'), errorResult('something went wrong'))).toBe(false);
  });
});

// ─── Individual predicate helpers ──────────────────────────────

describe('isEnoentError', () => {
  it('matches ENOENT', () => {
    expect(isEnoentError('ENOENT: no such file')).toBe(true);
  });

  it('does not match other errors', () => {
    expect(isEnoentError('file not found')).toBe(false);
    expect(isEnoentError(undefined)).toBe(false);
  });
});

describe('isReadPolicyLimitError', () => {
  it('matches total read limit', () => {
    expect(isReadPolicyLimitError('total read limit reached')).toBe(true);
  });

  it('matches read loop', () => {
    expect(isReadPolicyLimitError('Read loop detected')).toBe(true);
  });

  it('does not match other errors', () => {
    expect(isReadPolicyLimitError('file not found')).toBe(false);
    expect(isReadPolicyLimitError(undefined)).toBe(false);
  });
});

describe('isBashLoopError', () => {
  it('matches bash loop', () => {
    expect(isBashLoopError('Bash loop detected')).toBe(true);
  });

  it('does not match other errors', () => {
    expect(isBashLoopError('command failed')).toBe(false);
    expect(isBashLoopError(undefined)).toBe(false);
  });
});
