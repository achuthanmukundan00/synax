/**
 * Dependency resolver — topological sort for sub-task execution ordering.
 *
 * Uses Kahn's algorithm to produce a dependency-respecting execution order.
 * Detects cycles and reports them as actionable errors.
 * Returns execution groups (independent tasks that can run in parallel within a group).
 */

import type { SubTask } from '../session/types';

/** Error thrown when a dependency cycle is detected in the sub-task graph. */
export class DependencyCycleError extends Error {
  /** IDs of the subtasks involved in the cycle. */
  readonly cycle: string[];

  constructor(cycle: string[]) {
    super(`Dependency cycle detected: ${cycle.join(' → ')}`);
    this.name = 'DependencyCycleError';
    this.cycle = cycle;
  }
}

/**
 * Execution group: a set of sub-tasks whose dependencies are all satisfied
 * and can therefore be executed concurrently within this group.
 */
export type ExecutionGroup = SubTask[];

/**
 * Perform a topological sort of sub-tasks by their dependencies.
 *
 * Dependencies are declared via SubTask.dependencies (array of other SubTask.id values).
 * Tasks with no dependencies or whose dependencies are fully satisfied can run in the same group.
 *
 * @param subtasks - Array of sub-tasks to order.
 * @returns Groups of independent tasks in execution order.
 * @throws {DependencyCycleError} if a cycle is detected.
 */
export function resolveTaskDependencies(subtasks: SubTask[]): ExecutionGroup[] {
  // Guard: empty
  if (subtasks.length === 0) return [];

  // Build adjacency and in-degree maps
  const taskMap = new Map<string, SubTask>();
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // task -> tasks that depend on it

  for (const task of subtasks) {
    taskMap.set(task.id, task);
    inDegree.set(task.id, 0);
    dependents.set(task.id, []);
  }

  for (const task of subtasks) {
    for (const depId of task.dependencies) {
      if (!taskMap.has(depId)) {
        throw new Error(
          `Sub-task "${task.id}" depends on unknown task "${depId}". ` +
            `Known tasks: ${[...taskMap.keys()].join(', ')}`,
        );
      }
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
      dependents.get(depId)!.push(task.id);
    }
  }

  // Kahn's algorithm — fill ready queue with zero-in-degree tasks
  const ready: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) ready.push(id);
  }

  const groups: ExecutionGroup[] = [];
  let processedCount = 0;

  while (ready.length > 0) {
    // All currently-ready tasks form a group (they're independent)
    const group: SubTask[] = [];
    const nextReady: string[] = [];

    for (const id of ready) {
      const task = taskMap.get(id)!;
      group.push(task);

      // Decrease in-degree for all dependents
      for (const dependentId of dependents.get(id) ?? []) {
        const newDegree = (inDegree.get(dependentId) ?? 1) - 1;
        inDegree.set(dependentId, newDegree);
        if (newDegree === 0) {
          nextReady.push(dependentId);
        }
      }
    }

    groups.push(group);
    processedCount += group.length;

    // Replace ready queue with next batch
    ready.length = 0;
    ready.push(...nextReady);
  }

  // Cycle detection: if we didn't process all tasks, there's a cycle
  if (processedCount !== subtasks.length) {
    const cycle = findCycle(subtasks);
    throw new DependencyCycleError(cycle.map((t) => t.id));
  }

  return groups;
}

/**
 * Find a cycle in the dependency graph using DFS.
 * Only called when Kahn's algorithm can't process all nodes.
 */
function findCycle(subtasks: SubTask[]): SubTask[] {
  const taskMap = new Map<string, SubTask>();
  for (const t of subtasks) taskMap.set(t.id, t);

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string>();

  for (const t of subtasks) color.set(t.id, WHITE);

  function dfs(nodeId: string): string[] | null {
    color.set(nodeId, GRAY);
    const task = taskMap.get(nodeId)!;

    for (const depId of task.dependencies) {
      if (!color.has(depId)) continue; // external dep, skip
      const depColor = color.get(depId)!;
      if (depColor === GRAY) {
        // Found back edge → cycle detected
        const cycle: string[] = [depId];
        let current = nodeId;
        while (current !== depId) {
          cycle.push(current);
          current = parent.get(current) ?? depId;
        }
        cycle.push(depId);
        return cycle.reverse();
      }
      if (depColor === WHITE) {
        parent.set(depId, nodeId);
        const result = dfs(depId);
        if (result) return result;
      }
    }

    color.set(nodeId, BLACK);
    return null;
  }

  for (const task of subtasks) {
    if (color.get(task.id) === WHITE) {
      const result = dfs(task.id);
      if (result) {
        return result.map((id) => taskMap.get(id)!).filter(Boolean);
      }
    }
  }

  // Fallback: return remaining tasks
  return subtasks.filter((t) => (color.get(t.id) ?? WHITE) !== BLACK);
}
