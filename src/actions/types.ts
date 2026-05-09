/**
 * Typed agent actions — extracted from runner.ts tool dispatch.
 *
 * Each action corresponds to a tool the agent can invoke. The discriminated
 * union enables type-safe handler dispatch through the ActionExecutor.
 */

import type { ToolResult } from '../tools/types';
import type { InspectionLedger } from '../tools';
import type { PatchPreview } from '../agent/patch';
import type { TerminalState } from '../agent/events';
import type { ContextBudgetSettings } from '../agent/context-budget';
import type { ParsedToolCall } from '../llm/tool-calls';
import type { RunMode } from '../agent/task-policy';
import type { ExecutionEnv } from '../env/ExecutionEnv';

// ─── Action types ─────────────────────────────────────────

export interface ReadAction {
  kind: 'read';
  path?: string;
  startLine?: number;
  endLine?: number;
  query?: string;
  maxFiles?: number;
  maxMatches?: number;
}

export interface EditAction {
  kind: 'edit';
  path: string;
  oldStr: string;
  newStr: string;
}

export interface WriteAction {
  kind: 'write';
  path: string;
  content: string;
}

export interface BashAction {
  kind: 'bash';
  command: string;
}

export interface SearchMemoryAction {
  kind: 'search_memory';
  query: string;
  maxResults?: number;
}

export type AgentAction = ReadAction | EditAction | WriteAction | BashAction | SearchMemoryAction;

// ─── Execution context ────────────────────────────────────

/** Mutable turn-scoped state passed through each tool execution. */
export interface ExecutionContext {
  repoRoot: string;
  registry: import('../tools/types').ToolRegistry;
  ledger: InspectionLedger;
  mode: RunMode;
  env: ExecutionEnv;
  readCache: Map<string, ToolResult>;
  identicalReadCounts: Map<string, number>;
  totalReadCalls: number;
  totalReadResultTokens: number;
  readResultBudget: ContextBudgetSettings;
  ensureCheckpoint?: () => Promise<unknown>;
  approvePatch?: (preview: PatchPreview) => PatchApprovalDecision | Promise<PatchApprovalDecision>;
  onPatchPreview?: (preview: PatchPreview) => void;
  memory?: import('../memory/HolographicMemory').HolographicMemory | null;
}

// ─── Handler type ─────────────────────────────────────────

/** A tool handler receives a typed action and execution context, returns a result. */
export type PatchApprovalDecision = 'accept' | 'reject';

export type ActionHandler = (action: AgentAction, context: ExecutionContext) => Promise<AgentToolExecutionResult>;

// ─── Result ───────────────────────────────────────────────

export interface AgentToolExecutionResult {
  success: boolean;
  toolResult: ToolResult;
  changedFile?: string;
  error?: string;
  terminalState?: TerminalState;
}

// ─── Shared helpers ───────────────────────────────────────

/** Create a failure result for a tool call. */
export function toolFailure(
  toolName: string,
  error: string,
): { success: false; toolResult: ToolResult; error: string } {
  return {
    success: false,
    error,
    toolResult: { success: false, toolName, error },
  };
}

/**
 * Convert a ParsedToolCall to a typed AgentAction.
 * Returns null if the tool name is unrecognized or arguments are missing required fields.
 */
export function toAgentAction(call: ParsedToolCall): AgentAction | null {
  const args = call.arguments;
  switch (call.name) {
    case 'read':
      return {
        kind: 'read',
        path: typeof args.path === 'string' ? args.path : undefined,
        startLine: typeof args.startLine === 'number' ? args.startLine : undefined,
        endLine: typeof args.endLine === 'number' ? args.endLine : undefined,
        query: typeof args.query === 'string' ? args.query : undefined,
        maxFiles: typeof args.maxFiles === 'number' ? args.maxFiles : undefined,
        maxMatches: typeof args.maxMatches === 'number' ? args.maxMatches : undefined,
      };
    case 'edit':
    case 'replace_in_file':
      if (typeof args.path !== 'string' || typeof args.oldStr !== 'string' || typeof args.newStr !== 'string') {
        return null;
      }
      return { kind: 'edit', path: args.path, oldStr: args.oldStr, newStr: args.newStr };
    case 'write':
    case 'create_file':
      if (typeof args.path !== 'string' || typeof args.content !== 'string') {
        return null;
      }
      return { kind: 'write', path: args.path, content: args.content };
    case 'bash':
      if (typeof args.command !== 'string' || args.command.trim().length === 0) {
        return null;
      }
      return { kind: 'bash', command: args.command.trim() };
    case 'search_memory':
      if (typeof args.query !== 'string' || args.query.trim().length === 0) {
        return null;
      }
      return {
        kind: 'search_memory',
        query: args.query.trim(),
        maxResults: typeof args.maxResults === 'number' ? args.maxResults : undefined,
      };
    default:
      // Unknown tool — let the registry handle it
      return null;
  }
}
