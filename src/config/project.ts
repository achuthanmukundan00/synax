import { readFileSync, existsSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { parse as parseToml } from 'toml';

export type ProviderKind = 'openai-compatible';
export type ProviderPreset =
  | 'relay-local'
  | 'relay-cloudflare'
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'custom-openai-compatible';

export interface ProviderConfig {
  preset?: ProviderPreset;
  kind?: ProviderKind;
  baseUrl?: string;
  base_url?: string;
  model?: string;
  apiKey?: string;
  api_key?: string;
  customHeaders?: Record<string, string>;
  custom_headers?: Record<string, string>;
  timeoutSeconds?: number;
  timeout_seconds?: number;
  timeoutMs?: number;
  timeout_ms?: number;
  tool_call_parser?: string;
  toolCallParser?: string;
  api_key_env?: string;
  apiKeyEnv?: string;
}

export interface AgentBudgetConfig {
  contextBudgetTokens?: number;
  context_budget_tokens?: number;
  maxModelSteps?: number;
  max_model_steps?: number;
  maxToolCalls?: number;
  max_tool_calls?: number;
  contextWindowTokens?: number;
  context_window_tokens?: number;
  reservedOutputTokens?: number;
  reserved_output_tokens?: number;
  keepRecentTokens?: number;
  keep_recent_tokens?: number;
  maxSingleReadResultTokens?: number;
  max_single_read_result_tokens?: number;
  maxTotalReadResultTokensPerTurn?: number;
  max_total_read_result_tokens_per_turn?: number;
}

function providerPresetDefaults(preset: ProviderPreset): ProviderConfig {
  switch (preset) {
    case 'relay-cloudflare':
      return {
        preset,
        kind: 'openai-compatible',
        base_url: 'https://ai.watchyourtemper.com/v1',
        model: 'Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf',
        custom_headers: {
          'CF-Access-Client-Id': '$SYNAX_CF_ACCESS_CLIENT_ID',
          'CF-Access-Client-Secret': '$SYNAX_CF_ACCESS_CLIENT_SECRET',
        },
      };
    case 'openai':
      return {
        preset,
        kind: 'openai-compatible',
        base_url: 'https://api.openai.com/v1',
        model: 'gpt-4.1',
        api_key_env: 'OPENAI_API_KEY',
      };
    case 'anthropic':
      return {
        preset,
        kind: 'openai-compatible',
        base_url: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        api_key_env: 'ANTHROPIC_API_KEY',
      };
    case 'openrouter':
      return {
        preset,
        kind: 'openai-compatible',
        base_url: 'https://openrouter.ai/api/v1',
        model: '',
        api_key_env: 'OPENROUTER_API_KEY',
      };
    case 'custom-openai-compatible':
      return { preset, kind: 'openai-compatible', base_url: '', model: '', api_key_env: '' };
    case 'relay-local':
    default:
      return {
        preset: 'relay-local',
        kind: 'openai-compatible',
        base_url: 'http://127.0.0.1:1234/v1',
        model: 'Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf',
        api_key_env: '',
      };
  }
}

export function normalizeProviderConfig(p: ProviderConfig): import('../llm/types').NormalizedProviderConfig {
  const presetDefaults = providerPresetDefaults(p.preset ?? 'relay-local');
  const headersInput = p.custom_headers ?? p.customHeaders ?? presetDefaults.custom_headers;
  const customHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headersInput ?? {})) {
    if (value.startsWith('$')) {
      const envName = value.slice(1);
      const resolved = process.env[envName];
      if (resolved) customHeaders[name] = resolved;
      continue;
    }
    customHeaders[name] = value;
  }
  const apiKeyEnv = p.api_key_env ?? p.apiKeyEnv ?? presetDefaults.api_key_env;
  const apiKey = p.api_key ?? p.apiKey ?? (apiKeyEnv ? process.env[apiKeyEnv] : undefined);
  const kind = p.kind ?? presetDefaults.kind ?? 'openai-compatible';
  const baseUrl = p.base_url ?? p.baseUrl ?? presetDefaults.base_url ?? 'http://127.0.0.1:1234/v1';
  const model = p.model ?? presetDefaults.model ?? '';
  const timeoutMs = p.timeout_ms ?? p.timeoutMs ?? (p.timeout_seconds ?? p.timeoutSeconds ?? 120) * 1000;
  const toolCallParser = p.tool_call_parser ?? p.toolCallParser;
  return { kind, baseUrl, model, toolCallParser, apiKey, customHeaders, timeoutMs };
}

