/**
 * Tests for prompt-cache-stable message assembly.
 *
 * Verifies that mutable runtime state (orientation, memory index, compaction
 * notes) is appended at the tail of the model request so the stable prefix
 * (system prompt + conversation history) remains identical across steps.
 * This preserves provider prompt-cache locality (Anthropic, OpenAI).
 */

import {
  appendMutableRuntimeState,
  buildOrientationMessage,
  buildMemoryIndexMessage,
  buildModelRequest,
  MAX_TOTAL_READS_PER_TURN,
} from '../session/message-assembly';
import type { AgentMessage, AgentConversation } from '../session/types';
import type { InspectionLedger } from '../tools';
import { resolveContextBudgetSettings } from '../agent/context-budget';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMsg(role: AgentMessage['role'], content: string, opts?: Partial<AgentMessage>): AgentMessage {
  return { role, content, ...opts };
}

function makeConversation(messages: AgentMessage[]): AgentConversation {
  return {
    messages,
    inspectionLedger: createMockLedger(),
    tokenLedger: { lastKnownTokenCount: 0, lastMeasuredIndex: -1 },
    assemblyStats: null,
    latestCompaction: null,
  };
}

function createMockLedger(inspected: string[] = []): InspectionLedger {
  return {
    logEntry: () => {},
    getOrientation: (_readCounts?: Map<string, number>, _compacted?: string[]) => {
      if (inspected.length === 0) return '(nothing inspected yet)';
      return `Inspected: ${inspected.join(', ')}`;
    },
  } as unknown as InspectionLedger;
}

const defaultSettings = resolveContextBudgetSettings({});

// ── appendMutableRuntimeState ────────────────────────────────────────────────

describe('appendMutableRuntimeState', () => {
  it('returns stable messages unchanged when no runtime messages', () => {
    const stable = [makeMsg('system', 'You are a bot'), makeMsg('user', 'hello')];
    const result = appendMutableRuntimeState(stable);
    expect(result).toBe(stable); // same reference when empty
  });

  it('filters out null runtime messages', () => {
    const stable = [makeMsg('system', 'You are a bot')];
    const result = appendMutableRuntimeState(stable, null, null);
    expect(result).toBe(stable);
  });

  it('filters out empty-content runtime messages', () => {
    const stable = [makeMsg('system', 'You are a bot')];
    const result = appendMutableRuntimeState(
      stable,
      { role: 'system', content: '   ' },
    );
    expect(result).toBe(stable);
  });

  it('appends runtime messages after stable prefix', () => {
    const stable = [makeMsg('system', 'You are a bot'), makeMsg('user', 'hello')];
    const runtime = makeMsg('system', 'orientation data');
    const result = appendMutableRuntimeState(stable, runtime);

    expect(result).toHaveLength(3);
    expect(result[0]).toBe(stable[0]);
    expect(result[1]).toBe(stable[1]);
    expect(result[2]).toBe(runtime);
  });

  it('appends multiple runtime messages in order', () => {
    const stable = [makeMsg('system', 'prompt')];
    const a = makeMsg('system', 'orientation');
    const b = makeMsg('system', 'memory index');
    const c = makeMsg('system', 'compaction note');
    const result = appendMutableRuntimeState(stable, a, b, c);

    expect(result).toHaveLength(4);
    expect(result[0]).toBe(stable[0]);
    expect(result[1]).toBe(a);
    expect(result[2]).toBe(b);
    expect(result[3]).toBe(c);
  });
});

// ── buildOrientationMessage ──────────────────────────────────────────────────

describe('buildOrientationMessage', () => {
  it('returns null when nothing inspected', () => {
    const ledger = createMockLedger([]);
    const result = buildOrientationMessage(ledger);
    expect(result).toBeNull();
  });

  it('returns a system message when files inspected', () => {
    const ledger = createMockLedger(['src/a.ts', 'src/b.ts']);
    const result = buildOrientationMessage(ledger);
    expect(result).not.toBeNull();
    expect(result!.role).toBe('system');
    expect(result!.content).toContain('src/a.ts');
  });
});

// ── buildMemoryIndexMessage ──────────────────────────────────────────────────

describe('buildMemoryIndexMessage', () => {
  it('returns null for null index', () => {
    expect(buildMemoryIndexMessage(null)).toBeNull();
  });

  it('returns null for empty string index', () => {
    expect(buildMemoryIndexMessage('')).toBeNull();
  });

  it('returns a system message for non-empty index', () => {
    const result = buildMemoryIndexMessage('FTS5 index: 42 entries');
    expect(result).not.toBeNull();
    expect(result!.role).toBe('system');
    expect(result!.content).toBe('FTS5 index: 42 entries');
  });
});

// ── Prompt-cache stability: orientation changes ─────────────────────────────

