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
import { discoverConfigPath, normalizeProviderConfig as normalizeProvider } from '../config/project';
import type { NormalizedProviderConfig } from '../llm/types';

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
  const conversation = createAgentConversation();

  return {
    conversation,
    async handleUserMessage(message: string): Promise<ChatTurnReport> {
      const providerConfig = normalizeProviderConfig(options.config.provider ?? {});
      const client = createOpenAICompatibleClient(providerConfig);
      const result = await runAgentTurn({
        repoRoot: options.repoRoot,
        task: message,
        client,
        conversation,
        maxSteps: options.config.maxModelSteps,
        maxToolCalls: options.config.maxToolCalls,
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
  const trimmedCommand = rawCommand.trim();
  const command = trimmedCommand.toLowerCase();
  if (command === '/exit' || command === '/quit') {
    return { handled: true, exit: true, output: '[synax] bye' };
  }
  if (command === '/help') {
    return {
      handled: true,
      output: 'Commands: /help /settings /tools /budget /test-provider /inspect /verify /clear /status /exit /quit',
    };
  }
  if (command === '/clear') {
    resetAgentConversation(context.conversation);
    return { handled: true, output: '[synax] conversation cleared' };
  }
  if (command === '/settings') {
    return { handled: true, output: renderSettingsPanel(context.repoRoot, context.config) };
  }
  if (command.startsWith('/settings set ')) {
    return { handled: true, output: applySettingsSet(trimmedCommand, context.config) };
  }
  if (command === '/tools') {
    const exposed = context.config.tools?.exposed ?? ['read', 'write', 'edit', 'bash', 'git'];
    return {
      handled: true,
      output: `Tools\n-----\nExposed: ${exposed.join(', ')}\nShell: ${context.config.tools?.shell ?? 'zsh'}\nUnsafe: ${(context.config.tools?.unsafe ?? false) ? 'enabled' : 'disabled'}`,
    };
  }
  if (command === '/budget') {
    return {
      handled: true,
      output: `Budget\n------\nContext: ${context.config.contextBudgetTokens ?? 131072}\nMax model steps: ${context.config.maxModelSteps ?? 32}\nMax tool calls: ${context.config.maxToolCalls ?? 96}`,
    };
  }
  if (command === '/test-provider') {
    return { handled: true, output: await renderProviderTest(context.config) };
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
      output: [
        `Repo: ${git.root}`,
        `Branch: ${git.branch}`,
        `Dirty: ${git.isDirty ? 'yes' : 'no'}`,
        `Context budget tokens: ${context.config.contextBudgetTokens ?? 'not configured'}`,
        `Max model steps: ${context.config.maxModelSteps ?? 'not configured'}`,
        `Max tool calls: ${context.config.maxToolCalls ?? 'not configured'}`,
      ].join('\n'),
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

function applySettingsSet(rawCommand: string, config: ProjectConfig): string {
  const match = rawCommand.match(/^\/settings\s+set\s+(\S+)\s+([\s\S]+)$/i);
  if (!match) {
    return invalidSettingsPath();
  }
  const path = match[1];
  const value = match[2].trim();
  const normalizedPath = path.toLowerCase();
  if (!value) {
    return '[synax] Invalid settings value: value is required';
  }

  config.provider ??= {};
  if (normalizedPath === 'provider.endpoint') {
    config.provider.base_url = value;
    config.provider.baseUrl = value;
    return '[synax] provider.endpoint updated for current session only';
  }
  if (normalizedPath === 'provider.model') {
    config.provider.model = value;
    return '[synax] provider.model updated for current session only';
  }
  if (normalizedPath.startsWith('provider.header.')) {
    const headerName = path.slice('provider.header.'.length);
    if (!headerName.trim()) return invalidSettingsPath();
    config.provider.custom_headers = { ...(config.provider.custom_headers ?? config.provider.customHeaders ?? {}) };
    config.provider.custom_headers[headerName] = value;
    config.provider.customHeaders = config.provider.custom_headers;
    return `[synax] provider.header.${headerName} updated for current session only (value redacted)`;
  }

  const numeric = parsePositiveInteger(value);
  if (normalizedPath === 'agent.context_budget_tokens') {
    if (numeric === null)
      return '[synax] Invalid settings value: agent.context_budget_tokens must be a positive integer';
    config.contextBudgetTokens = numeric;
    return '[synax] agent.context_budget_tokens updated for current session only';
  }
  if (normalizedPath === 'agent.max_model_steps') {
    if (numeric === null) return '[synax] Invalid settings value: agent.max_model_steps must be a positive integer';
    config.maxModelSteps = numeric;
    return '[synax] agent.max_model_steps updated for current session only';
  }
  if (normalizedPath === 'agent.max_tool_calls') {
    if (numeric === null) return '[synax] Invalid settings value: agent.max_tool_calls must be a positive integer';
    config.maxToolCalls = numeric;
    return '[synax] agent.max_tool_calls updated for current session only';
  }

  return invalidSettingsPath();
}

function invalidSettingsPath(): string {
  return [
    '[synax] Invalid settings path.',
    'Examples:',
    '  /settings set provider.endpoint http://127.0.0.1:1234/v1',
    '  /settings set provider.model Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf',
    '  /settings set provider.header.Authorization Bearer <token>',
    '  /settings set agent.context_budget_tokens 16000',
    '  /settings set agent.max_model_steps 32',
    '  /settings set agent.max_tool_calls 96',
  ].join('\n');
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

type ProviderTestStatus = 'ready' | 'degraded' | 'blocked' | 'failed';

interface ProviderProbe {
  status: 'ok' | 'unavailable' | 'auth' | 'error';
  message: string;
  modelFound?: boolean;
}

async function renderProviderTest(config: ProjectConfig): Promise<string> {
  const provider = normalizeProvider(config.provider ?? {});
  if (!provider.baseUrl.trim() || !provider.model.trim()) {
    return formatProviderTest(config, provider, 'blocked', [
      provider.baseUrl.trim() ? '[ok] endpoint configured' : '[blocked] endpoint missing',
      provider.model.trim() ? '[ok] model configured' : '[blocked] model missing',
    ]);
  }

  const models = await probeModels(provider);
  if (models.status === 'auth') {
    return formatProviderTest(config, provider, 'blocked', [`[blocked] models: ${models.message}`]);
  }

  const chat = await probeChat(provider);
  if (chat.status === 'auth') {
    return formatProviderTest(config, provider, 'blocked', [
      formatModelsLine(models, provider.model),
      `[blocked] chat: ${chat.message}`,
    ]);
  }
  if (chat.status !== 'ok') {
    return formatProviderTest(config, provider, 'failed', [
      formatModelsLine(models, provider.model),
      `[failed] chat: ${chat.message}`,
    ]);
  }

  const status: ProviderTestStatus =
    models.status === 'ok' && models.modelFound !== false
      ? 'ready'
      : models.status === 'unavailable'
        ? 'degraded'
        : 'failed';
  return formatProviderTest(config, provider, status, [
    formatModelsLine(models, provider.model),
    `[ok] chat: ${chat.message}`,
  ]);
}

async function probeModels(provider: NormalizedProviderConfig): Promise<ProviderProbe> {
  try {
    const res = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: providerHeaders(provider),
    });
    if (res.status === 401 || res.status === 403) return { status: 'auth', message: `HTTP ${res.status}` };
    if (!res.ok) return { status: 'unavailable', message: `HTTP ${res.status}` };
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    if (!Array.isArray(data.data)) return { status: 'unavailable', message: 'listing not supported' };
    return {
      status: 'ok',
      message: `${data.data.length} models listed`,
      modelFound: data.data.some((model) => model.id === provider.model),
    };
  } catch (error) {
    return { status: 'unavailable', message: errorMessage(error) };
  }
}

async function probeChat(provider: NormalizedProviderConfig): Promise<ProviderProbe> {
  try {
    const res = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { ...providerHeaders(provider), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: 'Reply with exactly: OK' },
          { role: 'user', content: 'OK' },
        ],
        temperature: 0,
        max_tokens: 8,
        stream: false,
      }),
    });
    if (res.status === 401 || res.status === 403) return { status: 'auth', message: `HTTP ${res.status}` };
    if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` };
    return { status: 'ok', message: 'smoke request passed' };
  } catch (error) {
    return { status: 'error', message: errorMessage(error) };
  }
}

function providerHeaders(provider: NormalizedProviderConfig): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'synax-chat/0.3.0' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  for (const [key, value] of Object.entries(provider.customHeaders ?? {})) headers[key] = value;
  return headers;
}

function formatModelsLine(models: ProviderProbe, model: string): string {
  if (models.status === 'ok') {
    return models.modelFound === false
      ? `[failed] models: configured model not listed (${model})`
      : `[ok] models: ${models.message}`;
  }
  return `[warn] models: ${models.message}`;
}

function formatProviderTest(
  config: ProjectConfig,
  provider: NormalizedProviderConfig,
  status: ProviderTestStatus,
  checks: string[],
): string {
  return [
    'Provider Check',
    '--------------',
    `Status:      ${status}`,
    `Profile:     ${config.activeProfile ?? 'default'}`,
    `Endpoint:    ${sanitizeEndpoint(provider.baseUrl)}`,
    `Model:       ${provider.model || '(not set)'}`,
    '',
    'Checks',
    ...checks.map((line) => `  ${line}`),
  ].join('\n');
}

function sanitizeEndpoint(raw: string): string {
  try {
    const url = new URL(raw);
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, url.pathname === '/' ? '/' : '');
  } catch {
    return raw.split('?')[0];
  }
}

function printBanner(repoRoot: string, model: string): void {
  console.log('Synax');
  console.log('-----');
  console.log(`Repo: ${repoRoot}`);
  console.log(`Model: ${model}`);
  console.log('Commands: /help /settings /tools /budget /test-provider /inspect /verify /clear /status /exit');
  console.log('');
}

function renderSettingsPanel(repoRoot: string, config: ProjectConfig): string {
  const provider = normalizeProvider(config.provider ?? {});
  const headers = Object.keys(config.provider?.custom_headers ?? config.provider?.customHeaders ?? {});
  const configPath = discoverConfigPath(repoRoot) ?? '(defaults)';
  const exposed = config.tools?.exposed ?? ['read', 'write', 'edit', 'bash', 'git'];
  return [
    'Settings',
    '--------',
    `Profile:        ${config.activeProfile ?? 'default'}`,
    `Config file:    ${configPath}`,
    '',
    'Provider',
    `  preset:       ${config.provider?.preset ?? 'relay-local'}`,
    `  base_url:     ${provider.baseUrl}`,
    `  model:        ${provider.model || '(not set)'}`,
    `  api_key_env:  ${config.provider?.api_key_env ?? config.provider?.apiKeyEnv ?? 'not set'}`,
    `  headers:      ${headers.length} configured`,
    '',
    'Agent',
    `  context:      ${config.contextBudgetTokens ?? 131072}`,
    `  max_steps:    ${config.maxModelSteps ?? 32}`,
    `  max_tools:    ${config.maxToolCalls ?? 96}`,
    '',
    'Tools',
    `  exposed:      ${exposed.join(', ')}`,
    `  shell:        ${config.tools?.shell ?? 'zsh'}`,
    `  unsafe:       ${(config.tools?.unsafe ?? false) ? 'enabled' : 'disabled'}`,
    '',
    'Verification',
    `  command:      ${config.verification?.defaultCommand?.trim() || '(not set)'}`,
  ].join('\n');
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
