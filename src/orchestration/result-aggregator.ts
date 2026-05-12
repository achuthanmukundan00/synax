/**
 * Result aggregator — merges SubAgentResult[] from orchestrated children
 * into an OrchestrationResult with a narrative conclusion.
 *
 * Handles:
 * - Deduplicated changedFiles union
 * - Key findings concatenation
 * - Pending work collection from incomplete children
 * - Narrative conclusion generation
 * - Conflict annotation
 */

import type { SubAgentResult, OrchestrationResult, OrchestrationPlan } from '../session/types';
import type { OrchestrationConflict } from './conflict-detector';

/**
 * Aggregate child execution results into an OrchestrationResult.
 *
 * @param plan - The orchestration plan that was executed.
 * @param results - Results from each child sub-task execution.
 * @param conflicts - Optional conflict detection output.
 * @param error - Optional aggregate error message.
 * @param durationMs - Total wall-clock duration.
 * @returns Aggregated orchestration result.
 */
export function aggregateResults(
  plan: OrchestrationPlan,
  results: SubAgentResult[],
  conflicts?: OrchestrationConflict[],
  error?: string,
  _durationMs?: number,
): OrchestrationResult {
  // Changed files: deduplicated union across all children
  const changedFiles = [...new Set(results.flatMap((r) => r.changedFiles.filter(Boolean)))];

  // Terminal state: worst of all sub-results
  const terminalState = computeAggregateTerminalState(results);

  // Total tool calls
  const toolCalls = results.reduce((sum, r) => sum + r.toolCalls, 0);

  return {
    plan,
    results,
    terminalState,
    changedFiles,
    toolCalls,
    error: error ?? computeAggregateError(results),
    conclusion: buildConclusion(results, conflicts, terminalState),
  };
}

/**
 * Compute the aggregate terminal state from all child results.
 * Priority order (worst to best): model_error, tool_error, budget_exhausted,
 *   blocked, failed_verification, completed.
 */
function computeAggregateTerminalState(results: SubAgentResult[]): import('../session/types').AgentTerminalState {
  if (results.length === 0) return 'completed';

  const severity: Record<string, number> = {
    model_error: 5,
    tool_error: 4,
    budget_exhausted: 3,
    blocked: 2,
    failed_verification: 1,
    completed: 0,
  };

  let worst = 'completed' as import('../session/types').AgentTerminalState;
  let worstScore = 0;

  for (const r of results) {
    const score = severity[r.terminalState] ?? 0;
    if (score > worstScore) {
      worstScore = score;
      worst = r.terminalState;
    }
  }

  return worst;
}

/**
 * Compute an aggregate error message from children that failed.
 */
function computeAggregateError(results: SubAgentResult[]): string | undefined {
  const failed = results.filter((r) => r.error);
  if (failed.length === 0) return undefined;

  if (failed.length === 1) {
    return `Sub-task "${failed[0].subTaskId}" failed: ${failed[0].error}`;
  }

  return `${failed.length} sub-tasks failed: ${failed.map((r) => `"${r.subTaskId}"`).join(', ')}`;
}

/**
 * Build a human-readable narrative conclusion from child results.
 */
function buildConclusion(
  results: SubAgentResult[],
  conflicts?: OrchestrationConflict[],
  terminalState?: string,
): string {
  const parts: string[] = [];

  // Summary line
  const completed = results.filter((r) => r.terminalState === 'completed').length;
  const total = results.length;
  parts.push(`Orchestration completed: ${completed}/${total} sub-tasks finished.`);
  parts.push('');

  // Per-sub-task results
  parts.push('## Sub-task Results');
  for (const result of results) {
    const statusIcon = result.terminalState === 'completed' ? '✅' : '❌';
    parts.push(`${statusIcon} **${result.subTaskId}** (${result.terminalState})`);
    parts.push(`   Files changed: ${result.changedFiles.length > 0 ? result.changedFiles.join(', ') : '(none)'}`);
    parts.push(`   Tool calls: ${result.toolCalls}`);
    if (result.error) {
      parts.push(`   Error: ${result.error}`);
    }
  }
  parts.push('');

  // Changed files summary
  const allChanged = [...new Set(results.flatMap((r) => r.changedFiles.filter(Boolean)))];
  if (allChanged.length > 0) {
    parts.push(`## Files Changed (${allChanged.length})`);
    for (const file of allChanged) {
      parts.push(`- ${file}`);
    }
    parts.push('');
  } else {
    parts.push('## Files Changed');
    parts.push('(none)');
    parts.push('');
  }

  // Conflicts
  if (conflicts && conflicts.length > 0) {
    parts.push('## Conflicts Detected');
    for (const conflict of conflicts) {
      parts.push(`- **${conflict.file}**: ${conflict.reason}`);
    }
    parts.push('');
  }

  // Remaining work
  const failed = results.filter((r) => r.terminalState !== 'completed');
  if (failed.length > 0) {
    parts.push('## Remaining Work');
    for (const f of failed) {
      parts.push(`- ${f.subTaskId}: ${f.error ?? 'did not complete'}`);
    }
    parts.push('');
  }

  // Final status
  const fullTerminalState = terminalState ?? computeAggregateTerminalState(results);
  if (fullTerminalState === 'completed') {
    parts.push('All sub-tasks completed successfully.');
  } else {
    parts.push(`Orchestration ended with state: ${fullTerminalState}.`);
  }

  return parts.join('\n');
}
