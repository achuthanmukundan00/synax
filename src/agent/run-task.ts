import { loadProjectConfig, toProviderFactoryInput, type ProjectConfig } from '../config/project';
import { loadSynaxConfig } from '../config/load-config';
import { createLLMClient } from '../llm/provider-factory';
import { Session, type AgentActivity, type AgentTerminalState } from '../session/Session';
import { createSessionComponents, createAgentSession, type SessionComponents } from '../session/SessionFactory';
import type { Logger } from '../logging/Logger';
import { runVerification, type VerificationResult } from './verification';
import { eventNow, type AgentEvent } from './events';
import { createSafetyCheckpoint, detectDirtyTree, writeRunLog } from './safety';
import { normalizeRunMode, isInformationalTask, type RunMode } from './task-policy';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  VERIFICATION_CONTRACTS,
  type VerificationContract,
  evaluateVerificationContract,
  resolveVerificationContract,
} from '../session/verification-contracts';
import { upsertSessionMeta, findSessionMeta } from '../sessions/session-store';
import { OrchestrationManager } from '../orchestration/OrchestrationManager';
import { HandoffManager } from '../handoff/HandoffManager';
import type { AgentTurnResult, OrchestrationPlan, SubAgentResult, SubTask } from '../session/types';
import {
  classifyDispatchIntent,
  buildRepoReconTasks,
  startPlannerTimer,
  markIntentClassified,
  markStrategySelected,
  markTasksGenerated,
  markWorkersSpawned,
  reportPlannerTelemetry,
  type RepoHints,
  type RepoReconTask,
  type DispatchIntent,
  type PlannerPhaseTiming,
} from './dispatch-intent';

export interface RunTaskOptions {
  repoRoot: string;
  task: string;
  mode?: RunMode;
  yes?: boolean;
  verificationProfile?: 'quick' | 'full';
  repairAttempts?: number;
  recordRunArtifacts?: boolean;
  onActivity?: (activity: AgentActivity) => void;
  onEvent?: (event: AgentEvent) => void;
  /** Optional structured logger for internal diagnostics. */
  logger?: Logger;
  /** Maximum API cost budget in USD (stops agent when exceeded). */
  maxBudget?: number;
  /** Context strategy override. Takes precedence over auto-detection. */
  strategy?: string;
  /** Verification contract level override. */
  verify?: string;
  /** Disable all skill injection. */
  noSkills?: boolean;
  /**
   * Pre-created Session to use instead of creating a new one.
   *
   * When provided, the setup phase (config loading, LLM client creation,
   * component/session construction) is skipped. The caller owns lifecycle:
   *   - Caller must also provide: components, client, metadata, projectConfigOverride
   *   - Caller emits task_started/task_finished events (runAgentTask skips them)
   *   - Caller handles EventStore.closeSession and session-store upsert
   *   - Run log artifacts are still written (use recordRunArtifacts: false to opt out)
   *   - Files changed include commit-introduced files (beforeHead is captured)
   */
  session?: Session;
  /** Pre-created SessionComponents (required with session). */
  components?: SessionComponents;
  /** Pre-created LLM client (required with session). */
  client?: ReturnType<typeof createLLMClient>['client'];
  /** Pre-loaded ProjectConfig (required with session). */
  projectConfigOverride?: ProjectConfig;
  /** Provider metadata (required with session for task_started event fields). */
  metadata?: ReturnType<typeof createLLMClient>['metadata'];
}

export interface RunTaskReport {
  task: string;
  mode: RunMode;
  terminalState: AgentTerminalState;
  finalAnswer: string;
  filesChanged: string[];
  filesRead: string[];
  verification: VerificationResult;
  steps: number;
  toolCalls: Array<{ name: string; success: boolean; error?: string }>;
  messages: string[];
  contextBudgetTokens: number;
  maxModelSteps: number;
  maxToolCalls: number;
  /** Whether the working tree is clean after the task completes. */
  workingTreeClean?: boolean;
  checkpoint?: { id: string; statusPath: string; diffPath: string } | null;
  error?: string;
  /** DeepSeek / thinking-model reasoning content (bug #114).
   *  Preserved separately from finalAnswer so downstream consumers
   *  (session store, TUI, run log) can access it even when finalAnswer
   *  already absorbs it via the reasoningContent→content fallback. */
  reasoningContent?: string;
}

const execFileAsync = promisify(execFile);

/** Detected subagent trigger from user task text. */
type SubagentMode = 'parallel' | 'sequential' | 'auto';

function buildExplicitOrchestrationTask(task: string, mode: SubagentMode): string {
  const modeInstruction =
    mode === 'parallel'
      ? 'Use parallel sub-agents. Return independent sub-tasks with no dependencies when possible.'
      : mode === 'sequential'
        ? 'Use sequential sub-agents. Return ordered sub-tasks with dependencies where needed.'
        : 'Use sub-agents. Return a non-inline orchestration plan.';

  return [
    task,
    '',
    'Planner directive: the user explicitly requested sub-agent orchestration.',
    modeInstruction,
    'Do not return {"inline": true} unless the request is impossible to delegate safely.',
  ].join('\n');
}

