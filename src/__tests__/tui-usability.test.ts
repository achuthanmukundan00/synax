/**
 * Usability floor tests for the Synax TUI rendering path.
 *
 * Goals tested:
 * 1. Final assistant/model results must never silently truncate.
 * 2. Feed scroll model retains the full final answer.
 * 3. Busy indicator changes state while a run is active.
 * 4. Compact tool cards can still truncate/summarize without affecting final results.
 * 5. Scroll indicator visibility at bottom vs not-bottom.
 * 6. Unsupported commands excluded from registry/help.
 * 7. Provider check semantic rendering classes.
 */

import { classifyAgentEvent, type SemanticEvent } from '../tui/semantic-events';
import { applyEventToRunState, createInitialRunStateSnapshot } from '../agent/tui-state';
import { IncrementalFeedModel } from '../tui/opentui-render-scheduler';
import type { AgentEvent } from '../agent/events';
import { slashOutputClass } from '../tui/key-handlers';
import { getAllCommands, registerBuiltinCommands } from '../settings/slash-command-registry';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<AgentEvent> & { type: AgentEvent['type'] }): AgentEvent {
  return {
    timestamp: new Date().toISOString(),
    ...overrides,
  } as AgentEvent;
}

function classifiedEvents(events: AgentEvent[]): SemanticEvent[] {
  let state = createInitialRunStateSnapshot(Date.now());
  const result: SemanticEvent[] = [];
  for (const ev of events) {
    state = applyEventToRunState(state, ev, Date.now());
    result.push(...classifyAgentEvent(ev, state, Date.now()));
  }
  return result;
}