export interface ProjectConfig {
  activeProfile?: string;
  model?: string;
  baseUrl?: string;
  context_budget_tokens?: number;
  contextBudgetTokens?: number;
  maxModelSteps?: number;
  max_model_steps?: number;
  maxToolCalls?: number;
  max_tool_calls?: number;
  contextWindowTokens?: number;
  context_window_tokens?: number;
  reservedOutputTokens?: number;
  reserved_output_tokens?: number;
  keepRecentTokens?: number;
  keep_recent_tokens?: number;
  maxSingleReadResultTokens?: number;
  max_single_read_result_tokens?: number;
  maxTotalReadResultTokensPerTurn?: number;
  max_total_read_result_tokens_per_turn?: number;
  agent?: AgentBudgetConfig;
  subagents?: { enabled?: boolean; mode?: 'sequential' | 'parallel' };
  verification?: { defaultCommand?: string };
  provider?: ProviderConfig;
  tools?: ToolSurfaceConfig;
}

export interface ToolSurfaceConfig {
  exposed?: string[];
  shell?: 'bash' | 'zsh';
  unsafe?: boolean;
  bash?: { enabled?: boolean };
}

export interface ValidationError {
  path: string;
  message: string;
}

export type ConfigSource = 'default' | 'file' | 'explicit';

export interface LoadProjectConfigResult {
  config: ProjectConfig;
  errors: ValidationError[];
  path: string | null;
  source: ConfigSource;
}

const DEFAULTS: ProjectConfig = {
  activeProfile: 'default',
  model: undefined,
  baseUrl: 'http://127.0.0.1:1234/v1',
  contextBudgetTokens: 131072,
  contextWindowTokens: 131072,
  reservedOutputTokens: 8192,
  keepRecentTokens: 20000,
  maxSingleReadResultTokens: 12000,
  maxTotalReadResultTokensPerTurn: 40000,
  maxModelSteps: 64,
  maxToolCalls: 192,
  subagents: { enabled: false, mode: 'sequential' },
  verification: { defaultCommand: undefined },
  provider: {
    preset: 'relay-local',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: undefined,
    apiKey: undefined,
    customHeaders: undefined,
    timeoutSeconds: 120,
  },
  tools: { exposed: ['read', 'write', 'edit', 'bash'], shell: 'zsh', unsafe: false, bash: { enabled: true } },
};

export function discoverConfigPath(baseDir?: string): string | null {
  const dir = baseDir ?? process.cwd();
  if (basename(dir) === '.synax.toml') {
    return existsSync(dir) ? dir : null;
  }
  const candidate = join(dir, '.synax.toml');
  if (existsSync(candidate)) return candidate;
  const parent = join(dir, '..');
  if (parent === dir) return null;
  return discoverConfigPath(parent);
}

export function parseTomlString(raw: string): { config: ProjectConfig; errors: ValidationError[] } {
  try {
    const parsed = parseToml(raw) as Record<string, unknown>;
    const config = configFromParsedToml(parsed);
    return { config, errors: validateConfig(config) };
  } catch (err) {
    return {
      config: {},
      errors: [{ path: 'toml', message: `Failed to parse TOML: ${(err as Error).message}` }],
    };
  }
}

export function generateDefaultConfig(): string {
  return [
    '# Synax project configuration',
    '',
    'baseUrl = "http://127.0.0.1:1234/v1"',
    '',
    '[agent]',
    '# 16000 is minimal/safe, 65536 is normal, 131072 is a high-context local profile.',
    'context_budget_tokens = 131072',
    'max_model_steps = 64',
    'max_tool_calls = 192',
    '',
    '[subagents]',
    'enabled = false',
    'mode = "sequential"',
    '',
    '[verification]',
    'defaultCommand = ""',
    '',
    '[tools]',
    'exposed = ["read", "write", "edit", "bash"]',
    'shell = "zsh"',
    'unsafe = false',
    '',
    '[tools.bash]',
    'enabled = true',
    '',
    '[provider]',
    'kind = "openai-compatible"',
    'base_url = "http://127.0.0.1:1234/v1"',
    'model = ""',
    '',
  ].join('\n');
}

