/**
 * Dispatch intent classifier — fast-path routing for subagent orchestration.
 *
 * Core insight: decision to use subagents and how to decompose work should be
 * handled by cheap deterministic routing before falling back to LLM planning.
 *
 * This module provides:
 * - Explicit delegation intent detection (fast-path)
 * - Repo reconnaissance intent detection (fast-path)
 * - Domain-based repo reconnaissance task templates
 * - Dispatch plan normalization (guard invariants)
 * - Timing instrumentation helpers
 */

// ─── Intent types ─────────────────────────────────────────────────────────────

export type DispatchIntent =
  /** User explicitly asked for subagents/parallel agents */
  | { kind: 'explicit_delegation'; mode: 'parallel' | 'sequential' | 'auto'; cleanTask: string }
  /** User asked to understand/read/review the entire repository */
  | { kind: 'repo_reconnaissance'; cleanTask: string }
  /** Ambiguous or mixed — use LLM planning */
  | { kind: 'requires_llm_planning'; cleanTask: string };

export interface RepoReconTask {
  id: string;
  description: string;
  scope: string;
  exclusions: string[];
  expectedOutput: string;
}

// ─── Domain-based repo reconnaissance template ────────────────────────────────

export interface RepoHints {
  /** Approximate number of tracked files */
  fileCount: number;
  /** Whether the repo has a TUI/frontend */
  hasTui: boolean;
  /** Whether the repo has test files */
  hasTests: boolean;
  /** Whether the repo has docs/readme/config */
  hasDocs: boolean;
  /** Known domain names (from package.json, Cargo.toml, etc.) */
  domains: string[];
}

/**
 * Build domain-based reconnaissance tasks for a repo-wide understanding prompt.
 *
 * Produces 3–6 bounded tasks depending on repo size and detected domains.
 * Each task includes scope, exclusions, and expected output shape.
 */
export function buildRepoReconTasks(hints: RepoHints): RepoReconTask[] {
  const tasks: RepoReconTask[] = [];
  const isTiny = hints.fileCount < 30;
  const isLarge = hints.fileCount > 500;

  // ── Core tasks (always present) ──────────────────────────────────────

  tasks.push({
    id: 'repo-map',
    description: 'Inspect top-level structure: entrypoints, scripts, module layout. Report the architecture overview without reading every file.',
    scope: 'package.json, tsconfig, Cargo.toml, Makefile, src/index, src/main, bin/, lib/',
    exclusions: ['node_modules', '.git', 'dist', 'build', 'coverage'],
    expectedOutput: 'Summary of project purpose, language, build system, dependency graph, and directory layout.',
  });

  tasks.push({
    id: 'runtime-flow',
    description: 'Trace the startup/runtime flow: CLI entry, lifecycle, main orchestration, async behavior.',
    scope: 'CLI entrypoint, main loop, session lifecycle, config loading',
    exclusions: ['test files', 'node_modules', '.git'],
    expectedOutput: 'Description of how the application starts, runs, and handles its main loop, including async concurrency model.',
  });

  tasks.push({
    id: 'tests-quality',
    description: 'Inspect tests, fixtures, smoke scripts, and CI configuration. Report coverage patterns, missing areas, and fragile tests.',
    scope: 'src/__tests__/, test/, tests/, .github/workflows/, .circleci/',
    exclusions: ['node_modules', '.git', 'dist', 'build'],
    expectedOutput: 'Summary of test framework, number of tests, coverage gaps, CI setup, and any flaky or slow tests.',
  });

  // ── TUI/renderer (adaptive) ───────────────────────────────────────────

  if (hints.hasTui && !isTiny) {
    tasks.push({
      id: 'tui-rendering',
      description: 'Inspect TUI render loop, input handling, layout/status indicators, terminal edge cases, and render scheduling.',
      scope: 'src/tui/, src/presentation/',
      exclusions: ['node_modules', '.git', 'dist', 'build', 'tests'],
      expectedOutput: 'Summary of TUI architecture, render loop design, input model, layout system, and terminal compatibility.',
    });
  }

  // ── Agent/system core (adaptive for larger repos) ─────────────────────

  if (!isTiny) {
    tasks.push({
      id: 'agent-system',
      description: 'Inspect agent planning, subagent dispatch, tool execution, context handoff, memory/history behavior.',
      scope: 'src/agent/, src/orchestration/, src/handoff/, src/session/',
      exclusions: ['node_modules', '.git', 'dist', 'build', 'test fixtures'],
      expectedOutput: 'Description of how the agent processes tasks, manages context, dispatches sub-tasks, and handles tool execution.',
    });
  }

  // ── Docs and config (adaptive) ─────────────────────────────────────────

  if (hints.hasDocs && !isTiny) {
    tasks.push({
      id: 'docs-config',
      description: 'Inspect README, docs, config files, env/schema, and versioning. Compare docs to actual code for accuracy.',
      scope: 'README*, docs/, *.md, .env.example, tsconfig.json, Cargo.toml, package.json',
      exclusions: ['node_modules', '.git', 'dist', 'build'],
      expectedOutput: 'Summary of documentation quality, config structure, env requirements, and any discrepancies between docs and code.',
    });
  }

  // ── Cap tasks based on repo size ──────────────────────────────────────

  if (isTiny) {
    // Tiny repos: merge into 3 tasks
    return tasks.slice(0, 3);
  }

  if (isLarge && tasks.length < 6) {
    // Large repos: add a general-inspection catch-all
    tasks.push({
      id: 'code-quality',
      description: 'Survey code quality patterns: error handling, logging, async safety, type safety, and common anti-patterns.',
      scope: 'src/',
      exclusions: ['node_modules', '.git', 'dist', 'build', 'coverage', 'test fixtures', 'generated files'],
      expectedOutput: 'Summary of code quality strengths and concerns, with specific file/line references for notable patterns.',
    });
  }

  return tasks;
}

