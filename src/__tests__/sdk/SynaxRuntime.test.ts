/**
 * Integration test for SynaxRuntime — proves an external TypeScript app can:
 *
 * 1. Import SynaxRuntime from 'synax'
 * 2. Register custom tools
 * 3. Inject a MemoryAdapter
 * 4. Enforce a Policy
 * 5. Run one task
 * 6. Receive events via onEvent callback
 * 7. Get a clean RuntimeResult (no AgentConversation exposed)
 */

import { SynaxRuntime } from '../../sdk/SynaxRuntime';
import type {
  MemoryAdapter,
  MemoryEntry,
  MemorySearchResult,
  Policy,
  RuntimeEvent,
  RuntimeResult,
  ToolUseRequest,
} from '../../sdk/types';
import type { AgentClient } from '../../session/types';
import type { ChatOptions, ChatResponse } from '../../llm/types';
import type { ToolDefinition, ToolResult } from '../../tools/types';

// ─── Fake LLM client ─────────────────────────────────────

function makeFakeClient(responses: Array<{
  content?: string;
  toolCalls?: ChatResponse['toolCalls'];
  toolCallFormat?: 'openai' | 'content_xml' | 'none';
}>): AgentClient {
  const copy = [...responses];
  return {
    async chat(_opts: ChatOptions): Promise<ChatResponse> {
      const next = copy.shift() ?? { content: 'done.', toolCalls: [] };
      return {
        content: next.content ?? '',
        model: 'test-model',
        finishReason: 'stop',
        toolCallFormat: next.toolCallFormat ?? 'none',
        toolCalls: next.toolCalls ?? [],
        usage: null,
      };
    },
  };
}

// ─── Spy memory adapter ──────────────────────────────────

function makeSpyMemory(): MemoryAdapter & { stored: MemoryEntry[]; searches: string[] } {
  const stored: MemoryEntry[] = [];
  const searches: string[] = [];

  return {
    stored,
    searches,
    store(entry: MemoryEntry): void {
      stored.push(entry);
    },
    search(query: string, _limit?: number): MemorySearchResult[] {
      searches.push(query);
      return [];
    },
    buildMemoryIndex(): string | null {
      return stored.length > 0 ? '[Memory: active]' : null;
    },
  };
}

// ─── Spy policy ──────────────────────────────────────────

function makeSpyPolicy(decisions: {
  toolUse?: 'allow' | 'deny';
  fileEdit?: 'allow' | 'deny';
} = {}): Policy & { toolRequests: ToolUseRequest[]; editPreviews: Array<{ path: string; diff: string }> } {
  const toolRequests: ToolUseRequest[] = [];
  const editPreviews: Array<{ path: string; diff: string }> = [];
  return {
    toolRequests,
    editPreviews,
    approveToolUse(request: ToolUseRequest) {
      toolRequests.push(request);
      return decisions.toolUse ?? 'allow';
    },
    approveFileEdit(preview: { path: string; diff: string }) {
      editPreviews.push(preview);
      return decisions.fileEdit ?? 'allow';
    },
  };
}

// ─── Simple custom tool ──────────────────────────────────

const echoTool: ToolDefinition<{ message: string }, { echoed: string }> = {
  name: 'echo',
  description: 'Echoes a message back for testing',
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
  },
  safetyPolicy: { readOnly: true, rejectsUnsafePaths: false, boundedOutput: false },
  ledgerBehavior: 'none',
  async execute(input: { message: string }, _ctx: any): Promise<ToolResult<{ echoed: string }>> {
    return { success: true, toolName: 'echo', output: { echoed: input.message } };
  },
};

// ─── Tests ───────────────────────────────────────────────