function blockedReport(options: RunTaskOptions, mode: RunMode, messages: string[], error: string): RunTaskReport {
  return {
    task: options.task,
    mode,
    terminalState: 'blocked',
    finalAnswer: '',
    filesChanged: [],
    filesRead: [],
    verification: { state: 'skipped', stdout: '', stderr: '' },
    steps: 0,
    toolCalls: [],
    messages,
    contextBudgetTokens: options.projectConfigOverride?.contextBudgetTokens ?? 131072,
    maxModelSteps: options.projectConfigOverride?.maxModelSteps ?? 64,
    maxToolCalls: options.projectConfigOverride?.maxToolCalls ?? 192,
    error,
  };
}

/**
 * Execute a user task through the full agent lifecycle (orchestration, verification, repair).
 *
 * **Lifecycle ownership** depends on whether a pre-created `options.session` is provided:
 *
 * **Pre-created session** (when `options.session` is set):
 *   The caller is responsible for:
 *   - Session lifecycle (EventStore.closeSession, session-store meta upsert)
 *   - Emitting `task_started` / `task_finished` events
 *   - Providing components, client, metadata, and projectConfigOverride
 *
 *   runAgentTask handles:
 *   - Orchestration, verification, and repair loops
 *   - Run log artifact writing (unless `recordRunArtifacts: false`)
 *   - File change tracking and dirty tree detection
 *
 * **Auto-created session** (when `options.session` is NOT set):
 *   runAgentTask owns the full lifecycle: config loading, LLM client creation,
 *   session/component construction, EventStore registration and close,
 *   session-store upsert, task_started/task_finished emission, and run log writing.
 */
