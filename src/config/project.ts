import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { parse as parseToml } from 'toml'

export type ProviderKind = 'openai-compatible'

export interface ProviderConfig {
  kind?: ProviderKind
  baseUrl?: string
  base_url?: string
  model?: string
  apiKey?: string
  api_key?: string
  customHeaders?: Record<string, string>
  custom_headers?: Record<string, string>
  timeoutSeconds?: number
  timeout_seconds?: number
}

export function normalizeProviderConfig(
  p: ProviderConfig,
): import('../llm/types').NormalizedProviderConfig {
  const kind = p.kind ?? 'openai-compatible'
  const baseUrl = p.base_url ?? p.baseUrl ?? 'http://127.0.0.1:1234/v1'
  const model = p.model ?? ''
  const apiKey = p.api_key ?? p.apiKey
  const customHeaders = p.custom_headers ?? p.customHeaders
  const timeoutMs = ((p.timeout_seconds ?? p.timeoutSeconds ?? 120) * 1000)
  return { kind, baseUrl, model, apiKey, customHeaders, timeoutMs }
}

export interface ProjectConfig {
  model?: string
  baseUrl?: string
  contextBudgetTokens?: number
  subagents?: { enabled?: boolean; mode?: 'sequential' | 'parallel' }
  verification?: { defaultCommand?: string }
  provider?: ProviderConfig
}

export interface ValidationError {
  path: string
  message: string
}

const DEFAULTS: ProjectConfig = {
  model: undefined,
  baseUrl: 'http://127.0.0.1:1234/v1',
  contextBudgetTokens: 16000,
  subagents: { enabled: false, mode: 'sequential' },
  verification: { defaultCommand: undefined },
  provider: {
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: undefined,
    apiKey: undefined,
    customHeaders: undefined,
    timeoutSeconds: 120,
  },
}

export function discoverConfigPath(baseDir?: string): string | null {
  const dir = baseDir ?? process.cwd()
  const candidate = join(dir, '.synax.toml')
  if (existsSync(candidate)) return candidate
  const parent = join(dir, '..')
  if (parent === dir) return null
  return discoverConfigPath(parent)
}

