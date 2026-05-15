import { repairJson } from '../llm/repair/json-repair';
import type { PlanParseResult, OrchestrationPlan, OrchestratedSubtask, SubTask } from '../session/types';
import type { VerificationContract } from '../session/verification-contracts';

/**
 * Validates that an object conforms to the structural requirements of an
 * OrchestrationPlan.
 */
function isValidPlan(obj: any): obj is OrchestrationPlan {
  if (typeof obj !== 'object' || obj === null) return false;
  if (obj.inline === true) return true;

  if (typeof obj.planId !== 'string') return false;
  if (!Array.isArray(obj.subtasks)) return false;

  for (const task of obj.subtasks) {
    if (typeof task !== 'object' || task === null) return false;
    if (typeof task.id !== 'string') return false;
    if (typeof task.description !== 'string') return false;
  }

  return true;
}

export interface PlanNormalizationDefaults {
  /** Default token budget per sub-task when the planner doesn't specify one. */
  defaultBudget?: number;
  /** Default verification contract when neither the planner nor the subtask specifies one. */
  defaultVerification?: VerificationContract;
}

function normalizeSubTask(task: OrchestratedSubtask, defaults?: PlanNormalizationDefaults): SubTask {
  return {
    id: task.id,
    description: task.description,
    fileScope: task.fileScope ?? [],
    dependencies: task.dependencies ?? [],
    estimatedBudget: task.estimatedTokens ?? defaults?.defaultBudget ?? 4000,
    verification: task.verification ??
      defaults?.defaultVerification ?? { level: 'files_changed', label: 'Verify files changed' },
  };
}

function normalizePlan(parsed: any, defaults?: PlanNormalizationDefaults): OrchestrationPlan {
  const subtasks = parsed.subtasks as OrchestratedSubtask[];
  const defaultBudget = defaults?.defaultBudget ?? 4000;
  return {
    ...parsed,
    subtasks,
    subTasks: subtasks.map((t) => normalizeSubTask(t, defaults)),
    strategy: parsed.strategy ?? 'orchestrate',
    estimatedTotalTokens:
      parsed.estimatedTotalTokens ?? subtasks.reduce((sum, task) => sum + (task.estimatedTokens ?? defaultBudget), 0),
    repoMetadata: parsed.repoMetadata ?? { fileCount: 0, totalKB: 0, sourceKB: 0 },
    contextWindowTokens: parsed.contextWindowTokens ?? 0,
  };
}

/**
 * Parses and validates a model-generated task decomposition plan.
 * Employs JSON repair capabilities for malformed model output.
 * If generation is completely unrecoverable, falls back safely to inline execution.
 *
 * @param jsonText Raw output string from the model
 * @returns Parsed and validated OrhcestrationPlan or inline fallback
 */
export function parseOrchestrationPlan(jsonText: string, defaults?: PlanNormalizationDefaults): PlanParseResult {
  try {
    let parsed: any;
    try {
      // First attempt native parse
      parsed = JSON.parse(jsonText);
    } catch {
      // If native fails, attempt comprehensive repair pipeline
      const repaired = repairJson(jsonText);
      if (!repaired || !repaired.repaired) {
        return { success: false, inline: true, error: 'repair_failed' } as any;
      }
      parsed = JSON.parse(repaired.repaired);
    }

    if (parsed.inline === true) {
      return { success: false, inline: true, error: 'inline_response' } as any;
    }

    if (isValidPlan(parsed)) {
      return { success: true, plan: normalizePlan(parsed, defaults) };
    }

    // Invalid schema structure even after successful parse
    return { success: false, inline: true, error: 'schema_invalid' } as any;
  } catch {
    // Ultimate fallback on unhandled internal error
    return { success: false, inline: true, error: 'unhandled_error' } as any;
  }
}