export async function runAgentTask(options: RunTaskOptions): Promise<RunTaskReport> {
  // ── Fast path: caller provided pre-created session ────────────────────────
  const usePreCreated = options.session !== undefined;

  let projectConfig: ReturnType<typeof loadProjectConfig>;
  let mode: RunMode;
  let client: ReturnType<typeof createLLMClient>['client'];
  let metadata: ReturnType<typeof createLLMClient>['metadata'];
  let components: SessionComponents;
  let session: Session;
  let wrappedOnEvent: (event: AgentEvent) => void;

  if (usePreCreated) {
    // Caller manages lifecycle — skip setup.
    if (
      !options.projectConfigOverride ||
      !options.components ||
      !options.client ||
      !options.metadata ||
      !options.session
    ) {
      return blockedReport(
        options,
        'patch',
        [
          'runAgentTask: session provided without required companion fields (components, client, metadata, projectConfigOverride)',
        ],
        'runAgentTask called with pre-created session but missing companion fields',
      );
    }
    projectConfig = { config: options.projectConfigOverride, errors: [], path: null, source: 'explicit' };
    mode = normalizeRunMode(options.mode) || 'patch';
    client = options.client;
    metadata = options.metadata;
    components = options.components;
    session = options.session;
    // Use the session's own event callback (already wired to EventStore / TUI sink).
    wrappedOnEvent = (event: AgentEvent) => {
      session.onEvent?.(event);
    };
  } else {
    // ── Standard path: full setup (ask, run --no-tui) ───────────────────────
    const loaded = loadProjectConfig(options.repoRoot);
    projectConfig = loaded;
    mode = normalizeRunMode(options.mode);
    if (projectConfig.errors.length > 0) {
      return blockedReport(
        options,
        mode,
        projectConfig.errors.map((error) => `${error.path}: ${error.message}`),
        'config validation failed',
      );
    }

    const providerInput = toProviderFactoryInput(projectConfig.config);

    // Load effective config once for thinking level and skills.
    let effectiveConfig;
    try {
      effectiveConfig = loadSynaxConfig(options.repoRoot);
    } catch {
      effectiveConfig = undefined;
    }
    if (effectiveConfig?.active.thinking && effectiveConfig.active.thinking !== 'off') {
      providerInput.thinkingLevel = effectiveConfig.active.thinking;
    }

    let factoryResult;
    try {
      factoryResult = createLLMClient(providerInput);
    } catch (err) {
      return blockedReport(options, mode, [(err as Error).message], (err as Error).message);
    }

    client = factoryResult.client;
    metadata = factoryResult.metadata;

    // ── Create shared observability components via factory ──
    const modelContextWindow =
      metadata.contextWindow ??
      projectConfig.config.contextWindowTokens ??
      projectConfig.config.contextBudgetTokens ??
      131072;

    components = createSessionComponents({
      repoRoot: options.repoRoot,
      modelId: metadata.modelId ?? '',
      contextWindow: modelContextWindow,
      modelContextWindow,
      noSkills: options.noSkills,
      strategyOverride: options.strategy,
      title: options.task.slice(0, 80),
    });

    const agentSession = createAgentSession({
      repoRoot: options.repoRoot,
      client,
      config: projectConfig.config,
      components,
      mode,
      onActivity: options.onActivity,
      onEvent: options.onEvent,
      maxBudget: options.maxBudget,
      approvePatch: () => (options.yes ? 'accept' : 'reject'),
      ensureCheckpoint: async () => {
        if (options.recordRunArtifacts === false) return null;
        if (checkpoint) return checkpoint;
        checkpoint = await createSafetyCheckpoint(options.repoRoot);
        return checkpoint;
      },
    });

    session = agentSession.session;
    // Dual routing: the factory's wrappedOnEvent calls both options.onEvent
    // (for TUI / CLI forwarding) and components.eventStore (for EventStore
    // persistence) — this is intentional, not a double emission.
    wrappedOnEvent = agentSession.wrappedOnEvent;
  }

  const dirtyTree = await detectDirtyTree(options.repoRoot);
  const beforeHead = await gitHead(options.repoRoot);
  let checkpoint: { id: string; statusPath: string; diffPath: string } | null = null;

  // Emit task_started event (skip when caller handles lifecycle, e.g. TUI)
  if (!usePreCreated) {
    const tools = Session.buildModelTools({ bashEnabled: projectConfig.config.tools?.bash?.enabled, mode }).map(
      (tool) => tool.name,
    );
    wrappedOnEvent({
      type: 'task_started',
      timestamp: eventNow(),
      mode,
      profile: projectConfig.config.activeProfile ?? 'default',
      endpoint: metadata.baseUrl,
      model: metadata.modelId,
      providerName: metadata.displayName,
      contextBudgetTokens: projectConfig.config.contextBudgetTokens ?? 131072,
      contextWindowTokens:
        projectConfig.config.contextWindowTokens ?? projectConfig.config.contextBudgetTokens ?? 131072,
      maxModelSteps: projectConfig.config.maxModelSteps ?? 64,
      maxToolCalls: projectConfig.config.maxToolCalls ?? 192,
      tools,
      task: options.task,
      inputPricePer1MTokens: metadata.inputPricePer1MTokens,
      outputPricePer1MTokens: metadata.outputPricePer1MTokens,
    });
  }

  // Apply --verify override if specified
  if (options.verify) {
    const verifyContract = resolveVerifyOverride(options.verify);
    if (verifyContract) {
      session.setVerificationContract(verifyContract);
    }
  }

  // ── Orchestration: dispatch intent classification + fast-path dispatch ──
  let turn: AgentTurnResult;
  let orchestrationUsed = false;

  // Start planner timer for telemetry
  const plannerTimer = startPlannerTimer();

  // Emit planner_started event
  wrappedOnEvent({
    type: 'planner_started',
    timestamp: eventNow(),
    promptLength: options.task.length,
  });

  // Classify dispatch intent.
  // Sub-agent orchestration is opt-in via config.subagents.enabled, with one
  // exception: an explicit in-task delegation request ("use parallel
  // sub-agents …") overrides the config default — the user literally asked.
  // When disabled and not explicitly requested, skip the entire planner
  // pipeline (no fast-path dispatch, no LLM planning calls, no repo metadata
  // collection) and run the task inline. This keeps the common single-agent
  // path fast and cheap.
  const subagentsEnabled = projectConfig.config.subagents?.enabled === true;
  const classifiedIntent = classifyDispatchIntent(options.task);
  const dispatchIntent: DispatchIntent =
    subagentsEnabled || classifiedIntent.kind === 'explicit_delegation'
      ? classifiedIntent
      : { kind: 'requires_llm_planning', cleanTask: options.task };
  const classifiedTimer = markIntentClassified(plannerTimer);
  const intentElapsed = Math.round(classifiedTimer.intentClassifiedMs! - classifiedTimer.startedMs);

  // Accumulating timer for the full planner lifecycle (immutable chain — each mark
  // returns a new object carrying all prior timestamps forward).
  let plannerState: PlannerPhaseTiming = classifiedTimer;

  wrappedOnEvent({
    type: 'planner_intent_detected',
    timestamp: eventNow(),
    intent: dispatchIntent.kind,
    mode: dispatchIntent.kind === 'explicit_delegation' ? (dispatchIntent as any).mode : undefined,
    elapsedMs: intentElapsed,
  });

  // Determine strategy and build plan
  let forceOrchestrate = false;
  let forcedMode: 'parallel' | 'sequential' | undefined;
  let planResult: import('../session/types').PlanParseResult | null = null;
  let strategyLabel = 'inline';
  let plan: OrchestrationPlan | null = null;

  // ═══ Fast-path: repo reconnaissance ═══════════════════════════════════
  if (dispatchIntent.kind === 'repo_reconnaissance') {
    // Cheap repo hints collection (single find + dir checks)
    const repoHints = await collectRepoHints(options.repoRoot);
    const reconTasks = buildRepoReconTasks(repoHints);

    // Build orchestration plan directly (no LLM call)
    plan = buildReconOrchestrationPlan(reconTasks, options.repoRoot, options.task);
    strategyLabel = 'repo_reconnaissance';
    forcedMode = 'parallel';
    plannerState = markStrategySelected(plannerState);
    plannerState = markTasksGenerated(plannerState);

    wrappedOnEvent({
      type: 'planner_strategy_selected',
      timestamp: eventNow(),
      strategy: 'repo_reconnaissance',
      agentCount: reconTasks.length,
      usedLlmPlanning: false,
      usedFastPath: true,
      elapsedMs: Math.round(performance.now() - classifiedTimer.startedMs),
    });

    // ═══ Fast-path: explicit delegation ═══════════════════════════════════
  } else if (dispatchIntent.kind === 'explicit_delegation') {
    const delegation = dispatchIntent as Extract<DispatchIntent, { kind: 'explicit_delegation' }>;
    const planningTask = buildExplicitOrchestrationTask(options.task, delegation.mode);

    strategyLabel =
      delegation.mode === 'parallel'
        ? 'orchestrate (parallel)'
        : delegation.mode === 'sequential'
          ? 'orchestrate (sequential)'
          : 'orchestrate';
    forceOrchestrate = true;
    if (delegation.mode === 'parallel' || delegation.mode === 'sequential') {
      forcedMode = delegation.mode;
    }
    plannerState = markStrategySelected(plannerState);

    wrappedOnEvent({
      type: 'planner_strategy_selected',
      timestamp: eventNow(),
      strategy: strategyLabel,
      agentCount: 0,
      usedLlmPlanning: true,
      usedFastPath: false,
      elapsedMs: Math.round(performance.now() - classifiedTimer.startedMs),
    });

    // Call LLM planner for decomposition
    planResult = await session.planOrchestratedTurn(planningTask, forcedMode);
    plannerState = markTasksGenerated(plannerState);

    // ═══ LLM planning fallback ════════════════════════════════════════════
  } else if (subagentsEnabled) {
    // Auto-detect strategy via budget estimation
    const estimate = await session.estimateTaskBudget(options.task);
    strategyLabel = estimate.strategy;
    plannerState = markStrategySelected(plannerState);

    wrappedOnEvent({
      type: 'planner_strategy_selected',
      timestamp: eventNow(),
      strategy: strategyLabel,
      agentCount: 0,
      usedLlmPlanning: true,
      usedFastPath: false,
      elapsedMs: Math.round(performance.now() - classifiedTimer.startedMs),
    });

    if (strategyLabel === 'orchestrate' || strategyLabel === 'decompose') {
      planResult = await session.planOrchestratedTurn(options.task, undefined);
      plannerState = markTasksGenerated(plannerState);
    }
  } else {
    // Sub-agents disabled: inline execution, no planning overhead.
    plannerState = markStrategySelected(plannerState);
    wrappedOnEvent({
      type: 'planner_strategy_selected',
      timestamp: eventNow(),
      strategy: 'inline',
      agentCount: 0,
      usedLlmPlanning: false,
      usedFastPath: true,
      elapsedMs: Math.round(performance.now() - classifiedTimer.startedMs),
    });
  }

  // ═══ Execute orchestration plan ═══════════════════════════════════════
  const planFromResult = planResult?.success ? planResult.plan : undefined;
  const effectivePlan = plan ?? planFromResult ?? null;

  if (effectivePlan && effectivePlan.subTasks && effectivePlan.subTasks.length > 0) {
    const agentCount = effectivePlan.subTasks.length;
    const mode = forcedMode ?? 'parallel';

    // Guard: 1 agent in parallel mode — normalize to delegated single
    const normalizedMode = agentCount === 1 && mode === 'parallel' ? 'delegated' : mode;

    // Emit dispatch_started
    wrappedOnEvent({
      type: 'dispatch_started',
      timestamp: eventNow(),
      strategy: strategyLabel,
      agentCount,
      mode: normalizedMode as 'parallel' | 'sequential' | 'delegated' | 'inline',
    });

    const handoffManager = new HandoffManager();
    session.setHandoffManager(handoffManager);

    const orchestrationResult = await OrchestrationManager.execute(effectivePlan, session, handoffManager, {
      forcedMode: normalizedMode === 'delegated' ? undefined : forcedMode,
    });

    orchestrationUsed = true;

    // ── Bridge sub-agent results into parent session conversation ──
    // The orchestration path bypasses session.startTurn(), so the parent
    // conversation is never populated with what sub-agents found. Push
    // structured summaries here so follow-up turns have model-visible context.
    session.conversation.messages.push({
      role: 'user',
      content: options.task,
    });
    for (const result of orchestrationResult.results) {
      session.conversation.messages.push({
        role: 'assistant',
        content: compactChildSummary(result),
      });
    }
    session.conversation.messages.push({
      role: 'assistant',
      content: orchestrationResult.conclusion,
    });

    plannerState = markWorkersSpawned(plannerState);

    // Report planner telemetry
    const telemetry = reportPlannerTelemetry(
      plannerState,
      dispatchIntent.kind,
      strategyLabel,
      agentCount,
      strategyLabel !== 'repo_reconnaissance',
      strategyLabel === 'repo_reconnaissance',
    );
    const telemetryMsg = `planner telemetry: ${telemetry.elapsedMs}ms · ${telemetry.intent} · ${telemetry.strategy} · ${telemetry.agentCount} agents · ${telemetry.usedFastPath ? 'fast-path' : 'LLM'}`;
    options.onActivity?.({
      kind: 'model',
      message: telemetryMsg,
    });

    wrappedOnEvent({
      type: 'dispatch_workers_completed',
      timestamp: eventNow(),
      workerCount: agentCount,
    });

    // Convert orchestration result to AgentTurnResult
    turn = {
      terminalState: orchestrationResult.terminalState as AgentTerminalState,
      finalAnswer: orchestrationResult.conclusion,
      steps: orchestrationResult.results.length,
      toolCalls: orchestrationResult.results.flatMap((r) =>
        Array.from({ length: r.toolCalls }, () => ({
          name: `subagent:${r.subTaskId}`,
          success: r.terminalState === 'completed',
          error: r.error,
        })),
      ),
      changedFiles: orchestrationResult.changedFiles,
      conversation: session.conversation,
      error: orchestrationResult.error,
    };
  } else if (forceOrchestrate) {
    const reason =
      planResult && !planResult.success
        ? (planResult.error ?? 'planner returned inline')
        : 'planner returned no sub-tasks';
    const message = `Explicit ${strategyLabel} was requested, but Synax could not generate a valid sub-agent plan (${reason}). Refusing to continue inline because that would ignore the requested execution mode.`;
    turn = {
      terminalState: 'blocked',
      finalAnswer: message,
      steps: 0,
      toolCalls: [],
      changedFiles: [],
      conversation: session.conversation,
      error: message,
    };
  } else {
    // Auto-detection: plan failed, returned inline, or inline strategy — normal execution
    turn = await session.startTurnWithRecovery(options.task);
  }
  const checkpointRecord = checkpoint as { id: string; statusPath: string; diffPath: string } | null;

  const verificationCommand = projectConfig.config.verification?.defaultCommand;
  const verCheckId = 'run-verification';
  if (verificationCommand && turn.changedFiles.length > 0) {
    wrappedOnEvent({
      type: 'verification_planned',
      timestamp: eventNow(),
      checkId: verCheckId,
      checkLabel: verificationCommand,
      command: verificationCommand,
      summary: `${turn.changedFiles.length} file(s) changed`,
    });
  }

  let verification: VerificationResult = { state: 'skipped', stdout: '', stderr: '' };
  if (turn.changedFiles.length > 0) {
    const vStarted = Date.now();
    wrappedOnEvent({
      type: 'verification_started',
      timestamp: eventNow(),
      checkId: verCheckId,
      checkLabel: verificationCommand ?? '(no command)',
      command: verificationCommand,
    });
    verification = await runVerification({
      repoRoot: options.repoRoot,
      command: verificationCommand,
      timeoutMs: options.verificationProfile === 'full' ? 120000 : 60000,
      maxOutputChars: options.verificationProfile === 'full' ? 12000 : 4000,
    });
    const vDuration = Date.now() - vStarted;
    if (verification.state === 'passed') {
      wrappedOnEvent({
        type: 'verification_passed',
        timestamp: eventNow(),
        checkId: verCheckId,
        checkLabel: verificationCommand ?? '(no command)',
        command: verification.command,
        summary: verification.stdout.slice(0, 200).trim() || 'passed',
        durationMs: vDuration,
      });
    } else if (verification.state === 'failed') {
      wrappedOnEvent({
        type: 'verification_failed',
        timestamp: eventNow(),
        checkId: verCheckId,
        checkLabel: verificationCommand ?? '(no command)',
        command: verification.command,
        summary: verification.stderr.slice(0, 200).trim() || `exit ${verification.exitCode ?? '?'}`,
        severity: 'S2',
        durationMs: vDuration,
      });
    } else {
      wrappedOnEvent({
        type: 'verification_skipped',
        timestamp: eventNow(),
        checkId: verCheckId,
        checkLabel: verificationCommand ?? '(no command)',
        summary: 'no verification command configured',
      });
    }
  }
  let repairedTurn = turn;
  const maxRepairAttempts = options.repairAttempts ?? 1;

  // Determine if we need repair. Two cases:
  // 1. Verification command ran and failed (verification.state === 'failed')
  // 2. Contract not satisfied — model completed without write/edit (verification skipped)
  //
  // Contract derivation: an explicit --verify flag always wins. Otherwise the
  // contract comes from the run mode, EXCEPT for informational tasks in patch
  // mode ("explain X", "why does Y fail?") — forcing files_changed there
  // pushes the model into spurious edits, so those degrade to 'none'.
  const informational = mode === 'patch' && turn.changedFiles.length === 0 && isInformationalTask(options.task);
  const effectiveContract = options.verify
    ? (resolveVerifyOverride(options.verify) ?? resolveVerificationContract(mode))
    : informational
      ? { level: 'none' as const, label: 'No verification required (informational task)' }
      : resolveVerificationContract(mode);
  const contractEval = evaluateVerificationContract({
    contract: effectiveContract,
    evidence: {
      changedFiles: turn.changedFiles,
      verificationRan: verification.state !== 'skipped',
      verificationExitCode: verification.exitCode,
    },
  });
  const contractFailed =
    turn.terminalState === 'completed' && effectiveContract.level !== 'none' && !contractEval.passed;

  const needsRepair = verification.state === 'failed' || contractFailed;
  if (needsRepair && maxRepairAttempts > 0) {
    for (let attempt = 1; attempt <= maxRepairAttempts; attempt += 1) {
      const repairCheckId = `repair-verification-${attempt}`;
      wrappedOnEvent({
        type: 'verification_planned',
        timestamp: eventNow(),
        checkId: repairCheckId,
        checkLabel: `repair attempt ${attempt}`,
        command: verificationCommand,
        summary: `repair ${attempt}/${maxRepairAttempts}`,
      });
      const repairSession = new Session({
        repoRoot: options.repoRoot,
        client,
        mode,
        sessionId: components.sessionId,
        memory: components.memory,
        maxToolCalls: Math.max(8, Math.floor((projectConfig.config.maxToolCalls ?? 192) / 2)),
        bashEnabled: projectConfig.config.tools?.bash?.enabled,
        skillMessages: components.skillMessages,
        logger: components.logger,
        contextBudget: {
          contextBudgetTokens: projectConfig.config.contextBudgetTokens,
          contextWindowTokens: projectConfig.config.contextWindowTokens,
          reservedOutputTokens: projectConfig.config.reservedOutputTokens,
          keepRecentTokens: projectConfig.config.keepRecentTokens,
          maxSingleReadResultTokens: projectConfig.config.maxSingleReadResultTokens,
          maxTotalReadResultTokensPerTurn: projectConfig.config.maxTotalReadResultTokensPerTurn,
        },
        onActivity: options.onActivity,
        onEvent: wrappedOnEvent,
        approvePatch: () => (options.yes ? 'accept' : 'reject'),
        ensureCheckpoint: async () => checkpoint ?? (checkpoint = await createSafetyCheckpoint(options.repoRoot)),
      });
      const repairTask =
        verification.state === 'failed'
          ? `Verification failed. Fix the changed files and make verification pass. Failure output:\n${verification.stderr.slice(0, 1000)}`
          : `The verification contract '${effectiveContract.level}' was not satisfied: ${contractEval.message}. Task: ${options.task}. Use write/edit/bash to make the required changes and satisfy the contract.`;
      const repair = await repairSession.startTurnWithRecovery(repairTask);
      repairedTurn = repair;
      if (repair.changedFiles.length > 0) {
        const rStarted = Date.now();
        wrappedOnEvent({
          type: 'verification_started',
          timestamp: eventNow(),
          checkId: repairCheckId,
          checkLabel: `repair attempt ${attempt}`,
          command: verificationCommand,
        });
        verification = await runVerification({
          repoRoot: options.repoRoot,
          command: verificationCommand,
          timeoutMs: options.verificationProfile === 'full' ? 120000 : 60000,
          maxOutputChars: options.verificationProfile === 'full' ? 12000 : 4000,
        });
        const rDuration = Date.now() - rStarted;
        if (verification.state === 'passed') {
          wrappedOnEvent({
            type: 'verification_passed',
            timestamp: eventNow(),
            checkId: repairCheckId,
            checkLabel: `repair attempt ${attempt}`,
            command: verification.command,
            summary: verification.stdout.slice(0, 200).trim() || 'passed',
            durationMs: rDuration,
          });
        } else {
          wrappedOnEvent({
            type: 'verification_failed',
            timestamp: eventNow(),
            checkId: repairCheckId,
            checkLabel: `repair attempt ${attempt}`,
            command: verification.command,
            summary: verification.stderr.slice(0, 200).trim() || `exit ${verification.exitCode ?? '?'}`,
            severity: 'S2',
            durationMs: rDuration,
          });
        }
      }
      // Break if the contract is now satisfied (or verification passed).
      const postRepairContract = evaluateVerificationContract({
        contract: effectiveContract,
        evidence: {
          changedFiles: [...turn.changedFiles, ...repair.changedFiles],
          verificationRan: verification.state !== 'skipped',
          verificationExitCode: verification.exitCode,
        },
      });
      if (verification.state === 'passed' || postRepairContract.passed) break;
    }
  }
  let terminalState = turn.terminalState;
  if (repairedTurn.terminalState === 'completed' && verification.state === 'failed') {
    terminalState = 'failed_verification';
  }
  // If a contract-triggered repair was attempted but failed, ensure we don't
  // silently accept the original completion.
  if (contractFailed && repairedTurn !== turn && repairedTurn.terminalState !== 'completed') {
    terminalState = repairedTurn.terminalState === 'blocked' ? 'failed_verification' : repairedTurn.terminalState;
  }
  const finalAnswer = repairedTurn === turn ? turn.finalAnswer : repairedTurn.finalAnswer || turn.finalAnswer;
  const reasoningContent =
    repairedTurn === turn ? turn.reasoningContent : repairedTurn.reasoningContent || turn.reasoningContent;
  const filesRead = unique(turn.conversation.inspectionLedger.getInspectedRanges().map((range) => range.path));
  const afterHead = await gitHead(options.repoRoot);
  const changedByCommit =
    beforeHead && afterHead && beforeHead !== afterHead
      ? await changedFilesBetween(options.repoRoot, beforeHead, afterHead)
      : [];
  const filesChanged = unique([...turn.changedFiles, ...repairedTurn.changedFiles, ...changedByCommit]);

  // ── Contract evaluation: always verify the turn satisfies the contract ──
  // Guards against false completion when the model claims success without
  // changing files (or without running verification when contract demands it).
  // Must always verify when task expects output. If no write/edit attempted,
  // fail explicitly with proper verification lifecycle events.
  if (terminalState === 'completed' || terminalState === 'failed_verification') {
    // Reuse the contract derived above (includes the informational-task
    // exception) — re-deriving from mode alone would re-fail relaxed tasks.
    const contractCheck = evaluateVerificationContract({
      contract: effectiveContract,
      evidence: {
        changedFiles: filesChanged,
        verificationRan: verification.state !== 'skipped',
        verificationExitCode: verification.exitCode,
      },
    });
    if (!contractCheck.passed) {
      // Emit explicit verification lifecycle events so the contract failure
      // is visible, not silently skipped.
      const contractCheckId = 'contract-check';
      if (terminalState === 'completed') {
        // Verification was silently skipped — emit what a normal flow would.
        wrappedOnEvent({
          type: 'verification_planned',
          timestamp: eventNow(),
          checkId: contractCheckId,
          checkLabel: effectiveContract.label,
          summary: contractCheck.message,
        });
      }
      wrappedOnEvent({
        type: 'verification_failed',
        timestamp: eventNow(),
        checkId: contractCheckId,
        checkLabel: effectiveContract.label,
        summary: contractCheck.message,
        severity: 'S2',
      });
      terminalState = 'failed_verification';
    }
  }
  const finalDirtyTree = await detectDirtyTree(options.repoRoot);
  // Emit final consolidated answer as a single assistant_message per turn.
  // (Not a duplicate of per-turn assistant_message events emitted by Session execution.)
  // Pre-created path: routes through session.onEvent -> eventSink + EventStore + JSONL.
  // Auto-created path: routes through agentSession.wrappedOnEvent (same sinks).
  if (finalAnswer.trim().length > 0) {
    wrappedOnEvent({
      type: 'assistant_message',
      timestamp: eventNow(),
      content: finalAnswer,
    });
  }
  wrappedOnEvent({
    type: 'task_finished',
    timestamp: eventNow(),
    status: terminalState,
    toolCalls: turn.toolCalls.length + (repairedTurn === turn ? 0 : repairedTurn.toolCalls.length),
    maxToolCalls: projectConfig.config.maxToolCalls ?? 192,
    modelSteps: turn.steps + (repairedTurn === turn ? 0 : repairedTurn.steps),
    maxModelSteps: projectConfig.config.maxModelSteps ?? 64,
    changedFiles: filesChanged,
    workingTreeClean: !finalDirtyTree.dirty,
    verification:
      verification.state === 'passed'
        ? `${verification.command ?? 'verification'} passed`
        : verification.state === 'failed'
          ? `${verification.command ?? 'verification'} failed`
          : 'not run',
    error: turn.error,
  });

  // ── Lifecycle cleanup (skipped for pre-created sessions where caller owns lifecycle) ──
  if (!usePreCreated) {
    // Close EventStore observability session (caller manages EventStore lifecycle)
    if (components.eventStore) {
      components.eventStore.closeSession(components.sessionId, terminalState, {
        steps: turn.steps + (repairedTurn === turn ? 0 : repairedTurn.steps),
        toolCalls: turn.toolCalls.length + (repairedTurn === turn ? 0 : repairedTurn.toolCalls.length),
        changedFiles: filesChanged,
      });
    }

    // Upsert session metadata for /resume discoverability (caller manages session-store lifecycle)
    try {
      const existing = findSessionMeta(components.sessionId);
      upsertSessionMeta({
        id: components.sessionId,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        workspacePath: options.repoRoot,
        title: options.task.slice(0, 80),
        summary: finalAnswer.slice(0, 120),
        activeModel: metadata.modelId,
        messageCount: 1,
        eventCount: 1,
        status: terminalState === 'completed' ? 'completed' : 'failed',
      });
    } catch {
      // Best-effort
    }

    // Write run log artifact (skipped when caller explicitly opts out via recordRunArtifacts: false)
    if (options.recordRunArtifacts !== false) {
      await writeRunLog(options.repoRoot, {
        task: options.task,
        mode,
        terminalState,
        changedFiles: filesChanged,
        filesRead,
        checkpointId: checkpointRecord?.id,
        verification: verification.state,
        error: turn.error,
      });
    }
  }

  return {
    task: options.task,
    mode,
    terminalState,
    finalAnswer,
    filesChanged,
    filesRead,
    verification,
    steps: turn.steps + (repairedTurn === turn ? 0 : repairedTurn.steps),
    toolCalls: [...turn.toolCalls, ...(repairedTurn === turn ? [] : repairedTurn.toolCalls)],
    messages: [
      ...(orchestrationUsed ? [`orchestrated: task decomposed across sub-agents`] : []),
      ...(dirtyTree.dirty ? ['working tree was dirty before run', ...dirtyTree.summary] : []),
      ...(checkpointRecord ? [`checkpoint: ${checkpointRecord.id}`] : []),
    ],
    contextBudgetTokens: projectConfig.config.contextBudgetTokens ?? 131072,
    maxModelSteps: projectConfig.config.maxModelSteps ?? 64,
    maxToolCalls: projectConfig.config.maxToolCalls ?? 192,
    workingTreeClean: !finalDirtyTree.dirty,
    checkpoint: checkpointRecord
      ? {
          id: checkpointRecord.id,
          statusPath: checkpointRecord.statusPath,
          diffPath: checkpointRecord.diffPath,
        }
      : null,
    error: turn.error,
    reasoningContent,
  };
}

