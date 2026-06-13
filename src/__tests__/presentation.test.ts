import { createInitialPresentationState, reduceEvents } from '../presentation';
import type { AgentEvent } from '../agent/events';

function ts(iso: string): string {
  return iso;
}

describe('PresentationState reducer', () => {
  it('starts empty', () => {
    const state = createInitialPresentationState();
    expect(state.blocks).toHaveLength(0);
    expect(state.streamingText).toBe('');
  });

  it('handles empty event array', () => {
    const state = reduceEvents([]);
    expect(state.blocks).toHaveLength(0);
  });

  it('reduces task_started to runtime_status blocks', () => {
    const events: AgentEvent[] = [
      {
        type: 'task_started',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        mode: 'patch',
        profile: 'default',
        endpoint: 'https://api.anthropic.com',
        model: 'frontier-sonnet-4-20250514',
        providerName: 'Anthropic',
        contextBudgetTokens: 32000,
        maxModelSteps: 16,
        maxToolCalls: 64,
        tools: ['read', 'edit', 'write', 'bash'],
        task: 'Update the README',
      },
    ];
    const state = reduceEvents(events);
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[0]).toMatchObject({
      kind: 'runtime_status',
      label: 'model',
      priority: 'line',
    });
    expect(state.blocks[1]).toMatchObject({
      kind: 'runtime_status',
      label: 'mode',
      value: 'patch',
    });
  });

  it('reduces assistant_message to model_output block', () => {
    const events: AgentEvent[] = [
      {
        type: 'task_started',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        mode: 'patch',
        profile: 'default',
        endpoint: 'local',
        model: 'local',
        providerName: 'Relay',
        contextBudgetTokens: 32000,
        maxModelSteps: 16,
        maxToolCalls: 64,
        tools: [],
        task: 'test',
      },
      {
        type: 'assistant_message',
        timestamp: ts('2026-01-01T00:00:01.000Z'),
        content: '<thinking>thinking...</thinking>Here is my answer.',
      },
    ];
    const state = reduceEvents(events);
    const modelBlocks = state.blocks.filter((b) => b.kind === 'model_output');
    expect(modelBlocks).toHaveLength(1);
    if (modelBlocks[0]?.kind === 'model_output') {
      expect(modelBlocks[0].role).toBe('primary');
      // Think block should be stripped
      expect(modelBlocks[0].text).not.toContain('thinking');
    }
  });

  it('drops assistant_message content that is only a stray closing think tag', () => {
    const state = reduceEvents([
      {
        type: 'assistant_message',
        timestamp: ts('2026-01-01T00:00:01.000Z'),
        content: '</think>',
      },
    ]);

    expect(state.blocks.filter((b) => b.kind === 'model_output')).toHaveLength(0);
  });

  it('clears assistant streaming text at tool boundaries', () => {
    const state = reduceEvents([
      {
        type: 'assistant_delta',
        timestamp: ts('2026-01-01T00:00:01.000Z'),
        reasoningContent: 'checking repo',
      },
      {
        type: 'tool_started',
        timestamp: ts('2026-01-01T00:00:02.000Z'),
        toolCallId: 'call-1',
        toolName: 'bash',
        summary: '{"command":"git status --short"}',
      },
      {
        type: 'tool_finished',
        timestamp: ts('2026-01-01T00:00:03.000Z'),
        toolCallId: 'call-1',
        toolName: 'bash',
        summary: 'completed',
        status: 'ok',
      },
      {
        type: 'assistant_delta',
        timestamp: ts('2026-01-01T00:00:04.000Z'),
        reasoningContent: 'checking stashes',
      },
    ]);

    expect(state.streamingText).toBe('checking stashes');
  });

  it('replaces orchestration block in-place on child events', () => {
    const orchestrationEvent: AgentEvent = {
      type: 'orchestration_plan_generated',
      timestamp: ts('2026-01-01T00:00:00.000Z'),
      payload: {
        sessionId: 's1',
        task: 'Refactor module',
        plan: {
          strategy: 'decompose',
          subTasks: [
            {
              id: 'a',
              description: 'Extract constants',
              fileScope: [],
              dependencies: [],
              estimatedBudget: 8000,
              verification: { level: 'files_changed', label: 'extract' },
            },
            {
              id: 'b',
              description: 'Update tests',
              fileScope: [],
              dependencies: ['a'],
              estimatedBudget: 8000,
              verification: { level: 'files_changed', label: 'test' },
            },
          ],
          estimatedTotalTokens: 32000,
          repoMetadata: { fileCount: 100, totalKB: 500, sourceKB: 300 },
          contextWindowTokens: 128000,
        },
      },
    };
    const state = reduceEvents([orchestrationEvent]);
    expect(state.blocks).toHaveLength(1);
    const block = state.blocks[0];
    if (block?.kind !== 'orchestration') throw new Error('expected orchestration');
    expect(block.subAgents).toHaveLength(2);
    expect(block.subAgents[0]?.phase).toBe('pending');
  });

  it('does not emit orchestration block for inline plans', () => {
    const event: AgentEvent = {
      type: 'orchestration_plan_generated',
      timestamp: ts('2026-01-01T00:00:00.000Z'),
      payload: {
        sessionId: 's1',
        task: 'Simple task',
        plan: { inline: true },
      },
    };
    const state = reduceEvents([event]);
    expect(state.blocks).toHaveLength(0);
  });

  it('handles tool lifecycle', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool_started',
        timestamp: ts('2026-01-01T00:00:01.000Z'),
        toolCallId: 'call1',
        toolName: 'read',
        summary: 'Reading file',
        detail: '{"path":"src/foo.ts"}',
      },
      {
        type: 'tool_finished',
        timestamp: ts('2026-01-01T00:00:02.000Z'),
        toolCallId: 'call1',
        toolName: 'read',
        summary: 'completed',
        status: 'ok',
        detail: '{"output":{}}',
      },
    ];
    const state = reduceEvents(events);
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[0]).toMatchObject({ kind: 'tool_activity', phase: 'started', toolName: 'read' });
    expect(state.blocks[1]).toMatchObject({ kind: 'tool_activity', phase: 'completed', toolName: 'read' });
  });

  it('handles task_finished with summary', () => {
    const events: AgentEvent[] = [
      {
        type: 'task_started',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        mode: 'patch',
        profile: 'default',
        endpoint: 'local',
        model: 'test',
        providerName: 'Local',
        contextBudgetTokens: 32000,
        maxModelSteps: 16,
        maxToolCalls: 64,
        tools: [],
        task: 'test',
      },
      {
        type: 'task_finished',
        timestamp: ts('2026-01-01T00:00:10.000Z'),
        status: 'completed',
        toolCalls: 3,
        maxToolCalls: 64,
        modelSteps: 2,
        maxModelSteps: 16,
        changedFiles: ['src/test.ts'],
        workingTreeClean: true,
        verification: 'passed',
      },
    ];
    const state = reduceEvents(events);
    const summaryBlocks = state.blocks.filter((b) => b.kind === 'runtime_status' && b.label === 'summary');
    expect(summaryBlocks).toHaveLength(1);
    if (summaryBlocks[0]?.kind === 'runtime_status') {
      expect(summaryBlocks[0].value).toContain('completed');
      expect(summaryBlocks[0].value).toContain('3 tool calls');
    }
  });

  it('handles verification lifecycle', () => {
    const events: AgentEvent[] = [
      {
        type: 'verification_planned',
        timestamp: ts('2026-01-01T00:00:01.000Z'),
        checkId: 'c1',
        checkLabel: 'npm test',
        summary: 'Run npm test',
      },
      {
        type: 'verification_started',
        timestamp: ts('2026-01-01T00:00:02.000Z'),
        checkId: 'c1',
        checkLabel: 'npm test',
      },
      {
        type: 'verification_passed',
        timestamp: ts('2026-01-01T00:00:05.000Z'),
        checkId: 'c1',
        checkLabel: 'npm test',
        durationMs: 3000,
      },
    ];
    const state = reduceEvents(events);
    const toolBlocks = state.blocks.filter((b) => b.kind === 'tool_activity' && b.toolName === 'run_verification');
    // started + completed
    expect(toolBlocks.length).toBeGreaterThanOrEqual(2);
  });

  it('handles local_shell_command', () => {
    const events: AgentEvent[] = [
      {
        type: 'local_shell_command',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        command: 'npm test',
        exitCode: 0,
        durationMs: 1500,
        stdout: 'PASS',
        stderr: '',
      },
    ];
    const state = reduceEvents(events);
    expect(state.blocks).toHaveLength(1);
    const block = state.blocks[0];
    if (block?.kind !== 'shell_command') throw new Error('expected shell_command');
    expect(block.command).toBe('npm test');
    expect(block.exitCode).toBe(0);
    expect(block.stdout).toBe('PASS');
  });

  it('handles error events', () => {
    const events: AgentEvent[] = [
      {
        type: 'error',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        message: 'Connection refused',
      },
    ];
    const state = reduceEvents(events);
    const errorStatus = state.blocks.filter((b) => b.kind === 'runtime_status' && b.label === 'error');
    expect(errorStatus.length).toBeGreaterThanOrEqual(1);
    expect(state.blocks.filter((b) => b.kind === 'debug_detail' && b.tag === 'error')).toHaveLength(1);
  });

  it('handles token_usage', () => {
    const events: AgentEvent[] = [
      {
        type: 'token_usage',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        inputTokens: 500,
        outputTokens: 200,
        estimatedCost: 0.003,
      },
    ];
    const state = reduceEvents(events);
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ kind: 'runtime_status', label: 'tokens' });
  });

  it('handles SynaxEvent lifecycle events', () => {
    const state = reduceEvents([
      {
        type: 'session_start',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        mode: 'patch',
        model: 'frontier',
      },
    ]);
    expect(state.blocks.filter((b) => b.kind === 'debug_detail' && b.tag === 'lifecycle')).toHaveLength(1);
  });

  it('handles pre_tool_use control hook', () => {
    const state = reduceEvents([
      {
        type: 'pre_tool_use',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        stepIndex: 1,
        toolCallId: 'call_1',
        toolName: 'bash',
        arguments: { command: 'ls' },
      },
    ]);
    expect(state.blocks.filter((b) => b.kind === 'debug_detail' && b.tag === 'control_hook')).toHaveLength(1);
  });

  it('produces deterministic output for identical events', () => {
    const events: AgentEvent[] = [
      {
        type: 'task_started',
        timestamp: '2026-01-01T00:00:00.000Z',
        mode: 'patch',
        profile: 'default',
        endpoint: 'local',
        model: 'test',
        providerName: 'Local',
        contextBudgetTokens: 32000,
        maxModelSteps: 16,
        maxToolCalls: 64,
        tools: [],
        task: 'test',
      },
      {
        type: 'tool_started',
        timestamp: '2026-01-01T00:00:01.000Z',
        toolCallId: 'c1',
        toolName: 'read',
        summary: 'read file',
        detail: '{"path":"a.ts"}',
      },
      {
        type: 'tool_finished',
        timestamp: '2026-01-01T00:00:02.000Z',
        toolCallId: 'c1',
        toolName: 'read',
        summary: 'ok',
        status: 'ok',
      },
      {
        type: 'task_finished',
        timestamp: '2026-01-01T00:00:10.000Z',
        status: 'completed',
        toolCalls: 1,
        maxToolCalls: 64,
        modelSteps: 1,
        maxModelSteps: 16,
        changedFiles: [],
        workingTreeClean: true,
        verification: 'passed',
      },
    ];
    const state1 = reduceEvents(events);
    const state2 = reduceEvents(events);
    expect(state1).toEqual(state2);
  });

  it('has no orchestration blocks when no orchestration events fire', () => {
    const events: AgentEvent[] = [
      {
        type: 'task_started',
        timestamp: '2026-01-01T00:00:00.000Z',
        mode: 'patch',
        profile: 'default',
        endpoint: 'local',
        model: 'test',
        providerName: 'Local',
        contextBudgetTokens: 32000,
        maxModelSteps: 16,
        maxToolCalls: 64,
        tools: [],
        task: 'test',
      },
      { type: 'assistant_message', timestamp: '2026-01-01T00:00:01.000Z', content: 'Done.' },
      {
        type: 'task_finished',
        timestamp: '2026-01-01T00:00:02.000Z',
        status: 'completed',
        toolCalls: 0,
        maxToolCalls: 64,
        modelSteps: 1,
        maxModelSteps: 16,
        changedFiles: [],
        workingTreeClean: true,
        verification: 'passed',
      },
    ];
    const state = reduceEvents(events);
    expect(state.blocks.filter((b) => b.kind === 'orchestration')).toHaveLength(0);
  });

  // ── child_session → agentPanes ─────────────────────────────────
  it('child_session_spawned adds an agent pane', () => {
    const events: any[] = [
      {
        type: 'child_session_spawned',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        parentSessionId: 'parent-1',
        childSessionId: 'child-a1',
        subtaskId: 'a1',
        model: 'qwen-7b',
        task: 'Scan files',
      },
    ];
    const state = reduceEvents(events);
    expect(state.agentPanes).toHaveLength(1);
    expect(state.agentPanes[0]).toMatchObject({
      id: 'child-a1',
      role: 'a1',
      phase: 'active',
    });
  });

  it('child_session_completed updates agent pane with finding and changedFiles', () => {
    const events: any[] = [
      {
        type: 'child_session_spawned',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        parentSessionId: 'parent-1',
        childSessionId: 'child-a1',
        subtaskId: 'a1',
        model: 'qwen-7b',
      },
      {
        type: 'child_session_completed',
        timestamp: ts('2026-01-01T00:00:01.000Z'),
        sessionId: 'child-a1',
        parentSessionId: 'parent-1',
        childSessionId: 'child-a1',
        subtaskId: 'a1',
        model: 'qwen-7b',
        result: {
          terminalState: 'completed',
          toolCalls: 5,
          changedFiles: ['src/index.ts'],
        },
      },
    ];
    const state = reduceEvents(events);
    expect(state.agentPanes).toHaveLength(1);
    expect(state.agentPanes[0]).toMatchObject({
      phase: 'completed',
      finding: '5 tool calls · 1 files',
    });
  });

  it('child_session_failed updates agent pane with error', () => {
    const events: any[] = [
      {
        type: 'child_session_spawned',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        parentSessionId: 'parent-1',
        childSessionId: 'child-a2',
        subtaskId: 'a2',
        model: 'qwen-7b',
      },
      {
        type: 'child_session_failed',
        timestamp: ts('2026-01-01T00:00:01.000Z'),
        sessionId: 'child-a2',
        parentSessionId: 'parent-1',
        childSessionId: 'child-a2',
        subtaskId: 'a2',
        model: 'qwen-7b',
        error: 'timeout after 30s',
      },
    ];
    const state = reduceEvents(events);
    expect(state.agentPanes).toHaveLength(1);
    expect(state.agentPanes[0].phase).toBe('failed');
    expect(state.agentPanes[0].lastAction).toContain('timeout');
  });

  it('child_session events grow agentPanes array', () => {
    const events: any[] = [
      {
        type: 'child_session_spawned',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        parentSessionId: 'parent-1',
        childSessionId: 'child-a1',
        subtaskId: 'a1',
      },
      {
        type: 'child_session_spawned',
        timestamp: ts('2026-01-01T00:00:01.000Z'),
        parentSessionId: 'parent-1',
        childSessionId: 'child-a2',
        subtaskId: 'a2',
      },
      {
        type: 'child_session_spawned',
        timestamp: ts('2026-01-01T00:00:02.000Z'),
        parentSessionId: 'parent-1',
        childSessionId: 'child-a3',
        subtaskId: 'a3',
      },
    ];
    const state = reduceEvents(events);
    expect(state.agentPanes).toHaveLength(3);
  });

  // ── memory_decision → MemoryDecisionView ───────────────────────
  it('memory_decision creates memory decision with used disposition', () => {
    const events: any[] = [
      {
        type: 'memory_decision',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        queryType: 'project',
        queryKey: 'synax/tui-symbols',
        disposition: 'used',
        reason: 'relevant',
        provenance: 'session-abc',
      },
    ];
    const state = reduceEvents(events);
    expect(state.memoryDecisions).toHaveLength(1);
    expect(state.memoryDecisions[0]).toMatchObject({
      label: 'project: synax/tui-symbols',
      disposition: 'used',
      reason: 'relevant',
    });
  });

  it('memory_decision with rejected disposition', () => {
    const events: any[] = [
      {
        type: 'memory_decision',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        queryType: 'cwd',
        queryKey: '.',
        disposition: 'rejected',
        reason: 'stale',
        provenance: 'old-session',
        conflict: true,
        stale: true,
      },
    ];
    const state = reduceEvents(events);
    expect(state.memoryDecisions).toHaveLength(1);
    expect(state.memoryDecisions[0].disposition).toBe('rejected');
    expect(state.memoryDecisions[0].conflict).toBe(true);
    expect(state.memoryDecisions[0].stale).toBe(true);
  });

  it('memory_decision with quarantined disposition', () => {
    const events: any[] = [
      {
        type: 'memory_decision',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        queryType: 'ports',
        queryKey: '8080:8080',
        disposition: 'quarantined',
        reason: 'untrusted memory source',
        provenance: 'unknown',
      },
    ];
    const state = reduceEvents(events);
    expect(state.memoryDecisions).toHaveLength(1);
    expect(state.memoryDecisions[0].disposition).toBe('quarantined');
  });

  it('memory_context_injected sets memory decisions from batch', () => {
    const events: any[] = [
      {
        type: 'memory_context_injected',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        decisions: [
          {
            queryType: 'project',
            queryKey: 'synax/tui-symbols',
            disposition: 'used',
            reason: 'relevant',
            provenance: 'session-abc',
          },
          {
            queryType: 'cwd',
            queryKey: '.',
            disposition: 'rejected',
            reason: 'stale',
            provenance: 'old-session',
            conflict: true,
            stale: true,
          },
        ],
      },
    ];
    const state = reduceEvents(events);
    expect(state.memoryDecisions).toHaveLength(2);
    expect(state.memoryDecisions[0].disposition).toBe('used');
    expect(state.memoryDecisions[1].disposition).toBe('rejected');
  });

  // ── handoff events → HandoffPacketView ─────────────────────────
  it('handoff_planned creates a handoff packet', () => {
    const events: any[] = [
      {
        type: 'handoff_planned',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        sourceModel: 'qwen-32b',
        targetModel: 'qwen-7b',
        reason: 'budget exhausted',
        summary: 'Cleanup remaining files',
        includedContextKeys: ['changedFiles'],
        excludedContextKeys: ['rawOutput'],
      },
    ];
    const state = reduceEvents(events);
    expect(state.handoffPackets).toHaveLength(1);
    expect(state.handoffPackets[0]).toMatchObject({
      source: 'qwen-32b',
      target: 'qwen-7b',
      reason: 'budget exhausted',
      summary: 'Cleanup remaining files',
      includedContext: ['changedFiles'],
      excludedContext: ['rawOutput'],
    });
  });

  it('handoff_completed does not crash', () => {
    const events: any[] = [
      {
        type: 'handoff_completed',
        timestamp: ts('2026-01-01T00:00:01.000Z'),
        packetId: 'h1',
        finalState: 'success',
      },
    ];
    const state = reduceEvents(events);
    // No handoff block for completed — just no crash
    expect(state).toBeDefined();
  });

  it('handoff_planned with contextWindowBudgetRemaining includes budget info', () => {
    const events: any[] = [
      {
        type: 'handoff_planned',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        sourceModel: 'qwen-32b',
        targetModel: 'deepseek-6.7b',
        reason: 'budget',
        contextWindowBudgetRemaining: 5000,
        summary: 'Compact then handoff',
        includedContextKeys: ['files'],
        excludedContextKeys: [],
      },
    ];
    const state = reduceEvents(events);
    expect(state.handoffPackets).toHaveLength(1);
    // Budget remaining should be reflected in the reason string
    expect(state.handoffPackets[0].reason).toContain('5000');
  });

  // ── orchestration_plan_generated clears agentPanes ─────────────
  it('orchestration_plan_generated with inline plan clears agentPanes', () => {
    const events: any[] = [
      {
        type: 'child_session_spawned',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        parentSessionId: 'parent-1',
        childSessionId: 'child-a1',
        subtaskId: 'a1',
      },
      {
        type: 'orchestration_plan_generated',
        timestamp: ts('2026-01-01T00:00:01.000Z'),
        profile: 'default',
        payload: {
          plan: { strategy: 'inline', inline: true, subTasks: [] },
        },
      },
    ];
    const state = reduceEvents(events);
    // agentPanes should be cleared on a new orchestration plan
    expect(state.agentPanes).toHaveLength(0);
  });

  it('orchestration_plan_generated with orchestrate plan and child_session updates both', () => {
    const events: any[] = [
      {
        type: 'task_started',
        timestamp: ts('2026-01-01T00:00:00.000Z'),
        mode: 'patch',
        profile: 'default',
        endpoint: 'local',
        model: 'qwen-7b',
        providerName: 'local',
        contextBudgetTokens: 32000,
        maxModelSteps: 16,
        maxToolCalls: 64,
        tools: [],
        task: 'test',
      },
      {
        type: 'orchestration_plan_generated',
        timestamp: ts('2026-01-01T00:00:01.000Z'),
        profile: 'default',
        payload: {
          plan: {
            strategy: 'orchestrate' as const,
            subTasks: [
              { id: 'a1', description: 'Scan files' },
              { id: 'a2', description: 'Fix bugs' },
            ],
          },
        },
      },
      {
        type: 'child_session_spawned',
        timestamp: ts('2026-01-01T00:00:02.000Z'),
        parentSessionId: 'parent-1',
        childSessionId: 'child-a1',
        subtaskId: 'a1',
        model: 'qwen-7b',
        task: 'Scan files',
      },
      {
        type: 'child_session_spawned',
        timestamp: ts('2026-01-01T00:00:03.000Z'),
        parentSessionId: 'parent-1',
        childSessionId: 'child-a2',
        subtaskId: 'a2',
        model: 'qwen-7b',
        task: 'Fix bugs',
      },
    ];
    const state = reduceEvents(events);
    // agentPanes should have both children
    expect(state.agentPanes).toHaveLength(2);
    // The orchestration block should have active phase
    const orch = state.blocks.find((b) => b.kind === 'orchestration');
    expect(orch).toBeDefined();
    if (orch?.kind === 'orchestration') {
      expect(orch.subAgents).toHaveLength(2);
      expect(orch.subAgents[0].phase).toBe('active');
      expect(orch.subAgents[1].phase).toBe('active');
    }
  });
});
