/**
 * Conflict detector — identifies file-level conflicts when multiple
 * sub-agents modify the same output file.
 *
 * Used by the parallel fan-out path of OrchestrationManager to detect
 * collisions before merging results. Non-overlapping edits to the same
 * file are not flagged as conflicts (the detector operates at file
 * granularity; line-level overlap detection requires diff inspection).
 */

import type { SubAgentResult } from '../session/types';

/** A detected conflict between sub-agents over the same output file. */
export interface OrchestrationConflict {
  /** File path modified by multiple children. */
  file: string;
  /** Human-readable explanation of the conflict. */
  reason: string;
  /** IDs of the sub-tasks involved in the conflict. */
  children: string[];
}

/**
 * Detect output-file conflicts across child execution results.
 *
 * Each `SubAgentResult.changedFiles` entry is compared across all results.
 * If two or more children claim the same file, a conflict is reported.
 *
 * @param results - Completed sub-agent results.
 * @returns Array of conflicts, empty if none detected.
 */
export function detectConflicts(results: SubAgentResult[]): OrchestrationConflict[] {
  const fileToChildren = new Map<string, string[]>();

  for (const result of results) {
    for (const file of result.changedFiles) {
      if (!file) continue;
      if (!fileToChildren.has(file)) {
        fileToChildren.set(file, []);
      }
      fileToChildren.get(file)!.push(result.subTaskId);
    }
  }

  const conflicts: OrchestrationConflict[] = [];
  for (const [file, children] of fileToChildren.entries()) {
    if (children.length > 1) {
      conflicts.push({
        file,
        reason: `Modified by ${children.length} sub-agents: ${children.join(', ')}`,
        children,
      });
    }
  }

  return conflicts;
}

/**
 * Check whether the changedFiles arrays of two results are disjoint.
 *
 * @returns true if no common files are claimed by both results.
 */
export function areFileScopesDisjoint(a: SubAgentResult, b: SubAgentResult): boolean {
  const aSet = new Set(a.changedFiles.filter(Boolean));
  for (const file of b.changedFiles) {
    if (file && aSet.has(file)) return false;
  }
  return true;
}