// ─── Intent detection ─────────────────────────────────────────────────────────

/**
 * Patterns that explicitly request subagent delegation.
 * These bypass LLM planning and go directly to dispatch.
 */
const EXPLICIT_DELEGATION_PATTERNS: Array<{ regex: RegExp; mode: 'parallel' | 'sequential' | 'auto' }> = [
  // Explicit parallel subagents
  { regex: /\bparallel\s+sub-?agents?\b/i, mode: 'parallel' },
  { regex: /\bsequential\s+sub-?agents?\b/i, mode: 'sequential' },
  // "use agents", "use subagents", "use sub-agents" — must come before generic sub-?agents?
  { regex: /\buse\s+(sub-?)?agents?\b/i, mode: 'auto' },
  // Generic subagent mentions
  { regex: /\bsub-?agents?\b/i, mode: 'auto' },
  // Alternative delegation phrasing
  { regex: /\b(?:delegate|fan\s*out|spawn\s+agents?|dispatch\s+agents?)\b/i, mode: 'auto' },
  // "parallel agents"
  { regex: /\bparallel\s+agents?\b/i, mode: 'parallel' },
];

/**
 * Patterns that indicate repo-wide reconnaissance intent.
 * These do NOT require LLM planning — use domain template instead.
 */
const REPO_RECON_PATTERNS: RegExp[] = [
  /\bread\s+(?:all\s+)?(?:the\s+)?code\b/i,
  /\bread\s+(?:all\s+)?(?:the\s+)?(?:files|source|repo(?:sitory)?|codebase)\b/i,
  /\bread\s+(?:the\s+)?(?:entire|whole|full)\s+(?:repo(?:sitory)?|codebase)\b/i,
  /\b(?:scan|inspect|survey|audit|explore)\s+(?:the\s+)?(?:entire\s+)?(?:repo(?:sitory)?|codebase|project|code)\b/i,
  /\bunderstand\s+(?:this|the)\s+(?:repo(?:sitory)?|codebase|project|system)\b/i,
  /\brepo(?:re)?-?recon(?:naissance)?\b/i,
  /\b(?:overview|architecture)\s+(?:of\s+)?(?:this\s+)?(?:repo|project|codebase)\b/i,
  // "I want to ask you questions about it" after a read-request
  /\bquestions?\s+about\s+(?:it|the\s+code|this)\b/i,
];

/**
 * Detect whether a user prompt contains explicit delegation intent.
 *
 * Returns the detected intent on first match. Only falls through to
 * LLM planning if no pattern matches AND the prompt is ambiguous.
 */