describe('prompt-cache stability with orientation changes', () => {
  it('preserves stable prefix when orientation changes across steps', () => {
    // Simulate two model requests for consecutive steps.
    // Step 1: no files read yet.
    // Step 2: some files read → orientation changes.
    const messages: AgentMessage[] = [
      makeMsg('system', 'You are Synax, a coding agent.'),
      makeMsg('user', 'Fix the bug in src/app.ts'),
      makeMsg('assistant', 'Let me read the file.', { tool_calls: [{ id: 't1', name: 'read', arguments: { path: 'src/app.ts' } }] }),
      makeMsg('tool', JSON.stringify({ success: true, toolName: 'read', output: { path: 'src/app.ts', totalLines: 42, content: 'line1\nline2' } }), { tool_call_id: 't1' }),
    ];

    // Step 1 conversation: nothing inspected yet
    const conv1 = makeConversation(messages);
    const result1 = buildModelRequest(conv1, defaultSettings, new Map());

    // Step 2 conversation: same messages, but now ledger says files were read
    const conv2 = makeConversation(messages);
    conv2.inspectionLedger = createMockLedger(['src/app.ts']);
    const result2 = buildModelRequest(conv2, defaultSettings, new Map());

    // The stable prefix (system prompt + conversation) must be identical
    // between step 1 and step 2. Only the runtime tail may differ.
    const prefixLen = messages.length;
    for (let i = 0; i < prefixLen; i++) {
      expect(result1[i]).toEqual(result2[i]);
    }

    // The tail should differ (step 2 has orientation)
    expect(result2.length).toBeGreaterThanOrEqual(result1.length);
  });

  it('orientations with different file counts share the same prefix', () => {
    const messages: AgentMessage[] = [
      makeMsg('system', 'You are Synax.'),
      makeMsg('user', 'Review the codebase.'),
      makeMsg('assistant', 'On it.'),
    ];

    const conv1 = makeConversation(messages);
    conv1.inspectionLedger = createMockLedger(['a.ts']);
    const r1 = buildModelRequest(conv1, defaultSettings, new Map());

    const conv2 = makeConversation(messages);
    conv2.inspectionLedger = createMockLedger(['a.ts', 'b.ts', 'c.ts']);
    const r2 = buildModelRequest(conv2, defaultSettings, new Map());

    // Prefix (system + messages) is identical
    for (let i = 0; i < messages.length; i++) {
      expect(r1[i]).toEqual(r2[i]);
    }
  });
});

// ── Prompt-cache stability: memory index changes ────────────────────────────

describe('prompt-cache stability with memory index changes', () => {
  it('preserves stable prefix when memory index changes', () => {
    const messages: AgentMessage[] = [
      makeMsg('system', 'You are Synax.'),
      makeMsg('user', 'tell me about past sessions'),
    ];

    const conv1 = makeConversation(messages);
    const r1 = buildModelRequest(conv1, defaultSettings, new Map(), 0, 'FTS5: 3 entries');

    const conv2 = makeConversation(messages);
    const r2 = buildModelRequest(conv2, defaultSettings, new Map(), 0, 'FTS5: 57 entries (different)');

    // Prefix must be identical
    for (let i = 0; i < messages.length; i++) {
      expect(r1[i]).toEqual(r2[i]);
    }
  });

  it('null vs populated memory index share the same prefix', () => {
    const messages: AgentMessage[] = [
      makeMsg('system', 'You are Synax.'),
      makeMsg('user', 'hello'),
    ];

    const conv = makeConversation(messages);
    const r1 = buildModelRequest(conv, defaultSettings, new Map(), 0, null);
    const r2 = buildModelRequest(conv, defaultSettings, new Map(), 0, 'FTS5: 5 entries');

    for (let i = 0; i < messages.length; i++) {
      expect(r1[i]).toEqual(r2[i]);
    }
  });
});

// ── Read budget warning — appended at tail after runtime state ──────────────

describe('read budget warning placement', () => {
  it('appends warning after runtime state, preserving prefix', () => {
    const messages: AgentMessage[] = [
      makeMsg('system', 'You are Synax.'),
      makeMsg('user', 'read files'),
    ];

    const conv = makeConversation(messages);
    conv.inspectionLedger = createMockLedger(['a.ts']);

    // Simulate read budget pressure: exactly at threshold
    const readCounts = new Map([['a.ts', 1]]);
    const totalReads = Math.floor(MAX_TOTAL_READS_PER_TURN * 0.5);
    const result = buildModelRequest(conv, defaultSettings, readCounts, totalReads);

    // Verify warning is the LAST message
    const last = result[result.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('STOP READING');

    // Prefix (system + user) is intact
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual(messages[1]);
  });
});
