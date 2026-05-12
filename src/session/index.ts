/**
 * Session module — re-exports for `synax/session` subpath.
 *
 * ```ts
 * import { Session } from 'synax/session';
 * ```
 */

export { Session, systemPrompt } from './Session';
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
  TurnContext,
} from './types';
