/**
 * runner.ts — thin delegation layer.
 *
 * All agent lifecycle and turn logic now lives in src/session/Session.ts.
 * This module exists for backward compatibility with existing callers.
 *
 * New code should use `import { Session } from '../session/Session'` directly.
 */

// Re-export all types and the Session class from the canonical module.
export {
  Session,
  systemPrompt,
  type AgentTerminalState,
  type AgentMessage,
  type AgentClient,
  type AgentConversation,
  type AgentRunnerOptions,
  type ModelToolSurfaceOptions,
  type AgentActivity,
  type AgentBudgetSnapshot,
  type PatchApprovalDecision,
  type AgentTurnResult,
} from '../session/Session';
import {
  Session,
  systemPrompt,
  type AgentConversation,
  type AgentRunnerOptions,
  type AgentTurnResult,
  type AgentMessage,
  type ModelToolSurfaceOptions,
} from '../session/Session';
import { createInspectionLedger } from '../tools';
import { createTokenLedger } from './context-budget';
import { type ToolDefinition } from '../tools/types';

/**
 * Create a fresh agent conversation with the Synax system prompt.
 * @deprecated Use `Session.createConversation()` instead.
 */
export function createAgentConversation(options: { skillMessages?: string[] } = {}): AgentConversation {
  return Session.createConversation(options);
}

/**
 * Reset an existing conversation to a fresh state.
 * @deprecated Use `session.resetConversation()` on a Session instance instead.
 */
export function resetAgentConversation(
  conversation: AgentConversation,
  options: { skillMessages?: string[] } = {},
): void {
  const messages: AgentMessage[] = [{ role: 'system', content: systemPrompt() }];
  if (options.skillMessages && options.skillMessages.length > 0) {
    for (const message of options.skillMessages) {
      if (message.trim().length === 0) continue;
      messages.push({ role: 'system', content: message });
    }
  }
  conversation.messages.splice(0, conversation.messages.length, ...messages);
  conversation.inspectionLedger = createInspectionLedger();
  conversation.latestCompaction = null;
  conversation.assemblyStats = null;
  // Re-create the token ledger (fresh counters)
  conversation.tokenLedger = createTokenLedger();
}

/**
 * Execute one agent turn: take a task, run the model ↔ tool loop.
 * @deprecated Use `new Session({...}).startTurn(task)` instead.
 */
export async function runAgentTurn(options: AgentRunnerOptions & { task: string }): Promise<AgentTurnResult> {
  const session = new Session({
    repoRoot: options.repoRoot,
    client: options.client,
    mode: options.mode,
    maxToolCalls: options.maxToolCalls,
    bashEnabled: options.tools?.bashEnabled,
    skillMessages: options.skillMessages,
    conversation: options.conversation,
    registry: options.registry,
    contextBudget: options.contextBudget,
    onActivity: options.onActivity,
    onEvent: options.onEvent,
    onBudget: options.onBudget,
    approvePatch: options.approvePatch,
    ensureCheckpoint: options.ensureCheckpoint,
    logger: options.logger,
    tracer: options.tracer,
  });
  return session.startTurn(options.task);
}

/**
 * Build the model-facing tool definitions for the current surface.
 * @deprecated Use `Session.buildModelTools(options)` instead.
 */
export function buildModelFacingTools(options: ModelToolSurfaceOptions = {}): ToolDefinition[] {
  return Session.buildModelTools(options);
}
