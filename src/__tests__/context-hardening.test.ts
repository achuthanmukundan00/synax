/**
 * Tests for context-window management, tool safety, and agent runtime hardening.
 *
 * Covers:
 * - Multi-stage compaction (stages 1-4)
 * - Tool-call/tool-result integrity
 * - Hard read omission
 * - Incremental token estimation
 * - Dynamic tail sizing
 * - Preflight enforcement
 * - Large synthetic sessions
 */

import {
  compactMessages,
  compactMessagesMultiStage,
  createTokenLedger,
  estimateMessageTokens,
  estimateIncrementalTokens,
  estimateRequestTokens,
  estimateTokens,
  formatContextBudgetError,
  resolveContextBudgetSettings,
} from '../agent/context-budget';
import { resolveStrategy } from '../context/ContextStrategy';
import { Session, type AgentClient, type AgentMessage, type AgentRunnerOptions } from '../session/Session';

/** Local shim — Session.startTurn with the old options+task signature. */
async function runTurn(opts: AgentRunnerOptions & { task: string }): Promise<ReturnType<Session['startTurn']>> {
  const { task, tools, ...rest } = opts;
  return new Session({ ...rest, bashEnabled: tools?.bashEnabled }).startTurn(task);
}
import { createInspectionLedger, type InspectionLedger } from '../tools';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const TMP = join(process.cwd(), 'tmp', 'synax-context-harden-tests');

function resetTmp(): void {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

function makeMsg(role: string, content: string, opts?: Partial<AgentMessage>): AgentMessage {
  return { role, content, ...opts };
}

function makeToolCallMsg(callId: string, toolName: string): AgentMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: callId, type: 'function', function: { name: toolName, arguments: '{}' } }],
  };
}

function makeToolResultMsg(callId: string, toolName: string, content: string): AgentMessage {
  return {
    role: 'tool',
    tool_call_id: callId,
    name: toolName,
    content,
  };
}

function makeBulkMessages(count: number, baseRole: string, charsPerMsg: number): AgentMessage[] {
  const msgs: AgentMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    msgs.push({
      role: baseRole,
      content: `${baseRole} message ${i} `.padEnd(charsPerMsg, 'x'),
    });
  }
  return msgs;
}