export function validateConfig(config: ProjectConfig): ValidationError[] {
  const errors: ValidationError[] = []
  const allowed = new Set([
    'model', 'baseUrl', 'contextBudgetTokens', 'subagents', 'verification', 'provider',
  ])
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) {
      errors.push({ path: key, message: `Unknown config key: ${key}` })
    }
  }
  if (config.model !== undefined && typeof config.model !== 'string') {
    errors.push({ path: 'model', message: 'model must be a string' })
  }
  if (config.baseUrl !== undefined && typeof config.baseUrl !== 'string') {
    errors.push({ path: 'baseUrl', message: 'baseUrl must be a string' })
  }
  if (config.contextBudgetTokens !== undefined) {
    if (typeof config.contextBudgetTokens !== 'number') {
      errors.push({ path: 'contextBudgetTokens', message: 'must be a number' })
    } else if (config.contextBudgetTokens <= 0 || !Number.isInteger(config.contextBudgetTokens)) {
      errors.push({ path: 'contextBudgetTokens', message: 'must be a positive integer' })
    }
  }
  if (config.subagents !== undefined) {
    if (typeof config.subagents !== 'object') {
      errors.push({ path: 'subagents', message: 'must be an object' })
    } else {
      if (config.subagents.enabled !== undefined && typeof config.subagents.enabled !== 'boolean') {
        errors.push({ path: 'subagents.enabled', message: 'must be a boolean' })
      }
      if (config.subagents.mode !== undefined && !['sequential','parallel'].includes(config.subagents.mode)) {
        errors.push({ path: 'subagents.mode', message: 'must be one of: sequential, parallel' })
      }
    }
  }
  if (config.verification !== undefined) {
    if (typeof config.verification !== 'object') {
      errors.push({ path: 'verification', message: 'must be an object' })
    } else if (config.verification.defaultCommand !== undefined && typeof config.verification.defaultCommand !== 'string') {
      errors.push({ path: 'verification.defaultCommand', message: 'must be a string' })
    }
  }
  if (config.provider !== undefined) {
    if (typeof config.provider !== 'object') {
      errors.push({ path: 'provider', message: 'must be an object' })
    } else {
      const p = config.provider
      const kind = p.kind
      if (kind === undefined) {
        errors.push({ path: 'provider.kind', message: 'missing required field: provider.kind is required' })
      } else if (kind !== 'openai-compatible') {
        errors.push({
          path: 'provider.kind',
          message: `unsupported-provider: kind="${kind}" is not supported in v0.1. Use "openai-compatible". Native Anthropic provider support is not available.`,
        })
      }
      const resolvedBaseUrl = p.base_url ?? p.baseUrl
      if (resolvedBaseUrl === undefined) {
        errors.push({ path: 'provider.base_url', message: 'missing required field: provider.base_url is required' })
      } else if (typeof resolvedBaseUrl !== 'string') {
        errors.push({ path: 'provider.base_url', message: 'base_url must be a string' })
      }
      if (p.model !== undefined && typeof p.model !== 'string') {
        errors.push({ path: 'provider.model', message: 'must be a string' })
      }
      for (const variantKey of ['customHeaders', 'custom_headers'] as const) {
        if (p[variantKey] !== undefined) {
          if (typeof p[variantKey] !== 'object') {
            errors.push({ path: `provider.${variantKey}`, message: 'must be an object' })
          } else {
            for (const [k, v] of Object.entries(p[variantKey] as Record<string, unknown>)) {
              if (typeof k !== 'string' || typeof v !== 'string') {
                errors.push({ path: `provider.${variantKey}['${String(k)}']`, message: 'keys and values must be strings' })
              }
            }
          }
        }
      }
      for (const timeoutKey of ['timeoutSeconds', 'timeout_seconds'] as const) {
        if (p[timeoutKey] !== undefined && typeof p[timeoutKey] !== 'number') {
          errors.push({ path: `provider.${timeoutKey}`, message: 'must be a number' })
        }
      }
    }
  }
  return errors
}

export function loadProjectConfig(baseDir?: string): { config: ProjectConfig; errors: ValidationError[]; path: string | null } {
  const config: ProjectConfig = {}
  let path: string | null = null
  const errors: ValidationError[] = []
  const discoveredPath = discoverConfigPath(baseDir)
  if (discoveredPath !== null) {
    path = discoveredPath
    try {
      const raw = readFileSync(discoveredPath, 'utf-8')
      const parsed = parseToml(raw) as Record<string, unknown>
      if (parsed.provider && typeof parsed.provider === 'object') {
        config.provider = parsed.provider as ProviderConfig
      }
      if (parsed.model !== undefined) config.model = parsed.model as string
      if (parsed.baseUrl !== undefined) config.baseUrl = parsed.baseUrl as string
      if (parsed.base_url !== undefined) config.baseUrl = parsed.base_url as string
      if (parsed.contextBudgetTokens !== undefined) config.contextBudgetTokens = parsed.contextBudgetTokens as number
      if (parsed.subagents !== undefined && typeof parsed.subagents === 'object') config.subagents = parsed.subagents as { enabled?: boolean; mode?: 'sequential' | 'parallel' }
      if (parsed.verification !== undefined && typeof parsed.verification === 'object') config.verification = parsed.verification as { defaultCommand?: string }
    } catch (err) {
      errors.push({ path: discoveredPath, message: `Failed to parse TOML: ${(err as Error).message}` })
    }
  }
  const mergedConfig: ProjectConfig = {
    ...DEFAULTS,
    ...config,
    provider: config.provider ?? DEFAULTS.provider,
  }
  const validationErrors = validateConfig(mergedConfig)
  errors.push(...validationErrors)
  return { config: mergedConfig, errors, path }
}

export default loadProjectConfig
