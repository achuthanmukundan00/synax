import { spawnSync, execSync } from 'child_process';
import { Command } from 'commander';
import { loadProjectConfig, toProviderFactoryInput, type ProjectConfig } from '../config/project';
import pkg from '../../package.json';
import { createLLMClient } from '../llm/provider-factory';
import type { NormalizedProviderConfig } from '../llm/types';

// ---------------------------------------------------------------------------
// Doctor diagnostic types
// ---------------------------------------------------------------------------

export interface DiagnosticResult {
  check: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  message?: string;
  detail?: string;
}

export interface DoctorFullReport {
  repo: DiagnosticResult;
  config: DiagnosticResult;
  providerReachability: DiagnosticResult;
  modelRequest: DiagnosticResult;
  packageManager: DiagnosticResult;
  configuredCommands: DiagnosticResult;
  contextBudget: DiagnosticResult;
  relayHealth: DiagnosticResult;
}

export type DoctorMode = 'quick' | 'full';

// ---------------------------------------------------------------------------
// Diagnostic helpers
// ---------------------------------------------------------------------------

export function pass(check: string, message?: string, detail?: string): DiagnosticResult {
  return { check, status: 'pass', message, detail };
}

function fail(check: string, message: string, detail?: string): DiagnosticResult {
  return { check, status: 'fail', message, detail };
}

function warn(check: string, message: string, detail?: string): DiagnosticResult {
  return { check, status: 'warn', message, detail };
}

export function failWithDetail(check: string, message: string, detail: string): DiagnosticResult {
  return { check, status: 'fail', message, detail };
}

export function warnWithDetail(check: string, message: string, detail: string): DiagnosticResult {
  return { check, status: 'warn', message, detail };
}

export function skip(check: string, message?: string): DiagnosticResult {
  return { check, status: 'skip', message };
}

// ---------------------------------------------------------------------------
// Git repository check
// ---------------------------------------------------------------------------

