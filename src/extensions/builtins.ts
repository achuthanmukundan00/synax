import { QuietRenderer, JsonlRenderer, DebugRenderer } from '../agent/renderers';
import { runVerification } from '../agent/verification';
import { Session, type ModelToolSurfaceOptions } from '../session/Session';
import { discoverLocalDocs, readLocalDoc } from '../context/local-docs';
import { createOpenAICompatibleClient } from '../llm/client';
import type { NormalizedProviderConfig } from '../llm/types';
import { parseOpenAIToolCallsResult, parseToolCallsFromContentResult } from '../llm/tool-calls';
import { repairJson } from '../llm/repair/json-repair';
import { repairXml } from '../llm/repair/xml-repair';
import { sanitizeReasoning } from '../llm/repair/reasoning-sanitizer';
import type { ToolDefinition } from '../tools/types';
import type {
  DocsProvider,
  McpBridge,
  McpImportedTool,
  ProviderAdapter,
  ReasoningSanitizer,
  Renderer,
  ToolCallParser,
  ToolCallRepairer,
  Verifier,
} from './interfaces';

export type BuiltinRendererKind = 'quiet' | 'jsonl' | 'debug';

export interface BuiltinExtensions {
  toolCallParser: ToolCallParser;
  toolCallRepairer: ToolCallRepairer;
  reasoningSanitizer: ReasoningSanitizer;
  docsProvider: DocsProvider;
  verifier: Verifier;
  createProviderAdapter(config: NormalizedProviderConfig): ProviderAdapter;
  createRenderer(kind: BuiltinRendererKind): Renderer;
  createModelTools(options?: ModelToolSurfaceOptions): ToolDefinition[];
  mcpBridge: McpBridge;
}

export function createBuiltinExtensions(): BuiltinExtensions {
  return {
    toolCallParser: {
      parseContent: parseToolCallsFromContentResult,
      parseNative: parseOpenAIToolCallsResult,
    },
    toolCallRepairer: {
      repairMalformedJson: (raw, _context) => {
        const result = repairJson(raw);
        return result?.repaired ?? null;
      },
      repairMalformedXml: (raw, _context) => {
        const result = repairXml(raw);
        return result?.repaired ?? null;
      },
    },
    reasoningSanitizer: {
      sanitize: (content) => sanitizeReasoning(content),
    },
    docsProvider: {
      discover: ({ repoRoot, maxFiles }) => discoverLocalDocs(repoRoot, maxFiles),
      read: ({ repoRoot, path, options }) => readLocalDoc(repoRoot, path, options),
    },
    verifier: {
      verify: runVerification,
    },
    createProviderAdapter,
    createRenderer,
    createModelTools: Session.buildModelTools,
    mcpBridge: guardedMcpBridge,
  };
}

function createProviderAdapter(config: NormalizedProviderConfig): ProviderAdapter {
  if (config.kind !== 'openai-compatible') {
    throw new Error(`unsupported built-in provider adapter: ${config.kind}`);
  }

  const client = createOpenAICompatibleClient(config);
  return {
    kind: config.kind,
    chat: (options) => client.chat(options),
  };
}

function createRenderer(kind: BuiltinRendererKind): Renderer {
  switch (kind) {
    case 'quiet':
      return new QuietRenderer();
    case 'jsonl':
      return new JsonlRenderer();
    case 'debug':
      return new DebugRenderer();
  }
}

const guardedMcpBridge: McpBridge = {
  exportNativeTool: (tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }),
  async importTool(tool: McpImportedTool) {
    if (!tool.name.trim() || !isPlainObject(tool.inputSchema)) {
      return { ok: false, reason: 'invalid-schema' };
    }

    if (!tool.policy.readOnly || !tool.policy.rejectsUnsafePaths || !tool.policy.boundedOutput) {
      return { ok: false, reason: 'policy-rejected' };
    }

    return { ok: false, reason: 'unsupported' };
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