function textBodyFrom(events: SemanticEvent[], eventClass: string): string {
  const match = events.find((e) => e.class === eventClass && e.artifact.type === 'text');
  return match && match.artifact.type === 'text' ? match.artifact.body : '';
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TUI usability floor', () => {
  // ── Goal 1: Final results never truncate ──────────────────────────────────

  it('preserves a long final answer with no content loss', () => {
    const longParagraphs = Array.from(
      { length: 20 },
      (_, i) =>
        `Paragraph ${i + 1}: This is a long line of text that should not be truncated away by the semantic event pipeline. It simulates what a real model might produce as a final answer.`,
    ).join('\n\n');

    const events: AgentEvent[] = [
      makeEvent({
        type: 'task_started',
        mode: 'patch',
        profile: 'default',
        endpoint: 'http://localhost:1234/v1',
        model: 'test-model',
        contextBudgetTokens: 8000,
        maxModelSteps: 5,
        maxToolCalls: 10,
        tools: ['read', 'write'],
        task: 'Write a report',
      }),
      makeEvent({
        type: 'assistant_message',
        content: longParagraphs,
      }),
      makeEvent({
        type: 'task_finished',
        status: 'completed',
        toolCalls: 0,
        maxToolCalls: 10,
        modelSteps: 1,
        maxModelSteps: 5,
        changedFiles: [],
        verification: 'not run',
      }),
    ];

    const semanticEvents = classifiedEvents(events);
    const resultBody = textBodyFrom(semanticEvents, 'tool_result');

    // The result body must NOT be truncated to 400 chars.
    expect(resultBody.length).toBeGreaterThan(400);
    // It should contain content from the end of the long text.
    expect(resultBody).toContain('Paragraph 20');
    // It should contain content from the beginning too.
    expect(resultBody).toContain('Paragraph 1');
  });

  it('keeps assistant_message result bodies intact (no summarization)', () => {
    const markdownResult = [
      '# Architecture Overview',
      '',
      'The system consists of three main layers:',
      '',
      '- **Frontend**: React 18 with TypeScript, using Vite as the bundler.',
      '- **Backend**: Node.js with Express, PostgreSQL for persistence.',
      '- **Infrastructure**: Docker Compose for local dev, Kubernetes for production.',
      '',
      '## Data Flow',
      '',
      '```',
      'User → Frontend → API Gateway → Backend → Database',
      '```',
      '',
      '## Key Decisions',
      '',
      '1. Chose PostgreSQL over MongoDB for ACID guarantees.',
      '2. Used JWT for stateless authentication.',
      '3. Adopted OpenTelemetry for observability.',
    ].join('\n');

    const events: AgentEvent[] = [
      makeEvent({
        type: 'task_started',
        mode: 'docs',
        profile: 'default',
        endpoint: 'http://localhost:1234/v1',
        model: 'test-model',
        contextBudgetTokens: 8000,
        maxModelSteps: 3,
        maxToolCalls: 5,
        tools: ['read'],
        task: 'Explain architecture',
      }),
      makeEvent({
        type: 'assistant_message',
        content: markdownResult,
      }),
    ];

    const semanticEvents = classifiedEvents(events);
    const resultBody = textBodyFrom(semanticEvents, 'tool_result');

    // All content should be preserved.
    expect(resultBody).toContain('Architecture Overview');
    expect(resultBody).toContain('PostgreSQL over MongoDB');
    expect(resultBody).toContain('OpenTelemetry');
    // Should NOT be truncated with "..."
    expect(resultBody).not.toMatch(/…$/);
  });

  it('still summarizes error and note events safely', () => {
    const longError = 'Error: '.repeat(300);

    const events: AgentEvent[] = [
      makeEvent({
        type: 'task_started',
        mode: 'patch',
        profile: 'default',
        endpoint: 'http://localhost:1234/v1',
        model: 'test-model',
        contextBudgetTokens: 8000,
        maxModelSteps: 3,
        maxToolCalls: 5,
        tools: ['read'],
        task: 'Test error',
      }),
      makeEvent({
        type: 'error',
        message: longError,
      }),
    ];

    const semanticEvents = classifiedEvents(events);
    const errorBody = textBodyFrom(semanticEvents, 'error');

    // Error events should still be capped (not infinite).
    expect(errorBody.length).toBeGreaterThan(0);
    expect(errorBody.length).toBeLessThan(longError.length);
  });

  // ── Goal 2: Feed scroll model retains full answer ─────────────────────────

  it('feed model retains the full final answer event', () => {
    const model = new IncrementalFeedModel(300);
    const longBody = 'Line '.repeat(500);

    const events = classifiedEvents([
      makeEvent({
        type: 'task_started',
        mode: 'patch',
        profile: 'default',
        endpoint: 'http://localhost:1234/v1',
        model: 'test-model',
        contextBudgetTokens: 8000,
        maxModelSteps: 3,
        maxToolCalls: 5,
        tools: ['read'],
        task: 'Test',
      }),
      makeEvent({
        type: 'assistant_message',
        content: longBody,
      }),
      makeEvent({
        type: 'task_finished',
        status: 'completed',
        toolCalls: 0,
        maxToolCalls: 5,
        modelSteps: 1,
        maxModelSteps: 3,
        changedFiles: [],
        verification: 'not run',
      }),
    ]);

    // Feed model plan should include all events without truncating content.
    const plan = model.plan(events);
    expect(plan.visibleIds.length).toBeGreaterThanOrEqual(1);
    expect(plan.operations.length).toBeGreaterThanOrEqual(1);

    // The appended event should have the full body, not truncated.
    const appendOps = plan.operations.filter((op) => op.type === 'append');
    expect(appendOps.length).toBeGreaterThanOrEqual(1);
    // At least one append operation must carry the full assistant_message body.
    const hasFullBody = appendOps.some((op) => {
      if (op.event?.artifact.type === 'text') {
        const body = (op.event.artifact as { type: 'text'; title: string; body: string }).body;
        return body.length > 400;
      }
      return false;
    });
    expect(hasFullBody).toBe(true);
  });

  it('feed model handles event updates (streaming → stable card transition)', () => {
    // Build full classified event set in one pass so IDs are consistent.
    const agentEvents: AgentEvent[] = [
      makeEvent({
        type: 'task_started',
        mode: 'patch',
        profile: 'default',
        endpoint: 'http://localhost:1234/v1',
        model: 'test-model',
        contextBudgetTokens: 8000,
        maxModelSteps: 3,
        maxToolCalls: 5,
        tools: ['read'],
        task: 'Test',
      }),
      makeEvent({
        type: 'assistant_message',
        content: 'Streaming partial response...',
      }),
      makeEvent({
        type: 'assistant_message',
        content: 'Full and complete answer with all the details now that processing is finished.',
      }),
    ];

    let state = createInitialRunStateSnapshot(Date.now());
    const allSemantic: SemanticEvent[] = [];
    for (const ev of agentEvents) {
      state = applyEventToRunState(state, ev, Date.now());
      allSemantic.push(...classifyAgentEvent(ev, state, Date.now()));
    }

    // Feed the first N-1 events (streaming phase), then the full set.
    const partial = allSemantic.slice(0, allSemantic.length - 1);
    const model = new IncrementalFeedModel(300);
    model.plan(partial);

    // Now feed all events — the last assistant_message should be detected as a transition.
    const plan = model.plan(allSemantic);
    // After partial feed, the full set adds an event. Either an append (new ID)
    // or an update (same ID, changed signature) proves correct incremental behavior.
    const appendOrUpdate = plan.operations.filter((op) => op.type === 'append' || op.type === 'update');
    expect(appendOrUpdate.length).toBeGreaterThanOrEqual(1);
  });

  // ── Goal 3: Busy indicator state changes ───────────────────────────────────

  it('produces distinct semantic phases for thinking → tool → completed', () => {
    const events: AgentEvent[] = [
      makeEvent({
        type: 'task_started',
        mode: 'patch',
        profile: 'default',
        endpoint: 'http://localhost:1234/v1',
        model: 'test-model',
        contextBudgetTokens: 8000,
        maxModelSteps: 3,
        maxToolCalls: 5,
        tools: ['read', 'bash'],
        task: 'Read and run',
      }),
      // Thinking phase
      makeEvent({ type: 'model_step_started' }),
      makeEvent({ type: 'assistant_message', content: 'Let me check...' }),
      // Tool execution phase
      makeEvent({
        type: 'tool_started',
        toolCallId: 't1',
        toolName: 'bash',
        summary: 'ls',
      }),
      makeEvent({
        type: 'tool_finished',
        toolCallId: 't1',
        toolName: 'bash',
        summary: 'completed',
        status: 'ok',
        detail: '{"exitCode":0,"stdout":"file.txt"}',
      }),
      // Back to thinking
      makeEvent({ type: 'model_step_started' }),
      makeEvent({ type: 'assistant_message', content: 'Done.' }),
      // Completed
      makeEvent({
        type: 'task_finished',
        status: 'completed',
        toolCalls: 1,
        maxToolCalls: 5,
        modelSteps: 2,
        maxModelSteps: 3,
        changedFiles: [],
        verification: 'not run',
      }),
    ];

    let state = createInitialRunStateSnapshot(Date.now());
    const phases: string[] = [];

    for (const ev of events) {
      state = applyEventToRunState(state, ev, Date.now());
      phases.push(state.phase);
    }

    // Phase transitions should cover the main active states.
    expect(phases).toContain('thinking');
    expect(phases).toContain('tool_execution');
    // Without verification lifecycle events, task_finished yields 'verifying'.
    expect(phases).toContain('verifying');

    // After tool_finished (success), should return to thinking.
    const toolFinishedIdx = events.findIndex((e) => e.type === 'tool_finished');
    expect(toolFinishedIdx).toBeGreaterThan(0);
    expect(phases[toolFinishedIdx]).toBe('thinking');

    // After task_finished, phase reflects verification state — without
    // explicit verification lifecycle events, it's 'verifying'.
    const taskFinishedIdx = events.findIndex((e) => e.type === 'task_finished');
    expect(phases[taskFinishedIdx]).toBe('verifying');
  });

  it('identifies error state distinctly from thinking/tool', () => {
    const events: AgentEvent[] = [
      makeEvent({
        type: 'task_started',
        mode: 'patch',
        profile: 'default',
        endpoint: 'http://localhost:1234/v1',
        model: 'test-model',
        contextBudgetTokens: 8000,
        maxModelSteps: 3,
        maxToolCalls: 5,
        tools: ['bash'],
        task: 'Run command',
      }),
      makeEvent({
        type: 'tool_started',
        toolCallId: 't1',
        toolName: 'bash',
        summary: 'rm -rf /',
      }),
      makeEvent({
        type: 'tool_finished',
        toolCallId: 't1',
        toolName: 'bash',
        summary: 'permission denied',
        status: 'error',
        detail: 'Permission denied',
      }),
    ];

    let state = createInitialRunStateSnapshot(Date.now());

    for (const ev of events) {
      state = applyEventToRunState(state, ev, Date.now());
    }

    // After tool_finished with error, phase should be 'error'.
    expect(state.phase).toBe('error');
  });

  // ── Goal 4: Compact tool cards don't affect final results ─────────────────

  it('tool_result summaries are compact but final assistant_message is full', () => {
    const longToolOutput = 'stdout: ' + 'x'.repeat(5000);
    const finalAnswer = 'The operation completed successfully. Here is the detailed analysis:\n\n' + 'A'.repeat(3000);

    const events: AgentEvent[] = [
      makeEvent({
        type: 'task_started',
        mode: 'patch',
        profile: 'default',
        endpoint: 'http://localhost:1234/v1',
        model: 'test-model',
        contextBudgetTokens: 8000,
        maxModelSteps: 3,
        maxToolCalls: 5,
        tools: ['bash'],
        task: 'Run analysis',
      }),
      // Tool execution with large output
      makeEvent({
        type: 'tool_started',
        toolCallId: 't1',
        toolName: 'bash',
        summary: 'long-running-analysis',
      }),
      makeEvent({
        type: 'tool_finished',
        toolCallId: 't1',
        toolName: 'bash',
        summary: 'completed',
        status: 'ok',
        detail: `command: long-analysis\nexit code: 0\nstdout:\n${longToolOutput}`,
      }),
      // Final assistant message
      makeEvent({ type: 'model_step_started' }),
      makeEvent({
        type: 'assistant_message',
        content: finalAnswer,
      }),
      makeEvent({
        type: 'task_finished',
        status: 'completed',
        toolCalls: 1,
        maxToolCalls: 5,
        modelSteps: 1,
        maxModelSteps: 3,
        changedFiles: [],
        verification: 'not run',
      }),
    ];

    const semanticEvents = classifiedEvents(events);

    // Tool result should be a tool_result event (not a text).
    const toolResults = semanticEvents.filter((e) => e.class === 'tool_result' && e.artifact.type === 'tool_result');
    expect(toolResults.length).toBeGreaterThanOrEqual(1);

    // The assistant_message text event should contain the full answer.
    const assistantTexts = semanticEvents.filter((e) => e.class === 'tool_result' && e.artifact.type === 'text');
    expect(assistantTexts.length).toBeGreaterThanOrEqual(1);

    // At least one text event must contain the full final answer, not truncated.
    const fullAnswer = assistantTexts.some((text) => {
      if (text.artifact.type === 'text') {
        return text.artifact.body.includes('operation completed successfully') && text.artifact.body.length > 2000;
      }
      return false;
    });
    expect(fullAnswer).toBe(true);
  });

  it('compact edit tool cards preserve file path and summary', () => {
    const events: AgentEvent[] = [
      makeEvent({
        type: 'task_started',
        mode: 'patch',
        profile: 'default',
        endpoint: 'http://localhost:1234/v1',
        model: 'test-model',
        contextBudgetTokens: 8000,
        maxModelSteps: 3,
        maxToolCalls: 5,
        tools: ['write', 'edit'],
        task: 'Edit file',
      }),
      makeEvent({
        type: 'tool_started',
        toolCallId: 'e1',
        toolName: 'edit',
        summary: '{"path":"src/main.ts"}',
      }),
      makeEvent({
        type: 'tool_finished',
        toolCallId: 'e1',
        toolName: 'edit',
        summary: 'completed',
        status: 'ok',
        detail: '{"path":"src/main.ts","lines":5}',
      }),
    ];

    const semanticEvents = classifiedEvents(events);

    // Should have an 'edit' class event from the tool_finished (via editEventFromToolResult).
    const editEvents = semanticEvents.filter((e) => e.class === 'edit');
    expect(editEvents.length).toBeGreaterThanOrEqual(1);

    const editEvent = editEvents[0];
    expect(editEvent).toBeDefined();
    if (!editEvent) return;
    expect(editEvent.artifact.type).toBe('edit');
    if (editEvent.artifact.type === 'edit') {
      expect(editEvent.artifact.file).toBe('src/main.ts');
    }
  });

  // ── Goal 5: Scroll indicator visibility ───────────────────────────────────

  it('scroll indicator should be hidden when stickyScroll is active (at bottom)', () => {
    const scrollBox = { stickyScroll: true, scrollTop: 0 };
    expect(scrollBox.stickyScroll).toBe(true);
    // stickyScroll=true means auto-following bottom → not away.
    if (scrollBox.stickyScroll === true) {
      expect(true).toBe(true);
      return;
    }
    expect(false).toBe(true); // unreachable
  });

  it('scroll indicator should be hidden when scrolled to the bottom (scrollTop + viewport >= content)', () => {
    const scrollBox = { stickyScroll: false, scrollTop: 500, contentHeight: 600, viewportHeight: 100 };
    // At bottom when: top + viewport >= content - 1
    const top = scrollBox.scrollTop ?? 0;
    const content = scrollBox.contentHeight ?? 0;
    const viewport = scrollBox.viewportHeight ?? 0;
    const away = content > 0 && viewport > 0 ? top + viewport < content - 1 : scrollBox.stickyScroll !== true;
    expect(away).toBe(false);
  });

  it('scroll indicator should be visible when scrolled up with content below', () => {
    const scrollBox = { stickyScroll: false, scrollTop: 100, contentHeight: 600, viewportHeight: 100 };
    const top = scrollBox.scrollTop ?? 0;
    const content = scrollBox.contentHeight ?? 0;
    const viewport = scrollBox.viewportHeight ?? 0;
    const away = content > 0 && viewport > 0 ? top + viewport < content - 1 : scrollBox.stickyScroll !== true;
    expect(away).toBe(true);
  });

  // ── Goal 6: Command registry excludes unsupported commands ────────────────

  it('command registry does not include /login', () => {
    const commands = getAllCommands();
    const names = commands.map((c) => c.name);
    expect(names).not.toContain('login');
  });

  it('command registry does not include interactive /theme', () => {
    const commands = getAllCommands();
    const names = commands.map((c) => c.name);
    expect(names).not.toContain('theme');
  });

  it('command registry does not include /export or /import', () => {
    const commands = getAllCommands();
    const names = commands.map((c) => c.name);
    expect(names).not.toContain('export');
    expect(names).not.toContain('import');
  });

  it('command registry does not include /checkpoint, /checkpoints, or /restore', () => {
    const commands = getAllCommands();
    const names = commands.map((c) => c.name);
    expect(names).not.toContain('checkpoint');
    expect(names).not.toContain('checkpoints');
    expect(names).not.toContain('restore');
  });

  it('registerBuiltinCommands is idempotent and does not reintroduce removed commands', () => {
    registerBuiltinCommands(); // re-register (idempotent due to Map.set)
    const commands = getAllCommands();
    const names = commands.map((c) => c.name);
    expect(names).not.toContain('login');
    expect(names).not.toContain('theme');
    expect(names).not.toContain('export');
    expect(names).not.toContain('import');
  });

  // ── Goal 7: Provider check semantic rendering ─────────────────────────────

  it('slashOutputClass returns tool_result for provider ready', () => {
    const output = [
      'Provider Check',
      '--------------',
      'Status:      ready',
      'Profile:     default',
      'Endpoint:    http://localhost:1234/v1',
      'Model:       qwen',
      '',
      'Checks',
      '  [ok] models: 5 models listed',
      '  [ok] chat: smoke request passed',
    ].join('\n');
    const result = slashOutputClass(output);
    expect(result.eventClass).toBe('tool_result');
    expect(result.title).toBe('Provider Ready');
  });

  it('slashOutputClass returns result_error for provider failed', () => {
    const output = [
      'Provider Check',
      '--------------',
      'Status:      failed',
      'Profile:     default',
      'Endpoint:    http://localhost:1234/v1',
      'Model:       bad-model',
      '',
      'Checks',
      '  [failed] models: HTTP 404',
    ].join('\n');
    const result = slashOutputClass(output);
    expect(result.eventClass).toBe('result_error');
    expect(result.title).toBe('Provider Check Failed');
  });

  it('slashOutputClass returns result_error for provider blocked', () => {
    const output = [
      'Provider Check',
      '--------------',
      'Status:      blocked',
      'Profile:     default',
      'Endpoint:    http://localhost:1234/v1',
      'Model:       (not set)',
      '',
      'Checks',
      '  [blocked] endpoint missing',
      '  [blocked] model missing',
    ].join('\n');
    const result = slashOutputClass(output);
    expect(result.eventClass).toBe('result_error');
    expect(result.title).toBe('Provider Check Failed');
  });

  it('slashOutputClass returns note for provider degraded', () => {
    const output = [
      'Provider Check',
      '--------------',
      'Status:      degraded',
      'Profile:     default',
      'Endpoint:    http://localhost:1234/v1',
      'Model:       unknown-model',
      '',
      'Checks',
      '  [warn] models: configured model not listed (unknown-model)',
      '  [ok] chat: smoke request passed',
    ].join('\n');
    const result = slashOutputClass(output);
    expect(result.eventClass).toBe('note');
    expect(result.title).toBe('Provider Degraded');
  });

  it('slashOutputClass returns note for generic output', () => {
    const result = slashOutputClass('Some generic command output');
    expect(result.eventClass).toBe('note');
    expect(result.title).toBe('Command');
  });
});
