import {
  applyEventToRunState,
  compressChanges,
  compressTimeline,
  createBlockedRunStateSnapshot,
  createInitialRunStateSnapshot,
} from '../agent/tui-state';

describe('tui-state', () => {
  it('creates a blocked startup snapshot for missing configuration', () => {
    const state = createBlockedRunStateSnapshot(0, 'Configuration required', 'configure provider.model');

    expect(state.phase).toBe('blocked');
    expect(state.objective.label).toBe('Configuration required');
    expect(state.objective.nextCheckpoint).toBe('configure provider.model');
    expect(state.terminal).toBe('blocked');
  });

  it('transitions through model and tool phases', () => {
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
        task: 'update renderer',
      },
      1,
    );
    expect(state.phase).toBe('thinking');

    state = applyEventToRunState(
      state,
      {
        type: 'tool_started',
        timestamp: new Date(1).toISOString(),
        toolCallId: '1',
        toolName: 'read',
        summary: '{"path":"src/agent/renderers.ts"}',
      },
      2,
    );
    expect(state.phase).toBe('tool_execution');
    expect(state.changes.items).toEqual([]);
    expect(state.toolInvocationCount).toBe(1);

    state = applyEventToRunState(
      state,
      {
        type: 'tool_finished',
        timestamp: new Date(2).toISOString(),
        toolCallId: '1',
        toolName: 'read',
        summary: 'completed',
        status: 'ok',
      },
      3,
    );
    expect(state.phase).toBe('thinking');
  });

  it('records compact model step progress and assistant notes', () => {
    let state = createInitialRunStateSnapshot(0);

    state = applyEventToRunState(
      state,
      {
        type: 'model_step_started',
        timestamp: new Date(1).toISOString(),
        stepIndex: 1,
      },
      1,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'assistant_message',
        timestamp: new Date(2).toISOString(),
        content: 'Inspecting the TUI state reducer before editing.',
      },
      2,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'model_step_started',
        timestamp: new Date(3).toISOString(),
        stepIndex: 2,
      },
      3,
    );

    expect(state.lastModelOutput).toBe('Inspecting the TUI state reducer before editing.');
    expect(state.timeline.map((item) => item.summary)).toEqual([
      'Working · step 1',
      'Working · Inspecting the TUI state reducer before editing.',
      'Working · step 2',
    ]);
  });

  it('does not treat terminal tool errors as running verification', () => {
    let state = createInitialRunStateSnapshot(0);

    state = applyEventToRunState(
      state,
      {
        type: 'task_finished',
        timestamp: new Date(1).toISOString(),
        status: 'tool_error',
        toolCalls: 1,
        maxToolCalls: 1,
        modelSteps: 1,
        maxModelSteps: 1,
        changedFiles: [],
        workingTreeClean: true,
        verification: 'unsafe path rejected: .synax.toml',
        error: 'unsafe path rejected: .synax.toml',
      },
      1,
    );

    expect(state.terminal).toBe('failed');
    expect(state.phase).toBe('error');
    expect(state.verification.state).toBe('skipped');
  });

  it('does not classify provider errors containing "passed back" as passed verification', () => {
    let state = createInitialRunStateSnapshot(0);

    state = applyEventToRunState(
      state,
      {
        type: 'task_finished',
        timestamp: new Date(1).toISOString(),
        status: 'model_error',
        toolCalls: 0,
        maxToolCalls: 192,
        modelSteps: 1,
        maxModelSteps: 64,
        changedFiles: [],
        workingTreeClean: true,
        verification: 'Provider error: reasoning_content must be passed back to the model',
        error: 'Provider error: reasoning_content must be passed back to the model',
      },
      1,
    );

    expect(state.terminal).toBe('failed');
    expect(state.phase).toBe('error');
    expect(state.verification.state).toBe('skipped');
  });

  it('records model responses and tool calls in a debug history', () => {
    let state = createInitialRunStateSnapshot(0);

    state = applyEventToRunState(
      state,
      {
        type: 'assistant_message',
        timestamp: new Date(1).toISOString(),
        content: '<thinking>checking status</thinking>\nI will inspect git status.',
      },
      1,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'tool_started',
        timestamp: new Date(2).toISOString(),
        toolCallId: 'call_1',
        toolName: 'bash',
        summary: '{"command":"git status --short"}',
      },
      2,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'tool_finished',
        timestamp: new Date(3).toISOString(),
        toolCallId: 'call_1',
        toolName: 'bash',
        summary: 'completed',
        status: 'ok',
        detail: 'stdout:\n M src/tui/layout.ts',
      },
      3,
    );

    expect(state.debugHistory.map((item) => item.kind)).toEqual(['model', 'tool_call', 'tool_result']);
    expect(state.debugHistory[0].detail).toContain('checking status');
    expect(state.debugHistory[1].detail).toContain('git status --short');
    expect(state.debugHistory[2].detail).toContain('M src/tui/layout.ts');
  });

  it('appends streaming assistant deltas into one model transcript entry', () => {
    let state = createInitialRunStateSnapshot(0);

    state = applyEventToRunState(
      state,
      { type: 'assistant_delta', timestamp: new Date(1).toISOString(), reasoningContent: 'checking ' },
      1,
    );
    state = applyEventToRunState(
      state,
      { type: 'assistant_delta', timestamp: new Date(2).toISOString(), reasoningContent: 'files\n' },
      2,
    );
    state = applyEventToRunState(
      state,
      { type: 'assistant_delta', timestamp: new Date(3).toISOString(), content: 'I will read package.json.' },
      3,
    );

    expect(state.debugHistory).toHaveLength(1);
    expect(state.debugHistory[0].kind).toBe('model');
    expect(state.debugHistory[0].detail).toBe('checking files\nI will read package.json.');
  });

  it('records a terminal completion summary', () => {
    let state = createInitialRunStateSnapshot(0);
    state = applyEventToRunState(
      state,
      {
        type: 'assistant_message',
        timestamp: new Date(2).toISOString(),
        content: 'There are no unstaged changes on this branch.',
      },
      3,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'task_finished',
        timestamp: new Date(3).toISOString(),
        status: 'completed',
        toolCalls: 2,
        maxToolCalls: 10,
        modelSteps: 3,
        maxModelSteps: 10,
        changedFiles: ['src/tui/layout.ts', 'src/agent/tui-state.ts'],
        workingTreeClean: true,
        verification: 'npm test passed',
      },
      4,
    );

    expect(state.statusNote).toBe('completed: 3 model steps, 2 tool calls, 2 files changed');
    expect(state.lastModelOutput).toBe('There are no unstaged changes on this branch.');
  });

  it('separates files changed this run from working tree cleanliness and tool invocations', () => {
    let state = createInitialRunStateSnapshot(0);

    state = applyEventToRunState(
      state,
      {
        type: 'tool_started',
        timestamp: new Date(1).toISOString(),
        toolCallId: 'read-1',
        toolName: 'read',
        summary: '{"path":"src/tui/layout.ts"}',
      },
      1,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'tool_started',
        timestamp: new Date(2).toISOString(),
        toolCallId: 'edit-1',
        toolName: 'edit',
        summary: '{"path":"src/tui/layout.ts"}',
      },
      2,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'patch_preview',
        timestamp: new Date(2).toISOString(),
        toolCallId: 'edit-1',
        toolName: 'edit',
        path: 'src/tui/layout.ts',
        diff: '--- src/tui/layout.ts\n+++ src/tui/layout.ts\n-old\n+new',
      },
      2,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'tool_finished',
        timestamp: new Date(2).toISOString(),
        toolCallId: 'edit-1',
        toolName: 'edit',
        summary: 'completed',
        status: 'ok',
      },
      2,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'task_finished',
        timestamp: new Date(3).toISOString(),
        status: 'completed',
        toolCalls: 2,
        maxToolCalls: 10,
        modelSteps: 1,
        maxModelSteps: 10,
        changedFiles: ['src/tui/layout.ts'],
        workingTreeClean: true,
        verification: 'npm test passed',
      },
      3,
    );

    expect(state.toolInvocationCount).toBe(2);
    expect(state.filesChangedThisRun).toEqual(['src/tui/layout.ts']);
    expect(state.workingTreeClean).toBe(true);
    expect(state.changes.items).toEqual([{ path: 'src/tui/layout.ts', op: 'edit' }]);
    expect(state.statusNote).toBe('completed: 1 model step, 2 tool calls, 1 file changed');
  });

  it('records patch previews for TUI rendering before an edit is applied', () => {
    let state = createInitialRunStateSnapshot(0);
    state = applyEventToRunState(
      state,
      {
        type: 'patch_preview',
        timestamp: new Date(1).toISOString(),
        toolCallId: 'call_1',
        toolName: 'edit',
        path: 'src/tui/layout.ts',
        diff: '--- src/tui/layout.ts\n+++ src/tui/layout.ts\n-old\n+new',
      },
      2,
    );

    expect(state.changes.items[state.changes.items.length - 1]).toEqual({
      op: 'edit',
      path: 'src/tui/layout.ts',
    });
    expect(state.patchPreview).toEqual({
      path: 'src/tui/layout.ts',
      diff: '--- src/tui/layout.ts\n+++ src/tui/layout.ts\n-old\n+new',
    });
  });

  it('maps failed verification to S2 risk line', () => {
    let state = createInitialRunStateSnapshot(0);
    state = applyEventToRunState(
      state,
      {
        type: 'task_finished',
        timestamp: new Date(3).toISOString(),
        status: 'failed_verification',
        toolCalls: 2,
        maxToolCalls: 10,
        modelSteps: 2,
        maxModelSteps: 10,
        changedFiles: ['src/a.ts'],
        verification: 'npm test failed',
      },
      4,
    );
    expect(state.verification.state).toBe('failed');
    expect(state.severity === 'S2' || state.severity === 'S3').toBe(true);
  });

  it('verification lifecycle: planned → running → passed', () => {
    let state = createInitialRunStateSnapshot(0);
    expect(state.verification.state).toBe('planned');
    expect(state.verification.checksPlanned).toBe(0);
    expect(state.verification.checksRunning).toBe(0);
    expect(state.verification.checksPassed).toBe(0);

    state = applyEventToRunState(
      state,
      {
        type: 'verification_planned',
        timestamp: new Date(1).toISOString(),
        checkId: 'chk-1',
        checkLabel: 'npm test',
        command: 'npm test',
        summary: '3 file(s) changed',
      },
      2,
    );
    expect(state.verification.state).toBe('planned');
    expect(state.verification.checksPlanned).toBe(1);
    expect(state.verification.currentCheckLabel).toBe('npm test');
    expect(state.phase).toBe('verifying');

    state = applyEventToRunState(
      state,
      {
        type: 'verification_started',
        timestamp: new Date(3).toISOString(),
        checkId: 'chk-1',
        checkLabel: 'npm test',
        command: 'npm test',
      },
      4,
    );
    expect(state.verification.state).toBe('running');
    expect(state.verification.checksPlanned).toBe(0);
    expect(state.verification.checksRunning).toBe(1);

    state = applyEventToRunState(
      state,
      {
        type: 'verification_passed',
        timestamp: new Date(5).toISOString(),
        checkId: 'chk-1',
        checkLabel: 'npm test',
        summary: 'all tests passed',
        durationMs: 1234,
      },
      6,
    );
    expect(state.verification.state).toBe('passed');
    expect(state.verification.checksPassed).toBe(1);
    expect(state.verification.checksRunning).toBe(0);
    expect(state.verification.summary).toContain('all tests passed');
    expect(state.verification.summary).toContain('1.2s');
  });

  it('failed verification escalates severity to S2', () => {
    let state = createInitialRunStateSnapshot(0);
    state = applyEventToRunState(
      state,
      {
        type: 'verification_planned',
        timestamp: new Date(1).toISOString(),
        checkId: 'chk-1',
        checkLabel: 'npm test',
        summary: 'planned',
      },
      1,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'verification_started',
        timestamp: new Date(2).toISOString(),
        checkId: 'chk-1',
        checkLabel: 'npm test',
      },
      2,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'verification_failed',
        timestamp: new Date(3).toISOString(),
        checkId: 'chk-1',
        checkLabel: 'npm test',
        summary: '2 tests failed',
        severity: 'S2',
        durationMs: 500,
      },
      3,
    );
    expect(state.verification.state).toBe('failed');
    expect(state.verification.checksFailed).toBe(1);
    expect(state.verification.checksPassed).toBe(0);
    const hasS2OrS3 = state.severity === 'S2' || state.severity === 'S3';
    expect(hasS2OrS3).toBe(true);
    expect(state.riskLine).toContain('verification failed');
    expect(state.phase).toBe('verifying');
  });

  it('multiple verification checks compress correctly', () => {
    let state = createInitialRunStateSnapshot(0);

    // Check 1: planned → started → passed
    state = applyEventToRunState(
      state,
      {
        type: 'verification_planned',
        timestamp: new Date(1).toISOString(),
        checkId: 'chk-1',
        checkLabel: 'npm test',
        summary: 'first check',
      },
      1,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'verification_started',
        timestamp: new Date(2).toISOString(),
        checkId: 'chk-1',
        checkLabel: 'npm test',
      },
      2,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'verification_passed',
        timestamp: new Date(3).toISOString(),
        checkId: 'chk-1',
        checkLabel: 'npm test',
        summary: 'ok',
      },
      3,
    );
    expect(state.verification.checksPassed).toBe(1);

    // Check 2: planned → started → failed
    state = applyEventToRunState(
      state,
      {
        type: 'verification_planned',
        timestamp: new Date(4).toISOString(),
        checkId: 'chk-2',
        checkLabel: 'npm run lint',
        summary: 'second check',
      },
      4,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'verification_started',
        timestamp: new Date(5).toISOString(),
        checkId: 'chk-2',
        checkLabel: 'npm run lint',
      },
      5,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'verification_failed',
        timestamp: new Date(6).toISOString(),
        checkId: 'chk-2',
        checkLabel: 'npm run lint',
        summary: 'lint errors',
        severity: 'S2',
      },
      6,
    );

    // Aggregate: 1 passed + 1 failed
    expect(state.verification.state).toBe('failed');
    expect(state.verification.checksPlanned).toBe(0);
    expect(state.verification.checksRunning).toBe(0);
    expect(state.verification.checksPassed).toBe(1);
    expect(state.verification.checksFailed).toBe(1);
    expect(state.verification.checksSkipped).toBe(0);
  });

  it('handles repeated verification events idempotently', () => {
    let state = createInitialRunStateSnapshot(0);

    // Duplicate planned events with same checkId should not double-count
    state = applyEventToRunState(
      state,
      {
        type: 'verification_planned',
        timestamp: new Date(1).toISOString(),
        checkId: 'chk-1',
        checkLabel: 'npm test',
      },
      1,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'verification_planned',
        timestamp: new Date(2).toISOString(),
        checkId: 'chk-1',
        checkLabel: 'npm test',
      },
      2,
    );
    expect(state.verification.checksPlanned).toBe(1);
    expect(state.verification.seenCheckIds.size).toBe(1);

    // Different checkId should increment
    state = applyEventToRunState(
      state,
      {
        type: 'verification_planned',
        timestamp: new Date(3).toISOString(),
        checkId: 'chk-2',
        checkLabel: 'npm run lint',
      },
      3,
    );
    expect(state.verification.checksPlanned).toBe(2);
  });

  it('verification_skipped counts correctly', () => {
    let state = createInitialRunStateSnapshot(0);
    state = applyEventToRunState(
      state,
      {
        type: 'verification_skipped',
        timestamp: new Date(1).toISOString(),
        checkId: 'chk-1',
        checkLabel: 'npm test',
        summary: 'no verification command configured',
      },
      1,
    );
    expect(state.verification.state).toBe('planned');
    expect(state.verification.checksSkipped).toBe(1);
    expect(state.verification.seenCheckIds.has('chk-1')).toBe(true);
  });

  it('compresses timeline and change lists deterministically', () => {
    const timeline = compressTimeline(
      Array.from({ length: 16 }, (_, i) => ({
        atMs: i,
        phase: 'thinking' as const,
        summary: `s${i}`,
        severity: 'S0' as const,
      })),
      10,
    );
    expect(timeline).toHaveLength(10);
    expect(timeline[0]?.summary).toBe('s6');

    const changes = compressChanges(
      [
        { path: 'a.ts', op: 'edit' as const },
        { path: 'a.ts', op: 'edit' as const },
        { path: 'b.ts', op: 'read' as const },
      ],
      1,
    );
    expect(changes.items).toHaveLength(1);
    expect(changes.overflowCount).toBe(1);
  });

  it('does not count failed edit tools as file changes', () => {
    let state = createInitialRunStateSnapshot(0);

    state = applyEventToRunState(
      state,
      {
        type: 'tool_started',
        timestamp: new Date(1).toISOString(),
        toolCallId: 'edit-fail',
        toolName: 'edit',
        summary: '{"path":".synax.toml"}',
      },
      1,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'tool_finished',
        timestamp: new Date(2).toISOString(),
        toolCallId: 'edit-fail',
        toolName: 'edit',
        summary: 'oldStr must match a prior read of .synax.toml',
        status: 'error',
      },
      2,
    );

    // No changes should be tracked for a failed edit.
    expect(state.changes.items).toEqual([]);
    expect(state.toolInvocationCount).toBe(1);
  });

  it('does not label failed edits as recovered with turbulence', () => {
    let state = createInitialRunStateSnapshot(0);

    state = applyEventToRunState(
      state,
      {
        type: 'tool_finished',
        timestamp: new Date(1).toISOString(),
        toolCallId: 'edit-fail',
        toolName: 'edit',
        summary: 'oldStr must match a prior read of .synax.toml',
        status: 'error',
      },
      1,
    );

    // Must NOT claim recovery; must surface the actual error.
    expect(state.statusNote).not.toContain('recovered');
    expect(state.statusNote).toContain('error:');
    expect(state.statusNote).toContain('oldStr must match a prior read');
  });

  it('labels successful retry after an edit failure as recovered', () => {
    let state = createInitialRunStateSnapshot(0);

    // Failed edit attempt
    state = applyEventToRunState(
      state,
      {
        type: 'tool_started',
        timestamp: new Date(1).toISOString(),
        toolCallId: 'edit-1',
        toolName: 'edit',
        summary: '{"path":"src/a.ts"}',
      },
      1,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'tool_finished',
        timestamp: new Date(2).toISOString(),
        toolCallId: 'edit-1',
        toolName: 'edit',
        summary: 'oldStr does not match',
        status: 'error',
      },
      2,
    );

    // Successful retry with a new tool call
    state = applyEventToRunState(
      state,
      {
        type: 'tool_started',
        timestamp: new Date(3).toISOString(),
        toolCallId: 'edit-2',
        toolName: 'edit',
        summary: '{"path":"src/a.ts"}',
      },
      3,
    );
    state = applyEventToRunState(
      state,
      {
        type: 'tool_finished',
        timestamp: new Date(4).toISOString(),
        toolCallId: 'edit-2',
        toolName: 'edit',
        summary: 'completed',
        status: 'ok',
        detail: '{"success":true,"toolName":"edit","output":{"path":"src/a.ts"}}',
      },
      4,
    );

    // The successful retry should be tracked as a change.
    expect(state.changes.items).toEqual([{ path: 'src/a.ts', op: 'edit' }]);
  });

  it('surfaces the actual tool error as a blocker in the final failed run summary', () => {
    let state = createInitialRunStateSnapshot(0);

    state = applyEventToRunState(
      state,
      {
        type: 'task_finished',
        timestamp: new Date(1).toISOString(),
        status: 'tool_error',
        toolCalls: 1,
        maxToolCalls: 192,
        modelSteps: 1,
        maxModelSteps: 64,
        changedFiles: [],
        verification: 'not run',
        error: 'oldStr must match a prior read of .synax.toml',
      },
      1,
    );

    expect(state.terminal).toBe('failed');
    expect(state.terminalIssue).toContain('oldStr must match a prior read');
    expect(state.riskLine).toContain('blocker:');
    expect(state.riskLine).toContain('oldStr must match a prior read');
    expect(state.filesChangedThisRun).toEqual([]);
  });

  it('retains the full terminal issue while keeping the risk line clipped', () => {
    let state = createInitialRunStateSnapshot(0);
    const longError = `Provider error (400): ${'DeepSeek context overflow. '.repeat(30)}`;

    state = applyEventToRunState(
      state,
      {
        type: 'task_finished',
        timestamp: new Date(1).toISOString(),
        status: 'model_error',
        toolCalls: 8,
        maxToolCalls: 192,
        modelSteps: 3,
        maxModelSteps: 64,
        changedFiles: [],
        verification: 'not run',
        error: longError,
      },
      1,
    );

    expect(state.riskLine.length).toBeLessThanOrEqual(123);
    expect(state.terminalIssue).toBe(longError);
  });
});
