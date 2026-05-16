/**
 * Session types — extracted from Session.ts to avoid circular dependencies
 * between the Session class and extracted helper modules.
 */

import type { ChatOptions, ChatResponse } from '../llm/types';
import type { InspectionLedger } from '../tools';
import type { ToolRegistry } from '../tools/types';
import type { PatchPreview } from '../agent/patch';
import type {
  AssemblyStats,
  CompactionRecord,
  ContextBudgetSettings,
  TokenLedger,
  RepoMetadata,
  BudgetStrategy,
} from '../agent/context-budget';
import type { AgentEvent, TerminalState, AgentEventBase } from '../agent/events';
import type { RunMode } from '../agent/task-policy';
import type { Logger } from '../logging/index.js';
import type { SpanTracer } from '../telemetry/SpanTracer';
import type { TokenCounter } from '../metrics/TokenCounter';
import type { CostTracker } from '../metrics/CostTracker';
import type { ExecutionEnv } from '../env/ExecutionEnv';
import type { HolographicMemory } from '../memory/HolographicMemory';
import type { VerificationContract } from './verification-contracts';

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
  reasoningContent?: string;
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

// ─── Orchestration types (spec 021 phase 1) ───────────────────────────────────

/**
 * Sub-task for orchestration planner output parsing.
 */
export interface OrchestratedSubtask {
  id: string;
  description: string;
  fileScope?: string[];
  dependencies?: string[];
  parallelizable?: boolean;
  estimatedTokens?: number;
  /** Optional verification contract override (when absent, defaults to files_changed). */
  verification?: VerificationContract;
}

/**
 * A single sub-task in an orchestration plan.
 *
 * Each SubTask carries a typed budget that the orchestration runtime enforces,
 * following the Codex CLI GoalRuntimeState pattern.
 */
export interface SubTask {
  /** Unique identifier within the orchestration plan. */
  id: string;
  /** Human-readable description of what this sub-task accomplishes. */
  description: string;
  /** Estimated token budget for this sub-task. */
  estimatedBudget: number;
  /** File paths this sub-task is expected to operate on. */
  fileScope: string[];
  /** IDs of sub-tasks that must complete before this one can start. */
  dependencies: string[];
  /** Verification contract — the system checks completion, not the child self-declaring. */
  verification: VerificationContract;
}

/**
 * Result from a single sub-agent execution.
 *
 * Reuses the existing AgentTerminalState enum for consistency
 * with the main turn loop's terminal state taxonomy.
 */
export interface SubAgentResult {
  /** Matches the SubTask.id this result corresponds to. */
  subTaskId: string;
  /** Terminal state of this sub-agent (completed, blocked, budget_exhausted, etc.). */
  terminalState: AgentTerminalState;
  /** Files modified by this sub-agent. */
  changedFiles: string[];
  /** Number of tool calls made by this sub-agent (for observability). */
  toolCalls: number;
  /** Error message if the sub-agent did not complete successfully. */
  error?: string;
}

/**
 * An orchestration plan produced by budget estimation.
 *
 * This is the output of the planning phase — a decomposition of the task
 * into sub-tasks, each with a typed budget and verification contract.
 */
export interface OrchestrationPlan {
  planId?: string;
  inline?: boolean;
  subtasks?: OrchestratedSubtask[]; // Added for new plan parser compatibility
  /** Decomposed sub-tasks in dependency order. */
  subTasks: SubTask[];
  /** Strategy used to produce this plan. */
  strategy: BudgetStrategy;
  /** Total estimated token budget across all sub-tasks. */
  estimatedTotalTokens: number;
  /** Repository metadata used for estimation. */
  repoMetadata: RepoMetadata;
  /** Context window tokens of the model this plan targets. */
  contextWindowTokens: number;
}

/**
 * Aggregate result of executing an orchestration plan.
 */
export interface OrchestrationResult {
  /** The plan that was executed. */
  plan: OrchestrationPlan;
  /** Results for each sub-task, in execution order. */
  results: SubAgentResult[];
  /** Aggregate terminal state (worst of all sub-results). */
  terminalState: AgentTerminalState;
  /** Union of all files changed across sub-agents (deduplicated). */
  changedFiles: string[];
  /** Total tool calls across all sub-agents. */
  toolCalls: number;
  /** Human-readable conclusion summarizing all sub-task results. */
  conclusion: string;
  /** Aggregate error if any sub-agent failed. */
  error?: string;
}

/**
 * Result of attempting to parse an orchestration plan from a model response.
 */
export type PlanParseResult =
  | { success: true; plan: OrchestrationPlan }
  | { success: false; inline: true; error?: string };

/**
 * Emitted when the model proposes a task decomposition plan.
 */
export interface OrchestrationPlanGeneratedEvent extends AgentEventBase {
  type: 'orchestration_plan_generated';
  payload: {
    sessionId: string;
    task: string;
    plan: OrchestrationPlan | { inline: true };
  };
}
