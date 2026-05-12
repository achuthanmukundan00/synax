/**
 * Session types — extracted from Session.ts to avoid circular dependencies
 * between the Session class and extracted helper modules.
 */

import type { ChatOptions, ChatResponse } from '../llm/types';
import type { InspectionLedger } from '../tools';
import type { ToolRegistry } from '../tools/types';
import type { PatchPreview } from '../agent/patch';
import type { AssemblyStats, CompactionRecord, ContextBudgetSettings, TokenLedger } from '../agent/context-budget';
import type { AgentEvent, TerminalState } from '../agent/events';
import type { RunMode } from '../agent/task-policy';
import type { Logger } from '../logging/index.js';
import type { SpanTracer } from '../telemetry/SpanTracer';
import type { TokenCounter } from '../metrics/TokenCounter';
import type { CostTracker } from '../metrics/CostTracker';
import type { ExecutionEnv } from '../env/ExecutionEnv';
import type { HolographicMemory } from '../memory/HolographicMemory';

// Re-export TerminalState as AgentTerminalState for backward compat.
export type AgentTerminalState = TerminalState;

export interface AgentMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: unknown;
  /** Provider-specific reasoning field required by DeepSeek thinking-mode continuation requests. */
  reasoning_content?: string;
  // Internal markers for compaction integrity (not serialized to the model).
  _tool_call_ids?: string[];
  _tool_result_ids?: string[];
}

export interface AgentClient {
  chat(options: ChatOptions): Promise<ChatResponse>;
}

export interface AgentConversation {
  messages: AgentMessage[];
  inspectionLedger: InspectionLedger;
  latestCompaction: CompactionRecord | null;
  tokenLedger: TokenLedger;
  assemblyStats: AssemblyStats | null;
}

export interface AgentRunnerOptions {
  repoRoot: string;
  client: AgentClient;
  maxSteps?: number;
  maxModelSteps?: number;
  maxToolCalls?: number;
  mode?: RunMode;
  tools?: ModelToolSurfaceOptions;
  conversation?: AgentConversation;
  registry?: ToolRegistry;
  onActivity?: (activity: AgentActivity) => void;
  onEvent?: (event: AgentEvent) => void;
  onBudget?: (snapshot: AgentBudgetSnapshot) => void;
  approvePatch?: (preview: PatchPreview) => PatchApprovalDecision | Promise<PatchApprovalDecision>;
  ensureCheckpoint?: () => Promise<unknown>;
  /** Optional preloaded skill instructions injected as additional system messages. */
  skillMessages?: string[];
  contextBudget?: Partial<ContextBudgetSettings> & { contextBudgetTokens?: number };
  /** Optional structured logger for internal diagnostics. */
  logger?: Logger;
  /** Optional span tracer for telemetry instrumentation. */
  tracer?: SpanTracer;
  /** Optional token counter for per-turn usage metrics. */
  tokenCounter?: TokenCounter;
  /** Optional cost tracker for API cost estimation. */
  costTracker?: CostTracker;
  /** Maximum API cost budget (stops agent when exceeded). */
  maxBudget?: number;
}

export interface ModelToolSurfaceOptions {
  bashEnabled?: boolean;
  mode?: RunMode;
}

export interface AgentActivity {
  kind: 'model' | 'tool' | 'model_response';
  message: string;
  /** Raw model output for debugging local-model behavior. Only set when kind === 'model_response'. */
  modelOutput?: string;
  toolCallCount?: number;
}

export interface AgentBudgetSnapshot {
  estimatedInputTokens: number;
  inputLimit: number;
  contextWindowTokens: number;
  reservedOutputTokens: number;
  step: number;
  compactionStage?: number;
}

export type PatchApprovalDecision = 'accept' | 'reject';

export interface AgentTurnResult {
  terminalState: AgentTerminalState;
  finalAnswer: string;
  steps: number;
  toolCalls: Array<{ name: string; success: boolean; error?: string }>;
  changedFiles: string[];
  conversation: AgentConversation;
  error?: string;
}

/**
 * Full execution context passed into the turn loop.
 * Sessions construct this and pass it to executeTurn().
 */
export interface TurnContext {
  repoRoot: string;
  client: AgentClient;
  maxToolCalls: number;
  mode: RunMode;
  bashEnabled: boolean;
  contextBudget: ContextBudgetSettings;
  conversation: AgentConversation;
  registry: ToolRegistry;
  executor: import('../actions/ActionExecutor').ActionExecutor;
  env: ExecutionEnv;
  memory: HolographicMemory | null;
  eventBus: import('../events/EventBus').EventBus;
  recovery: import('../recovery/RecoveryManager').RecoveryManager;
  onActivity?: (activity: AgentActivity) => void;
  onEvent?: (event: AgentEvent) => void;
  onBudget?: (snapshot: AgentBudgetSnapshot) => void;
  approvePatch?: (preview: PatchPreview) => PatchApprovalDecision | Promise<PatchApprovalDecision>;
  ensureCheckpoint?: () => Promise<unknown>;
  logger?: Logger;
  tracer?: SpanTracer;
  tokenCounter?: TokenCounter;
  costTracker?: CostTracker;
  maxBudget?: number;
  _sessionStarted: boolean;
}