export function checkGitRepository(): DiagnosticResult {
  try {
    const result = execSync('git rev-parse --is-inside-work-tree', {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    if (result.trim() === 'true') {
      return pass('git-repository', 'Inside a git repository');
    }
    return warn(
      'git-repository',
      'Not inside a git repository',
      'doctor works best inside a git repository for file operations',
    );
  } catch {
    return warn(
      'git-repository',
      'git not found or not inside a git repository',
      'doctor works best inside a git repository for file operations',
    );
  }
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

export function checkConfig(baseDir?: string): DiagnosticResult {
  const result = loadProjectConfig(baseDir);
  if (result.path) {
    if (result.errors.length > 0) {
      const messages = result.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
      return fail('config', `Config file has validation errors: ${messages}`, result.path);
    }
    return pass('config', `Loaded from ${result.path}`, result.path);
  }
  return warn(
    'config',
    'No .synax.toml found; using defaults',
    'Create .synax.toml with a [provider] section for explicit configuration',
  );
}

// ---------------------------------------------------------------------------
// Provider reachability
// ---------------------------------------------------------------------------

async function checkProviderReachability(
  normalized: NormalizedProviderConfig,
  timeoutMs = 1000,
): Promise<DiagnosticResult> {
  const baseUrl = normalized.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': `synax-doctor/${pkg.version}`,
  };
  if (normalized.apiKey && normalized.apiKey.length > 0) {
    headers.Authorization = `Bearer ${normalized.apiKey}`;
  }
  for (const [key, value] of Object.entries(normalized.customHeaders ?? {})) {
    headers[key] = value;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/models`, { method: 'GET', headers, signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        return pass('provider-reachability', `Provider models endpoint is reachable (HTTP ${res.status})`);
      }
      return warn(
        'provider-reachability',
        `Provider models endpoint returned HTTP ${res.status}`,
        'Model Request is the authoritative end-to-end provider check in full mode',
      );
    } catch (err) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
        return fail('provider-reachability', `Provider models endpoint is unreachable: ${msg}`);
      }
      return fail('provider-reachability', `Provider models endpoint check failed: ${msg}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail('provider-reachability', `Provider reachability check failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Model request check
// ---------------------------------------------------------------------------

async function checkModelRequest(client: import('../agent/runner').AgentClient): Promise<DiagnosticResult> {
  try {
    const start = performance.now();
    const response = await client.chat({
      messages: [
        { role: 'system', content: 'You are a health-check assistant. Reply with exactly: OK' },
        { role: 'user', content: 'Say OK.' },
      ],
      temperature: 0,
      maxTokens: 16,
    });
    const latencyMs = Math.round(performance.now() - start);
    const content = (response.content || '').trim().slice(0, 200);
    if (content.toLowerCase() === 'ok') {
      return pass(
        'model-request',
        `Model responded OK in ${latencyMs}ms`,
        `Model: ${response.model || 'unknown'}, Content: ${content}`,
      );
    }
    return warn(
      'model-request',
      `Model responded but unexpected content: ${content}`,
      `Model: ${response.model || 'unknown'}, Latency: ${latencyMs}ms`,
    );
  } catch (err) {
    const error = err as Error & { type?: string; statusCode?: number; retryable?: boolean; detail?: string };
    const errorType = error.type ?? 'unknown';
    const statusCode = error.statusCode;
    const detail = error.detail ?? error.message ?? String(error);
    const retryable = error.retryable ?? false;
    return fail(
      'model-request',
      `Model request failed (${errorType})`,
      `Type: ${errorType}; Message: ${detail}; Retryable: ${retryable}${statusCode ? `; Status: ${statusCode}` : ''}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Package manager detection
// ---------------------------------------------------------------------------

export function detectPackageManager(): { name: string; version: string } | null {
  const checks = [
    { name: 'pnpm', cmd: 'pnpm', versionFlag: '--version' },
    { name: 'yarn', cmd: 'yarn', versionFlag: '--version' },
    { name: 'npm', cmd: 'npm', versionFlag: '--version' },
    { name: 'bun', cmd: 'bun', versionFlag: '-v' },
  ];
  for (const check of checks) {
    try {
      const output = execSync(`${check.cmd} ${check.versionFlag}`, { stdio: 'pipe', encoding: 'utf-8' });
      const versionMatch = output.trim().match(/v?([\d.]+)/);
      if (versionMatch) {
        return { name: check.name, version: versionMatch[1] };
      }
    } catch {
      // Not available
    }
  }
  return null;
}

export function checkPackageManager(): DiagnosticResult {
  const pm = detectPackageManager();
  if (!pm) {
    return fail('package-manager', 'No supported package manager found', 'Required: npm, yarn, pnpm, or bun');
  }
  return pass('package-manager', `Detected ${pm.name} v${pm.version}`);
}

// ---------------------------------------------------------------------------
// Configured commands check
// ---------------------------------------------------------------------------

export function checkConfiguredCommands(config: ProjectConfig): DiagnosticResult {
  const verification = config.verification;
  if (!verification || !verification.defaultCommand) {
    return warn(
      'configured-commands',
      'No defaultVerificationCommand configured',
      'Set verification.defaultCommand in .synax.toml to enable verification',
    );
  }
  const cmd = verification.defaultCommand;
  const shell = process.env.SHELL ?? '/bin/sh';
  const result = spawnSync(shell, ['-c', cmd], { timeout: 30_000, stdio: 'pipe', encoding: 'utf-8' });
  if (result.status === 0) {
    return pass('configured-commands', `defaultVerificationCommand passed: ${cmd}`);
  }
  const stderr = (result.stderr as string)?.trim().slice(0, 500);
  return fail('configured-commands', `defaultVerificationCommand failed: exit ${result.status}`, `stderr: ${stderr}`);
}

// ---------------------------------------------------------------------------
// Context budget check
// ---------------------------------------------------------------------------

export function checkContextBudget(config: ProjectConfig): DiagnosticResult {
  const budget = config.contextBudgetTokens;
  if (!budget) {
    return warn(
      'context-budget',
      'No contextBudgetTokens configured',
      'Set contextBudgetTokens in .synax.toml to enable budget monitoring',
    );
  }
  if (budget < 4000) {
    return warn(
      'context-budget',
      `contextBudgetTokens is ${budget}, which is below the recommended minimum of 4000`,
      'Low context budgets may cause early truncation during long tasks',
    );
  }
  if (budget > 128000) {
    if (budget <= 131072) {
      return pass(
        'context-budget',
        formatBudgetMessage(config),
        'High-context local profile; verify the loaded llama.cpp server was started with a matching context window',
      );
    }
    return warn(
      'context-budget',
      `contextBudgetTokens is ${budget}, which is above typical local model limits`,
      'Very high budgets may not be usable with local models',
    );
  }
  return pass('context-budget', formatBudgetMessage(config));
}

function formatBudgetMessage(config: ProjectConfig): string {
  return [
    `contextBudgetTokens set to ${config.contextBudgetTokens}`,
    'modelSteps unlimited',
    `maxToolCalls set to ${config.maxToolCalls ?? 'not configured'}`,
  ].join('; ');
}

// ---------------------------------------------------------------------------
// Relay health check (OpenAPI-compatible endpoint probe)
// ---------------------------------------------------------------------------

async function checkRelayHealth(
  baseUrl: string,
  apiKey?: string,
  customHeaders?: Record<string, string>,
  timeoutMs = 1000,
): Promise<DiagnosticResult> {
  const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': `synax-doctor/${pkg.version}`,
  };
  if (apiKey && apiKey.length > 0) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  for (const [key, value] of Object.entries(customHeaders ?? {})) {
    headers[key] = value;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${cleanBaseUrl}/models`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = (await res.json()) as { data?: Array<{ id?: string; object?: string }> };
        const models = data.data?.slice(0, 5).map((m) => m.id) ?? [];
        return pass(
          'relay-health',
          `Provider models endpoint is healthy (found ${data.data?.length || 0} models)`,
          `Models: ${models.join(', ') || 'none listed'}`,
        );
      }
      return warn(
        'relay-health',
        `Provider models endpoint returned HTTP ${res.status}`,
        'Some OpenAI-compatible providers do not expose /models; Model Request is authoritative',
      );
    } catch (err) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : String(err);
      return fail('relay-health', `Provider models endpoint check failed: ${msg}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail('relay-health', `Provider models endpoint check failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Run doctor checks
// ---------------------------------------------------------------------------

async function runQuickDoctor(baseDir?: string): Promise<DoctorFullReport> {
  const result = loadProjectConfig(baseDir);
  const config = result.config;
  const pm = checkPackageManager();
  const repo = checkGitRepository();
  const cfg = checkConfig(baseDir);
  const budget = checkContextBudget(config);
  const commands = checkConfiguredCommands(config);

  const providerReachability: DiagnosticResult = skip('provider-reachability');
  const modelRequest: DiagnosticResult = skip('model-request');
  const relayHealth: DiagnosticResult = skip('relay-health');

  return {
    repo,
    config: cfg,
    providerReachability,
    modelRequest,
    packageManager: pm,
    configuredCommands: commands,
    contextBudget: budget,
    relayHealth,
  };
}

async function runFullDoctor(baseDir?: string): Promise<DoctorFullReport> {
  const report = await runQuickDoctor(baseDir);
  const result = loadProjectConfig(baseDir);
  const config = result.config;

  let factoryResult: ReturnType<typeof createLLMClient>;
  try {
    factoryResult = createLLMClient(toProviderFactoryInput(config));
  } catch (err: unknown) {
    // Provider construction errors (missing API key, unknown provider, etc.)
    // should be reported as doctor diagnostics, not hard crashes.
    if (err instanceof Error && err.name === 'ProviderError') {
      const msg = err.message;
      return {
        ...report,
        providerReachability: fail('provider-reachability', `Provider client creation failed: ${msg}`),
        modelRequest: skip('model-request', 'Skipped because provider client could not be created'),
        relayHealth: fail('relay-health', `Provider health check failed: ${msg}`),
      };
    }
    // Unexpected programmer errors — let them propagate.
    throw err;
  }

  const { client, metadata, normalizedConfig } = factoryResult;

  // Skip full checks for non-OpenAI-compatible providers
  if (result.errors.length > 0 || metadata.protocol !== 'openai-compatible') {
    return report;
  }

  const providerReachability = await checkProviderReachability(normalizedConfig);
  const modelRequest = await checkModelRequest(client);
  const relayHealth = await checkRelayHealth(
    normalizedConfig.baseUrl,
    normalizedConfig.apiKey,
    normalizedConfig.customHeaders,
  );
  return { ...report, providerReachability, modelRequest, relayHealth };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runDoctor(mode: DoctorMode = 'quick', baseDir?: string): Promise<DoctorFullReport> {
  if (mode === 'full') {
    return runFullDoctor(baseDir);
  }
  return runQuickDoctor(baseDir);
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function statusIcon(status: DiagnosticResult['status']): string {
  switch (status) {
    case 'pass':
      return '✓';
    case 'fail':
      return '✗';
    case 'warn':
      return '⚠';
    case 'skip':
      return '-';
  }
}

export function formatReport(report: DoctorFullReport, compact: boolean = false): string {
  const lines: string[] = [];
  lines.push('Synax Doctor Report');
  lines.push('===================');
  lines.push('');

  const checks: Array<{ label: string; result: DiagnosticResult }> = [
    { label: 'Git Repository', result: report.repo },
    { label: 'Config', result: report.config },
    { label: 'Package Manager', result: report.packageManager },
    { label: 'Context Budget', result: report.contextBudget },
    { label: 'Configured Commands', result: report.configuredCommands },
    { label: 'Provider Reachability', result: report.providerReachability },
    { label: 'Model Request', result: report.modelRequest },
    { label: 'Relay Health', result: report.relayHealth },
  ];

  for (const { label, result } of checks) {
    lines.push(`  ${statusIcon(result.status)} ${label}: ${result.message ?? ''}`);
    if (result.detail && !compact) {
      lines.push(`    ${result.detail}`);
    }
  }

  lines.push('');
  const passCount = checks.filter((c) => c.result.status === 'pass').length;
  const failCount = checks.filter((c) => c.result.status === 'fail').length;
  const warnCount = checks.filter((c) => c.result.status === 'warn').length;
  const skipCount = checks.filter((c) => c.result.status === 'skip').length;
  lines.push(`Summary: ${passCount} passed, ${failCount} failed, ${warnCount} warnings, ${skipCount} skipped`);

  if (failCount > 0) {
    lines.push('');
    lines.push('Failures indicate issues that need attention.');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI command handler
// ---------------------------------------------------------------------------

export async function handleDoctorCommand(mode: DoctorMode = 'quick', baseDir?: string): Promise<void> {
  const report = await runDoctor(mode, baseDir);
  const output = formatReport(report);
  console.log(output);

  const failCount = Object.values(report).filter(
    (v) => typeof v === 'object' && 'status' in v && v.status === 'fail',
  ).length;

  void failCount;
}

// ---------------------------------------------------------------------------
// CLI command registration
// ---------------------------------------------------------------------------

export function doctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Run a health check on the project and provider configuration')
    .option('--quick', 'Run only the quick check (default)')
    .option('--full', 'Run all checks including model requests')
    .option('--base-dir <path>', 'Override the project base directory')
    .action(async (opts: { quick?: boolean; full?: boolean; baseDir?: string }) => {
      const mode: DoctorMode = opts.full ? 'full' : 'quick';
      const baseDir = opts.baseDir ?? process.cwd();
      await handleDoctorCommand(mode, baseDir);
    });
}
