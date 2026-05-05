import { loadProjectConfig, normalizeProviderConfig } from '../config/project';
import { createOpenAICompatibleClient } from '../llm/client';
import { runAgentTurn, type AgentActivity, type AgentTerminalState } from './runner';
import { runVerification, type VerificationResult } from './verification';
import { eventNow, type AgentEvent } from './events';

export interface RunTaskOptions {
  repoRoot: string;
  task: string;
  yes?: boolean;
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
    tools: projectConfig.config.tools?.exposed ?? ['read', 'write', 'edit', 'bash', 'git'],
    task: options.task,
  });
  const turn = await runAgentTurn({
    repoRoot: options.repoRoot,
    task: options.task,
    client,
    maxSteps: projectConfig.config.maxModelSteps,
    maxToolCalls: projectConfig.config.maxToolCalls,
    onActivity: options.onActivity,
    onEvent: options.onEvent,
  });

  let verification: VerificationResult = { state: 'skipped', stdout: '', stderr: '' };
  if (turn.changedFiles.length > 0) {
    verification = await runVerification({
      repoRoot: options.repoRoot,
      command: projectConfig.config.verification?.defaultCommand,
    });
  }
  let terminalState = turn.terminalState;
  if (turn.terminalState === 'completed' && verification.state === 'failed') {
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

  return {
    task: options.task,
    terminalState,
    finalAnswer: turn.finalAnswer,
    filesChanged: unique(turn.changedFiles),
    verification,
    steps: turn.steps,
    toolCalls: turn.toolCalls,
    messages: [],
    error: turn.error,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
