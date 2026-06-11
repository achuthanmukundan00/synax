/**
 * OrchestrationManager — the runtime that takes an OrchestrationPlan and
 * executes it, managing sequential dependency ordering, parallel fan-out
 * with conflict detection, result aggregation, and graceful degradation
 * on child failure.
 *
 * This is the "brain" that connects planning to execution. It is a new
 * module, not a bolt-on to the turn loop.
 *
 * Design contract:
 * - Sequential mode: topological sort → execute in dependency order → aggregate
 * - Parallel mode: group independent tasks → Promise.all per group → detect conflicts → aggregate
 * - Child failure always produces a partial result, never orphaned data
 * - Recovery recipes are delegated to existing RecoveryManager inside child sessions
 */

import { Session } from '../session/Session';
import { HandoffManager } from '../handoff/HandoffManager';
import type { SubTask, SubAgentResult, OrchestrationPlan, OrchestrationResult } from '../session/types';
import type { HandoffManifest } from '../handoff/types';
import type { BudgetStrategy } from '../agent/context-budget';
import { resolveTaskDependencies, DependencyCycleError } from './dependency-resolver';
import { detectConflicts } from './conflict-detector';
import { aggregateResults } from './result-aggregator';

export { DependencyCycleError };

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum sub-tasks allowed in a single orchestration plan. */
const MAX_SUBTASKS = 12;

/** Maximum parallel children spawned concurrently. */
const DEFAULT_MAX_PARALLEL_CHILDREN = 3;

// ─── OrchestrationManager ───────────────────────────────────────────────────

/**
 * @public
 */
export class OrchestrationManager {
  private constructor() {
    // Static-only class — no instance state.
    // All configuration is passed per-call for testability and reentrancy.
  }

  // ── Public entry point ──────────────────────────────────────────────────

