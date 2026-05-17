/**
 * Synax SDK — public types for embedding Synax in external apps.
 *
 * ```ts
 * import { SynaxRuntime, type MemoryAdapter, type Policy } from 'synax';
 * ```
 */

import type { MemoryEntry, MemorySearchResult } from '../memory/HolographicMemory';
import type { ToolDefinition } from '../tools/types';
import type { ContextBudgetSettings } from '../agent/context-budget';
import type { Logger } from '../logging';
import type { RunMode } from '../agent/task-policy';
import type { AgentBudgetSnapshot, AgentActivity } from '../session/types';

// Re-export memory types so SDK consumers can implement MemoryAdapter
export type { MemoryEntry, MemorySearchResult };

// ─── ModelConfig ─────────────────────────────────────────

export interface ModelConfig {
  /** Provider ID (e.g. 'custom', 'relay', 'deepseek'). Defaults to 'custom'. */
  provider?: string;
  /** OpenAI-compatible base URL (e.g. 'http://127.0.0.1:1234/v1'). */
  baseUrl: string;
  /** Model name to use. */
  model: string;
  /** API key. Empty string for local endpoints without auth. */
  apiKey?: string;
  /** Max output tokens per model response. */
  maxTokens?: number;
  /** Request timeout in milliseconds. Default 120000. */
  timeoutMs?: number;
  /** Custom HTTP headers for every provider request. */
  customHeaders?: Record<string, string>;
}

// ─── MemoryAdapter ───────────────────────────────────────

/**
 * Pluggable memory interface for the agent runtime.
 *
 * The default implementation is HolographicMemory (SQLite FTS5).
 * External apps can provide any backing store by implementing this interface.
 */
export interface MemoryAdapter {
  /** Store a memory entry. Sync or async — both work. */
  store(entry: MemoryEntry): void | Promise<void>;
  /** Full-text search over stored memory. Results ranked by relevance. */
  search(query: string, limit?: number): MemorySearchResult[] | Promise<MemorySearchResult[]>;
  /** Build a compact index of what's in memory for context injection. Returns null if empty. */
  buildMemoryIndex(): string | null | Promise<string | null>;
}

// ─── Policy ──────────────────────────────────────────────

export type ApprovalDecision = 'allow' | 'deny';

export interface ToolUseRequest {
  toolName: string;
  args: Record<string, unknown>;
}

export interface FileEditPreview {
  path: string;
  diff: string;
}

/**
 * Approval policy for tool use and file edits.
 *
 * Implement this to control what the agent can do. Both methods are optional —
 * omit to allow all actions of that type.
 */
export interface Policy {
  /** Called before each tool execution. Return 'deny' to block. */
  approveToolUse?(request: ToolUseRequest): ApprovalDecision | Promise<ApprovalDecision>;
  /** Called before file edits. Return 'deny' to reject. */
  approveFileEdit?(preview: FileEditPreview): ApprovalDecision | Promise<ApprovalDecision>;
}

// ─── Event system ────────────────────────────────────────

export type RuntimeEvent =
  | { type: 'started'; timestamp: string }
  | { type: 'model_step'; content: string; timestamp: string }
  | { type: 'model_response'; content: string; timestamp: string }
  | { type: 'model_step_started'; stepIndex: number; timestamp: string }
  | { type: 'tool_start'; toolName: string; args: unknown; timestamp: string }
  | { type: 'tool_finish'; toolName: string; success: boolean; error?: string; timestamp: string }
  | { type: 'task_started'; timestamp: string }
  | { type: 'task_finished'; timestamp: string }
  | { type: 'error'; message: string; timestamp: string }
  | { type: 'complete'; status: RuntimeStatus; timestamp: string }
  | {
      type: 'token_usage';
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      step: number;
      timestamp: string;
    };

export type RuntimeStatus = 'completed' | 'error' | 'blocked' | 'policy_blocked';

// ─── RuntimeResult ───────────────────────────────────────

/**
 * Result of a single runtime.run() call.
 * Does NOT expose internal AgentConversation.
 */
export interface RuntimeResult {
  /** Terminal state of the agent run. */
  status: RuntimeStatus;
  /** Final text output from the model. */
  output: string;
  /** Files that were modified during the run. */
  filesChanged: string[];
  /** Total tool calls made. */
  toolCalls: number;
  /** Model steps (turns) taken. */
  steps: number;
  /** Error message if status is 'error' or 'blocked'. */
  error?: string;
}

// ─── RuntimeConfig ───────────────────────────────────────

export interface RuntimeConfig {
  /** Model endpoint configuration. Required unless `client` is provided. */
  model?: ModelConfig;
  /** Pre-built AgentClient for testing or custom providers. */
  client?: import('../session/types').AgentClient;
  /** Memory adapter. Omit for stateless runs. */
  memory?: MemoryAdapter;
  /** Custom tool definitions to register alongside built-in tools. */
  tools?: ToolDefinition[];
  /** Approval policy for tool use and file edits. */
  policy?: Policy;
  /** Called for each RuntimeEvent during run(). */
  onEvent?: (event: RuntimeEvent) => void;
  /** Agent run mode. Defaults to 'patch'. */
  mode?: RunMode;
  /** Called with budget snapshots during a run. */
  onBudget?: (snapshot: AgentBudgetSnapshot) => void;
  /** Called with activity updates during a run. */
  onActivity?: (activity: AgentActivity) => void;
  /** Working directory for file operations. Defaults to process.cwd(). */
  workingDir?: string;
  /** Stable session ID for memory persistence across runs. */
  sessionId?: string;
  /** Enable bash/shell tools. Default true. */
  bashEnabled?: boolean;
  /** Context budget settings for the session. */
  contextBudget?: Partial<ContextBudgetSettings>;
  /** Max output tokens per model response. */
  maxOutputTokens?: number;
  /** Logger for structured logging. */
  logger?: Logger;
}

// ─── RuntimeRunInput ─────────────────────────────────────

export interface RuntimeRunInput {
  /** The natural-language task to execute. */
  input: string;
  /** Optional context string prepended to the task. */
  context?: string;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Per-run session ID override. Takes precedence over config-level sessionId. */
  sessionId?: string;
}
