/**
 * Synax Super Edition — cognitive layer exports.
 *
 * Super is the persistent world/self/reflection layer built on Synax.
 * It does not replace SynaxRuntime; it extends it with world context,
 * self-model patch proposals, memory consolidation, and bounded run loops.
 */

export { SuperWorld } from './world';
export type { SuperWorldPaths } from './world';

export { SuperSelfModel } from './self-model';
export type { SuperSelfModelOptions } from './self-model';

export { SuperRuntime } from './runtime';

export { SuperPulse } from './pulse';
export { SuperDreamCycle } from './dream-cycle';

export { NoopSuperMemoryConsolidator } from './memory';
export type { SuperMemoryConsolidationInput, SuperMemoryConsolidationResult, SuperMemoryConsolidator } from './memory';

export type {
  SuperRunKind,
  SuperSelfModificationMode,
  SuperActionPlan,
  SuperRunRequest,
  SuperRunResult,
  SuperPatchSuggestion,
  SynaxRuntimeLike,
} from './types';

export type { AutoCareerContextProvider, AutoCareerToolName, AutoCareerToolRegistration } from './autocareer';
export { defaultAutoCareerToolNames } from './autocareer';
