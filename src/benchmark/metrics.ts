/**
 * Pure functions for computing benchmark metrics and objective scores.
 *
 * These are separated from the benchmark runner so they can be unit-tested
 * independently without a running provider or agent loop.
 */

import {
  type BenchmarkMetrics,
  type ToolCallEntry,
} from './types';

// ---------------------------------------------------------------------------
// Read analysis
// ---------------------------------------------------------------------------

/**
 * Extract read metrics from a list of tool call entries.
 * This operates on synthetic data so it can be unit-tested.
 */
export function computeReadMetrics(toolCalls: ToolCallEntry[]): {
  readCalls: number;
  uniqueReadPaths: number;
  repeatedReadCalls: number;
  directoryReadCalls: number;
} {
  const readCalls = toolCalls.filter((tc) => tc.name === 'read');
  const signatures = new Set<string>();

  let directoryReadCalls = 0;

  for (const call of readCalls) {
    const sig = readSignature(call.arguments);
    if (sig) {
      signatures.add(sig);
    }

    if (isDirectoryRead(call.arguments)) {
      directoryReadCalls += 1;
    }
  }

  const uniqueReadPaths = signatures.size;
  const repeatedReadCalls = Math.max(0, readCalls.length - uniqueReadPaths);

  return {
    readCalls: readCalls.length,
    uniqueReadPaths,
    repeatedReadCalls,
    directoryReadCalls,
  };
}

// ---------------------------------------------------------------------------
// Objective score
// ---------------------------------------------------------------------------

/**
 * Compute a single objective score (lower is better).
 *
 * Penalties:
 * - wall time (ms / 1000)
 * - max prompt tokens (tokens / 1000)
 * - prompt token growth (tokens / 2000)
 * - repeated reads (* 10)
 * - directory reads (* 3)
 * - recoverable tool errors (* 25)
 * - terminal errors (* 100)
 * - incomplete run (+200)
 * - failing tests (+500)
 */
export function computeObjectiveScore(metrics: BenchmarkMetrics): number {
  const wall = metrics.totalWallMs / 1000;
  const maxPrompt = metrics.maxPromptTokens / 1000;
  const promptGrowth = Math.max(0, metrics.promptTokenGrowth) / 2000;
  const repeated = metrics.repeatedReadCalls * 10;
  const dirReads = metrics.directoryReadCalls * 3;
  const recoverable = metrics.recoverableToolErrors * 25;
  const termErrors = metrics.terminalErrors * 100;
  const incomplete = metrics.completed ? 0 : 200;
  const testsFail = metrics.testsPassed === false ? 500 : 0;

  return (
    wall +
    maxPrompt +
    promptGrowth +
    repeated +
    dirReads +
    recoverable +
    termErrors +
    incomplete +
    testsFail
  );
}

// ---------------------------------------------------------------------------
// Token growth
// ---------------------------------------------------------------------------

/**
 * Compute prompt token growth from first to last step.
 * Returns 0 if fewer than 2 steps, or if tokens decreased.
 */
export function computeTokenGrowth(stepTokens: number[]): number {
  if (stepTokens.length < 2) return 0;
  return Math.max(0, stepTokens[stepTokens.length - 1] - stepTokens[0]);
}

// ---------------------------------------------------------------------------
// Recoverable tool error detection
// ---------------------------------------------------------------------------

/**
 * Determine if a failed read call is a recoverable error
 * (ENOENT or read policy limit).
 */
export function isRecoverableError(call: ToolCallEntry): boolean {
  if (call.name !== 'read') return false;
  if (call.success) return false;
  return (
    isEnoentError(call.error) ||
    isReadPolicyLimitError(call.error)
  );
}

export function isEnoentError(error: string | undefined): boolean {
  return error !== undefined && /\bENOENT\b/.test(error);
}

export function isReadPolicyLimitError(error: string | undefined): boolean {
  if (error === undefined) return false;
  return (
    error.includes('total read limit reached') ||
    error.includes('Read loop detected')
  );
}

// ---------------------------------------------------------------------------
// Read classification
// ---------------------------------------------------------------------------

/**
 * Create a stable signature for a read call's target.
 * Matches the readSignature logic in runner.ts.
 */
function readSignature(args: Record<string, unknown>): string {
  return JSON.stringify({
    path: typeof args.path === 'string' ? args.path : undefined,
    query: typeof args.query === 'string' ? args.query : undefined,
    startLine: typeof args.startLine === 'number' ? args.startLine : undefined,
    endLine: typeof args.endLine === 'number' ? args.endLine : undefined,
  });
}

/**
 * A read is a "directory read" if it specifies no path and no query
 * (i.e., lists files), or if the path is '.' or ''.
 */
function isDirectoryRead(args: Record<string, unknown>): boolean {
  const hasQuery = typeof args.query === 'string' && args.query.trim().length > 0;
  const hasPath = typeof args.path === 'string' && args.path.trim().length > 0;
  if (hasQuery) return false;
  if (hasPath) {
    return args.path === '.' || args.path === '';
  }
  return true; // no path, no query → list files
}

// ---------------------------------------------------------------------------
// JSON shape validation
// ---------------------------------------------------------------------------

/**
 * Validate that an object matches the expected benchmark result shape.
 * Returns null if valid, or an array of error strings if invalid.
 */
export function validateBenchmarkShape(obj: unknown): string[] | null {
  const errors: string[] = [];
  if (!obj || typeof obj !== 'object') {
    return ['root must be an object'];
  }

  const result = obj as Record<string, unknown>;

  if (typeof result.workload !== 'string') {
    errors.push('workload must be a string');
  }
  if (typeof result.timestamp !== 'string') {
    errors.push('timestamp must be a string');
  }
  if (!result.metrics || typeof result.metrics !== 'object') {
    errors.push('metrics must be an object');
    return errors.length > 0 ? errors : null;
  }

  const metrics = result.metrics as Record<string, unknown>;
  const requiredMetricFields = [
    { name: 'terminalStatus', type: 'string' },
    { name: 'completed', type: 'boolean' },
    { name: 'totalWallMs', type: 'number' },
    { name: 'modelSteps', type: 'number' },
    { name: 'stepPromptTokens', isArray: true },
    { name: 'maxPromptTokens', type: 'number' },
    { name: 'promptTokenGrowth', type: 'number' },
    { name: 'toolCalls', type: 'number' },
    { name: 'readCalls', type: 'number' },
    { name: 'uniqueReadPaths', type: 'number' },
    { name: 'repeatedReadCalls', type: 'number' },
    { name: 'directoryReadCalls', type: 'number' },
    { name: 'score', type: 'number' },
  ];

  for (const field of requiredMetricFields) {
    if (!(field.name in metrics)) {
      errors.push(`metrics.${field.name} is missing`);
    } else if (field.isArray) {
      if (!Array.isArray(metrics[field.name])) {
        errors.push(`metrics.${field.name} must be an array`);
      }
    } else if (typeof metrics[field.name] !== field.type) {
      errors.push(`metrics.${field.name} must be a ${field.type}`);
    }
  }

  return errors.length > 0 ? errors : null;
}
