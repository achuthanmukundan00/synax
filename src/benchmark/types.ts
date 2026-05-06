/** Structured result from a single benchmark run. */

export interface BenchmarkMetrics {
  /** Terminal state from the agent run. */
  terminalStatus: string;
  /** Whether the run completed successfully. */
  completed: boolean;
  /** Total wall-clock time in milliseconds. */
  totalWallMs: number;
  /** Time spent waiting for model responses in milliseconds. */
  modelWallMs: number;
  /** Time spent executing tools in milliseconds. */
  toolWallMs: number;
  /** Number of model steps (API calls to the model). */
  modelSteps: number;
  /** Approximate prompt tokens at each step (from budget snapshots). */
  stepPromptTokens: number[];
  /** Maximum prompt tokens observed across all steps. */
  maxPromptTokens: number;
  /** Token growth from first to last step. Negative if no growth. */
  promptTokenGrowth: number;
  /** Total number of tool calls executed. */
  toolCalls: number;
  /** Number of read tool calls. */
  readCalls: number;
  /** Number of unique read paths (deduplicated by signature). */
  uniqueReadPaths: number;
  /** Number of repeated read calls (total reads minus unique paths). */
  repeatedReadCalls: number;
  /** Number of read calls that listed a directory (no path/query). */
  directoryReadCalls: number;
  /** Number of recoverable tool errors (ENOENT, read policy limits). */
  recoverableToolErrors: number;
  /** Number of terminal (non-recoverable) tool errors. */
  terminalErrors: number;
  /** Number of changed files from the run. */
  changedFiles: number;
  /** Whether typecheck/tests passed (null if not applicable). */
  testsPassed: boolean | null;
  /** The objective score (lower is better). */
  score: number;
  /** Human-readable error message if any. */
  error?: string;
}

export interface BenchmarkResult {
  /** Workload file that was used. */
  workload: string;
  /** Timestamp when the benchmark was run. */
  timestamp: string;
  /** Computed metrics. */
  metrics: BenchmarkMetrics;
}

export interface ToolCallEntry {
  name: string;
  success: boolean;
  error?: string;
  arguments: Record<string, unknown>;
}

