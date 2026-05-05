import { loadProjectConfig, normalizeProviderConfig } from '../config/project';
import { createOpenAICompatibleClient } from '../llm/client';
import { runAgentTurn, type AgentActivity, type AgentTerminalState } from './runner';
import { runVerification, type VerificationResult } from './verification';

export interface RunTaskOptions {
  repoRoot: string;
  task: string;
  yes?: boolean;
  onActivity?: (activity: AgentActivity) => void;
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
      terminalState: 'failedValidation',
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
      terminalState: 'failedValidation',
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
  const turn = await runAgentTurn({
    repoRoot: options.repoRoot,
    task: options.task,
    client,
    maxSteps: projectConfig.config.maxModelSteps,
    maxToolCalls: projectConfig.config.maxToolCalls,
    onActivity: options.onActivity,
  });

  let verification = await runVerification({
    repoRoot: options.repoRoot,
    command: projectConfig.config.verification?.defaultCommand,
  });
  let terminalState = turn.terminalState;
  if (turn.terminalState === 'completed' && verification.state === 'failed') {
    terminalState = 'failedVerification';
  }

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
