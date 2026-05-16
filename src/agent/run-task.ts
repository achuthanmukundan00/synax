import { loadProjectConfig, toProviderFactoryInput, type ProjectConfig } from '../config/project';
import { loadSynaxConfig } from '../config/load-config';
import { createLLMClient } from '../llm/provider-factory';
import { Session, type AgentActivity, type AgentTerminalState } from '../session/Session';
import { createSessionComponents, createAgentSession, type SessionComponents } from '../session/SessionFactory';
import type { Logger } from '../logging/Logger';
import { runVerification, type VerificationResult } from './verification';
import { eventNow, type AgentEvent } from './events';
import { createSafetyCheckpoint, detectDirtyTree, writeRunLog } from './safety';
import { normalizeRunMode, type RunMode } from './task-policy';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { VERIFICATION_CONTRACTS, type VerificationContract } from '../session/verification-contracts';
import { upsertSessionMeta, findSessionMeta } from '../sessions/session-store';
import { OrchestrationManager } from '../orchestration/OrchestrationManager';
import { HandoffManager } from '../handoff/HandoffManager';
import { createTokenLedger } from '../agent/context-budget';
import { createInspectionLedger as createInspLedger } from '../tools';
import type { AgentTurnResult } from '../session/types';

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
   *   - Caller handles writeRunLog (runAgentTask skips recordRunArtifacts)
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
}

const execFileAsync = promisify(execFile);

/** Detected subagent trigger from user task text. */
interface SubagentTrigger {
  active: boolean;
  mode: 'parallel' | 'sequential' | 'auto';
  cleanTask: string;
}

const SUBAGENT_TRIGGERS: Array<{ pattern: RegExp; mode: SubagentTrigger['mode'] }> = [
  { pattern: /parallel\s+sub-?agents?\b/i, mode: 'parallel' },
  { pattern: /sequential\s+sub-?agents?\b/i, mode: 'sequential' },
  { pattern: /\bsub-?agents?\b/i, mode: 'auto' },
];

/**
 * Detect explicit subagent trigger phrases in the user's task.
 * Returns the trigger mode and the cleaned task text (trigger phrase removed).
 * If no trigger is found, returns active=false.
 */
function detectSubagentTrigger(task: string): SubagentTrigger {
  for (const trigger of SUBAGENT_TRIGGERS) {
    if (trigger.pattern.test(task)) {
      const cleanTask = task
        .replace(trigger.pattern, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      return { active: true, mode: trigger.mode, cleanTask: cleanTask || task };
    }
  }
  return { active: false, mode: 'auto', cleanTask: task };
}

function buildExplicitOrchestrationTask(task: string, mode: SubagentTrigger['mode']): string {
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

  // ── Orchestration: detect explicit triggers, or auto-estimate budget ──
  let turn: AgentTurnResult;
  let orchestrationUsed = false;

  const subagentTrigger = detectSubagentTrigger(options.task);
  const effectiveTask = subagentTrigger.cleanTask;
  const planningTask = subagentTrigger.active
    ? buildExplicitOrchestrationTask(options.task, subagentTrigger.mode)
    : effectiveTask;

  // Determine strategy: explicit trigger phrase overrides auto-estimation
  let strategy: string;
  let forceOrchestrate = false;
  let forcedMode: 'parallel' | 'sequential' | undefined;

  if (subagentTrigger.active) {
    // User explicitly requested subagents via trigger phrase — force orchestration
    strategy =
      subagentTrigger.mode === 'parallel'
        ? 'orchestrate (parallel)'
        : subagentTrigger.mode === 'sequential'
          ? 'orchestrate (sequential)'
          : 'orchestrate';
    forceOrchestrate = true;
    if (subagentTrigger.mode === 'parallel' || subagentTrigger.mode === 'sequential') {
      forcedMode = subagentTrigger.mode;
    }
  } else {
    // Auto-detect strategy via budget estimation
    const estimate = await session.estimateTaskBudget(options.task);
    strategy = estimate.strategy as string;
  }

  if (forceOrchestrate || strategy === 'orchestrate' || strategy === 'decompose') {
    const planResult = await session.planOrchestratedTurn(planningTask);

    if (planResult.success && planResult.plan.subTasks && planResult.plan.subTasks.length > 0) {
      const handoffManager = new HandoffManager();
      session.setHandoffManager(handoffManager);

      const orchestrationResult = await OrchestrationManager.execute(planResult.plan, session, handoffManager, {
        forcedMode: forceOrchestrate ? forcedMode : undefined,
      });

      orchestrationUsed = true;

      // Convert orchestration result to AgentTurnResult for downstream compatibility
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
        conversation: {
          messages: [],
          inspectionLedger: createInspLedger(),
          latestCompaction: null,
          tokenLedger: createTokenLedger(),
          assemblyStats: null,
        },
        error: orchestrationResult.error,
      };
    } else if (forceOrchestrate) {
      const reason = planResult.success
        ? 'planner returned no sub-tasks'
        : (planResult.error ?? 'planner returned inline');
      const message = `Explicit ${strategy} was requested, but Synax could not generate a valid sub-agent plan (${reason}). Refusing to continue inline because that would ignore the requested execution mode.`;
      wrappedOnEvent({
        type: 'assistant_message',
        timestamp: eventNow(),
        content: message,
      });
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
      // Auto-detection: plan failed or returned inline — fall through to inline execution
      turn = await session.startTurnWithRecovery(options.task);
    }
  } else {
    // Strategy is 'inline' — normal execution
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
      timeoutMs: options.verificationProfile === 'full' ? 120000 : 30000,
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
  if (verification.state === 'failed' && maxRepairAttempts > 0) {
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
      const repair = await repairSession.startTurnWithRecovery(
        `Verification failed. Fix the changed files and make verification pass. Failure output:\n${verification.stderr.slice(0, 1000)}`,
      );
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
          timeoutMs: options.verificationProfile === 'full' ? 120000 : 30000,
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
      if (verification.state === 'passed') break;
    }
  }
  let terminalState = turn.terminalState;
  if (repairedTurn.terminalState === 'completed' && verification.state === 'failed') {
    terminalState = 'failed_verification';
  }
  const finalAnswer = repairedTurn === turn ? turn.finalAnswer : repairedTurn.finalAnswer || turn.finalAnswer;
  const filesRead = unique(turn.conversation.inspectionLedger.getInspectedRanges().map((range) => range.path));
  const afterHead = await gitHead(options.repoRoot);
  const changedByCommit =
    beforeHead && afterHead && beforeHead !== afterHead
      ? await changedFilesBetween(options.repoRoot, beforeHead, afterHead)
      : [];
  const filesChanged = unique([...turn.changedFiles, ...repairedTurn.changedFiles, ...changedByCommit]);
  const finalDirtyTree = await detectDirtyTree(options.repoRoot);
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

  // ─── Close observability session (skip when caller owns lifecycle) ───
  if (!usePreCreated && components.eventStore) {
    components.eventStore.closeSession(components.sessionId, terminalState, {
      steps: turn.steps + (repairedTurn === turn ? 0 : repairedTurn.steps),
      toolCalls: turn.toolCalls.length + (repairedTurn === turn ? 0 : repairedTurn.toolCalls.length),
      changedFiles: filesChanged,
    });
  }

  // Finalize in session-store for /resume discoverability (skip when caller owns lifecycle)
  if (!usePreCreated) {
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
  }

  if (options.recordRunArtifacts !== false && !usePreCreated) {
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
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
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
