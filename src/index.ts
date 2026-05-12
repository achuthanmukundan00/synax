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

export type { ToolRegistry, ToolDefinition, ToolResult, ToolSafetyPolicy } from './tools/types';
export type { AgentEvent, TerminalState } from './agent/events';
