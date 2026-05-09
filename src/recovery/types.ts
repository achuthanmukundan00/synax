/**
 * Recovery types — failure scenarios and recovery actions.
 *
 * Extracted from the recovery recipes spec (010). Each failure scenario
 * has a pre-programmed recovery path so the agent survives rather than
 * failing closed.
 */

// ─── Lightweight conversation type (avoids circular dep with Session) ──

export interface RecoveryConversation {
  messages: Array<{ role: string; content: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

// ─── Failure scenarios ───────────────────────────────────

export type FailureScenario =
  | 'empty_response'
  | 'bash_failure'
  | 'context_exhaustion'
  | 'infinite_loop'
  | 'malformed_tool_call'
  | 'provider_error'
  | 'missing_api_key';

// ─── Recovery context ────────────────────────────────────

export interface RecoveryContext {
  scenario: FailureScenario;
  /** The conversation state at the time of failure. */
  conversation: RecoveryConversation;
  /** The task being attempted. */
  task: string;
  /** Number of recovery attempts made so far for this scenario. */
  attempt: number;
  /** Additional details about the failure. */
  details?: string;
  /** For bash failures: stderr output to feed back to the model. */
  stderr?: string;
  /** For infinite loop: the repeated action description. */
  repeatedAction?: string;
}

// ─── Recovery result ─────────────────────────────────────

export interface RecoveryResult {
  /** Whether recovery was applied (false = give up). */
  recovered: boolean;
  /** Message injected into the conversation as a user/system nudge. */
  injectedMessage?: string;
  /** Updated conversation after recovery mutations. */
  conversation: RecoveryConversation;
}

// ─── Recovery action ─────────────────────────────────────

export interface RecoveryAction {
  scenario: FailureScenario;
  /** Maximum number of times this recovery can be attempted per turn. */
  maxAttempts: number;
  /** Execute the recovery action. Returns updated recovery result. */
  execute(context: RecoveryContext): Promise<RecoveryResult>;
}

// ─── Recoverable error ───────────────────────────────────

/**
 * Throw this instead of returning a terminal state.
 * The recovery loop catches it and applies the matching recipe.
 */
export class RecoverableError extends Error {
  readonly scenario: FailureScenario;
  readonly details?: string;
  readonly stderr?: string;
  readonly repeatedAction?: string;

  constructor(opts: {
    scenario: FailureScenario;
    message: string;
    details?: string;
    stderr?: string;
    repeatedAction?: string;
  }) {
    super(opts.message);
    this.name = 'RecoverableError';
    this.scenario = opts.scenario;
    this.details = opts.details;
    this.stderr = opts.stderr;
    this.repeatedAction = opts.repeatedAction;
  }
}