export function writeConfigFile(
  path: string,
  contents = generateDefaultConfig(),
): { success: boolean; error?: string } {
  if (existsSync(path)) {
    return { success: false, error: `Config file already exists: ${path}` };
  }

  try {
    writeFileSync(path, contents, 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export function validateConfig(config: ProjectConfig): ValidationError[] {
  const errors: ValidationError[] = [];
  const allowed = new Set([
    'activeProfile',
    'model',
    'baseUrl',
    'contextBudgetTokens',
    'context_budget_tokens',
    'maxModelSteps',
    'max_model_steps',
    'maxToolCalls',
    'max_tool_calls',
    'contextWindowTokens',
    'context_window_tokens',
    'reservedOutputTokens',
    'reserved_output_tokens',
    'keepRecentTokens',
    'keep_recent_tokens',
    'maxSingleReadResultTokens',
    'max_single_read_result_tokens',
    'maxTotalReadResultTokensPerTurn',
    'max_total_read_result_tokens_per_turn',
    'agent',
    'subagents',
    'verification',
    'provider',
    'tools',
  ]);
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) {
      errors.push({ path: key, message: `Unknown config key: ${key}` });
    }
  }
  if (config.model !== undefined && typeof config.model !== 'string') {
    errors.push({ path: 'model', message: 'model must be a string' });
  }
  if (config.baseUrl !== undefined && typeof config.baseUrl !== 'string') {
    errors.push({ path: 'baseUrl', message: 'baseUrl must be a string' });
  }
  validatePositiveInteger(errors, 'contextBudgetTokens', config.contextBudgetTokens);
  validatePositiveInteger(errors, 'context_budget_tokens', config.context_budget_tokens);
  validatePositiveInteger(errors, 'maxModelSteps', config.maxModelSteps);
  validatePositiveInteger(errors, 'max_model_steps', config.max_model_steps);
  validatePositiveInteger(errors, 'maxToolCalls', config.maxToolCalls);
  validatePositiveInteger(errors, 'max_tool_calls', config.max_tool_calls);
  validatePositiveInteger(errors, 'contextWindowTokens', config.contextWindowTokens);
  validatePositiveInteger(errors, 'context_window_tokens', config.context_window_tokens);
  validatePositiveInteger(errors, 'reservedOutputTokens', config.reservedOutputTokens);
  validatePositiveInteger(errors, 'reserved_output_tokens', config.reserved_output_tokens);
  validatePositiveInteger(errors, 'keepRecentTokens', config.keepRecentTokens);
  validatePositiveInteger(errors, 'keep_recent_tokens', config.keep_recent_tokens);
  validatePositiveInteger(errors, 'maxSingleReadResultTokens', config.maxSingleReadResultTokens);
  validatePositiveInteger(errors, 'max_single_read_result_tokens', config.max_single_read_result_tokens);
  validatePositiveInteger(errors, 'maxTotalReadResultTokensPerTurn', config.maxTotalReadResultTokensPerTurn);
  validatePositiveInteger(
    errors,
    'max_total_read_result_tokens_per_turn',
    config.max_total_read_result_tokens_per_turn,
  );
  if (config.agent !== undefined) {
    if (typeof config.agent !== 'object') {
      errors.push({ path: 'agent', message: 'must be an object' });
    } else {
      validatePositiveInteger(errors, 'agent.contextBudgetTokens', config.agent.contextBudgetTokens);
      validatePositiveInteger(errors, 'agent.context_budget_tokens', config.agent.context_budget_tokens);
      validatePositiveInteger(errors, 'agent.maxModelSteps', config.agent.maxModelSteps);
      validatePositiveInteger(errors, 'agent.max_model_steps', config.agent.max_model_steps);
      validatePositiveInteger(errors, 'agent.maxToolCalls', config.agent.maxToolCalls);
      validatePositiveInteger(errors, 'agent.max_tool_calls', config.agent.max_tool_calls);
      validatePositiveInteger(errors, 'agent.contextWindowTokens', config.agent.contextWindowTokens);
      validatePositiveInteger(errors, 'agent.context_window_tokens', config.agent.context_window_tokens);
      validatePositiveInteger(errors, 'agent.reservedOutputTokens', config.agent.reservedOutputTokens);
      validatePositiveInteger(errors, 'agent.reserved_output_tokens', config.agent.reserved_output_tokens);
      validatePositiveInteger(errors, 'agent.keepRecentTokens', config.agent.keepRecentTokens);
      validatePositiveInteger(errors, 'agent.keep_recent_tokens', config.agent.keep_recent_tokens);
      validatePositiveInteger(errors, 'agent.maxSingleReadResultTokens', config.agent.maxSingleReadResultTokens);
      validatePositiveInteger(
        errors,
        'agent.max_single_read_result_tokens',
        config.agent.max_single_read_result_tokens,
      );
      validatePositiveInteger(
        errors,
        'agent.maxTotalReadResultTokensPerTurn',
        config.agent.maxTotalReadResultTokensPerTurn,
      );
      validatePositiveInteger(
        errors,
        'agent.max_total_read_result_tokens_per_turn',
        config.agent.max_total_read_result_tokens_per_turn,
      );
    }
  }
  if (config.subagents !== undefined) {
    if (typeof config.subagents !== 'object') {
      errors.push({ path: 'subagents', message: 'must be an object' });
    } else {
      if (config.subagents.enabled !== undefined && typeof config.subagents.enabled !== 'boolean') {
        errors.push({ path: 'subagents.enabled', message: 'must be a boolean' });
      }
      if (config.subagents.mode !== undefined && !['sequential', 'parallel'].includes(config.subagents.mode)) {
        errors.push({ path: 'subagents.mode', message: 'must be one of: sequential, parallel' });
      }
    }
  }
  if (config.verification !== undefined) {
    if (typeof config.verification !== 'object') {
      errors.push({ path: 'verification', message: 'must be an object' });
    } else if (
      config.verification.defaultCommand !== undefined &&
      typeof config.verification.defaultCommand !== 'string'
    ) {
      errors.push({ path: 'verification.defaultCommand', message: 'must be a string' });
    }
  }
  if (config.provider !== undefined) {
    if (typeof config.provider !== 'object') {
      errors.push({ path: 'provider', message: 'must be an object' });
    } else {
      const p = config.provider;
      const kind = p.kind;
      if (kind !== undefined && kind !== 'openai-compatible') {
        errors.push({
          path: 'provider.kind',
          message: `unsupported-provider: kind="${kind}" is not supported in v0.1. Use "openai-compatible". Native Anthropic provider support is not available.`,
        });
      }
      const resolvedBaseUrl = p.base_url ?? p.baseUrl;
      if (resolvedBaseUrl !== undefined && typeof resolvedBaseUrl !== 'string') {
        errors.push({ path: 'provider.base_url', message: 'base_url must be a string' });
      }
      if (p.model !== undefined && typeof p.model !== 'string') {
        errors.push({ path: 'provider.model', message: 'must be a string' });
      }
      for (const variantKey of ['customHeaders', 'custom_headers'] as const) {
        if (p[variantKey] !== undefined) {
          if (typeof p[variantKey] !== 'object') {
            errors.push({ path: `provider.${variantKey}`, message: 'must be an object' });
          } else {
            for (const [k, v] of Object.entries(p[variantKey] as Record<string, unknown>)) {
              if (typeof k !== 'string' || typeof v !== 'string') {
                errors.push({
                  path: `provider.${variantKey}['${String(k)}']`,
                  message: 'keys and values must be strings',
                });
              }
            }
          }
        }
      }
      for (const timeoutKey of ['timeoutSeconds', 'timeout_seconds', 'timeoutMs', 'timeout_ms'] as const) {
        if (p[timeoutKey] !== undefined && typeof p[timeoutKey] !== 'number') {
          errors.push({ path: `provider.${timeoutKey}`, message: 'must be a number' });
        }
      }
    }
  }
  if (config.tools !== undefined) {
    if (typeof config.tools !== 'object') {
      errors.push({ path: 'tools', message: 'must be an object' });
    } else if (config.tools.bash !== undefined) {
      if (typeof config.tools.bash !== 'object') {
        errors.push({ path: 'tools.bash', message: 'must be an object' });
      } else if (config.tools.bash.enabled !== undefined && typeof config.tools.bash.enabled !== 'boolean') {
        errors.push({ path: 'tools.bash.enabled', message: 'must be a boolean' });
      }
    }
  }
  validateSameNumericValue(errors, [
    ['contextBudgetTokens', config.contextBudgetTokens],
    ['context_budget_tokens', config.context_budget_tokens],
    ['contextWindowTokens', config.contextWindowTokens],
    ['context_window_tokens', config.context_window_tokens],
  ]);
  if (config.agent !== undefined && typeof config.agent === 'object') {
    validateSameNumericValue(errors, [
      ['agent.contextBudgetTokens', config.agent.contextBudgetTokens],
      ['agent.context_budget_tokens', config.agent.context_budget_tokens],
      ['agent.contextWindowTokens', config.agent.contextWindowTokens],
      ['agent.context_window_tokens', config.agent.context_window_tokens],
    ]);
  }
  return errors;
}

function validatePositiveInteger(errors: ValidationError[], path: string, value: number | undefined): void {
  if (value === undefined) return;
  if (typeof value !== 'number') {
    errors.push({ path, message: 'must be a number' });
  } else if (value <= 0 || !Number.isInteger(value)) {
    errors.push({ path, message: 'must be a positive integer' });
  }
}

function validateSameNumericValue(errors: ValidationError[], entries: Array<[string, number | undefined]>): void {
  const first = entries.find((entry): entry is [string, number] => entry[1] !== undefined);
  if (!first) return;
  const [canonicalPath, canonicalValue] = first;
  for (const [aliasPath, aliasValue] of entries.slice(1)) {
    if (aliasValue !== undefined && aliasValue !== canonicalValue) {
      errors.push({
        path: aliasPath,
        message: `conflicts with ${canonicalPath}; use one value for context budget/window tokens`,
      });
    }
  }
}

function configFromParsedToml(parsed: Record<string, unknown>): ProjectConfig {
  const config: ProjectConfig = {};
  if (parsed.active_profile !== undefined) config.activeProfile = parsed.active_profile as string;
  if (parsed.activeProfile !== undefined) config.activeProfile = parsed.activeProfile as string;
  const agent = parsed.agent && typeof parsed.agent === 'object' ? (parsed.agent as AgentBudgetConfig) : undefined;
  if (parsed.provider && typeof parsed.provider === 'object') {
    config.provider = parsed.provider as ProviderConfig;
  }
  if (parsed.model !== undefined) config.model = parsed.model as string;
  if (parsed.baseUrl !== undefined) config.baseUrl = parsed.baseUrl as string;
  if (parsed.base_url !== undefined) config.baseUrl = parsed.base_url as string;
  if (agent !== undefined) config.agent = agent;
  if (parsed.contextBudgetTokens !== undefined) config.contextBudgetTokens = parsed.contextBudgetTokens as number;
  if (parsed.context_budget_tokens !== undefined) {
    config.context_budget_tokens = parsed.context_budget_tokens as number;
    config.contextBudgetTokens = parsed.context_budget_tokens as number;
  }
  if (agent?.contextBudgetTokens !== undefined) config.contextBudgetTokens = agent.contextBudgetTokens;
  if (agent?.context_budget_tokens !== undefined) config.contextBudgetTokens = agent.context_budget_tokens;
  if (parsed.maxModelSteps !== undefined) config.maxModelSteps = parsed.maxModelSteps as number;
  if (parsed.max_model_steps !== undefined) config.maxModelSteps = parsed.max_model_steps as number;
  if (agent?.maxModelSteps !== undefined) config.maxModelSteps = agent.maxModelSteps;
  if (agent?.max_model_steps !== undefined) config.maxModelSteps = agent.max_model_steps;
  if (parsed.maxToolCalls !== undefined) config.maxToolCalls = parsed.maxToolCalls as number;
  if (parsed.max_tool_calls !== undefined) config.maxToolCalls = parsed.max_tool_calls as number;
  if (agent?.maxToolCalls !== undefined) config.maxToolCalls = agent.maxToolCalls;
  if (agent?.max_tool_calls !== undefined) config.maxToolCalls = agent.max_tool_calls;
  if (parsed.contextWindowTokens !== undefined) config.contextWindowTokens = parsed.contextWindowTokens as number;
  if (parsed.context_window_tokens !== undefined) {
    config.context_window_tokens = parsed.context_window_tokens as number;
    config.contextWindowTokens = parsed.context_window_tokens as number;
  }
  if (agent?.contextWindowTokens !== undefined) config.contextWindowTokens = agent.contextWindowTokens;
  if (agent?.context_window_tokens !== undefined) config.contextWindowTokens = agent.context_window_tokens;
  if (config.contextWindowTokens === undefined && config.contextBudgetTokens !== undefined) {
    config.contextWindowTokens = config.contextBudgetTokens;
  }
  if (config.contextBudgetTokens === undefined && config.contextWindowTokens !== undefined) {
    config.contextBudgetTokens = config.contextWindowTokens;
  }
  if (parsed.reservedOutputTokens !== undefined) config.reservedOutputTokens = parsed.reservedOutputTokens as number;
  if (parsed.reserved_output_tokens !== undefined)
    config.reservedOutputTokens = parsed.reserved_output_tokens as number;
  if (agent?.reservedOutputTokens !== undefined) config.reservedOutputTokens = agent.reservedOutputTokens;
  if (agent?.reserved_output_tokens !== undefined) config.reservedOutputTokens = agent.reserved_output_tokens;
  if (parsed.keepRecentTokens !== undefined) config.keepRecentTokens = parsed.keepRecentTokens as number;
  if (parsed.keep_recent_tokens !== undefined) config.keepRecentTokens = parsed.keep_recent_tokens as number;
  if (agent?.keepRecentTokens !== undefined) config.keepRecentTokens = agent.keepRecentTokens;
  if (agent?.keep_recent_tokens !== undefined) config.keepRecentTokens = agent.keep_recent_tokens;
  if (parsed.maxSingleReadResultTokens !== undefined)
    config.maxSingleReadResultTokens = parsed.maxSingleReadResultTokens as number;
  if (parsed.max_single_read_result_tokens !== undefined)
    config.maxSingleReadResultTokens = parsed.max_single_read_result_tokens as number;
  if (agent?.maxSingleReadResultTokens !== undefined)
    config.maxSingleReadResultTokens = agent.maxSingleReadResultTokens;
  if (agent?.max_single_read_result_tokens !== undefined)
    config.maxSingleReadResultTokens = agent.max_single_read_result_tokens;
  if (parsed.maxTotalReadResultTokensPerTurn !== undefined)
    config.maxTotalReadResultTokensPerTurn = parsed.maxTotalReadResultTokensPerTurn as number;
  if (parsed.max_total_read_result_tokens_per_turn !== undefined)
    config.maxTotalReadResultTokensPerTurn = parsed.max_total_read_result_tokens_per_turn as number;
  if (agent?.maxTotalReadResultTokensPerTurn !== undefined)
    config.maxTotalReadResultTokensPerTurn = agent.maxTotalReadResultTokensPerTurn;
  if (agent?.max_total_read_result_tokens_per_turn !== undefined)
    config.maxTotalReadResultTokensPerTurn = agent.max_total_read_result_tokens_per_turn;
  if (parsed.subagents !== undefined && typeof parsed.subagents === 'object')
    config.subagents = parsed.subagents as { enabled?: boolean; mode?: 'sequential' | 'parallel' };
  if (parsed.verification !== undefined && typeof parsed.verification === 'object') {
    const v = parsed.verification as Record<string, unknown>;
    config.verification = {
      defaultCommand: (v.defaultCommand ?? v.default_command) as string | undefined,
    };
  }
  if (parsed.tools !== undefined && typeof parsed.tools === 'object') config.tools = parsed.tools as ToolSurfaceConfig;
  return config;
}

function applyEnvOverrides(config: ProjectConfig, errors: ValidationError[]): ProjectConfig {
  const overrides: ProjectConfig = {};
  const contextBudgetTokens = readEnvPositiveInteger('SYNAX_CONTEXT_BUDGET_TOKENS', errors);
  const maxModelSteps = readEnvPositiveInteger('SYNAX_MAX_MODEL_STEPS', errors);
  const maxToolCalls = readEnvPositiveInteger('SYNAX_MAX_TOOL_CALLS', errors);
  if (contextBudgetTokens !== undefined) {
    overrides.contextBudgetTokens = contextBudgetTokens;
    overrides.contextWindowTokens = contextBudgetTokens;
  }
  if (maxModelSteps !== undefined) overrides.maxModelSteps = maxModelSteps;
  if (maxToolCalls !== undefined) overrides.maxToolCalls = maxToolCalls;
  return { ...config, ...overrides };
}

function readEnvPositiveInteger(name: string, errors: ValidationError[]): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    errors.push({ path: name, message: 'must be a positive integer' });
    return undefined;
  }
  return value;
}

