import { repairJson } from '../llm/repair/json-repair';
import type { PlanParseResult, OrchestrationPlan } from '../session/types';

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

/**
 * Parses and validates a model-generated task decomposition plan.
 * Employs JSON repair capabilities for malformed model output.
 * If generation is completely unrecoverable, falls back safely to inline execution.
 *
 * @param jsonText Raw output string from the model
 * @returns Parsed and validated OrhcestrationPlan or inline fallback
 */
export function parseOrchestrationPlan(jsonText: string): PlanParseResult {
  try {
    let parsed: any;
    try {
      // First attempt native parse
      parsed = JSON.parse(jsonText);
    } catch (parseError) {
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
      return { success: true, plan: parsed } as any;
    }

    // Invalid schema structure even after successful parse
    return { success: false, inline: true, error: 'schema_invalid' } as any;
  } catch (error) {
    // Ultimate fallback on unhandled internal error
    return { success: false, inline: true, error: 'unhandled_error' } as any;
  }
}