export function detectExplicitDelegationIntent(prompt: string): Extract<DispatchIntent, { kind: 'explicit_delegation' }> | null {
  for (const pattern of EXPLICIT_DELEGATION_PATTERNS) {
    if (pattern.regex.test(prompt)) {
      const cleanTask = prompt
        .replace(pattern.regex, '')
        .replace(/\s{2,}/g, ' ')
        .trim() || prompt;
      return { kind: 'explicit_delegation', mode: pattern.mode, cleanTask };
    }
  }
  return null;
}

/**
 * Detect repo-wide reconnaissance intent.
 *
 * When the user asks to "read all the code" or "understand this repository",
 * we should use the domain-based template instead of LLM planning.
 */
export function detectRepoReconIntent(prompt: string): boolean {
  for (const pattern of REPO_RECON_PATTERNS) {
    if (pattern.test(prompt)) return true;
  }

  // Heuristic: look for "read all" + code/repo in the prompt
  const lower = prompt.toLowerCase();
  const hasReadIntent = /\bread\b/.test(lower);
  const hasRepoRef = /\b(repo|code|codebase|files|source)\b/.test(lower);
  const hasQuestionsIntent = /\b(questions?|ask|understand|learn|know)\b/.test(lower);

  if (hasReadIntent && hasRepoRef && hasQuestionsIntent) return true;

  return false;
}

/**
 * Classify dispatch intent from a user prompt.
 *
 * Priority:
 * 1. Explicit delegation (fast-path)
 * 2. Repo reconnaissance (fast-path via domain template)
 * 3. LLM planning fallback
 */
export function classifyDispatchIntent(prompt: string): DispatchIntent {
  // 1. Check explicit delegation
  const explicit = detectExplicitDelegationIntent(prompt);
  if (explicit) {
    return explicit;
  }

  // 2. Check repo reconnaissance
  if (detectRepoReconIntent(prompt)) {
    return { kind: 'repo_reconnaissance', cleanTask: prompt };
  }

  // 3. Fall back to LLM planning
  return { kind: 'requires_llm_planning', cleanTask: prompt };
}

// ─── Plan normalization safeguards ─────────────────────────────────────────────

export interface NormalizedDispatchPlan {
  /** Represents what will actually happen */
  strategy: 'repo_reconnaissance' | 'subagent_parallel' | 'subagent_sequential' | 'delegated_single' | 'inline';
  /** Number of subagents to dispatch */
  agentCount: number;
  /** Human-readable label for the UI */
  uiLabel: string;
  /** Whether LLM planning was used */
  usedLlmPlanning: boolean;
  /** Whether fast-path was used */
  usedFastPath: boolean;
}

/**
 * Normalize a dispatch plan to enforce invariants.
 *
 * Guards:
 * - "1 agents · parallel" → "Delegated · 1 agent" or "Inline"
 * - repo-recon with 1 task → expand to minimum 2 tasks
 * - single read-all task → replace with domain-based decomposition
 */
