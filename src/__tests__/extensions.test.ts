import type {
  ContextProvider,
  DocsProvider,
  McpBridge,
  ProviderAdapter,
  ReasoningSanitizer,
  Renderer,
  ToolCallParser,
  ToolCallRepairer,
  Verifier,
} from '../extensions';
import type { AgentEvent } from '../agent/events';
import { parseToolCallsFromContentResult } from '../llm/tool-calls';

describe('extension interfaces', () => {
  it('can describe built-in extension seams without runtime plugin state', async () => {
    const parser: ToolCallParser = {
      parseContent: parseToolCallsFromContentResult,
    };
    const repairer: ToolCallRepairer = {
      repairMalformedJson: (raw) => (raw.trim().startsWith('{') ? raw.trim() : null),
    };
    const sanitizer: ReasoningSanitizer = {
      sanitize: (content) => ({ content, removedReasoning: false }),
    };
    const provider: ProviderAdapter = {
      kind: 'openai-compatible',
      chat: async () => ({
        content: '',
        model: 'local',
        finishReason: 'stop',
        toolCalls: [],
        usage: null,
      }),
    };
    const contextProvider: ContextProvider = {
      name: 'static',
      getContext: async () => ({ content: 'context', truncated: false }),
    };
    const verifier: Verifier = {
      verify: async () => ({ state: 'skipped', stdout: '', stderr: '' }),
    };
    const docsProvider: DocsProvider = {
      discover: async () => ({ files: ['README.md'], truncated: false }),
      read: async () => ({
        path: 'README.md',
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        lines: [{ lineNumber: 1, text: '# Synax' }],
        truncated: false,
      }),
    };
    const renderer: Renderer = {
      onEvent: (_event: AgentEvent) => undefined,
    };
    const mcpBridge: McpBridge = {
      exportNativeTool: (tool) => ({ name: tool.name, inputSchema: tool.inputSchema }),
      importTool: async () => ({ ok: false, reason: 'policy-rejected' }),
    };

    expect(parser.parseContent('plain text')).toEqual({ ok: true, source: 'none', calls: [] });
    expect(repairer.repairMalformedJson(' nope')).toBeNull();
    expect(sanitizer.sanitize('answer')).toEqual({ content: 'answer', removedReasoning: false });
    await expect(provider.chat({ messages: [] })).resolves.toMatchObject({ model: 'local' });
    await expect(contextProvider.getContext({ repoRoot: process.cwd() })).resolves.toMatchObject({ truncated: false });
    await expect(verifier.verify({ repoRoot: process.cwd() })).resolves.toMatchObject({ state: 'skipped' });
    await expect(docsProvider.discover({ repoRoot: process.cwd() })).resolves.toEqual({
      files: ['README.md'],
      truncated: false,
    });
    renderer.onEvent({ type: 'model_step_started', timestamp: new Date(0).toISOString() });
    expect(mcpBridge.exportNativeTool({ name: 'read', inputSchema: {} })).toEqual({ name: 'read', inputSchema: {} });
    await expect(
      mcpBridge.importTool({
        name: 'shell',
        inputSchema: {},
        policy: { readOnly: false, rejectsUnsafePaths: false, boundedOutput: false },
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'policy-rejected',
    });
  });
});
