/**
 * Verification contracts — typed completion gates replacing regex heuristics.
 *
 * Instead of "does the model say 'verified passed'?", the system checks
 * objective evidence: were files changed? Did verification run? Did it pass?
 *
 * Contract levels (ascending):
 *   none            → accept any completion
 *   files_changed   → at least one file was modified
 *   verification_ran → a verification command was executed
 *   verification_passed → verification exited with code 0
 */

import type { TerminalState } from '../agent/events';

// ─── Types ───────────────────────────────────────────────────────────────────

export type VerificationLevel = 'none' | 'files_changed' | 'verification_ran' | 'verification_passed';

export interface VerificationContract {
  level: VerificationLevel;
  /** Human-readable label for diagnostics. */
  label: string;
}

export interface VerificationCheck {
  /** The contract being evaluated. */
  contract: VerificationContract;
  /** Evidence available to check against the contract. */
  evidence: VerificationEvidence;
}

export interface VerificationEvidence {
  /** Files changed during the turn so far. */
  changedFiles: string[];
  /** Whether verification has been executed this turn. */
  verificationRan: boolean;
  /** Verification exit code (undefined if not run). */
  verificationExitCode?: number;
  /** The model's response content (for diagnostics only). */
  responseContent?: string;
}

export interface VerificationResult {
  /** Whether the contract is satisfied. */
  passed: boolean;
  /** Human-readable explanation of why it passed or failed. */
  message: string;
  /** The contract that was evaluated. */
  contract: VerificationContract;
  /** If failed: a nudge message to inject into the conversation. */
  nudge?: string;
}

// ─── Contract presets ────────────────────────────────────────────────────────

export const VERIFICATION_CONTRACTS: Record<Exclude<VerificationLevel, 'none'>, VerificationContract> = {
  files_changed: {
    level: 'files_changed',
    label: 'Files changed — at least one file was modified',
  },
  verification_ran: {
    level: 'verification_ran',
    label: 'Verification ran — a verification command was executed',
  },
  verification_passed: {
    level: 'verification_passed',
    label: 'Verification passed — verification exited with code 0',
  },
};

// ─── Contract resolution ─────────────────────────────────────────────────────

/**
 * Resolve the minimum verification contract for a given run mode.
 *
 * - 'patch': files_changed (must actually modify something)
 * - 'verify': verification_passed (must pass verification)
 * - 'read-only' / 'docs': none (no mutations expected)
 */
export function resolveVerificationContract(mode: string): VerificationContract {
  if (mode === 'verify') return VERIFICATION_CONTRACTS.verification_passed;
  if (mode === 'patch') return VERIFICATION_CONTRACTS.files_changed;
  return { level: 'none', label: 'No verification required' };
}

// ─── Contract evaluation ─────────────────────────────────────────────────────

/**
 * Evaluate a verification contract against available evidence.
 *
 * Returns a VerificationResult with passed/failed status and a nudge message
 * for failed contracts that tells the model exactly what's missing.
 */
export function evaluateVerificationContract(check: VerificationCheck): VerificationResult {
  const { contract, evidence } = check;

  switch (contract.level) {
    case 'none':
      return {
        passed: true,
        message: 'No verification required.',
        contract,
      };

    case 'files_changed': {
      const passed = evidence.changedFiles.length > 0;
      return {
        passed,
        message: passed
          ? `${evidence.changedFiles.length} file(s) changed.`
          : 'No files were changed.',
        contract,
        nudge: passed
          ? undefined
          : 'You claimed completion but no files were changed. ' +
            'Use available tools (bash for git/commands, edit for file changes, write for new files) to complete the task. ' +
            'If no action is needed, explain specifically why. Do not just say "verified" or "passed" — show evidence.',
      };
    }

    case 'verification_ran': {
      const passed = evidence.verificationRan;
      return {
        passed,
        message: passed ? 'Verification was executed.' : 'Verification has not been run.',
        contract,
        nudge: passed
          ? undefined
          : 'You must run the verification command before claiming completion. Use bash to execute the verification.',
      };
    }

    case 'verification_passed': {
      const passed = evidence.verificationRan && evidence.verificationExitCode === 0;
      return {
        passed,
        message: passed
          ? 'Verification passed (exit code 0).'
          : evidence.verificationRan
            ? `Verification failed (exit code ${evidence.verificationExitCode}).`
            : 'Verification has not been run.',
        contract,
        nudge: !evidence.verificationRan
          ? 'You must run the verification command before claiming completion.'
          : `Verification failed with exit code ${evidence.verificationExitCode}. Fix the issues and run verification again.`,
      };
    }
  }
}

// ─── Convenience: check completion against contract ──────────────────────────

/**
 * Check whether a model's completion claim passes the verification contract.
 *
 * This replaces isPrematureCompletionClaim() — instead of regex-matching
 * English phrases, it checks objective evidence against the contract.
 *
 * @returns null if the completion is valid, or a nudge message to inject.
 */
export function checkCompletionAgainstContract(
  contract: VerificationContract,
  evidence: VerificationEvidence,
  terminalState: TerminalState,
): string | null {
  // Only check when the model is claiming completion
  if (terminalState !== 'completed') return null;

  const result = evaluateVerificationContract({ contract, evidence });
  if (result.passed) return null;

  return result.nudge ?? `Completion check failed: ${result.message}`;
}
