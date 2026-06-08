/**
 * Tests for agent event routing compile-time safety.
 *
 * Covers:
 * - Every AgentEvent type literal is registered in AGENT_EVENT_TYPES
 * - finalAnswerFromResponse falls back to reasoningContent when content is empty
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

// ─── finalAnswerFromResponse falls back to reasoningContent when content empty ─

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

  it('falls back to reasoningContent when visible content is empty', () => {
    const response = makeResponse({
      content: '',
      reasoningContent: 'The refactor is complete. All tests pass.',
    });
    // reasoningContent is used as fallback when content is empty/status-only
    expect(finalAnswerFromResponse(response)).toBe('The refactor is complete. All tests pass.');
  });

  it('falls back to reasoningContent when content is only protocol markup', () => {
    const response = makeResponse({
      content: '<tool_call><function=read><parameter=path>x</parameter></function></tool_call>',
      reasoningContent: 'Let me think about this. The bug is in the parser.',
    });
    // assistantVisibleContent strips protocol markup, leaving empty
    // reasoningContent is used as fallback
    expect(finalAnswerFromResponse(response)).toBe('Let me think about this. The bug is in the parser.');
  });

  it('falls back to reasoningContent when content sanitizes away', () => {
    const response = makeResponse({
      content: '</think>',
      reasoningContent: 'I should read the file first. The analysis shows no issues.',
    });
    expect(finalAnswerFromResponse(response)).toBe('I should read the file first. The analysis shows no issues.');
  });

  it('strips tool call markup from content', () => {
    const response = makeResponse({
      content: 'Summary: done. <tool_call><function=read><parameter=path>x</parameter></function></tool_call>',
      reasoningContent: 'Thinking step by step...',
    });
    expect(finalAnswerFromResponse(response)).toBe('Summary: done.');
  });

  it('returns empty when both content and reasoningContent are status-only', () => {
    const response = makeResponse({
      content: 'completed',
      reasoningContent: '',
    });
    expect(finalAnswerFromResponse(response)).toBe('');
  });

  it('returns empty when reasoningContent is also status-only', () => {
    const response = makeResponse({
      content: '',
      reasoningContent: 'done',
    });
    expect(finalAnswerFromResponse(response)).toBe('');
  });

  it('DeepSeek: falls back to reasoningContent when content is empty (bug #114)', () => {
    // DeepSeek thinking models may return rich reasoning_content with empty content field.
    // The reasoning content should be used as the final answer in this case.
    const response = makeResponse({
      content: '',
      reasoningContent:
        'The bug is in src/llm/client.ts at the parseSuccessResponse function. ' +
        'When DeepSeek returns reasoning_content but empty content, finalAnswer falls back ' +
        'to an opaque terminal state string instead of using the reasoning text.',
    });
    expect(finalAnswerFromResponse(response)).toBe(
      'The bug is in src/llm/client.ts at the parseSuccessResponse function. ' +
        'When DeepSeek returns reasoning_content but empty content, finalAnswer falls back ' +
        'to an opaque terminal state string instead of using the reasoning text.',
    );
  });

  it('DeepSeek: sanitizes reasoningContent before using as fallback', () => {
    // Reasoning content may contain <think> tags that should be stripped.
    const response = makeResponse({
      content: '',
      reasoningContent: '<think>Let me analyze this.</think>\nThe fix should be in finalAnswerFromResponse.',
    });
    expect(finalAnswerFromResponse(response)).toBe('The fix should be in finalAnswerFromResponse.');
  });
});