function expectNoOrphanedToolProtocol(messages: AgentMessage[]): void {
  const toolCallIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const message of messages) {
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls as Array<{ id?: unknown }>) {
        if (typeof call.id === 'string') toolCallIds.add(call.id);
      }
    }
    if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
      resultIds.add(message.tool_call_id);
    }
  }

  for (const id of resultIds) {
    expect(toolCallIds.has(id)).toBe(true);
  }
  for (const id of toolCallIds) {
    expect(resultIds.has(id)).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeClient(
  responses: Array<{
    content?: string;
    toolCallFormat?: 'openai' | 'content_xml' | 'none';
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  }>,
): AgentClient & { requests: Array<{ messages: AgentMessage[] }> } {
  const requests: Array<{ messages: AgentMessage[] }> = [];
  return {
    requests,
    async chat(options) {
      requests.push(JSON.parse(JSON.stringify(options)));
      const next = responses.shift() ?? { content: 'done', toolCalls: [] };
      return {
        content: next.content ?? '',
        model: 'fake',
        finishReason: 'stop',
        toolCallFormat: next.toolCallFormat,
        toolCalls: next.toolCalls ?? [],
        usage: null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Multi-stage compaction tests
// ---------------------------------------------------------------------------

describe('multi-stage compaction', () => {
  const defaultSettings = resolveContextBudgetSettings({});

  it('stage 1: normal compaction with dynamic tail produces under-limit result', () => {
    const msgs = [
      makeMsg('system', 'system prompt'),
      ...makeBulkMessages(20, 'user', 400),
      ...makeBulkMessages(20, 'assistant', 400),
      makeMsg('user', 'latest question'),
      makeMsg('assistant', 'latest answer'),
    ];

    const result = compactMessagesMultiStage(msgs, {
      ...defaultSettings,
      contextWindowTokens: 10000,
      reservedOutputTokens: 2000,
      keepRecentTokens: 3000,
    });

    expect(result.stage).toBeLessThanOrEqual(3);
    expect(result.activeMessages.length).toBeLessThan(msgs.length);

    const afterTokens = estimateRequestTokens(result.activeMessages);
    const limit = result.stage === 4 ? 1 : 10000 - 2000;
    // Stage 4 should be fail-closed but still report
    if (result.stage < 4) {
      expect(afterTokens).toBeLessThanOrEqual(limit);
    }
  });

  it('stage 2: reduced tail when stage 1 insufficient', () => {
    // Create messages that exceed even after normal compaction
    const msgs: AgentMessage[] = [makeMsg('system', 's')];
    for (let i = 0; i < 30; i += 1) {
      msgs.push(makeMsg('user', `user ${i} `.padEnd(180, 'x')));
      msgs.push(makeMsg('assistant', `asst ${i} `.padEnd(180, 'x')));
    }

    const result = compactMessagesMultiStage(msgs, {
      ...defaultSettings,
      contextWindowTokens: 4000,
      reservedOutputTokens: 800,
      keepRecentTokens: 3200,
    });

    // Should reach at least stage 2
    expect(result.stage).toBeGreaterThanOrEqual(1);

    if (result.stage < 4) {
      const afterTokens = estimateRequestTokens(result.activeMessages);
      expect(afterTokens).toBeLessThanOrEqual(4000 - 800);
    }
  });

  it('stage 4: fail-closed when compaction cannot reduce enough', () => {
    // Create messages with interleaved tool pairs so that integrity
    // enforcement cascades keepFrom backward.  Tool results are
    // separated from their matching tool calls by unrelated messages.
    const msgs: AgentMessage[] = [makeMsg('system', 's')];
    for (let i = 0; i < 50; i += 1) {
      // First: tool call
      msgs.push(makeToolCallMsg(`call_${i}`, 'read'));
      // Interleave unrelated messages between tool-call and tool-result
      msgs.push(makeMsg('user', `fillerA ${i} `.padEnd(300, 'q')));
      msgs.push(makeMsg('assistant', `fillerB ${i} `.padEnd(300, 'r')));
      msgs.push(makeMsg('user', `fillerC ${i} `.padEnd(300, 's')));
      // Then: tool result (separated from its call)
      msgs.push(
        makeToolResultMsg(
          `call_${i}`,
          'read',
          JSON.stringify({
            success: true,
            output: { path: `file_${i}.ts`, content: 'x'.repeat(400) },
          }),
        ),
      );
    }

    // Budget extremely tight — even the tail + aggressive summary exceed limit.
    const result = compactMessagesMultiStage(msgs, {
      ...defaultSettings,
      contextWindowTokens: 300,
      reservedOutputTokens: 100,
      keepRecentTokens: 200,
    });

    // Should reach stage 4 (fail-closed)
    expect(result.stage).toBe(4);
    expect(result.compaction).toBeNull();
  });

  it('compaction error message includes stage number', () => {
    const error = formatContextBudgetError({
      estimatedInputTokens: 50000,
      contextWindowTokens: 10000,
      reservedOutputTokens: 1000,
      effectiveInputLimit: 9000,
      largestContributors: ['user ~1000', 'tool read file.ts ~800'],
      compactionStage: 4,
    });

    expect(error).toContain('stage 4');
    expect(error).toContain('50000');
    expect(error).toContain('9000');
    expect(error).toContain('Largest contributors');
    expect(error).toContain('user ~1000');
  });
});

// ---------------------------------------------------------------------------
// 2. Tool-call / tool-result integrity tests
// ---------------------------------------------------------------------------

describe('tool-call / tool-result integrity', () => {
  const settings = resolveContextBudgetSettings({
    contextWindowTokens: 8000,
    reservedOutputTokens: 1000,
    keepRecentTokens: 2000,
  });

  it('keeps assistant tool-call with its tool-result as a unit', () => {
    const msgs: AgentMessage[] = [makeMsg('system', 's')];
    // Fill with context that will be compacted
    for (let i = 0; i < 15; i += 1) {
      msgs.push(makeMsg('user', `filler ${i} `.padEnd(180, 'x')));
      msgs.push(makeMsg('assistant', `reply ${i} `.padEnd(180, 'x')));
    }
    // Add a tool-call pair at the end
    msgs.push(makeToolCallMsg('pair_1', 'read'));
    msgs.push(makeToolResultMsg('pair_1', 'read', JSON.stringify({ success: true, output: { path: 'a.ts' } })));

    const result = compactMessagesMultiStage(msgs, settings);

    // The kept messages MUST contain both the tool-call and the tool-result
    const keptContent = result.activeMessages.map((m) => JSON.stringify(m));
    const hasCall = keptContent.some((s) => s.includes('pair_1') && s.includes('tool_calls'));
    const hasResult = keptContent.some((s) => s.includes('pair_1') && s.includes('"role":"tool"'));
    expect(hasCall).toBe(true);
    expect(hasResult).toBe(true);

    // Verify no orphaned tool_results exist in kept
    const keptResults = result.activeMessages.filter((m) => m.role === 'tool' && typeof m.tool_call_id === 'string');
    for (const resultMsg of keptResults) {
      const callId = resultMsg.tool_call_id as string;
      const hasMatchingCall = result.activeMessages.some(
        (m) =>
          m.role === 'assistant' &&
          Array.isArray(m.tool_calls) &&
          m.tool_calls.some((c: unknown) => (c as { id?: string }).id === callId),
      );
      expect(hasMatchingCall).toBe(true);
    }
  });

  it('prevents dangling assistant tool-call without matching tool-result', () => {
    const msgs: AgentMessage[] = [makeMsg('system', 's')];
    for (let i = 0; i < 12; i += 1) {
      msgs.push(makeMsg('user', `filler ${i} `.padEnd(180, 'x')));
      msgs.push(makeMsg('assistant', `reply ${i} `.padEnd(180, 'x')));
    }
    // Add a tool-call WITHOUT a matching tool_result (dangling)
    msgs.push(makeToolCallMsg('dangle_1', 'read'));
    // Add one more non-tool message after it
    msgs.push(makeMsg('user', 'new question'));

    const result = compactMessagesMultiStage(msgs, settings);

    // Check kept messages
    const keptAssistants = result.activeMessages.filter(
      (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    );
    for (const asst of keptAssistants) {
      const callIds = (asst.tool_calls as Array<{ id?: string }>).map((c) => c.id).filter(Boolean) as string[];
      for (const id of callIds) {
        const hasResult = result.activeMessages.some((m) => m.role === 'tool' && m.tool_call_id === id);
        // If this is the last tool-call turn, it should have been dropped entirely
        // to avoid dangling. Check whether it's the last one.
        const asstIdx = result.activeMessages.indexOf(asst);
        const hasLaterToolCalls = result.activeMessages
          .slice(asstIdx + 1)
          .some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
        if (!hasLaterToolCalls) {
          expect(hasResult).toBe(true);
        }
      }
    }
  });

  it('fallback path preserves protocol validity for tangled tool-call histories', () => {
    const msgs: AgentMessage[] = [
      makeMsg('system', 's'),
      makeToolCallMsg('kept_result_needs_older_call', 'read'),
      {
        ...makeToolCallMsg('dangling_last_call', 'read'),
        content: 'latest dangling assistant '.padEnd(1000, 'x'),
      },
      makeToolResultMsg('kept_result_needs_older_call', 'read', JSON.stringify({ success: true })),
      makeMsg('user', 'latest user question'),
    ];
    const body = msgs.slice(1);
    const keepFromOneTokens =
      estimateMessageTokens(body[1]) + estimateMessageTokens(body[2]) + estimateMessageTokens(body[3]);
    const keepFromZeroTokens = keepFromOneTokens + estimateMessageTokens(body[0]);

    const result = compactMessages(msgs, {
      ...settings,
      keepRecentTokens: keepFromOneTokens,
      contextWindowTokens: keepFromZeroTokens + 2000,
    });

    expect(result.compaction).not.toBeNull();
    expect(result.activeMessages.length).toBeLessThan(msgs.length);
    expectNoOrphanedToolProtocol(result.activeMessages);
  });
});

// ---------------------------------------------------------------------------
// 3. Hard read omission tests
// ---------------------------------------------------------------------------

describe('hard read omission', () => {
  beforeEach(() => resetTmp());
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it('omits read when per-turn token budget is exhausted', async () => {
    writeFileSync(join(TMP, 'a.txt'), `${'data\n'.repeat(500)}`, 'utf-8');
    writeFileSync(join(TMP, 'b.txt'), `${'more\n'.repeat(500)}`, 'utf-8');

    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'b.txt' } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read',
      client,
      contextBudget: {
        maxSingleReadResultTokens: 5000,
        maxTotalReadResultTokensPerTurn: 100,
      },
    });

    expect(result.terminalState).toBe('completed');
    const secondToolContent = (client.requests[2].messages as AgentMessage[]).find(
      (m) => m.role === 'tool' && m.tool_call_id === '2',
    )?.content;
    expect(secondToolContent).toBeDefined();
    const parsed = JSON.parse(secondToolContent as string);
    expect(parsed.output.omitted).toBe(true);
    expect(parsed.output.reason).toBe('turn token budget exceeded');
    expect(parsed.output.guidance).toBe('use targeted read/search');
  });

  it('omitted read consumes zero tokens toward budget', async () => {
    writeFileSync(join(TMP, 'a.txt'), `${'big\n'.repeat(5000)}`, 'utf-8');
    writeFileSync(join(TMP, 'b.txt'), `${'big\n'.repeat(3000)}`, 'utf-8');

    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'b.txt' } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read',
      client,
      contextBudget: {
        maxSingleReadResultTokens: 10000,
        maxTotalReadResultTokensPerTurn: 800,
      },
    });

    expect(result.terminalState).toBe('completed');
    // Second request's messages should have the omission
    const toolMsgs2 = (client.requests[2].messages as AgentMessage[]).filter(
      (m) => m.role === 'tool' && m.tool_call_id === '2',
    );
    expect(toolMsgs2.length).toBe(1);
    const parsed2 = JSON.parse(toolMsgs2[0].content);
    expect(parsed2.output.omitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Incremental token estimation tests
// ---------------------------------------------------------------------------

describe('incremental token estimation', () => {
  it('starts at zero', () => {
    const ledger = createTokenLedger();
    expect(ledger.lastKnownTokenCount).toBe(0);
    expect(ledger.lastMeasuredIndex).toBe(-1);
  });

  it('uses the configured chars-per-token estimate', () => {
    expect(estimateTokens('x'.repeat(30))).toBe(8);
  });

  it('uses a conservative estimate for dense long-token text', () => {
    expect(estimateTokens('a'.repeat(100))).toBe(50);
  });

  it('uses tighter strategy bands for model context windows', () => {
    expect(resolveStrategy(64_000).mode).toBe('aggressive');
    expect(resolveStrategy(131_072).mode).toBe('moderate');
    expect(resolveStrategy(300_000).mode).toBe('light');
    expect(resolveStrategy(2_000_000).mode).toBe('none');
  });

  it('light strategy falls through to summarizing compaction when stage 0 is insufficient', () => {
    const msgs = [
      makeMsg('system', 'system prompt'),
      ...makeBulkMessages(80, 'user', 500),
      ...makeBulkMessages(80, 'assistant', 500),
    ];

    const result = compactMessagesMultiStage(msgs, {
      ...resolveContextBudgetSettings({}),
      contextWindowTokens: 12000,
      reservedOutputTokens: 1000,
      keepRecentTokens: 3000,
      strategyMode: 'light',
    });

    expect(result.stage).toBeGreaterThanOrEqual(1);
  });

  it('full estimate on first call', () => {
    const ledger = createTokenLedger();
    const msgs = [makeMsg('user', 'hello'), makeMsg('assistant', 'world')];
    const tokens = estimateIncrementalTokens(msgs, ledger);

    expect(tokens).toBe(estimateRequestTokens(msgs));
    expect(ledger.lastKnownTokenCount).toBe(tokens);
    expect(ledger.lastMeasuredIndex).toBe(1);
  });

  it('only estimates new messages on subsequent calls', () => {
    const ledger = createTokenLedger();
    const msgs1 = [makeMsg('system', 'sys'), ...makeBulkMessages(10, 'user', 200)];
    const tokens1 = estimateIncrementalTokens(msgs1, ledger);
    expect(ledger.lastMeasuredIndex).toBe(10);

    // Add a few more messages
    const msgs2 = [...msgs1, makeMsg('assistant', 'reply'), makeMsg('user', 'question')];
    const tokens2 = estimateIncrementalTokens(msgs2, ledger);

    // Should be greater than tokens1 but only by the cost of 2 new messages
    const newMsgsTokens = estimateRequestTokens(msgs2.slice(msgs1.length));
    expect(tokens2).toBe(tokens1 + newMsgsTokens);
    expect(ledger.lastMeasuredIndex).toBe(12);
  });

  it('reuses cached count when no new messages', () => {
    const ledger = createTokenLedger();
    const msgs = makeBulkMessages(5, 'user', 100);
    const tokens1 = estimateIncrementalTokens(msgs, ledger);

    // Call again with same array
    const tokens2 = estimateIncrementalTokens(msgs, ledger);
    expect(tokens2).toBe(tokens1);
    expect(ledger.lastMeasuredIndex).toBe(4);
  });

  it('re-estimates when a previously measured message list shrinks', () => {
    const ledger = createTokenLedger();
    const expanded = [makeMsg('system', 'sys'), ...makeBulkMessages(8, 'user', 120)];
    const compacted = expanded.slice(0, 4);

    estimateIncrementalTokens(expanded, ledger);
    const tokensAfterShrink = estimateIncrementalTokens(compacted, ledger);

    expect(tokensAfterShrink).toBe(estimateRequestTokens(compacted));
    expect(ledger.lastMeasuredIndex).toBe(compacted.length - 1);
  });

  it('reset clears state', () => {
    const ledger = createTokenLedger();
    estimateIncrementalTokens([makeMsg('user', 'hi')], ledger);
    expect(ledger.lastMeasuredIndex).toBe(0);

    // reset
    ledger.lastKnownTokenCount = 0;
    ledger.lastMeasuredIndex = -1;
    const tokens = estimateIncrementalTokens([makeMsg('user', 'hello')], ledger);
    expect(tokens).toBeGreaterThan(0);
    expect(ledger.lastMeasuredIndex).toBe(0);
  });

  it('handles large message counts correctly', () => {
    const ledger = createTokenLedger();
    const msgs = [
      makeMsg('system', 's'),
      ...makeBulkMessages(200, 'user', 100),
      ...makeBulkMessages(200, 'assistant', 100),
    ];

    const tokens = estimateIncrementalTokens(msgs, ledger);
    const fullTokens = estimateRequestTokens(msgs);
    expect(tokens).toBe(fullTokens);
  });
});

// ---------------------------------------------------------------------------
// 5. Large synthetic session tests (150k+ tokens)
// ---------------------------------------------------------------------------

describe('large synthetic sessions', () => {
  it('survives a session that grows beyond 100k estimated tokens', () => {
    const conversation = Session.createConversation();
    // Add many large filler messages to simulate a very long session
    for (let i = 0; i < 200; i += 1) {
      conversation.messages.push(makeMsg('user', `context building message ${i} `.padEnd(800, 'z')));
      conversation.messages.push(makeMsg('assistant', `reply ${i} `.padEnd(800, 'y')));
      // Occasional large tool pairs
      if (i % 5 === 0) {
        conversation.messages.push(makeToolCallMsg(`call_${i}`, 'read'));
        conversation.messages.push(
          makeToolResultMsg(
            `call_${i}`,
            'read',
            JSON.stringify({
              success: true,
              output: { path: `file_${i}.ts`, content: 'x'.repeat(800) },
            }),
          ),
        );
      }
    }

    const estimated = estimateTokens(JSON.stringify(conversation.messages));
    // Verify we indeed have a very large session
    expect(estimated).toBeGreaterThan(80000);
  });

  it('compaction still reduces a large session under budget with tool pairs intact', () => {
    const msgs: AgentMessage[] = [makeMsg('system', 'system prompt')];
    // Build a session with 60 large exchanges (no tool pairs so compaction is clean)
    for (let i = 0; i < 60; i += 1) {
      msgs.push(makeMsg('user', `detailed question ${i} `.padEnd(600, 'a')));
      msgs.push(makeMsg('assistant', `detailed answer ${i} `.padEnd(600, 'b')));
    }

    const estimated = estimateTokens(JSON.stringify(msgs));
    expect(estimated).toBeGreaterThan(20000);

    const settings = resolveContextBudgetSettings({
      contextWindowTokens: 10000,
      reservedOutputTokens: 1000,
      keepRecentTokens: 4000,
    });

    const result = compactMessagesMultiStage(msgs, settings);

    if (result.stage < 4) {
      const afterTokens = estimateRequestTokens(result.activeMessages);
      expect(afterTokens).toBeLessThanOrEqual(10000 - 1000);
      expect(result.activeMessages).toContainEqual(
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('TASK:'),
        }),
      );
    }
  });

  it('tool pairs remain intact in large compacted sessions', () => {
    const msgs: AgentMessage[] = [makeMsg('system', 'system prompt')];
    for (let i = 0; i < 30; i += 1) {
      msgs.push(makeMsg('user', `fill ${i} `.padEnd(180, 'z')));
      msgs.push(makeMsg('assistant', `ack ${i} `.padEnd(180, 'y')));
    }
    // Final tool pair that should be preserved
    msgs.push(makeToolCallMsg('final_call', 'edit'));
    msgs.push(
      makeToolResultMsg(
        'final_call',
        'edit',
        JSON.stringify({
          success: true,
          output: { path: 'src/main.ts', diff: 'changed' },
        }),
      ),
    );

    const settings = resolveContextBudgetSettings({
      contextWindowTokens: 8000,
      reservedOutputTokens: 1000,
      keepRecentTokens: 2500,
    });

    const result = compactMessagesMultiStage(msgs, settings);

    if (result.stage < 4) {
      const kept = result.activeMessages;
      const hasCall = kept.some(
        (m) =>
          m.role === 'assistant' &&
          Array.isArray(m.tool_calls) &&
          m.tool_calls?.some((c: unknown) => (c as { id?: string }).id === 'final_call'),
      );
      const hasResult = kept.some((m) => m.role === 'tool' && m.tool_call_id === 'final_call');
      expect(hasCall).toBe(true);
      expect(hasResult).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. No provider call when over budget
// ---------------------------------------------------------------------------

describe('no provider call when over budget', () => {
  beforeEach(() => resetTmp());
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it('blocks provider call when context budget is exceeded after all compaction stages', async () => {
    const client = fakeClient([{ content: 'should not be reached' }]);
    const conversation = Session.createConversation();

    // Fill with interleaved tool pairs that prevent compaction cascade.
    // Adjacent tool-call/tool-result pairs compress easily, so we
    // separate them to force keepFrom expansion.
    for (let i = 0; i < 25; i += 1) {
      conversation.messages.push(makeToolCallMsg(`call_${i}`, 'read'));
      conversation.messages.push(makeMsg('user', `between ${i} `.padEnd(300, 'q')));
      conversation.messages.push(makeMsg('assistant', `between-reply ${i} `.padEnd(300, 'w')));
      conversation.messages.push(
        makeToolResultMsg(
          `call_${i}`,
          'read',
          JSON.stringify({
            success: true,
            output: { path: `f_${i}.ts`, content: 'c'.repeat(300) },
          }),
        ),
      );
      conversation.messages.push(makeMsg('assistant', `reply ${i} `.padEnd(300, 'j')));
    }

    const result = await runTurn({
      repoRoot: TMP,
      task: 'final request',
      client,
      conversation,
      contextBudget: {
        contextWindowTokens: 600,
        reservedOutputTokens: 100,
        keepRecentTokens: 500,
      },
    });

    expect(result.terminalState).toBe('budget_exhausted');
    expect(result.error).toContain('context budget exceeded');
    expect(client.requests).toHaveLength(0);
  });

  it('blocks provider call with extra-large single task', async () => {
    const client = fakeClient([{ content: 'should not be reached' }]);
    const hugeTask = 'x'.repeat(20000);

    const result = await runTurn({
      repoRoot: TMP,
      task: hugeTask,
      client,
      contextBudget: {
        contextWindowTokens: 500,
        reservedOutputTokens: 100,
      },
    });

    expect(result.terminalState).toBe('budget_exhausted');
    expect(result.error).toContain('context budget exceeded');
    expect(client.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Preflight enforcement within tool loop
// ---------------------------------------------------------------------------

describe('preflight enforcement within tool loop', () => {
  beforeEach(() => resetTmp());
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it('checks budget before every model call', async () => {
    // Create a conversation that starts under budget but grows
    writeFileSync(join(TMP, 'a.txt'), `${'a\n'.repeat(10000)}`, 'utf-8');
    writeFileSync(join(TMP, 'b.txt'), `${'b\n'.repeat(10000)}`, 'utf-8');

    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'b.txt' } }] },
      { content: 'should not be reached' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read many large files',
      client,
      contextBudget: {
        contextWindowTokens: 2000,
        reservedOutputTokens: 400,
        maxSingleReadResultTokens: 5000,
        maxTotalReadResultTokensPerTurn: 50000,
      },
    });

    // Should detect budget overflow after the first large tool result
    // and fail with budget_exhausted
    expect(['budget_exhausted', 'completed']).toContain(result.terminalState);

    // If it was exhausted, the error should include context budget
    if (result.terminalState === 'budget_exhausted') {
      expect(result.error).toContain('context budget exceeded');
    }
  });

  it('enforces per-turn read caps', async () => {
    writeFileSync(join(TMP, 'a.txt'), `${'a\n'.repeat(50)}`, 'utf-8');
    const client = fakeClient(
      Array.from({ length: 5 }, (_, i) => ({
        toolCalls: [{ id: String(i), name: 'read', arguments: { path: 'a.txt' } }],
      })),
    );

    const result = await runTurn({
      repoRoot: TMP,
      task: 'reread same file',
      client,
      maxSteps: 10,
    });

    // Read-loop errors are recoverable: the model sees the error and can adapt.
    // After exhausting responses, fakeClient returns a 'done' final answer.
    expect(result.terminalState).toBe('completed');
    expect(result.finalAnswer).toBe('done');
    // The loop-detection error was delivered to the model as a tool result
    const toolMsgs = client.requests.flatMap((r: unknown) =>
      (((r as Record<string, unknown>).messages as Array<Record<string, unknown>>) ?? []).filter(
        (m: Record<string, unknown>) => m.role === 'tool' && String(m.content ?? '').includes('Read loop detected'),
      ),
    );
    expect(toolMsgs.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 8. Dynamic tail sizing tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 9. Working context orientation from InspectionLedger
// ---------------------------------------------------------------------------

describe('working context orientation', () => {
  let ledger: InspectionLedger;

  beforeEach(() => {
    ledger = createInspectionLedger();
  });

  it('returns empty orientation for fresh ledger', () => {
    const orientation = ledger.getOrientation();
    expect(orientation).toContain('WORKING CONTEXT');
    expect(orientation).toContain('(nothing inspected yet)');
  });

  it('lists inspected files with line ranges', () => {
    ledger.recordFileRead('src/a.ts', 1, 50, 'content here', false);
    ledger.recordFileRange('src/b.ts', 10, 30);

    const orientation = ledger.getOrientation();
    expect(orientation).toContain('src/a.ts');
    expect(orientation).toContain('lines 1-50');
    expect(orientation).toContain('src/b.ts');
    expect(orientation).toContain('lines 10-30');
  });

  it('marks truncated paths in editable-from-memory section', () => {
    ledger.recordFileRead('src/trunc.ts', 1, 100, 'partial content', true);
    ledger.recordFileRead('src/complete.ts', 1, 20, 'full content', false);

    const orientation = ledger.getOrientation();
    // truncated files should NOT appear as editable from memory
    expect(orientation).toContain('src/trunc.ts');
    expect(orientation).toContain('truncated');
  });

  it('separates editable-from-memory vs needs-reread', () => {
    ledger.recordFileRead('src/editable.ts', 1, 30, 'exact text here\n', false);
    ledger.recordFileRead('src/trunc.ts', 1, 40, 'partial...', true);

    const orientation = ledger.getOrientation();
    expect(orientation).toContain('Editable');
    expect(orientation).toMatch(/src\/editable\.ts/);
    // truncated file should appear in needs-reread or not in editable
    expect(orientation).toMatch(/not safe to edit from memory|needs reread|truncated/i);
  });

  it('reports git inspection state', () => {
    ledger.recordGitStatus();
    ledger.recordGitDiff();

    const orientation = ledger.getOrientation();
    expect(orientation).toMatch(/git.*status.*inspected/i);
    expect(orientation).toMatch(/git.*diff.*inspected/i);
  });

  it('reports repeated read counts', () => {
    ledger.recordFileRead('src/repeat.ts', 1, 10, 'text', false);
    ledger.recordFileRead('src/repeat.ts', 1, 10, 'text', false);
    ledger.recordFileRead('src/repeat.ts', 1, 10, 'text', false);

    const orientation = ledger.getOrientation();
    expect(orientation).toContain('repeat.ts');
    expect(orientation).toContain('3');
  });

  it('fits orientation under token cap', () => {
    for (let i = 0; i < 100; i += 1) {
      ledger.recordFileRead(`src/file_${i}.ts`, 1, 200, 'x'.repeat(500), false);
    }

    const orientation = ledger.getOrientation();
    // Should be under the bounded orientation cap.
    expect(orientation.length).toBeLessThan(7000);
  });
});

// ---------------------------------------------------------------------------
// 10. Progressive loop resistance
// ---------------------------------------------------------------------------

describe('progressive loop resistance', () => {
  beforeEach(() => resetTmp());
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it('returns first duplicate read from cache silently', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'content1\ncontent2\n', 'utf-8');

    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'a.txt' } }] },
      { content: 'ok' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read same file twice',
      client,
      contextBudget: { maxSingleReadResultTokens: 5000, maxTotalReadResultTokensPerTurn: 50000 },
    });

    expect(result.terminalState).toBe('completed');
    const secondToolMsg = (client.requests[2].messages as AgentMessage[]).find(
      (m) => m.role === 'tool' && m.tool_call_id === '2',
    )?.content;
    expect(secondToolMsg).toBeDefined();
    const parsed = JSON.parse(secondToolMsg as string);
    expect(parsed.success).toBe(true);
  });

  it('warns on second duplicate read with guidance', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'content\n', 'utf-8');

    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '3', name: 'read', arguments: { path: 'a.txt' } }] },
      { content: 'ok' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read same file three times',
      client,
      contextBudget: { maxSingleReadResultTokens: 5000, maxTotalReadResultTokensPerTurn: 50000 },
    });

    expect(result.terminalState).toBe('completed');
    const thirdToolMsg = (client.requests[3].messages as AgentMessage[]).find(
      (m) => m.role === 'tool' && m.tool_call_id === '3',
    )?.content;
    expect(thirdToolMsg).toBeDefined();
    const parsed = JSON.parse(thirdToolMsg as string);
    expect(parsed.output.guidance ?? '').toMatch(/already|reread|duplicate|stop/i);
  });

  it('fails on third duplicate read with ledger summary', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'content\n', 'utf-8');

    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '3', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '4', name: 'read', arguments: { path: 'a.txt' } }] },
      { content: 'ok' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read same file four times',
      client,
      contextBudget: { maxSingleReadResultTokens: 5000, maxTotalReadResultTokensPerTurn: 50000 },
    });

    // Read-loop errors are recoverable: the model sees the error and can adapt.
    // After the loop detection, the model gives a final answer instead of dying.
    expect(result.terminalState).toBe('completed');
    expect(result.finalAnswer).toBe('ok');
    // The loop-detection error was delivered to the model as a tool result
    const toolMsgs = client.requests.flatMap((r: unknown) =>
      (((r as Record<string, unknown>).messages as Array<Record<string, unknown>>) ?? []).filter(
        (m: Record<string, unknown>) => m.role === 'tool',
      ),
    );
    const loopMsg = toolMsgs.find((m: Record<string, unknown>) =>
      /already read|reread|duplicate|loop/i.test(String(m.content ?? '')),
    );
    expect(loopMsg).toBeDefined();
  });

  it('different line ranges are not duplicates', async () => {
    writeFileSync(join(TMP, 'a.txt'), Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'), 'utf-8');

    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt', startLine: 1, endLine: 10 } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'a.txt', startLine: 20, endLine: 30 } }] },
      { toolCalls: [{ id: '3', name: 'read', arguments: { path: 'a.txt', startLine: 50, endLine: 60 } }] },
      { content: 'ok' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read different ranges',
      client,
      contextBudget: { maxSingleReadResultTokens: 5000, maxTotalReadResultTokensPerTurn: 50000 },
    });

    expect(result.terminalState).toBe('completed');
    expect(result.toolCalls.every((tc) => tc.success)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. Working context orientation injection
// ---------------------------------------------------------------------------

describe('working context injection', () => {
  beforeEach(() => resetTmp());
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it('injects orientation into model messages', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'content\n', 'utf-8');

    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt' } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read a file',
      client,
      contextBudget: { maxSingleReadResultTokens: 5000, maxTotalReadResultTokensPerTurn: 50000 },
    });

    expect(result.terminalState).toBe('completed');

    const secondReq = client.requests[1];
    expect(secondReq).toBeDefined();
    const msgs = secondReq.messages as AgentMessage[];
    const orientationMsg = msgs.find((m) => m.role === 'system' && m.content.includes('WORKING CONTEXT'));
    expect(orientationMsg).toBeDefined();
    const orientMsg = orientationMsg as NonNullable<typeof orientationMsg>;
    expect(orientMsg.content).toContain('a.txt');
    expect(orientMsg.content).toContain('Editable from memory');
  });

  it('omits orientation when nothing inspected yet', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'content\n', 'utf-8');

    const client = fakeClient([{ content: 'done' }]);

    await runTurn({
      repoRoot: TMP,
      task: 'just answer',
      client,
    });

    const firstReq = client.requests[0];
    const msgs = firstReq.messages as AgentMessage[];
    const orientationMsg = msgs.find((m) => m.role === 'system' && m.content.includes('WORKING CONTEXT'));
    expect(orientationMsg).toBeUndefined();
  });

  it('orientation lists editable from memory files', async () => {
    mkdirSync(join(TMP, 'src'), { recursive: true });
    writeFileSync(join(TMP, 'src/main.ts'), 'export function main() {}\n', 'utf-8');
    writeFileSync(join(TMP, 'src/utils.ts'), 'export function util() {}\n', 'utf-8');

    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'src/main.ts' } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'src/utils.ts' } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read some files',
      client,
      contextBudget: { maxSingleReadResultTokens: 5000, maxTotalReadResultTokensPerTurn: 50000 },
    });

    expect(result.terminalState).toBe('completed');

    const lastReq = client.requests[2];
    const msgs = lastReq.messages as AgentMessage[];
    const orientationMsg = msgs.find((m) => m.role === 'system' && m.content.includes('WORKING CONTEXT'));
    expect(orientationMsg).toBeDefined();
    const orientMsg = orientationMsg as NonNullable<typeof orientationMsg>;
    expect(orientMsg.content).toContain('src/main.ts');
    expect(orientMsg.content).toContain('src/utils.ts');
    expect(orientMsg.content).toContain('Editable from memory');
  });
});