// ─── Repo hints for dispatch intent classifier ────────────────────────────────

/**
 * Lightweight repo hints collector. Single find + stat calls — does NOT scan
 * file contents. Used by the dispatch intent classifier to determine:
 * - file count (tiny/normal/large)
 * - presence of test, TUI, and docs directories
 *
 * This is deliberately cheaper than collectRepoMetadata() which runs
 * 3 separate find+du commands for budget estimation.
 */
async function collectRepoHints(repoRoot: string): Promise<RepoHints> {
  // Quick file count
  let fileCount = 0;
  try {
    const { stdout } = await execFileAsync(
      'bash',
      [
        '-c',
        `find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/coverage/*' 2>/dev/null | wc -l`,
      ],
      { cwd: repoRoot, maxBuffer: 64 * 1024, timeout: 3000 },
    );
    fileCount = parseInt(stdout.trim(), 10) || 0;
  } catch {
    // Best-effort
  }

  // Quick directory checks (in parallel, cheap)
  const dirPaths = ['src/tui', 'src/__tests__', 'docs', 'README.md'];
  let hasTui = false;
  let hasTests = false;
  let hasDocs = false;

  try {
    const results = await Promise.all(
      dirPaths.map(async (d) => {
        try {
          await execFileAsync('bash', ['-c', `test -d '${d}' || test -f '${d}'`], { cwd: repoRoot, timeout: 1000 });
          return d;
        } catch {
          return null;
        }
      }),
    );
    hasTui = results.includes('src/tui');
    hasTests = results.includes('src/__tests__');
    hasDocs = results.includes('docs') || results.includes('README.md');
  } catch {
    // Best-effort
  }

  return { fileCount, hasTui, hasTests, hasDocs, domains: [] };
}

