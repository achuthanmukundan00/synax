import type { AgentEvent } from '../agent/events';
import type { VerificationOptions, VerificationResult } from '../agent/verification';
import type { LocalDocRead, LocalDocReadOptions, LocalDocsDiscovery } from '../context/local-docs';
import type { ChatOptions, ChatResponse } from '../llm/types';
import type { ToolCallParseResult } from '../llm/tool-calls';
import type { ToolDefinition, ToolSafetyPolicy } from '../tools/types';

/**
 * Parses provider-native or text-shaped tool calls into Synax's normalized call shape.
 */
export interface ToolCallParser {
  parseContent(content: string): ToolCallParseResult;
  parseNative?(toolCalls: unknown): ToolCallParseResult;
}

export interface ToolCallRepairContext {
  source: 'content' | 'native';
  toolName?: string;
}

/**
 * Attempts bounded repair of malformed structured tool-call text.
 * Supports JSON (most common) and XML (Qwen-family) formats.
 */
export interface ToolCallRepairer {
  repairMalformedJson(raw: string, context?: ToolCallRepairContext): string | null;
  repairMalformedXml?(raw: string, context?: ToolCallRepairContext): string | null;
}

export interface ReasoningSanitizerResult {
  content: string;
  removedReasoning: boolean;
}

/**
 * Removes reasoning/thinking text that must not be executed or rendered as final output.
 */
export interface ReasoningSanitizer {
  sanitize(content: string): ReasoningSanitizerResult;
}

/**
 * Provider boundary for local OpenAI-compatible and future provider adapters.
 */
export interface ProviderAdapter {
  kind: string;
  chat(options: ChatOptions): Promise<ChatResponse>;
}

export interface ContextProviderInput {
  repoRoot: string;
  maxChars?: number;
}

export interface ContextProviderResult {
  content: string;
  truncated: boolean;
  sources?: string[];
}

/**
 * Supplies bounded context to the agent without requiring embeddings or databases.
 */
export interface ContextProvider {
  name: string;
  getContext(input: ContextProviderInput): Promise<ContextProviderResult>;
}

/**
 * Runs a bounded verification command or profile.
 */
export interface Verifier {
  verify(options: VerificationOptions): Promise<VerificationResult>;
}

export interface DocsProviderDiscoverInput {
  repoRoot: string;
  maxFiles?: number;
}

export interface DocsProviderReadInput {
  repoRoot: string;
  path: string;
  options?: LocalDocReadOptions;
}

/**
 * Discovers and reads bounded project documentation/spec context.
 */
export interface DocsProvider {
  discover(input: DocsProviderDiscoverInput): Promise<LocalDocsDiscovery>;
  read(input: DocsProviderReadInput): Promise<LocalDocRead>;
}

/**
 * Renders agent events for a CLI or machine-readable output mode.
 */
export interface Renderer {
  onEvent(event: AgentEvent): void;
  finish?(): void;
}

export interface McpExportedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpImportedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  policy: ToolSafetyPolicy;
}

export type McpImportResult =
  | { ok: true; tool: ToolDefinition }
  | { ok: false; reason: 'invalid-schema' | 'policy-rejected' | 'unsupported' };

/**
 * Groundwork for guarded MCP export/import.
 *
 * Implementations must preserve Synax tool policy, approval/checkpoint policy,
 * verification policy, and context/budget policy.
 */
export interface McpBridge {
  exportNativeTool(tool: McpExportedTool): McpExportedTool;
  importTool(tool: McpImportedTool): Promise<McpImportResult>;
}