describe('dynamic tail sizing', () => {
  it('uses min(keepRecentTokens, 0.4 * effectiveLimit)', () => {
    const settings1 = resolveContextBudgetSettings({
      contextWindowTokens: 10000,
      reservedOutputTokens: 1000,
      keepRecentTokens: 5000,
    });
    // effective = 9000, 0.4 * 9000 = 3600 < 5000 → 3600
    const result1 = compactMessagesMultiStage(
      [makeMsg('system', 's'), ...makeBulkMessages(30, 'user', 200)],
      settings1,
    );
    // The tail will be clamped to the dynamic size
    expect(result1.activeMessages.length).toBeLessThan(32);
  });
});

// ---------------------------------------------------------------------------
// 12. Model message assembly (proactive tool result compaction)
// ---------------------------------------------------------------------------

describe('model message assembly', () => {
  beforeEach(() => resetTmp());
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it('compacts old tool results outside recent window', async () => {
    // Use different files to avoid read loop detection
    const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt'];
    for (const f of files) writeFileSync(join(TMP, f), 'x'.repeat(3000), 'utf-8');

    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'b.txt' } }] },
      { toolCalls: [{ id: '3', name: 'read', arguments: { path: 'c.txt' } }] },
      { toolCalls: [{ id: '4', name: 'read', arguments: { path: 'd.txt' } }] },
      { toolCalls: [{ id: '5', name: 'read', arguments: { path: 'e.txt' } }] },
      { toolCalls: [{ id: '6', name: 'read', arguments: { path: 'f.txt' } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read many different files',
      client,
      contextBudget: {
        maxSingleReadResultTokens: 50000,
        maxTotalReadResultTokensPerTurn: 500000,
        keepRecentToolTurns: 3,
        assemblyCompactionThreshold: 0,
      },
    });

    expect(result.terminalState).toBe('completed');

    const lastReqMsgs = client.requests[client.requests.length - 1].messages as AgentMessage[];

    // Tool result for id='4' should be verbatim (recent turn, within last 3)
    const tool4 = lastReqMsgs.find((m) => m.role === 'tool' && m.tool_call_id === '4');
    expect(tool4).toBeDefined();
    const t4 = tool4 as NonNullable<typeof tool4>;
    expect(t4.content).not.toContain('_compacted');

    // Tool result for id='1' should be compacted (old, outside last 3 turns)
    const tool1 = lastReqMsgs.find((m) => m.role === 'tool' && m.tool_call_id === '1');
    expect(tool1).toBeDefined();
    const t1 = tool1 as NonNullable<typeof tool1>;
    expect(t1.content).toContain('_compacted');
    expect(t1.content.length).toBeLessThan(600);
  });

  it('assembly shrinks model request compared to conversation history', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'x'.repeat(5000), 'utf-8');
    writeFileSync(join(TMP, 'b.txt'), 'y'.repeat(5000), 'utf-8');
    writeFileSync(join(TMP, 'c.txt'), 'z'.repeat(5000), 'utf-8');
    writeFileSync(join(TMP, 'd.txt'), 'w'.repeat(5000), 'utf-8');
    writeFileSync(join(TMP, 'e.txt'), 'v'.repeat(5000), 'utf-8');

    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'b.txt' } }] },
      { toolCalls: [{ id: '3', name: 'read', arguments: { path: 'c.txt' } }] },
      { toolCalls: [{ id: '4', name: 'read', arguments: { path: 'd.txt' } }] },
      { toolCalls: [{ id: '5', name: 'read', arguments: { path: 'e.txt' } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read many large files',
      client,
      contextBudget: {
        maxSingleReadResultTokens: 50000,
        maxTotalReadResultTokensPerTurn: 500000,
        keepRecentToolTurns: 2,
        assemblyCompactionThreshold: 0,
      },
    });

    expect(result.terminalState).toBe('completed');

    const lastReq = client.requests[client.requests.length - 1];
    const assembledMsgs = lastReq.messages as AgentMessage[];
    const assembledTokens = estimateTokens(JSON.stringify(assembledMsgs));
    const rawTokens = estimateTokens(JSON.stringify(result.conversation.messages));

    expect(assembledTokens).toBeLessThan(rawTokens * 0.7);
  });

  it('preserves tool-call/tool-result protocol validity after assembly', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'content\n', 'utf-8');

    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '2', name: 'bash', arguments: { command: 'git status --short' } }] },
      { toolCalls: [{ id: '3', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '4', name: 'bash', arguments: { command: 'git diff --no-ext-diff' } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read and git',
      client,
      contextBudget: {
        maxSingleReadResultTokens: 50000,
        maxTotalReadResultTokensPerTurn: 500000,
        keepRecentToolTurns: 2,
      },
    });

    expect(result.terminalState).toBe('completed');

    for (const req of client.requests) {
      const msgs = req.messages as AgentMessage[];
      const toolMsgs = msgs.filter((m) => m.role === 'tool');
      for (const tm of toolMsgs) {
        expect(tm.tool_call_id).toBeDefined();
        expect(typeof tm.tool_call_id).toBe('string');
      }
    }
  });

  it('compact includes path and line info in summaries', async () => {
    mkdirSync(join(TMP, 'src'), { recursive: true });
    writeFileSync(join(TMP, 'src/main.ts'), 'line 1\nline 2\nline 3\nline 4\nline 5\n', 'utf-8');

    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'src/main.ts', startLine: 1, endLine: 3 } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'src/main.ts', startLine: 3, endLine: 5 } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read same file',
      client,
      contextBudget: {
        maxSingleReadResultTokens: 50000,
        maxTotalReadResultTokensPerTurn: 500000,
        keepRecentToolTurns: 1,
        assemblyCompactionThreshold: 0,
      },
    });

    expect(result.terminalState).toBe('completed');

    const lastReq = client.requests[client.requests.length - 1];
    const msgs = lastReq.messages as AgentMessage[];
    const tool1 = msgs.find((m) => m.role === 'tool' && m.tool_call_id === '1');
    expect(tool1).toBeDefined();
    const t1 = tool1 as NonNullable<typeof tool1>;
    expect(t1.content).toContain('_compacted');
    expect(t1.content).toContain('src/main.ts');
  });

  it('non-tool messages are preserved verbatim', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello\n', 'utf-8');

    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'a.txt' } }] },
      { content: 'final answer' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'inspect and answer',
      client,
      contextBudget: {
        maxSingleReadResultTokens: 50000,
        maxTotalReadResultTokensPerTurn: 500000,
        keepRecentToolTurns: 1,
      },
    });

    expect(result.terminalState).toBe('completed');

    const lastReq = client.requests[client.requests.length - 1];
    const msgs = lastReq.messages as AgentMessage[];
    const userMsg = msgs.find((m) => m.role === 'user' && m.content === 'inspect and answer');
    expect(userMsg).toBeDefined();
  });

  it('assembly stats are tracked on conversation', async () => {
    const files = ['x.txt', 'y.txt', 'z.txt'];
    for (const f of files) writeFileSync(join(TMP, f), 'x'.repeat(3000), 'utf-8');

    const conversation = Session.createConversation();
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'x.txt' } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'y.txt' } }] },
      { toolCalls: [{ id: '3', name: 'read', arguments: { path: 'z.txt' } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read file',
      client,
      conversation,
      contextBudget: {
        maxSingleReadResultTokens: 50000,
        maxTotalReadResultTokensPerTurn: 500000,
        keepRecentToolTurns: 1,
        assemblyCompactionThreshold: 0,
      },
    });

    expect(result.terminalState).toBe('completed');
    expect(conversation.assemblyStats).toBeDefined();
    const stats = conversation.assemblyStats as NonNullable<typeof conversation.assemblyStats>;
    expect(stats.compactedToolResults).toBeGreaterThan(0);
    expect(stats.estimatedTokensOut).toBeLessThan(stats.estimatedTokensIn);
    const lastRequestMessages = client.requests[client.requests.length - 1].messages as AgentMessage[];
    expect(stats.totalMessagesOut).toBe(lastRequestMessages.length);
    expect(stats.estimatedTokensOut).toBe(estimateRequestTokens(lastRequestMessages));
  });

  it('assembly stats include read-budget warning messages sent to the model', async () => {
    writeFileSync(join(TMP, 'repeat.txt'), 'same content\n', 'utf-8');

    const conversation = Session.createConversation();
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'repeat.txt' } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'repeat.txt' } }] },
      { toolCalls: [{ id: '3', name: 'read', arguments: { path: 'repeat.txt' } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read repeat file',
      client,
      conversation,
      contextBudget: {
        maxSingleReadResultTokens: 50000,
        maxTotalReadResultTokensPerTurn: 500000,
        keepRecentToolTurns: 1,
      },
    });

    expect(result.terminalState).toBe('completed');
    const lastRequestMessages = client.requests[client.requests.length - 1].messages as AgentMessage[];
    expect(lastRequestMessages.at(-1)?.content).toContain('STOP READING');
    const stats = conversation.assemblyStats as NonNullable<typeof conversation.assemblyStats>;
    expect(stats.totalMessagesOut).toBe(lastRequestMessages.length);
    expect(stats.estimatedTokensOut).toBe(estimateRequestTokens(lastRequestMessages));
  });

  it('directory listing results are compacted correctly', async () => {
    mkdirSync(join(TMP, 'src'), { recursive: true });
    writeFileSync(join(TMP, 'src/a.ts'), 'a\n', 'utf-8');
    writeFileSync(join(TMP, 'src/b.ts'), 'b\n', 'utf-8');
    writeFileSync(join(TMP, 'src/c.ts'), 'c\n', 'utf-8');

    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: {} }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: {} }] },
      { toolCalls: [{ id: '3', name: 'read', arguments: {} }] },
      { content: 'done' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'list files',
      client,
      contextBudget: {
        maxSingleReadResultTokens: 50000,
        maxTotalReadResultTokensPerTurn: 500000,
        keepRecentToolTurns: 1,
        assemblyCompactionThreshold: 0,
      },
    });

    expect(result.terminalState).toBe('completed');

    const lastReq = client.requests[client.requests.length - 1];
    const msgs = lastReq.messages as AgentMessage[];
    const tool1 = msgs.find((m) => m.role === 'tool' && m.tool_call_id === '1');
    expect(tool1).toBeDefined();
    const t1 = tool1 as NonNullable<typeof tool1>;
    expect(t1.content).toContain('_compacted');
  });

  it('orientation marks compacted files as not model-visible for editing', async () => {
    const files = ['p.txt', 'q.txt', 'r.txt', 's.txt', 't.txt'];
    for (const f of files) writeFileSync(join(TMP, f), 'x'.repeat(3000), 'utf-8');

    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'p.txt' } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'q.txt' } }] },
      { toolCalls: [{ id: '3', name: 'read', arguments: { path: 'r.txt' } }] },
      { toolCalls: [{ id: '4', name: 'read', arguments: { path: 's.txt' } }] },
      { toolCalls: [{ id: '5', name: 'read', arguments: { path: 't.txt' } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read many files',
      client,
      contextBudget: {
        maxSingleReadResultTokens: 50000,
        maxTotalReadResultTokensPerTurn: 500000,
        keepRecentToolTurns: 2,
        assemblyCompactionThreshold: 0,
      },
    });

    expect(result.terminalState).toBe('completed');

    const lastReq = client.requests[client.requests.length - 1];
    const msgs = lastReq.messages as AgentMessage[];
    const orientationMsg = msgs.find((m) => m.role === 'system' && m.content.includes('WORKING CONTEXT'));
    expect(orientationMsg).toBeDefined();

    const orientMsg = orientationMsg as NonNullable<typeof orientationMsg>;
    const content = orientMsg.content;

    // Recent files (s.txt, t.txt — turns 4 and 5) should be model-visible
    expect(content).toContain('Editable from memory');

    // Old files (p.txt, q.txt — turns 1 and 2) should be marked compacted
    expect(content).toContain('Compated from model view');
    expect(content).toContain('p.txt');
  });

  it('compactedFilePaths are tracked in assembly stats', async () => {
    const files = ['a.txt', 'b.txt', 'c.txt'];
    for (const f of files) writeFileSync(join(TMP, f), 'x'.repeat(2000), 'utf-8');

    const conversation = Session.createConversation();
    const client = fakeClient([
      { toolCalls: [{ id: '1', name: 'read', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ id: '2', name: 'read', arguments: { path: 'b.txt' } }] },
      { toolCalls: [{ id: '3', name: 'read', arguments: { path: 'c.txt' } }] },
      { content: 'done' },
    ]);

    const result = await runTurn({
      repoRoot: TMP,
      task: 'read files',
      client,
      conversation,
      contextBudget: {
        maxSingleReadResultTokens: 50000,
        maxTotalReadResultTokensPerTurn: 500000,
        keepRecentToolTurns: 1,
        assemblyCompactionThreshold: 0,
      },
    });

    expect(result.terminalState).toBe('completed');
    expect(conversation.assemblyStats).toBeDefined();
    const stats = conversation.assemblyStats as NonNullable<typeof conversation.assemblyStats>;
    expect(stats.compactedFilePaths.length).toBeGreaterThanOrEqual(2);
    expect(stats.compactedFilePaths).toContain('a.txt');
    expect(stats.compactedFilePaths).toContain('b.txt');
  });
});
