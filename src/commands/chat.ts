import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { loadProjectConfig, normalizeProviderConfig, type ProjectConfig } from '../config/project';
import { createOpenAICompatibleClient } from '../llm/client';
import {
  createAgentConversation,
  resetAgentConversation,
  runAgentTurn,
  type AgentConversation,
  type AgentTerminalState,
} from '../agent/runner';
import { runVerification, type VerificationResult } from '../agent/verification';
import { buildProjectProfile, formatTextProfile } from '../config/profile';
import { buildInspectConfigProfile } from './inspect';

export interface ChatSession {
  conversation: AgentConversation;
  handleUserMessage(message: string): Promise<ChatTurnReport>;
  handleSlashCommand(command: string): Promise<SlashCommandReport>;
}

export interface ChatTurnReport {
  terminalState: AgentTerminalState;
  finalAnswer: string;
  changedFiles: string[];
  steps: number;
  error?: string;
}

export interface SlashCommandReport {
  handled: boolean;
  exit?: boolean;
  output: string;
  verification?: VerificationResult;
}

export function createChatSession(options: { repoRoot: string; config: ProjectConfig }): ChatSession {
  const providerConfig = normalizeProviderConfig(options.config.provider ?? {});
  const client = createOpenAICompatibleClient(providerConfig);
  const conversation = createAgentConversation();

  return {
    conversation,
    async handleUserMessage(message: string): Promise<ChatTurnReport> {
      const result = await runAgentTurn({
        repoRoot: options.repoRoot,
        task: message,
        client,
        conversation,
        onActivity(activity) {
          console.log(`[synax] ${activity.kind}: ${activity.message}`);
        },
      });
      return {
        terminalState: result.terminalState,
        finalAnswer: result.finalAnswer,
        changedFiles: result.changedFiles,
        steps: result.steps,
        error: result.error,
      };
    },
    async handleSlashCommand(command: string): Promise<SlashCommandReport> {
      return handleSlashCommand(command, {
        repoRoot: options.repoRoot,
        config: options.config,
        conversation,
      });
    },
  };
}

export function chatCommand(program: Command): void {
  const chat = new Command('chat');
  chat
    .description('Start an interactive Synax agent shell')
    .option('-m, --message <message>', 'Run one chat turn and exit')
    .action(async (options: { message?: string }) => {
      const repoRoot = process.cwd();
      const loaded = loadProjectConfig(repoRoot);
      if (loaded.errors.length > 0) {
        console.error(`[synax] Config error:\n${loaded.errors.map((e) => `${e.path}: ${e.message}`).join('\n')}`);
        process.exitCode = 1;
        return;
      }

      const provider = normalizeProviderConfig(loaded.config.provider ?? {});
      if (!provider.model.trim()) {
        console.error('[synax] Config error: provider.model is required for chat.');
        process.exitCode = 1;
        return;
      }

      const session = createChatSession({ repoRoot, config: loaded.config });
      if (options.message) {
        const report = await session.handleUserMessage(options.message);
        console.log(options.message);
        if (report.finalAnswer) console.log(report.finalAnswer);
        console.log(`[synax] terminal state: ${report.terminalState}`);
        if (report.terminalState !== 'completed') process.exitCode = 1;
        return;
      }

      console.log('[synax] Chat initialized');
      printBanner(repoRoot, provider.model);

      const rl = createInterface({ input, output, terminal: Boolean(output.isTTY) });
      rl.on('SIGINT', () => {
        console.log('\n[synax] exiting');
        rl.close();
      });

      try {
        if (input.isTTY) {
          while (true) {
            const shouldExit = await handleInteractiveLine(await rl.question('synax> '), session);
            if (shouldExit) break;
          }
        } else {
          for await (const line of rl) {
            const shouldExit = await handleInteractiveLine(line, session);
            if (shouldExit) break;
          }
        }
      } finally {
        rl.close();
      }
    });
  program.addCommand(chat);
}

async function handleInteractiveLine(line: string, session: ChatSession): Promise<boolean> {
  const trimmed = line.trim();
  if (!trimmed) return false;

  if (trimmed.startsWith('/')) {
    const report = await session.handleSlashCommand(trimmed);
    if (report.output) console.log(report.output);
    return Boolean(report.exit);
  }

  const report = await session.handleUserMessage(trimmed);
  if (report.finalAnswer) console.log(report.finalAnswer);
  if (report.error) console.log(`[synax] ${report.error}`);
  console.log(`[synax] terminal state: ${report.terminalState}`);
  if (report.changedFiles.length > 0) {
    console.log(`[synax] changed files: ${unique(report.changedFiles).join(', ')}`);
  }
  return false;
}

async function handleSlashCommand(
  rawCommand: string,
  context: { repoRoot: string; config: ProjectConfig; conversation: AgentConversation },
): Promise<SlashCommandReport> {
  const command = rawCommand.trim().toLowerCase();
  if (command === '/exit' || command === '/quit') {
    return { handled: true, exit: true, output: '[synax] bye' };
  }
  if (command === '/help') {
    return { handled: true, output: 'Commands: /help /inspect /verify /clear /status /exit /quit' };
  }
  if (command === '/clear') {
    resetAgentConversation(context.conversation);
    return { handled: true, output: '[synax] conversation cleared' };
  }
  if (command === '/inspect') {
    const profile = buildProjectProfile(context.repoRoot);
    return {
      handled: true,
      output: formatTextProfile({ project: profile, config: buildInspectConfigProfile(context.repoRoot) }),
    };
  }
  if (command === '/status') {
    const profile = buildProjectProfile(context.repoRoot);
    const git = profile.git;
    if (!git) return { handled: true, output: '[synax] git status unavailable' };
    return {
      handled: true,
      output: [`Repo: ${git.root}`, `Branch: ${git.branch}`, `Dirty: ${git.isDirty ? 'yes' : 'no'}`].join('\n'),
    };
  }
  if (command === '/verify') {
    const verification = await runVerification({
      repoRoot: context.repoRoot,
      command: context.config.verification?.defaultCommand,
    });
    return {
      handled: true,
      verification,
      output: formatVerification(verification),
    };
  }
  return { handled: false, output: `[synax] unknown command: ${rawCommand}` };
}

function printBanner(repoRoot: string, model: string): void {
  console.log('Synax v0.2 local agent');
  console.log(`Repo: ${repoRoot}`);
  console.log(`Model: ${model}`);
  console.log('Commands: /help /inspect /verify /clear /status /exit');
  console.log('');
}

function formatVerification(result: VerificationResult): string {
  const lines = [`[synax] verification: ${result.state}`];
  if (result.command) lines.push(`command: ${result.command}`);
  if (result.exitCode !== undefined) lines.push(`exit code: ${result.exitCode}`);
  if (result.stdout.trim()) lines.push(result.stdout.trim());
  if (result.stderr.trim()) lines.push(result.stderr.trim());
  return lines.join('\n');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
