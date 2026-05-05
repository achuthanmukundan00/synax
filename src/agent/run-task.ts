import { loadProjectConfig, normalizeProviderConfig } from '../config/project';
import { createOpenAICompatibleClient } from '../llm/client';
import { buildModelFacingTools, runAgentTurn, type AgentActivity, type AgentTerminalState } from './runner';
import { runVerification, type VerificationResult } from './verification';
import { eventNow, type AgentEvent } from './events';
import { createSafetyCheckpoint, detectDirtyTree, writeRunLog } from './safety';

export interface RunTaskOptions {
  repoRoot: string;
  task: string;
  yes?: boolean;
  verificationProfile?: 'quick' | 'full';
  repairAttempts?: number;
  recordRunArtifacts?: boolean;
  onActivity?: (activity: AgentActivity) => void;
  onEvent?: (event: AgentEvent) => void;
}

export interface RunTaskReport {
  task: string;
  terminalState: AgentTerminalState;
  finalAnswer: string;
  filesChanged: string[];
  verification: VerificationResult;
  steps: number;
  toolCalls: Array<{ name: string; success: boolean; error?: string }>;
  messages: string[];
  error?: string;
}

export async function runAgentTask(options: RunTaskOptions): Promise<RunTaskReport> {
  const projectConfig = loadProjectConfig(options.repoRoot);
  if (projectConfig.errors.length > 0) {
    return {
      task: options.task,
      terminalState: 'blocked',
      finalAnswer: '',
      filesChanged: [],
      verification: { state: 'skipped', stdout: '', stderr: '' },
      steps: 0,
      toolCalls: [],
      messages: projectConfig.errors.map((error) => `${error.path}: ${error.message}`),
      error: 'config validation failed',
    };
  }

  const providerConfig = normalizeProviderConfig(projectConfig.config.provider ?? {});
  if (!providerConfig.model.trim()) {
    return {
      task: options.task,
      terminalState: 'blocked',
      finalAnswer: '',
      filesChanged: [],
      verification: { state: 'skipped', stdout: '', stderr: '' },
      steps: 0,
      toolCalls: [],
      messages: ['provider.model is required for run.'],
      error: 'provider.model is required',
    };
  }

  const client = createOpenAICompatibleClient(providerConfig);
  const dirtyTree = await detectDirtyTree(options.repoRoot);
  const checkpoint = options.recordRunArtifacts === false ? null : await createSafetyCheckpoint(options.repoRoot);
  const tools = buildModelFacingTools({ bashEnabled: projectConfig.config.tools?.bash?.enabled }).map(
    (tool) => tool.name,
  );
  options.onEvent?.({
    type: 'task_started',
    timestamp: eventNow(),
    mode: 'bounded',
    profile: projectConfig.config.activeProfile ?? 'default',
    endpoint: providerConfig.baseUrl,
    model: providerConfig.model,
    contextBudgetTokens: projectConfig.config.contextBudgetTokens ?? 131072,
    maxModelSteps: projectConfig.config.maxModelSteps ?? 32,
    maxToolCalls: projectConfig.config.maxToolCalls ?? 96,
    tools,
    task: options.task,
  });
  const turn = await runAgentTurn({
    repoRoot: options.repoRoot,
    task: options.task,
    client,
    maxSteps: projectConfig.config.maxModelSteps,
    maxToolCalls: projectConfig.config.maxToolCalls,
    tools: { bashEnabled: projectConfig.config.tools?.bash?.enabled },
    onActivity: options.onActivity,
    onEvent: options.onEvent,
    approvePatch: () => (options.yes ? 'accept' : 'reject'),
  });

  let verification: VerificationResult = { state: 'skipped', stdout: '', stderr: '' };
  if (turn.changedFiles.length > 0) {
    verification = await runVerification({
      repoRoot: options.repoRoot,
      command: projectConfig.config.verification?.defaultCommand,
      timeoutMs: options.verificationProfile === 'full' ? 120000 : 30000,
      maxOutputChars: options.verificationProfile === 'full' ? 12000 : 4000,
    });
  }
  let repairedTurn = turn;
  const maxRepairAttempts = options.repairAttempts ?? 1;
  if (verification.state === 'failed' && maxRepairAttempts > 0) {
    for (let attempt = 1; attempt <= maxRepairAttempts; attempt += 1) {
      const repair = await runAgentTurn({
        repoRoot: options.repoRoot,
        task: `Verification failed. Fix the changed files and make verification pass. Failure output:\n${verification.stderr.slice(0, 1000)}`,
        client,
        maxSteps: Math.max(4, Math.floor((projectConfig.config.maxModelSteps ?? 32) / 2)),
        maxToolCalls: Math.max(8, Math.floor((projectConfig.config.maxToolCalls ?? 96) / 2)),
        tools: { bashEnabled: projectConfig.config.tools?.bash?.enabled },
        onActivity: options.onActivity,
        onEvent: options.onEvent,
        approvePatch: () => (options.yes ? 'accept' : 'reject'),
      });
      repairedTurn = repair;
      if (repair.changedFiles.length > 0) {
        verification = await runVerification({
          repoRoot: options.repoRoot,
          command: projectConfig.config.verification?.defaultCommand,
          timeoutMs: options.verificationProfile === 'full' ? 120000 : 30000,
          maxOutputChars: options.verificationProfile === 'full' ? 12000 : 4000,
        });
      }
      if (verification.state === 'passed') break;
    }
  }
  let terminalState = turn.terminalState;
  if (repairedTurn.terminalState === 'completed' && verification.state === 'failed') {
    terminalState = 'failed_verification';
  }
  options.onEvent?.({
    type: 'assistant_message',
    timestamp: eventNow(),
    content: turn.finalAnswer,
  });
  options.onEvent?.({
    type: 'task_finished',
    timestamp: eventNow(),
    status: terminalState,
    toolCalls: turn.toolCalls.length,
    maxToolCalls: projectConfig.config.maxToolCalls ?? 96,
    modelSteps: turn.steps,
    maxModelSteps: projectConfig.config.maxModelSteps ?? 32,
    changedFiles: unique(turn.changedFiles),
    verification:
      verification.state === 'passed'
        ? `${verification.command ?? 'verification'} passed`
        : verification.state === 'failed'
          ? `${verification.command ?? 'verification'} failed`
          : 'not run',
    error: turn.error,
  });
  if (options.recordRunArtifacts !== false) {
    await writeRunLog(options.repoRoot, {
      task: options.task,
      terminalState,
      changedFiles: unique([...turn.changedFiles, ...repairedTurn.changedFiles]),
      verification: verification.state,
      error: turn.error,
    });
  }

  return {
    task: options.task,
    terminalState,
    finalAnswer: turn.finalAnswer,
    filesChanged: unique([...turn.changedFiles, ...repairedTurn.changedFiles]),
    verification,
    steps: turn.steps + (repairedTurn === turn ? 0 : repairedTurn.steps),
    toolCalls: [...turn.toolCalls, ...(repairedTurn === turn ? [] : repairedTurn.toolCalls)],
    messages: [
      ...(dirtyTree.dirty ? ['working tree was dirty before run', ...dirtyTree.summary] : []),
      ...(checkpoint ? [`checkpoint: ${checkpoint.id}`] : []),
    ],
    error: turn.error,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