// ─── Direct orchestration plan builder (no LLM call) ──────────────────────────

/**
 * Build an OrchestrationPlan directly from repo-recon tasks, skipping the LLM
 * planning call entirely. Each task becomes a SubTask for OrchestrationManager.
 */
function buildReconOrchestrationPlan(tasks: RepoReconTask[], _repoRoot: string, _task: string): OrchestrationPlan {
  const subTasks: SubTask[] = tasks.map((t, i) => ({
    id: `recon-${i + 1}`,
    description: t.description,
    fileScope: [t.scope],
    dependencies: [],
    estimatedBudget: 8000,
    verification: { level: 'none', label: 'Read-only recon task' },
  }));

  return {
    planId: `repo-recon-${Date.now()}`,
    subtasks: tasks.map((t, i) => ({
      id: `recon-${i + 1}`,
      description: t.description,
      fileScope: [t.scope],
      dependencies: [],
      estimatedTokens: 8000,
    })),
    subTasks,
    strategy: 'orchestrate',
    estimatedTotalTokens: subTasks.length * 8000,
    repoMetadata: { fileCount: 0, totalKB: 0, sourceKB: 0 },
    contextWindowTokens: 0,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Compact structured summary of a sub-agent result for parent conversation
 * context. Preserves newlines in findings so the model can read them
 * naturally on the next turn. Truncates finalAnswer to 1,200 chars.
 */
function compactChildSummary(result: SubAgentResult): string {
  const parts: string[] = [];
  parts.push(`[Subagent result: ${result.subTaskId}]`);
  parts.push(`Status: ${result.terminalState}`);
  if (result.changedFiles.length > 0) {
    parts.push(`Files changed: ${result.changedFiles.join(', ')}`);
  }
  parts.push(`Tool calls: ${result.toolCalls}`);
  if (result.finalAnswer) {
    const truncated = result.finalAnswer.length > 1200 ? result.finalAnswer.slice(0, 1200) + '...' : result.finalAnswer;
    parts.push(`── Findings ──\n${truncated}\n──`);
  }
  if (result.error) {
    parts.push(`Error: ${result.error.slice(0, 300)}`);
  }
  return parts.join('\n');
}

async function gitHead(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, maxBuffer: 64 * 1024 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function changedFilesBetween(repoRoot: string, before: string, after: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', `${before}..${after}`], {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Resolve a --verify CLI value to a VerificationContract.
 *
 * Maps: none → none, files-changed → files_changed,
 *       verification-ran → verification_ran, tests-passing → verification_passed
 */
function resolveVerifyOverride(level: string): VerificationContract | null {
  switch (level) {
    case 'none':
      return { level: 'none', label: 'No verification required (explicit)' };
    case 'files-changed':
      return VERIFICATION_CONTRACTS.files_changed;
    case 'verification-ran':
      return VERIFICATION_CONTRACTS.verification_ran;
    case 'tests-passing':
      return VERIFICATION_CONTRACTS.verification_passed;
    default:
      return null;
  }
}
