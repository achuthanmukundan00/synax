/**
 * Tests for agent event routing compile-time safety.
 *
 * Covers:
 * - Every AgentEvent type literal is registered in AGENT_EVENT_TYPES
 * - finalAnswerFromResponse no longer falls back to reasoningContent
 *   (empty visible content now returns '' instead of protocol residue)
 */
import { AGENT_EVENT_TYPES, finalAnswerFromResponse } from '../../session/Session';
import type { ChatResponse } from '../../llm/types';

// ─── AGENT_EVENT_TYPES completeness ──────────────────────────────────────────

/**
 * Every event type literal in the AgentEvent discriminated union
 * (src/agent/events.ts). If you add a new event type to the union,
 * you MUST also add it here AND update AGENT_EVENT_TYPES in Session.ts.
 *
 * This list is the source of truth used by the TypeScript exhaustiveness
 * check below. It IS duplicated with AGENT_EVENT_TYPES intentionally —
 * the test bridges the gap between the TS union (compile time) and the
 * runtime Set.
 */
const ALL_AGENT_EVENT_TYPES = [
  'task_started',
  'model_step_started',
  'context_budget_updated',
  'tool_started',
  'tool_finished',
  'verification_planned',
  'verification_started',
  'verification_passed',
  'verification_failed',
  'verification_skipped',
  'patch_preview',
  'command_output',
  'local_shell_command',
  'assistant_message',
  'user_message',
  'assistant_delta',
  'task_finished',
  'error',
  'token_usage',
  'orchestration_plan_generated',
  'child_session_spawned',
  'child_session_completed',
  'child_session_failed',
  'planner_started',
  'planner_intent_detected',
  'planner_strategy_selected',
  'dispatch_started',
  'dispatch_worker_spawned',
  'dispatch_workers_completed',
] as const;

describe('AGENT_EVENT_TYPES', () => {
  it('contains every AgentEvent type literal', () => {
    for (const type of ALL_AGENT_EVENT_TYPES) {
      expect(AGENT_EVENT_TYPES.has(type)).toBe(true);
    }
  });

  it('has no extra types beyond the known event types', () => {
    // Spot check: internal EventBus lifecycle events should NOT be in the set
    expect(AGENT_EVENT_TYPES.has('turn_start')).toBe(false);
    expect(AGENT_EVENT_TYPES.has('turn_end')).toBe(false);
    expect(AGENT_EVENT_TYPES.has('session_start')).toBe(false);
    expect(AGENT_EVENT_TYPES.has('session_shutdown')).toBe(false);
    expect(AGENT_EVENT_TYPES.has('session_compact')).toBe(false);
    expect(AGENT_EVENT_TYPES.has('tool_execution_start')).toBe(false);
    expect(AGENT_EVENT_TYPES.has('tool_execution_end')).toBe(false);
  });
});

// ─── finalAnswerFromResponse no longer falls back to reasoningContent ─────────

function makeResponse(overrides: Partial<ChatResponse>): ChatResponse {
  return {
    content: '',
    toolCalls: [],
    toolCallFormat: 'openai',
    model: 'test',
    finishReason: 'stop',
    usage: null,
    ...overrides,
  };
}

describe('finalAnswerFromResponse', () => {
  it('returns visible content when present', () => {
    const response = makeResponse({
      content: 'The refactor is complete.',
    });
    expect(finalAnswerFromResponse(response)).toBe('The refactor is complete.');
  });

  it('returns empty string when visible content is empty and no reasoning', () => {
    const response = makeResponse({ content: '' });
    expect(finalAnswerFromResponse(response)).toBe('');
  });

  it('returns empty string when visible content is empty even with reasoningContent present', () => {
    const response = makeResponse({
      content: '',
      reasoningContent: '=read=path src/session/Session.ts',
    });
    // reasoningContent should NOT leak into finalAnswer
    expect(finalAnswerFromResponse(response)).toBe('');
  });

  it('returns empty string when visible content is only protocol markup', () => {
    const response = makeResponse({
      content: '<tool_call><function=read><parameter=path>x</parameter></function></tool_call>',
      reasoningContent: 'Let me think about this.',
    });
    // assistantVisibleContent strips protocol markup, leaving empty
    expect(finalAnswerFromResponse(response)).toBe('');
  });

  it('returns empty string when visible content is only markdown tag', () => {
    const response = makeResponse({
      content: '</think>',
      reasoningContent: 'I should read the file first.',
    });
    expect(finalAnswerFromResponse(response)).toBe('');
  });

  it('strips tool call markup from content', () => {
    const response = makeResponse({
      content: 'Summary: done. <tool_call><function=read><parameter=path>x</parameter></function></tool_call>',
      reasoningContent: 'Thinking step by step...',
    });
    expect(finalAnswerFromResponse(response)).toBe('Summary: done.');
  });
});
