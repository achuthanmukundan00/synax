/**
 * Synax SDK — main entry point for programmatic consumption.
 *
 * ```ts
 * import { Session } from 'synax';
 * ```
 */

export { Session, systemPrompt } from './session/Session';
export type {
  AgentTerminalState,
  AgentMessage,
  AgentClient,
  AgentConversation,
  AgentRunnerOptions,
  ModelToolSurfaceOptions,
  AgentActivity,
  AgentBudgetSnapshot,
  PatchApprovalDecision,
  AgentTurnResult,
} from './session/Session';

export { HandoffManager } from './handoff/HandoffManager';
export type { HandoffManifest, HandoffReason, HandoffResult, HandoffManagerOptions } from './handoff/types';

export { HolographicMemory } from './memory/HolographicMemory';
export type {
  MemoryEntry,
  MemorySearchResult,
  HandoffManifest as MemoryHandoffManifest,
} from './memory/HolographicMemory';

export { RecoveryManager } from './recovery/RecoveryManager';

export { ActionExecutor, createDefaultHandlerMap } from './actions/ActionExecutor';
export type { ActionKind, HandlerMap } from './actions/ActionExecutor';
export type {
  AgentAction,
  AgentToolExecutionResult,
  ActionHandler,
  ExecutionContext,
  ReadAction,
  EditAction,
  WriteAction,
  BashAction,
  SearchMemoryAction,
  ViewImageAction,
} from './actions/types';

export { discoverSkills, buildSkillMessages, parseFrontmatter } from './skills/SkillLoader';
export type { Skill, SkillDiscovery, SkillFrontmatter } from './skills/types';

export type { ToolRegistry, ToolDefinition, ToolResult, ToolSafetyPolicy } from './tools/types';
export type { AgentEvent, TerminalState } from './agent/events';

// ─── SDK v0.1 — embeddable single-agent runtime ─────────────────

export { SynaxRuntime } from './sdk/SynaxRuntime';
export type {
  ModelConfig,
  MemoryAdapter,
  Policy,
  ApprovalDecision,
  ToolUseRequest,
  FileEditPreview,
  RuntimeEvent,
  RuntimeStatus,
  RuntimeResult,
  RuntimeConfig,
  RuntimeRunInput,
} from './sdk/types';

// ─── Super Edition — world/self/reflection cognitive layer ───

export {
  SuperWorld,
  SuperSelfModel,
  SuperRuntime,
  SuperPulse,
  SuperDreamCycle,
  NoopSuperMemoryConsolidator,
  defaultAutoCareerToolNames,
} from './super';
export type {
  SuperWorldPaths,
  SuperSelfModelOptions,
  SuperRunKind,
  SuperSelfModificationMode,
  SuperActionPlan,
  SuperRunRequest,
  SuperRunResult,
  SuperPatchSuggestion,
  SynaxRuntimeLike,
  SuperMemoryConsolidationInput,
  SuperMemoryConsolidationResult,
  SuperMemoryConsolidator,
  AutoCareerContextProvider,
  AutoCareerToolName,
  AutoCareerToolRegistration,
} from './super';
