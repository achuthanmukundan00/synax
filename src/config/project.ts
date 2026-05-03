/**
 * Project configuration loading, parsing, and validation.
 *
 * Reads `.synax.toml` from the repository root and validates it
 * against the expected schema.
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parse as parseToml } from 'toml';

export interface ProjectConfig {
  model?: string;
  baseUrl?: string;
  contextBudgetTokens?: number;
  subagents?: {
    enabled?: boolean;
    mode?: 'sequential' | 'parallel';
  };
  verification?: {
    defaultCommand?: string;
  };
}

export interface ParsedConfig {
  source: 'default' | 'file' | 'explicit';
  config: ProjectConfig;
  errors?: ValidationError[];
}

export interface ValidationError {
  path: string;
  message: string;
}

const DEFAULTS: ProjectConfig = {
  model: undefined,
  baseUrl: 'http://127.0.0.1:1234/v1',
  contextBudgetTokens: 16000,
  subagents: {
    enabled: false,
    mode: 'sequential',
  },
  verification: {
    defaultCommand: undefined,
  },
};

const ENUMS: Record<string, string[]> = {
  'subagents.mode': ['sequential', 'parallel'],
};

export function discoverConfigPath(baseDir?: string): string | null {
  const dir = baseDir ?? process.cwd();
  const candidate = join(dir, '.synax.toml');
  if (existsSync(candidate)) {
    return candidate;
  }
  const parent = join(dir, '..');
  if (parent === dir) {
    return null;
  }
  return discoverConfigPath(parent);
}

export function validateConfig(config: ProjectConfig): ValidationError[] {
  const errors: ValidationError[] = [];
  const allowedTopKeys = new Set(Object.keys(DEFAULTS));
  for (const key of Object.keys(config)) {
    if (!allowedTopKeys.has(key)) {
      errors.push({ path: key, message: `Unknown config key: ${key}` });
    }
  }
  if (config.model !== undefined && typeof config.model !== 'string') {
    errors.push({ path: 'model', message: 'model must be a string' });
  }
  if (config.baseUrl !== undefined && typeof config.baseUrl !== 'string') {
    errors.push({ path: 'baseUrl', message: 'baseUrl must be a string' });
  }
  if (config.contextBudgetTokens !== undefined) {
    if (typeof config.contextBudgetTokens !== 'number') {
      errors.push({ path: 'contextBudgetTokens', message: 'contextBudgetTokens must be a number' });
    } else if (
      config.contextBudgetTokens <= 0 ||
      !Number.isInteger(config.contextBudgetTokens)
    ) {
      errors.push({
        path: 'contextBudgetTokens',
        message: 'contextBudgetTokens must be a positive integer',
      });
    }
  }
  if (config.subagents !== undefined) {
    if (typeof config.subagents !== 'object' || config.subagents === null) {
      errors.push({ path: 'subagents', message: 'subagents must be an object' });
    } else {
      if (
        config.subagents.enabled !== undefined &&
        typeof config.subagents.enabled !== 'boolean'
      ) {
        errors.push({ path: 'subagents.enabled', message: 'subagents.enabled must be a boolean' });
      }
      if (config.subagents.mode !== undefined) {
        if (typeof config.subagents.mode !== 'string') {
          errors.push({ path: 'subagents.mode', message: 'subagents.mode must be a string' });
        } else if (
          !ENUMS['subagents.mode']?.includes(config.subagents.mode)
        ) {
          errors.push({
            path: 'subagents.mode',
            message: `subagents.mode must be one of: ${ENUMS['subagents.mode']?.join(', ')}`,
          });
        }
      }
    }
  }
  if (config.verification !== undefined) {
    if (typeof config.verification !== 'object' || config.verification === null) {
      errors.push({ path: 'verification', message: 'verification must be an object' });
    } else if (
      config.verification.defaultCommand !== undefined &&
      typeof config.verification.defaultCommand !== 'string'
    ) {
      errors.push({
        path: 'verification.defaultCommand',
        message: 'verification.defaultCommand must be a string',
      });
    }
  }
  return errors;
}

function mergeWithDefaults(parsed: ProjectConfig): ProjectConfig {
  const merged: ProjectConfig = { ...DEFAULTS, ...parsed };
  if (!merged.subagents) {
    merged.subagents = DEFAULTS.subagents as typeof merged.subagents;
  } else {
    merged.subagents = {
      ...(DEFAULTS.subagents as Record<string, unknown>),
      ...merged.subagents,
    } as typeof merged.subagents;
  }
  if (!merged.verification) {
    merged.verification = DEFAULTS.verification as typeof merged.verification;
  } else {
    merged.verification = {
      ...(DEFAULTS.verification as Record<string, unknown>),
      ...merged.verification,
    } as typeof merged.verification;
  }
  return merged;
}

export function parseTomlString(
  tomlString: string
): { config: ProjectConfig; errors: ValidationError[] } {
  let raw: unknown;
  try {
    raw = parseToml(tomlString);
  } catch {
    return {
      config: { ...DEFAULTS },
      errors: [{ path: '.', message: 'Failed to parse TOML syntax' }],
    };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      config: { ...DEFAULTS },
      errors: [{ path: '.', message: 'Config root must be an object' }],
    };
  }
  const config = raw as ProjectConfig;
  const errors = validateConfig(config);
  return { config, errors };
}

export function loadProjectConfig(
  source: 'default' | 'file' | 'explicit',
  configPath?: string
): ParsedConfig {
  if (source === 'default') {
    return { source: 'default', config: mergeWithDefaults({}), errors: [] };
  }
  const filePath = configPath ?? discoverConfigPath();
  if (!filePath) {
    return { source: 'default', config: mergeWithDefaults({}), errors: [] };
  }
  let rawString: string;
  try {
    rawString = readFileSync(filePath, 'utf-8');
  } catch {
    return {
      source: 'default',
      config: mergeWithDefaults({}),
      errors: [{ path: filePath, message: 'Cannot read config file' }],
    };
  }
  const { config, errors } = parseTomlString(rawString);
  return { source, config: mergeWithDefaults(config), errors };
}

export function generateDefaultConfig(): string {
  return `# Synax project configuration
# See https://synax.dev/docs/config for full options

# Inference provider
model = "${DEFAULTS.model ?? 'qwen3.6-35b-a3b'}"
baseUrl = "${DEFAULTS.baseUrl}"

# Context budget in tokens
contextBudgetTokens = ${DEFAULTS.contextBudgetTokens}

# Subagent configuration
[subagents]
enabled = ${DEFAULTS.subagents?.enabled}
mode = "${DEFAULTS.subagents?.mode}"

# Verification
[verification]
defaultCommand = ""
`;
}

export function writeConfigFile(
  filePath: string,
  content?: string
): { success: boolean; error?: string } {
  const toWrite = content ?? generateDefaultConfig();
  if (existsSync(filePath)) {
    return { success: false, error: `File already exists: ${filePath}` };
  }
  try {
    writeFileSync(filePath, toWrite, 'utf-8');
    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}