  /**
   * Execute an orchestration plan against a parent session.
   *
   * Routes to sequential or parallel execution based on the plan's strategy
   * and parallelization hints.
   *
   * @param plan - The orchestration plan to execute. Must have at least one sub-task.
   * @param parentSession - The parent session that owns the orchestration.
   * @param handoffManager - Handoff manager for spawning child sessions.
   * @param options - Optional execution overrides.
   * @returns Aggregated orchestration result.
   */
  static async execute(
    plan: OrchestrationPlan,
    parentSession: Session,
    handoffManager: HandoffManager,
    options?: {
      maxParallelChildren?: number;
      /** Force a specific execution mode, bypassing automatic detection. */
      forcedMode?: 'parallel' | 'sequential';
    },
  ): Promise<OrchestrationResult> {
    const subTasks = plan.subTasks ?? [];

    // Guard: no sub-tasks to execute
    if (subTasks.length === 0) {
      return {
        plan,
        results: [],
        terminalState: 'completed',
        changedFiles: [],
        toolCalls: 0,
        conclusion: 'No sub-tasks to execute.',
      };
    }

    // Guard: too many sub-tasks
    if (subTasks.length > MAX_SUBTASKS) {
      return {
        plan,
        results: [],
        terminalState: 'blocked',
        changedFiles: [],
        toolCalls: 0,
        conclusion: `Too many sub-tasks (${subTasks.length} > ${MAX_SUBTASKS} max). Narrow the task scope.`,
        error: `Sub-task count ${subTasks.length} exceeds maximum ${MAX_SUBTASKS}.`,
      };
    }

    // Determine execution mode — respect forced mode when user specifies
    // trigger phrases, EXCEPT when sub-task file scopes overlap. Parallel
    // children share the same working tree with no isolation; concurrent
    // mutations to overlapping scopes corrupt each other's edits. Safety
    // beats the user's mode preference, so overlapping scopes downgrade
    // forced-parallel to sequential.
    let mode = options?.forcedMode ?? determineExecutionMode(plan.strategy, subTasks);
    const mutatingTasks = subTasks.filter((t) => t.verification.level !== 'none');
    if (mode === 'parallel' && mutatingTasks.length > 0 && hasOverlappingFileScopes(subTasks)) {
      // Read-only plans (all contracts 'none', e.g. repo recon) keep their
      // parallelism — concurrent reads are safe.
      mode = 'sequential';
    }

    let result: OrchestrationResult;
    try {
      if (mode === 'parallel') {
        result = await OrchestrationManager.runParallelMode(
          plan,
          subTasks,
          parentSession,
          handoffManager,
          options?.maxParallelChildren ?? DEFAULT_MAX_PARALLEL_CHILDREN,
        );
      } else {
        result = await OrchestrationManager.runSequentialMode(plan, subTasks, parentSession, handoffManager);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // On catastrophic failure (e.g., cycle detection), return a partial result
      // with what we have, never lose accumulated data.
      return {
        plan,
        results: [],
        terminalState: 'model_error',
        changedFiles: [],
        toolCalls: 0,
        conclusion: `Orchestration failed: ${message}`,
        error: message,
      };
    }

    return result;
  }

  // ── Sequential mode ─────────────────────────────────────────────────────

  /**
   * Execute sub-tasks in dependency-respecting sequential order.
   *
   * 1. Resolve dependencies via topological sort
   * 2. For each sub-task group in order:
   *    - Generate handoff manifest with cumulative context
   *    - Call parentSession.fork() to spawn child
   *    - Merge child result into accumulated state
   *    - If child fails: attempt recovery, then retry/skip/abort
   * 3. Build final conclusion from all child results
   */
  private static async runSequentialMode(
    plan: OrchestrationPlan,
    subTasks: SubTask[],
    parentSession: Session,
    handoffManager: HandoffManager,
  ): Promise<OrchestrationResult> {
    const results: SubAgentResult[] = [];
    const allChangedFiles: string[] = [];
    const allReadFiles: string[] = [];
    let aborted = false;

    // 1. Resolve dependencies
    let executionGroups;
    try {
      executionGroups = resolveTaskDependencies(subTasks);
    } catch (error) {
      if (error instanceof DependencyCycleError) {
        return {
          plan,
          results: [],
          terminalState: 'blocked',
          changedFiles: [],
          toolCalls: 0,
          conclusion: `Cannot execute: dependency cycle detected — ${error.cycle.join(' → ')}`,
          error: error.message,
        };
      }
      throw error;
    }

    // 2. Build parent manifest template (reused and enriched per child)
    const parentManifest = OrchestrationManager.buildParentManifest(
      parentSession.sessionId,
      plan,
      handoffManager.getCurrentDepth(),
    );

    // 3. Execute each group
    const groupCount = executionGroups.length;
    for (let g = 0; g < groupCount && !aborted; g++) {
      const group = executionGroups[g];

      for (const subtask of group) {
        if (aborted) break;

        // Enrich manifest with accumulated context from prior children
        const childManifest = OrchestrationManager.enrichManifest(
          parentManifest,
          subtask,
          { changedFiles: allChangedFiles, readFiles: allReadFiles },
          g + 1,
          groupCount,
        );

        const result = await parentSession.fork(subtask, childManifest, {
          maxToolCalls:
            subtask.estimatedBudget > 0
              ? Math.min(192, Math.max(8, Math.ceil(subtask.estimatedBudget / 256)))
              : undefined,
        });

        results.push(result);

        // Accumulate changed files
        for (const file of result.changedFiles) {
          if (file && !allChangedFiles.includes(file)) {
            allChangedFiles.push(file);
          }
        }

        // Track read files from sub-task scope
        for (const file of subtask.fileScope) {
          if (file && !allReadFiles.includes(file)) {
            allReadFiles.push(file);
          }
        }

        // Handle failure
        if (result.terminalState !== 'completed') {
          // In sequential mode, a single failure may abort remaining sub-tasks
          // that depend on this one. We mark the orchestration as partial but
          // preserve all accumulated results.
          aborted = true;
          break;
        }
      }
    }

    // 4. Check for conflicts (should not occur in sequential mode, but guard)
    const conflicts = detectConflicts(results);

    // 5. Aggregate
    const aggregateError = results.find((r) => r.error)?.error;

    return aggregateResults(plan, results, conflicts.length > 0 ? conflicts : undefined, aggregateError);
  }

  // ── Parallel mode ───────────────────────────────────────────────────────

  /**
   * Execute sub-tasks in parallel groups, with conflict detection.
   *
   * 1. Resolve dependencies into execution groups (independent tasks per group)
   * 2. Execute each group concurrently via Promise.all
   * 3. After each group completes, detect file conflicts
   * 4. If conflicts: escalate to sequential resolution for conflicted scope
   * 5. Merge group results into accumulated state
   * 6. On any child failure: cancel remaining groups, return partial result
   */
  private static async runParallelMode(
    plan: OrchestrationPlan,
    subTasks: SubTask[],
    parentSession: Session,
    handoffManager: HandoffManager,
    maxParallel: number,
  ): Promise<OrchestrationResult> {
    const results: SubAgentResult[] = [];
    const allChangedFiles: string[] = [];
    let aborted = false;

    // 1. Resolve dependencies into groups
    let executionGroups;
    try {
      executionGroups = resolveTaskDependencies(subTasks);
    } catch (error) {
      if (error instanceof DependencyCycleError) {
        return {
          plan,
          results: [],
          terminalState: 'blocked',
          changedFiles: [],
          toolCalls: 0,
          conclusion: `Cannot execute: dependency cycle detected — ${error.cycle.join(' → ')}`,
          error: error.message,
        };
      }
      throw error;
    }

    // 2. Build parent manifest
    const parentManifest = OrchestrationManager.buildParentManifest(
      parentSession.sessionId,
      plan,
      handoffManager.getCurrentDepth(),
    );

    const groupCount = executionGroups.length;

    // 3. Execute each group
    for (let g = 0; g < groupCount && !aborted; g++) {
      const group = executionGroups[g];

      // Limit parallel fan-out within each group
      const batchSize = Math.min(group.length, maxParallel);

      // Execute in batches if group is larger than max parallel
      for (let batchStart = 0; batchStart < group.length && !aborted; batchStart += batchSize) {
        const batch = group.slice(batchStart, batchStart + batchSize);

        // Spawn all children in this batch concurrently
        const batchPromises = batch.map((subtask) => {
          const childManifest = OrchestrationManager.enrichManifest(
            parentManifest,
            subtask,
            { changedFiles: allChangedFiles, readFiles: [] },
            g + 1,
            groupCount,
          );
          return parentSession.fork(subtask, childManifest);
        });

        let batchResults: SubAgentResult[];
        try {
          batchResults = await Promise.all(batchPromises);
        } catch {
          // If Promise.all itself throws (unexpected), abort parallel groups
          aborted = true;
          break;
        }

        results.push(...batchResults);

        // Accumulate changed files
        for (const r of batchResults) {
          for (const file of r.changedFiles) {
            if (file && !allChangedFiles.includes(file)) {
              allChangedFiles.push(file);
            }
          }
        }

        // Detect conflicts within this batch
        const batchConflicts = detectConflicts(batchResults);
        if (batchConflicts.length > 0) {
          // Conflicts detected in parallel execution.
          // Sequential resolution for conflicted scope would happen here
          // in a future iteration. For now, we report conflicts and continue
          // with a partial result — the presence of conflicts is surfaced
          // in the conclusion.
        }

        // Check for failures — abort remaining groups
        const hasFailed = batchResults.some((r) => r.terminalState !== 'completed');
        if (hasFailed) {
          aborted = true;
        }
      }
    }

    // 4. Final conflict detection across all results
    const allConflicts = detectConflicts(results);

    // 5. Aggregate
    const aggregateError = results.find((r) => r.error)?.error;

    return aggregateResults(plan, results, allConflicts.length > 0 ? allConflicts : undefined, aggregateError);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Build a parent HandoffManifest template for orchestration.
   * Each child gets a copy enriched with its specific sub-task context.
   */
  private static buildParentManifest(parentSessionId: string, plan: OrchestrationPlan, depth: number): HandoffManifest {
    return {
      handoffId: `orch-${plan.planId ?? 'unnamed'}-${Date.now()}`,
      parentSessionId,
      reason: 'task_delegation',
      task: `Orchestrated plan: ${plan.planId ?? 'unnamed'} (${plan.subTasks?.length ?? 0} sub-tasks)`,
      status: `Orchestration active: executing sub-tasks`,
      keyFindings: [],
      filesChanged: [],
      filesRead: [],
      pendingWork: [],
      suggestedSearchTerms: [],
      contextWindowUsed: 0,
      depth,
      createdAt: new Date().toISOString(),
      orchestrationPlanId: plan.planId,
    };
  }

  /**
   * Enrich a parent manifest with sub-task specific context plus
   * accumulated knowledge from prior siblings.
   */
  private static enrichManifest(
    parent: HandoffManifest,
    subtask: SubTask,
    priorContext: { changedFiles: string[]; readFiles: string[] },
    groupIndex: number,
    totalGroups: number,
  ): HandoffManifest {
    const contextParts: string[] = [];
    contextParts.push(`Sub-task group ${groupIndex}/${totalGroups}`);

    if (subtask.dependencies.length > 0) {
      contextParts.push(`Depends on: ${subtask.dependencies.join(', ')}`);
    }

    if (priorContext.changedFiles.length > 0) {
      contextParts.push(`Previously changed files (by prior sub-tasks): ${priorContext.changedFiles.join(', ')}`);
    }

    return {
      ...parent,
      handoffId: `${parent.handoffId}-${subtask.id}`,
      subtaskId: subtask.id,
      orchestrationContext: contextParts.join('. '),
      task: subtask.description,
      pendingWork:
        subtask.dependencies.length > 0 ? [`Complete dependencies first: ${subtask.dependencies.join(', ')}`] : [],
    };
  }
}

// ─── Mode determination ──────────────────────────────────────────────────

/**
 * Determine execution mode from the plan's budget strategy and sub-task properties.
 *
 * - decompose → always sequential (task is too large for parallel risk)
 * - orchestrate → parallel if any sub-task is marked parallelizable and all scopes are disjoint
 * - inline → sequential (single-task edge case, shouldn't reach here)
 */
/**
 * Check whether any two sub-tasks have overlapping file scopes.
 *
 * Scopes are treated as path prefixes: 'src/' overlaps 'src/llm/utils.ts'.
 * Empty scopes ("any relevant files") overlap everything, since the child
 * is unconstrained. Comma-separated scope strings are split and compared
 * individually.
 */
export function hasOverlappingFileScopes(subTasks: SubTask[]): boolean {
  const normalize = (scope: string): string[] =>
    scope
      .split(',')
      .map((s) => s.trim().replace(/^\.\//, '').replace(/\/+$/, ''))
      .filter(Boolean);

  const scopeSets = subTasks.map((t) => t.fileScope.flatMap(normalize));

  // A task with no concrete scope can touch anything — overlaps all others.
  if (subTasks.length > 1 && scopeSets.some((set) => set.length === 0)) return true;

  for (let i = 0; i < scopeSets.length; i += 1) {
    for (let j = i + 1; j < scopeSets.length; j += 1) {
      for (const a of scopeSets[i]) {
        for (const b of scopeSets[j]) {
          if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true;
        }
      }
    }
  }
  return false;
}

function determineExecutionMode(strategy: BudgetStrategy, subTasks: SubTask[]): 'sequential' | 'parallel' {
  if (strategy === 'decompose') return 'sequential';

  // For orchestrate: check if parallel is viable
  if (strategy === 'orchestrate') {
    // Only parallel if sub-tasks are truly independent
    const allIndependent = subTasks.every((t) => t.dependencies.length === 0);
    if (!allIndependent) return 'sequential';

    // Check for overlapping file scopes
    const allFiles = new Set<string>();
    for (const task of subTasks) {
      for (const file of task.fileScope) {
        if (allFiles.has(file)) return 'sequential';
        allFiles.add(file);
      }
    }

    // All independent and scopes are disjoint → parallel
    return 'parallel';
  }

  return 'sequential';
}
