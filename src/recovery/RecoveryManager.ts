/**
 * RecoveryManager — applies recovery recipes when the agent hits failure scenarios.
 *
 * Wraps the Session turn loop with recovery logic for:
 * 1. Empty response → inject nudge, retry
 * 2. Bash failure → feed stderr back to model
 * 3. Context exhaustion → inject compaction nudge, retry once
 * 4. Infinite loop → inject steering message
 */

import type { FailureScenario, RecoveryAction, RecoveryContext, RecoveryResult, RecoveryConversation } from './types';
import { RecoverableError } from './types';

// ─── Constants ────────────────────────────────────────────

const MAX_RECOVERY_ATTEMPTS_PER_TURN = 3;
const MAX_EMPTY_RESPONSE_ATTEMPTS = 2;
const MAX_BASH_FAILURE_ATTEMPTS = 2;
const MAX_CONTEXT_EXHAUSTION_ATTEMPTS = 1;
const MAX_INFINITE_LOOP_ATTEMPTS = 1;

// ─── RecoveryManager ─────────────────────────────────────

/**
 * @public
 */
export class RecoveryManager {
  private recipes: Map<FailureScenario, RecoveryAction>;
  private totalRecoveryAttempts = 0;

  constructor() {
    this.recipes = new Map();
    this.registerDefaults();
  }

  // ── Recipe registration ──────────────────────────────

  private registerDefaults(): void {
    this.register({
      scenario: 'empty_response',
      maxAttempts: MAX_EMPTY_RESPONSE_ATTEMPTS,
      execute: emptyResponseRecipe,
    });

    this.register({
      scenario: 'bash_failure',
      maxAttempts: MAX_BASH_FAILURE_ATTEMPTS,
      execute: bashFailureRecipe,
    });

    this.register({
      scenario: 'context_exhaustion',
      maxAttempts: MAX_CONTEXT_EXHAUSTION_ATTEMPTS,
      execute: contextExhaustionRecipe,
    });

    this.register({
      scenario: 'infinite_loop',
      maxAttempts: MAX_INFINITE_LOOP_ATTEMPTS,
      execute: infiniteLoopRecipe,
    });
  }

  register(recipe: RecoveryAction): void {
    this.recipes.set(recipe.scenario, recipe);
  }

  // ── Recovery loop ────────────────────────────────────

  /**
   * Attempt recovery for a failure scenario.
   * Returns the recovery result if a matching recipe exists and hasn't
   * exceeded its max attempts. Returns null if recovery is not possible.
   */
  async attemptRecovery(context: RecoveryContext): Promise<RecoveryResult | null> {
    const recipe = this.recipes.get(context.scenario);
    if (!recipe) return null;
    if (context.attempt >= recipe.maxAttempts) return null;
    if (this.totalRecoveryAttempts >= MAX_RECOVERY_ATTEMPTS_PER_TURN) return null;

    this.totalRecoveryAttempts++;
    return recipe.execute({ ...context, attempt: context.attempt });
  }

  /** Reset the per-turn attempt counter. */
  resetForTurn(): void {
    this.totalRecoveryAttempts = 0;
  }

  /**
   * Convert a RecoverableError into a RecoveryContext.
   */
  errorToContext(error: RecoverableError, conversation: RecoveryConversation, task: string): RecoveryContext {
    return {
      scenario: error.scenario,
      conversation,
      task,
      attempt: 0,
      details: error.details ?? error.message,
      stderr: error.stderr,
      repeatedAction: error.repeatedAction,
    };
  }
}

// ─── Recipe implementations ──────────────────────────────

async function emptyResponseRecipe(context: RecoveryContext): Promise<RecoveryResult> {
  const nudge =
    'Your last response was empty. Please continue from where you left off. ' +
    'If the task is complete, explain what was done and stop. ' +
    'If you need more information, use a read tool.';

  context.conversation.messages.push({ role: 'user', content: nudge });

  return {
    recovered: true,
    injectedMessage: nudge,
    conversation: context.conversation,
  };
}

async function bashFailureRecipe(context: RecoveryContext): Promise<RecoveryResult> {
  const stderr = context.stderr || 'unknown error';
  const nudge =
    `The last bash command failed with error:\n${stderr}\n\n` +
    'Fix the command and retry, or use a different approach. ' +
    'If the failure is expected (e.g., a file not found), explain and continue.';

  context.conversation.messages.push({ role: 'user', content: nudge });

  return {
    recovered: true,
    injectedMessage: nudge,
    conversation: context.conversation,
  };
}

async function contextExhaustionRecipe(context: RecoveryContext): Promise<RecoveryResult> {
  const nudge =
    '⚠️ Context budget is running low. ' +
    'Stop reading files. Use the information you already have. ' +
    'Take action with bash, edit, or write tools now.';

  context.conversation.messages.push({ role: 'user', content: nudge });

  return {
    recovered: true,
    injectedMessage: nudge,
    conversation: context.conversation,
  };
}

async function infiniteLoopRecipe(context: RecoveryContext): Promise<RecoveryResult> {
  const action = context.repeatedAction || 'the same action';
  const nudge =
    `You appear stuck repeating ${action}. ` +
    'Try a fundamentally different approach. ' +
    'If you are unsure how to proceed, explain what information you need.';

  context.conversation.messages.push({ role: 'user', content: nudge });

  return {
    recovered: true,
    injectedMessage: nudge,
    conversation: context.conversation,
  };
}