export function normalizeDispatchPlan(
  strategyName: string,
  mode: 'parallel' | 'sequential' | undefined,
  agentCount: number,
  taskDescriptions: string[],
  repoHints?: RepoHints,
): NormalizedDispatchPlan {
  // Guard: 1 agent in parallel mode → delegated single
  if (mode === 'parallel' && agentCount === 1) {
    const task = taskDescriptions[0] ?? '';
    // Check for read-all pattern
    if (/read\s+all\b|scan\s+all\b|inspect\s+(entire|all)/i.test(task)) {
      // Convert to repo reconnaissance
      const reconTasks = buildRepoReconTasks(repoHints ?? getDefaultHints());
      return {
        strategy: 'repo_reconnaissance',
        agentCount: reconTasks.length,
        uiLabel: reconTasks.length > 0
          ? `Strategy · repo reconnaissance (${reconTasks.length} domains)`
          : 'Inline · no delegation',
        usedLlmPlanning: false,
        usedFastPath: true,
      };
    }
    return {
      strategy: 'delegated_single',
      agentCount: 1,
      uiLabel: 'Delegated · 1 agent',
      usedLlmPlanning: false,
      usedFastPath: true,
    };
  }

  // Guard: repo-recon with single read-all task
  if (agentCount === 1 && taskDescriptions.length === 1) {
    const task = taskDescriptions[0];
    if (/recursively\s+read|read\s+all|scan\s+(all|entire)/i.test(task)) {
      const reconTasks = buildRepoReconTasks(repoHints ?? getDefaultHints());
      if (reconTasks.length > 0) {
        return {
          strategy: 'repo_reconnaissance',
          agentCount: reconTasks.length,
          uiLabel: `Strategy · repo reconnaissance (${reconTasks.length} domains)`,
          usedLlmPlanning: false,
          usedFastPath: true,
        };
      }
    }
  }

  // Normal case
  if (strategyName === 'repo_reconnaissance') {
    return {
      strategy: 'repo_reconnaissance',
      agentCount,
      uiLabel: `Strategy · repo reconnaissance (${agentCount} domains)`,
      usedLlmPlanning: false,
      usedFastPath: true,
    };
  }

  if (agentCount === 0) {
    return {
      strategy: 'inline',
      agentCount: 0,
      uiLabel: 'Inline · no delegation',
      usedLlmPlanning: false,
      usedFastPath: false,
    };
  }

  const modeLabel = mode === 'parallel' ? 'parallel' : mode === 'sequential' ? 'sequential' : '';
  const strategyLabel = strategyName === 'orchestrate' || strategyName === 'subagent_parallel'
    ? `Dispatch · ${agentCount} agents · ${modeLabel}`
    : `Strategy · ${strategyName}`;

  return {
    strategy: strategyName as NormalizedDispatchPlan['strategy'],
    agentCount,
    uiLabel: strategyLabel,
    usedLlmPlanning: true,
    usedFastPath: false,
  };
}

// ─── Timing instrumentation ───────────────────────────────────────────────────

export interface PlannerPhaseTiming {
  /** Monotonic ms when planning started */
  startedMs: number;
  /** Monotonic ms when intent was classified */
  intentClassifiedMs?: number;
  /** Monotonic ms when strategy was selected */
  strategySelectedMs?: number;
  /** Monotonic ms when tasks were generated */
  tasksGeneratedMs?: number;
  /** Monotonic ms when first worker started */
  workersSpawnedMs?: number;
}

export function startPlannerTimer(): PlannerPhaseTiming {
  return { startedMs: performance.now() };
}

export function markIntentClassified(timer: PlannerPhaseTiming): PlannerPhaseTiming {
  return { ...timer, intentClassifiedMs: performance.now() };
}

export function markStrategySelected(timer: PlannerPhaseTiming): PlannerPhaseTiming {
  return { ...timer, strategySelectedMs: performance.now() };
}

export function markTasksGenerated(timer: PlannerPhaseTiming): PlannerPhaseTiming {
  return { ...timer, tasksGeneratedMs: performance.now() };
}

export function markWorkersSpawned(timer: PlannerPhaseTiming): PlannerPhaseTiming {
  return { ...timer, workersSpawnedMs: performance.now() };
}

export interface PlannerTelemetry {
  phaseTimings: PlannerPhaseTiming;
  intent: DispatchIntent['kind'];
  strategy: string;
  agentCount: number;
  usedLlmPlanning: boolean;
  usedFastPath: boolean;
  elapsedMs: number;
}

export function reportPlannerTelemetry(
  timer: PlannerPhaseTiming,
  intent: DispatchIntent['kind'],
  strategy: string,
  agentCount: number,
  usedLlmPlanning: boolean,
  usedFastPath: boolean,
): PlannerTelemetry {
  const now = performance.now();
  return {
    phaseTimings: timer,
    intent,
    strategy,
    agentCount,
    usedLlmPlanning,
    usedFastPath,
    elapsedMs: now - timer.startedMs,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDefaultHints(): RepoHints {
  return { fileCount: 100, hasTui: true, hasTests: true, hasDocs: true, domains: [] };
}

const COMMON_EXCLUDED_DIRS = ['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo', 'vendor', 'target', '.venv', '__pycache__'];

export function commonExcludedDirs(): string[] {
  return [...COMMON_EXCLUDED_DIRS];
}
