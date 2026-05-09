import { loadProjectConfig, toProviderFactoryInput } from '../config/project';
import { loadSynaxConfig } from '../config/load-config';
import { loadSkills } from './skills';
import { createLLMClient } from '../llm/provider-factory';
import { buildModelFacingTools, runAgentTurn, type AgentActivity, type AgentTerminalState } from './runner';
import { runVerification, type VerificationResult } from './verification';
import { eventNow, type AgentEvent } from './events';
import { createSafetyCheckpoint, detectDirtyTree, writeRunLog } from './safety';
import { normalizeRunMode, type RunMode } from './task-policy';
import { type Logger } from '../logging/index.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createEventStore } from '../store/EventStore';
import { SpanTracer } from '../telemetry/SpanTracer';

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
  checkpoint?: { id: string; statusPath: string; diffPath: string } | null;
  error?: string;
}

const execFileAsync = promisify(execFile);

export async function runAgentTask(options: RunTaskOptions): Promise<RunTaskReport> {
  const projectConfig = loadProjectConfig(options.repoRoot);
  const mode = normalizeRunMode(options.mode);
  if (projectConfig.errors.length > 0) {
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
      messages: projectConfig.errors.map((error) => `${error.path}: ${error.message}`),
      contextBudgetTokens: projectConfig.config.contextBudgetTokens ?? 131072,
      maxModelSteps: projectConfig.config.maxModelSteps ?? 64,
      maxToolCalls: projectConfig.config.maxToolCalls ?? 192,
      error: 'config validation failed',
    };
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
      messages: [(err as Error).message],
      contextBudgetTokens: projectConfig.config.contextBudgetTokens ?? 131072,
      maxModelSteps: projectConfig.config.maxModelSteps ?? 64,
      maxToolCalls: projectConfig.config.maxToolCalls ?? 192,
      error: (err as Error).message,
    };
  }

  const { client, metadata } = factoryResult;

  // ─── Observability: event store + span tracer ───
  const sessionId = generateSessionId();
  const eventStore = createEventStore();
  const tracer = new SpanTracer({ sessionId, eventStore });

  if (eventStore) {
    eventStore.startSession({
      id: sessionId,
      repoRoot: options.repoRoot,
      mode,
      model: metadata.modelId,
      createdAt: new Date().toISOString(),
    });
  }

  // Wrap user's onEvent to also write to the event store
  const userOnEvent = options.onEvent;
  let eventSequence = 0;
  const wrappedOnEvent = (event: AgentEvent): void => {
    userOnEvent?.(event);
    if (eventStore) {
      eventSequence += 1;
      eventStore.appendEvent(sessionId, event, eventSequence);
    }
  };

  const dirtyTree = await detectDirtyTree(options.repoRoot);
  const beforeHead = await gitHead(options.repoRoot);
  let checkpoint: { id: string; statusPath: string; diffPath: string } | null = null;
  const tools = buildModelFacingTools({ bashEnabled: projectConfig.config.tools?.bash?.enabled, mode }).map(
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
    contextWindowTokens: projectConfig.config.contextWindowTokens ?? projectConfig.config.contextBudgetTokens ?? 131072,
    maxModelSteps: projectConfig.config.maxModelSteps ?? 64,
    maxToolCalls: projectConfig.config.maxToolCalls ?? 192,
    tools,
    task: options.task,
    inputPricePer1MTokens: metadata.inputPricePer1MTokens,
    outputPricePer1MTokens: metadata.outputPricePer1MTokens,
  });
  // Load configured skills for injection into agent context.
  let skillMessages: string[] | undefined;
  if (effectiveConfig?.skills.enabled.length) {
    const result = loadSkills(effectiveConfig.skills, options.repoRoot);
    skillMessages = result.systemMessages;
  }

  const turn = await runAgentTurn({
    repoRoot: options.repoRoot,
    task: options.task,
    client,
    mode,
    maxSteps: projectConfig.config.maxModelSteps,
    maxToolCalls: projectConfig.config.maxToolCalls,
    tools: { bashEnabled: projectConfig.config.tools?.bash?.enabled, mode },
    skillMessages,
    logger: options.logger,
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
    tracer,
    onBudget(snapshot) {
      wrappedOnEvent({
        type: 'context_budget_updated',
        timestamp: eventNow(),
        estimatedInputTokens: snapshot.estimatedInputTokens,
        inputLimit: snapshot.inputLimit,
        contextWindowTokens: snapshot.contextWindowTokens,
        reservedOutputTokens: snapshot.reservedOutputTokens,
        step: snapshot.step,
      });
    },
    approvePatch: () => (options.yes ? 'accept' : 'reject'),
    ensureCheckpoint: async () => {
      if (options.recordRunArtifacts === false) return null;
      if (checkpoint) return checkpoint;
      checkpoint = await createSafetyCheckpoint(options.repoRoot);
      return checkpoint;
    },
  });
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
      const repair = await runAgentTurn({
        repoRoot: options.repoRoot,
        task: `Verification failed. Fix the changed files and make verification pass. Failure output:\n${verification.stderr.slice(0, 1000)}`,
        client,
        mode,
        maxSteps: Math.max(4, Math.floor((projectConfig.config.maxModelSteps ?? 64) / 2)),
        maxToolCalls: Math.max(8, Math.floor((projectConfig.config.maxToolCalls ?? 192) / 2)),
        tools: { bashEnabled: projectConfig.config.tools?.bash?.enabled, mode },
        skillMessages,
        logger: options.logger,
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
  wrappedOnEvent({
    type: 'assistant_message',
    timestamp: eventNow(),
    content: finalAnswer,
  });
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

  // ─── Close observability session ───
  if (eventStore) {
    eventStore.closeSession(sessionId, terminalState, {
      steps: turn.steps + (repairedTurn === turn ? 0 : repairedTurn.steps),
      toolCalls: turn.toolCalls.length + (repairedTurn === turn ? 0 : repairedTurn.toolCalls.length),
      changedFiles: filesChanged,
    });
  }

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
      ...(dirtyTree.dirty ? ['working tree was dirty before run', ...dirtyTree.summary] : []),
      ...(checkpointRecord ? [`checkpoint: ${checkpointRecord.id}`] : []),
    ],
    contextBudgetTokens: projectConfig.config.contextBudgetTokens ?? 131072,
    maxModelSteps: projectConfig.config.maxModelSteps ?? 64,
    maxToolCalls: projectConfig.config.maxToolCalls ?? 192,
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

function generateSessionId(): string {
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  const dd = now.getDate().toString().padStart(2, '0');
  const hh = now.getHours().toString().padStart(2, '0');
  const min = now.getMinutes().toString().padStart(2, '0');
  const ss = now.getSeconds().toString().padStart(2, '0');
  const ms = now.getMilliseconds().toString().padStart(3, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${yyyy}${mm}${dd}${hh}${min}${ss}${ms}-${rand}`;
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