export function loadProjectConfig(baseDir?: string): LoadProjectConfigResult {
  let config: ProjectConfig = {};
  let path: string | null = null;
  const errors: ValidationError[] = [];
  const userConfigPath = process.env.HOME ? join(process.env.HOME, '.config', 'synax', 'config.toml') : null;
  let userConfig: ProjectConfig = {};
  if (userConfigPath && existsSync(userConfigPath)) {
    try {
      userConfig = configFromParsedToml(parseToml(readFileSync(userConfigPath, 'utf-8')) as Record<string, unknown>);
    } catch {
      userConfig = {};
    }
  }
  const discoveredPath = discoverConfigPath(baseDir);
  if (discoveredPath !== null) {
    path = discoveredPath;
    try {
      const raw = readFileSync(discoveredPath, 'utf-8');
      const parsed = parseToml(raw) as Record<string, unknown>;
      config = configFromParsedToml(parsed);
    } catch (err) {
      errors.push({ path: discoveredPath, message: `Failed to parse TOML: ${(err as Error).message}` });
    }
  }
  const activeProviderPreset = (config.provider?.preset ??
    userConfig.provider?.preset ??
    DEFAULTS.provider?.preset ??
    'relay-local') as ProviderPreset;
  const provider = {
    ...DEFAULTS.provider,
    ...providerPresetDefaults(activeProviderPreset),
    ...userConfig.provider,
    ...config.provider,
    model:
      config.provider?.model ??
      userConfig.provider?.model ??
      config.model ??
      userConfig.model ??
      DEFAULTS.provider?.model,
    baseUrl:
      config.provider?.baseUrl ??
      config.provider?.base_url ??
      userConfig.provider?.baseUrl ??
      userConfig.provider?.base_url ??
      config.baseUrl ??
      userConfig.baseUrl ??
      DEFAULTS.provider?.baseUrl,
  };
  const mergedConfig = applyEnvOverrides(
    {
      ...DEFAULTS,
      ...userConfig,
      ...config,
      provider,
      tools: {
        ...DEFAULTS.tools,
        ...userConfig.tools,
        ...config.tools,
        bash: { ...DEFAULTS.tools?.bash, ...userConfig.tools?.bash, ...config.tools?.bash },
      },
    },
    errors,
  );
  const validationErrors = validateConfig(mergedConfig);
  errors.push(...validationErrors);
  return {
    config: mergedConfig,
    errors,
    path,
    source:
      path === null ? 'default' : basename(path) === '.synax.toml' && dirname(path) !== baseDir ? 'file' : 'explicit',
  };
}

export default loadProjectConfig;