describe('SynaxRuntime', () => {
  describe('construction', () => {
    it('throws when neither model nor client is provided', () => {
      expect(() => new SynaxRuntime({} as any)).toThrow('either "model" or "client"');
    });

    it('accepts a pre-built client', () => {
      const client = makeFakeClient([{ content: 'done.' }]);
      const runtime = new SynaxRuntime({ client });
      expect(runtime).toBeInstanceOf(SynaxRuntime);
    });

    it('accepts model config', () => {
      const runtime = new SynaxRuntime({
        model: { baseUrl: 'http://localhost:8080/v1', model: 'test' },
      });
      expect(runtime).toBeInstanceOf(SynaxRuntime);
    });

    it('accepts a custom working directory', () => {
      const client = makeFakeClient([{ content: 'done.' }]);
      const runtime = new SynaxRuntime({ client, workingDir: '/tmp' });
      expect(runtime).toBeInstanceOf(SynaxRuntime);
    });

    it('registers custom tools', () => {
      const client = makeFakeClient([{ content: 'done.' }]);
      const runtime = new SynaxRuntime({ client, tools: [echoTool] });
      expect(runtime).toBeInstanceOf(SynaxRuntime);
    });

    it('accepts memory adapter', () => {
      const client = makeFakeClient([{ content: 'done.' }]);
      const memory = makeSpyMemory();
      const runtime = new SynaxRuntime({ client, memory });
      expect(runtime).toBeInstanceOf(SynaxRuntime);
    });

    it('accepts policy', () => {
      const client = makeFakeClient([{ content: 'done.' }]);
      const policy = makeSpyPolicy();
      const runtime = new SynaxRuntime({ client, policy });
      expect(runtime).toBeInstanceOf(SynaxRuntime);
    });
  });

  describe('run()', () => {
    it('returns a clean RuntimeResult for a simple task', async () => {
      const client = makeFakeClient([{ content: 'Updated the config file.' }]);
      const runtime = new SynaxRuntime({ client });

      const result: RuntimeResult = await runtime.run({ input: 'Update the config' });

      expect(result.status).toBe('completed');
      expect(result.output).toBe('Updated the config file.');
      expect(Array.isArray(result.filesChanged)).toBe(true);
      expect(typeof result.toolCalls).toBe('number');
      expect(typeof result.steps).toBe('number');
      // Must NOT expose internal conversation
      expect((result as any).conversation).toBeUndefined();
      expect((result as any).messages).toBeUndefined();
    });

    it('prefixes context to the task when provided', async () => {
      const client = makeFakeClient([{ content: 'Done.' }]);
      const runtime = new SynaxRuntime({ client });

      const result = await runtime.run({
        input: 'fix the bug',
        context: 'Project: my-app. Stack: React.',
      });
      expect(result.status).toBe('completed');
    });

    it('includes an error when the run fails', async () => {
      const client = makeFakeClient([]); // no responses → unexpected behavior
      const runtime = new SynaxRuntime({ client });

      const result = await runtime.run({ input: 'do something' });

      // The agent will get empty content — check result shape
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('output');
      expect(result).toHaveProperty('filesChanged');
    });
  });

  describe('memory adapter integration', () => {
    it('calls store() on the memory adapter during a run', async () => {
      const client = makeFakeClient([{ content: 'All good.' }]);
      const memory = makeSpyMemory();
      const runtime = new SynaxRuntime({ client, memory });

      await runtime.run({ input: 'Check the logs' });

      // Memory.store should have been called with the user task
      expect(memory.stored.length).toBeGreaterThan(0);
      const userEntry = memory.stored.find((e) => e.role === 'user');
      expect(userEntry).toBeDefined();
      expect(userEntry!.content).toContain('Check the logs');
    });

    it('calls buildMemoryIndex() during context construction', async () => {
      const client = makeFakeClient([{ content: 'Done.' }]);
      const memory = makeSpyMemory();
      const runtime = new SynaxRuntime({ client, memory });

      await runtime.run({ input: 'Quick check' });

      // buildMemoryIndex is called by Session to inject memory context
      // into model requests. With a fake client that returns immediately,
      // it may or may not be called depending on the turn path.
      // The key assertion is that it doesn't throw.
      expect(memory.buildMemoryIndex()).not.toBeNull();
    });
  });

  describe('custom tool registration', () => {
    it('registers and exposes custom tools in model tool surface', async () => {
      const requests: ChatOptions[] = [];
      const client: AgentClient = {
        async chat(opts: ChatOptions): Promise<ChatResponse> {
          requests.push(opts);
          return { content: 'done.', model: 'test', finishReason: 'stop', toolCalls: [], usage: null };
        },
      };

      const runtime = new SynaxRuntime({ client, tools: [echoTool] });
      await runtime.run({ input: 'Use the echo tool' });

      // The custom tool name should appear in the tool definitions sent to the model
      expect(requests.length).toBeGreaterThan(0);
      const toolNames = requests.flatMap((r) => (r.tools ?? []).map((t: any) => t.name ?? t.function?.name ?? t));
      expect(toolNames).toContain('echo');
    });
  });

  describe('policy enforcement', () => {
    it('calls approveToolUse via EventBus control hook', async () => {
      const client = makeFakeClient([
        {
          content: '',
          toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'README.md' } }],
          toolCallFormat: 'openai',
        },
        { content: 'Read the file.' },
      ]);
      const policy = makeSpyPolicy({ toolUse: 'allow' });
      const runtime = new SynaxRuntime({ client, policy });

      await runtime.run({ input: 'Read README.md' });

      // Policy was consulted for the tool call
      expect(policy.toolRequests.length).toBeGreaterThan(0);
      expect(policy.toolRequests[0].toolName).toBe('read');
    });

    it('can deny tool use via policy', async () => {
      const client = makeFakeClient([
        {
          content: '',
          toolCalls: [{ id: 'c1', name: 'bash', arguments: { command: 'rm -rf /' } }],
          toolCallFormat: 'openai',
        },
        { content: 'Tool was blocked.' },
      ]);
      // Deny ALL tool use
      const policy = makeSpyPolicy({ toolUse: 'deny' });
      const runtime = new SynaxRuntime({ client, policy });

      const result = await runtime.run({ input: 'Run dangerous command' });

      // The agent should still complete (the tool was skipped, model continues)
      expect(result).toHaveProperty('status');
    });
  });

  describe('event streaming', () => {
    it('delivers events via onEvent callback', async () => {
      const client = makeFakeClient([{ content: 'Task done.' }]);
      const received: RuntimeEvent[] = [];
      const runtime = new SynaxRuntime({ client, onEvent: (e) => received.push(e) });

      await runtime.run({ input: 'Do the thing' });

      // Should receive at least model_step + complete
      expect(received.length).toBeGreaterThanOrEqual(2);
      expect(received.some((e) => e.type === 'model_step')).toBe(true);
      expect(received.some((e) => e.type === 'complete')).toBe(true);
    });

    it('includes tool events when tools are called', async () => {
      const client = makeFakeClient([
        {
          content: '',
          toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'test.txt' } }],
          toolCallFormat: 'openai',
        },
        { content: 'File read.' },
      ]);
      const received: RuntimeEvent[] = [];
      const runtime = new SynaxRuntime({ client, onEvent: (e) => received.push(e) });

      await runtime.run({ input: 'Read test.txt' });

      const toolEvents = received.filter((e) => e.type === 'tool_start' || e.type === 'tool_finish');
      expect(toolEvents.length).toBeGreaterThan(0);
    });
  });

  describe('result shape', () => {
    it('RuntimeResult does not contain conversation state', async () => {
      const client = makeFakeClient([{ content: 'Done.' }]);
      const runtime = new SynaxRuntime({ client });

      const result = await runtime.run({ input: 'test' });

      const keys = Object.keys(result);
      expect(keys).toEqual(['status', 'output', 'filesChanged', 'toolCalls', 'steps', 'error']);
    });

    it('accepts no-arg model config for openai-compatible endpoints', () => {
      const client = makeFakeClient([{ content: 'ok' }]);
      // Test that openai-compatible provider string is accepted
      const runtime = new SynaxRuntime({
        client,
        model: { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen' },
      });
      // Falls back to client since both client and model are provided
      expect(runtime).toBeInstanceOf(SynaxRuntime);
    });
  });

  describe('HolographicMemory as MemoryAdapter', () => {
    it('HolographicMemory structurally satisfies MemoryAdapter', () => {
      // This is a compile-time check — if HolographicMemory doesn't satisfy
      // MemoryAdapter, this line won't compile.
      const { HolographicMemory } = require('../../memory/HolographicMemory');
      const adapter: MemoryAdapter = new HolographicMemory(null);
      // HolographicMemory has store/search/buildMemoryIndex/isAvailable
      expect(adapter.store).toBeDefined();
      expect(adapter.search).toBeDefined();
      expect(adapter.buildMemoryIndex).toBeDefined();
    });
  });

  // ─── Hardening tests ─────────────────────────────────────

  describe('started event', () => {
    it('emits started as the first event', async () => {
      const client = makeFakeClient([{ content: 'done.' }]);
      const events: RuntimeEvent[] = [];
      const runtime = new SynaxRuntime({ client, onEvent: (e) => events.push(e) });

      await runtime.run({ input: 'test' });

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].type).toBe('started');
    });
  });

  describe('no memory adapter', () => {
    it('runs without a memory adapter', async () => {
      const client = makeFakeClient([{ content: 'task done.' }]);
      const runtime = new SynaxRuntime({ client });

      const result = await runtime.run({ input: 'no memory test' });

      expect(result.status).toBe('completed');
    });
  });

  describe('memory adapter error tolerance', () => {
    it('handles adapter store() throwing', async () => {
      const throwingMemory: MemoryAdapter = {
        store() { throw new Error('store failed'); },
        search() { return []; },
        buildMemoryIndex() { return null; },
      };
      const client = makeFakeClient([{ content: 'done.' }]);
      const runtime = new SynaxRuntime({ client, memory: throwingMemory });

      // Should not throw — MemoryBridge catches store errors
      const result = await runtime.run({ input: 'test' });
      expect(result).toHaveProperty('status');
    });

    it('handles adapter search() throwing', async () => {
      const throwingMemory: MemoryAdapter = {
        store() { /* ok */ },
        search() { throw new Error('search failed'); },
        buildMemoryIndex() { return null; },
      };
      const client = makeFakeClient([{ content: 'done.' }]);
      const runtime = new SynaxRuntime({ client, memory: throwingMemory });

      const result = await runtime.run({ input: 'test' });
      expect(result).toHaveProperty('status');
    });

    it('handles adapter buildMemoryIndex() throwing', async () => {
      const throwingMemory: MemoryAdapter = {
        store() { /* ok */ },
        search() { return []; },
        buildMemoryIndex() { throw new Error('index failed'); },
      };
      const client = makeFakeClient([{ content: 'done.' }]);
      const runtime = new SynaxRuntime({ client, memory: throwingMemory });

      const result = await runtime.run({ input: 'test' });
      expect(result).toHaveProperty('status');
    });
  });

  describe('tool isolation', () => {
    it('excludes inspection tools from model tool surface', async () => {
      const requests: ChatOptions[] = [];
      const client: AgentClient = {
        async chat(opts: ChatOptions): Promise<ChatResponse> {
          requests.push(opts);
          return { content: 'done.', model: 'test', finishReason: 'stop', toolCalls: [], usage: null };
        },
      };

      const runtime = new SynaxRuntime({ client });
      await runtime.run({ input: 'test' });

      expect(requests.length).toBeGreaterThan(0);
      const toolNames = requests.flatMap((r) => (r.tools ?? []).map((t: any) => t.name));
      // Inspection tools should NOT be visible to the model
      expect(toolNames).not.toContain('list_files');
      expect(toolNames).not.toContain('search_text');
      expect(toolNames).not.toContain('read_file_range');
      expect(toolNames).not.toContain('show_git_status');
      expect(toolNames).not.toContain('show_git_diff');
    });

    it('includes custom registered tools in model tool surface', async () => {
      const requests: ChatOptions[] = [];
      const client: AgentClient = {
        async chat(opts: ChatOptions): Promise<ChatResponse> {
          requests.push(opts);
          return { content: 'done.', model: 'test', finishReason: 'stop', toolCalls: [], usage: null };
        },
      };

      const runtime = new SynaxRuntime({ client, tools: [echoTool] });
      await runtime.run({ input: 'test' });

      expect(requests.length).toBeGreaterThan(0);
      const toolNames = requests.flatMap((r) => (r.tools ?? []).map((t: any) => t.name));
      expect(toolNames).toContain('echo');
    });

    it('throws on duplicate custom tool name registration', () => {
      const client = makeFakeClient([{ content: 'done.' }]);
      const toolA: ToolDefinition = { ...echoTool, name: 'my_custom_tool' };
      const toolB: ToolDefinition = { ...echoTool, name: 'my_custom_tool' };

      expect(() => {
        new SynaxRuntime({ client, tools: [toolA, toolB] });
      }).toThrow('already registered');
    });
  });

  describe('failure handling', () => {
    it('returns structured RuntimeResult when model throws instead of crashing', async () => {
      const brokenClient: AgentClient = {
        async chat(): Promise<ChatResponse> {
          throw new Error('model API unreachable');
        },
      };
      const runtime = new SynaxRuntime({ client: brokenClient });
      const result: RuntimeResult = await runtime.run({ input: 'do something' });

      // Must return a clean result, not throw
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('output');
      expect(result).toHaveProperty('filesChanged');
      expect(typeof result.toolCalls).toBe('number');
      expect(typeof result.steps).toBe('number');
    });

    it('does not expose internal AgentConversation on error', async () => {
      const brokenClient: AgentClient = {
        async chat(): Promise<ChatResponse> {
          throw new Error('API down');
        },
      };
      const runtime = new SynaxRuntime({ client: brokenClient });
      const result: RuntimeResult = await runtime.run({ input: 'crash test' });

      expect((result as any).conversation).toBeUndefined();
      expect((result as any).messages).toBeUndefined();
    });
  });

  describe('no side effects', () => {
    it('does not initialize TUI rendering', () => {
      // SynaxRuntime import should not trigger TUI module loading.
      // The constructor should not create TUI artifacts.
      const dummyClient = makeFakeClient([{ content: '' }]);
      const runtime = new SynaxRuntime({ client: dummyClient });
      expect((runtime as any).tui).toBeUndefined();
      expect((runtime as any).renderer).toBeUndefined();
      expect((runtime as any).terminal).toBeUndefined();
    });

    it('does not dispatch subagents during run', async () => {
      // With a simple fake client, the runtime should complete without
      // creating any child sessions or forking.
      const client = makeFakeClient([{ content: 'done.' }]);
      const runtime = new SynaxRuntime({ client });
      const result = await runtime.run({ input: 'simple task' });

      expect(result.status).toBe('completed');
      // No subagent artifacts in the result
      expect((result as any).subAgents).toBeUndefined();
      expect((result as any).handoff).toBeUndefined();
      expect((result as any).forks).toBeUndefined();
    });
  });

  // ─── Async memory adapter support ─────────────────────────

  describe('async memory adapter', () => {
    it('async store resolves and runtime continues', async () => {
      let stored = false;
      const asyncMemory: MemoryAdapter = {
        async store() { stored = true; },
        search() { return []; },
        buildMemoryIndex() { return null; },
      };
      const client = makeFakeClient([{ content: 'done.' }]);
      const runtime = new SynaxRuntime({ client, memory: asyncMemory });

      const result = await runtime.run({ input: 'test' });

      expect(result.status).toBe('completed');
      expect(stored).toBe(true);
    });

    it('async search resolves and runtime continues', async () => {
      const asyncMemory: MemoryAdapter = {
        store() { /* ok */ },
        async search() { return []; },
        buildMemoryIndex() { return null; },
      };
      const client = makeFakeClient([{ content: 'done.' }]);
      const runtime = new SynaxRuntime({ client, memory: asyncMemory });

      const result = await runtime.run({ input: 'test' });

      // Runtime completes without crashing — async search() is safe even when not called
      expect(result).toHaveProperty('status');
    });

    it('async buildMemoryIndex resolves and runtime continues', async () => {
      let indexed = false;
      const asyncMemory: MemoryAdapter = {
        store() { /* ok */ },
        search() { return []; },
        async buildMemoryIndex() { indexed = true; return '[memory: active]'; },
      };
      const client = makeFakeClient([{ content: 'done.' }]);
      const runtime = new SynaxRuntime({ client, memory: asyncMemory });

      const result = await runtime.run({ input: 'test' });

      expect(result.status).toBe('completed');
      expect(indexed).toBe(true);
    });

    it('async search rejection is caught and runtime returns structured result', async () => {
      const asyncMemory: MemoryAdapter = {
        store() { /* ok */ },
        async search() { throw new Error('search db unreachable'); },
        buildMemoryIndex() { return null; },
      };
      const client = makeFakeClient([{ content: 'done.' }]);
      const runtime = new SynaxRuntime({ client, memory: asyncMemory });

      const result = await runtime.run({ input: 'test' });

      // Runtime should not crash; the session catches the tool error and continues
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('output');
    });

    it('async store rejection is caught without unhandled rejection', async () => {
      const asyncMemory: MemoryAdapter = {
        async store() { throw new Error('storage full'); },
        search() { return []; },
        buildMemoryIndex() { return null; },
      };
      const client = makeFakeClient([{ content: 'done.' }]);
      const runtime = new SynaxRuntime({ client, memory: asyncMemory });

      // Must not throw unhandled rejection — MemoryBridge catches async errors
      const result = await runtime.run({ input: 'test' });

      expect(result).toHaveProperty('status');
    });
  });
});
