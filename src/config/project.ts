import { readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { parse as parseToml } from 'toml'

export interface ParseTomlStringResult {
  config: ProjectConfig
  errors: ValidationError[]
}

export interface ProjectConfig {
  model?: string
  baseUrl?: string
  contextBudgetTokens?: number
  subagents?: { enabled?: boolean; mode?: 'sequential' | 'parallel' }
  verification?: { defaultCommand?: string }
  provider?: {
    kind?: 'openai-compatible'
    baseUrl?: string
    model?: string
    apiKey?: string
    customHeaders?: Record<string, string>
    timeoutSeconds?: number
  }
}

export interface ParsedConfig {
  source: 'default' | 'file' | 'explicit'
  config: ProjectConfig
  errors?: ValidationError[]
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
  const allowed = new Set(['model','baseUrl','contextBudgetTokens','subagents','verification','provider'])
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) errors.push({ path: key, message: `Unknown config key: ${key}` })
  }
  if (config.model !== undefined && typeof config.model !== 'string')
    errors.push({ path: 'model', message: 'model must be a string' })
  if (config.baseUrl !== undefined && typeof config.baseUrl !== 'string')
    errors.push({ path: 'baseUrl', message: 'baseUrl must be a string' })
  if (config.contextBudgetTokens !== undefined) {
    if (typeof config.contextBudgetTokens !== 'number')
      errors.push({ path: 'contextBudgetTokens', message: 'must be a number' })
    else if (config.contextBudgetTokens <= 0 || !Number.isInteger(config.contextBudgetTokens))
      errors.push({ path: 'contextBudgetTokens', message: 'must be a positive integer' })
  }
  if (config.subagents !== undefined) {
    if (typeof config.subagents !== 'object')
      errors.push({ path: 'subagents', message: 'must be an object' })
    else {
      if (config.subagents.enabled !== undefined && typeof config.subagents.enabled !== 'boolean')
        errors.push({ path: 'subagents.enabled', message: 'must be a boolean' })
      if (config.subagents.mode !== undefined &&
          !['sequential','parallel'].includes(config.subagents.mode))
        errors.push({ path: 'subagents.mode', message: 'must be one of: sequential, parallel' })
    }
  }
  if (config.verification !== undefined) {
    if (typeof config.verification !== 'object')
      errors.push({ path: 'verification', message: 'must be an object' })
    else if (config.verification.defaultCommand !== undefined &&
             typeof config.verification.defaultCommand !== 'string')
      errors.push({ path: 'verification.defaultCommand', message: 'must be a string' })
  }
  if (config.provider !== undefined) {
    if (typeof config.provider !== 'object')
      errors.push({ path: 'provider', message: 'must be an object' })
    else {
      if (config.provider.kind !== undefined && config.provider.kind !== 'openai-compatible')
        errors.push({ path: 'provider.kind', message: 'must be "openai-compatible"' })
      if (config.provider.baseUrl !== undefined && typeof config.provider.baseUrl !== 'string')
        errors.push({ path: 'provider.baseUrl', message: 'must be a string' })
      if (config.provider.model !== undefined && typeof config.provider.model !== 'string')
        errors.push({ path: 'provider.model', message: 'must be a string' })
      if (config.provider.customHeaders !== undefined) {
        if (typeof config.provider.customHeaders !== 'object')
          errors.push({ path: 'provider.customHeaders', message: 'must be an object' })
        else {
          for (const [k, v] of Object.entries(config.provider.customHeaders)) {
            if (typeof k !== 'string' || typeof v !== 'string')
              errors.push({ path: `provider.customHeaders['${k}']`, message: 'keys and values must be strings' })
          }
        }
      }
      if (config.provider.timeoutSeconds !== undefined) {
        if (typeof config.provider.timeoutSeconds !== 'number')
          errors.push({ path: 'provider.timeoutSeconds', message: 'must be a number' })
        else if (config.provider.timeoutSeconds <= 0)
          errors.push({ path: 'provider.timeoutSeconds', message: 'must be positive' })
      }
    }
  }
  return errors
}

function mergeWithDefaults(parsed: ProjectConfig): ProjectConfig {
  const merged: ProjectConfig = { ...DEFAULTS, ...parsed }
  if (parsed.subagents) merged.subagents = { ...DEFAULTS.subagents!, ...parsed.subagents }
  if (parsed.verification) merged.verification = { ...DEFAULTS.verification!, ...parsed.verification }
  if (parsed.provider) merged.provider = { ...DEFAULTS.provider!, ...parsed.provider }
  return merged
}

export function parseTomlString(tomlString: string): { config: ProjectConfig; errors: ValidationError[] } {
  let raw: unknown
  try {
    raw = parseToml(tomlString)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { config: { ...DEFAULTS }, errors: [{ path: '(root)', message: `TOML parse error: ${msg}` }] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { config: { ...DEFAULTS }, errors: [{ path: '(root)', message: 'TOML root must be an object' }] }
  }
  const parsed: ProjectConfig = {}
  const errors: ValidationError[] = []
  const ak = ['model','baseUrl','contextBudgetTokens','subagents','verification','provider']
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ak.includes(key)) {
      errors.push({ path: key, message: `Unknown config key: ${key}` })
      continue
    }
    if (key === 'model' && value !== undefined) {
      if (typeof value !== 'string') errors.push({ path: 'model', message: 'must be a string' })
      else parsed.model = value
    } else if (key === 'baseUrl' && value !== undefined) {
      if (typeof value !== 'string') errors.push({ path: 'baseUrl', message: 'must be a string' })
      else parsed.baseUrl = value
    } else if (key === 'contextBudgetTokens' && value !== undefined) {
      if (typeof value !== 'number') errors.push({ path: 'contextBudgetTokens', message: 'must be a number' })
      else parsed.contextBudgetTokens = value
    } else if (key === 'subagents' && value !== undefined) {
      if (typeof value !== 'object' || Array.isArray(value))
        errors.push({ path: 'subagents', message: 'must be an object' })
      else if (typeof value === 'object') {
        const sa = value as Record<string, unknown>
        if (sa.enabled !== undefined && typeof sa.enabled !== 'boolean')
          errors.push({ path: 'subagents.enabled', message: 'must be a boolean' })
        if (sa.mode !== undefined && !['sequential','parallel'].includes(sa.mode as string))
          errors.push({ path: 'subagents.mode', message: 'must be sequential or parallel' })
        parsed.subagents = { 
          enabled: (sa.enabled !== undefined && typeof sa.enabled === 'boolean') ? sa.enabled : undefined,
          mode: (['sequential', 'parallel'].includes(sa.mode as string)) ? sa.mode as 'sequential' | 'parallel' : undefined,
        }
        // Filter out undefined values
        if (parsed.subagents?.enabled === undefined && parsed.subagents?.mode === undefined) {
          delete parsed.subagents
        }
      }
    } else if (key === 'verification' && value !== undefined) {
      if (typeof value !== 'object' || Array.isArray(value))
        errors.push({ path: 'verification', message: 'must be an object' })
      else {
        const ver = value as Record<string, unknown>
        if (ver.defaultCommand !== undefined && typeof ver.defaultCommand !== 'string')
          errors.push({ path: 'verification.defaultCommand', message: 'must be a string' })
        parsed.verification = {
          defaultCommand: (ver.defaultCommand !== undefined && typeof ver.defaultCommand === 'string') ? ver.defaultCommand : undefined,
        }
        if (parsed.verification?.defaultCommand === undefined) {
          delete parsed.verification
        }
      }
    } else if (key === 'provider' && value !== undefined) {
      if (typeof value !== 'object' || Array.isArray(value))
        errors.push({ path: 'provider', message: 'must be an object' })
      else {
        const pv = value as Record<string, unknown>
        const parsedProvider: { kind?: 'openai-compatible'; baseUrl?: string; model?: string; apiKey?: string; customHeaders?: Record<string, string>; timeoutSeconds?: number } = {}
        if (pv.kind !== undefined) {
          if (pv.kind !== 'openai-compatible')
            errors.push({ path: 'provider.kind', message: 'must be "openai-compatible"' })
          else parsedProvider.kind = pv.kind
        }
        if (pv.baseUrl !== undefined && typeof pv.baseUrl === 'string') parsedProvider.baseUrl = pv.baseUrl
        else if (pv.baseUrl !== undefined) errors.push({ path: 'provider.baseUrl', message: 'must be a string' })
        if (pv.model !== undefined && typeof pv.model === 'string') parsedProvider.model = pv.model
        else if (pv.model !== undefined) errors.push({ path: 'provider.model', message: 'must be a string' })
        if (pv.apiKey !== undefined && typeof pv.apiKey === 'string') parsedProvider.apiKey = pv.apiKey
        else if (pv.apiKey !== undefined) errors.push({ path: 'provider.apiKey', message: 'must be a string' })
        if (pv.customHeaders !== undefined) {
          if (typeof pv.customHeaders !== 'object' || Array.isArray(pv.customHeaders))
            errors.push({ path: 'provider.customHeaders', message: 'must be an object' })
          else {
            const ch = pv.customHeaders as Record<string, unknown>
            const headers: Record<string, string> = {}
            let valid = true
            for (const [k, v] of Object.entries(ch)) {
              if (typeof v !== 'string') {
                errors.push({ path: `provider.customHeaders['${k}']`, message: 'values must be strings' })
                valid = false
              } else {
                headers[k] = v
              }
            }
            if (valid) parsedProvider.customHeaders = headers
          }
        }
        if (pv.timeoutSeconds !== undefined) {
          if (typeof pv.timeoutSeconds !== 'number')
            errors.push({ path: 'provider.timeoutSeconds', message: 'must be a number' })
          else if (pv.timeoutSeconds <= 0)
            errors.push({ path: 'provider.timeoutSeconds', message: 'must be positive' })
          else parsedProvider.timeoutSeconds = pv.timeoutSeconds
        }
        // Build cleaned provider from parsedProvider
        if (Object.keys(parsedProvider).length > 0) {
          parsed.provider = parsedProvider as {
            kind?: 'openai-compatible'
            baseUrl?: string
            model?: string
            apiKey?: string
            customHeaders?: Record<string, string>
            timeoutSeconds?: number
          }
        }
      }
    }
  }
  const config = mergeWithDefaults(parsed)
  return { config, errors }
}

export interface ConfigFileWriteResult {
  success: boolean
  path?: string
  error?: string
}

export function generateDefaultConfig(): string {
  const defaults: ProjectConfig = {
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
  const keys: (keyof ProjectConfig)[] = [
    'model',
    'baseUrl',
    'contextBudgetTokens',
    'subagents',
    'verification',
    'provider',
  ]
  const lines: string[] = []
  for (const key of keys) {
    const val = defaults[key]
    if (val === undefined) continue
    if (typeof val === 'object') {
      lines.push(`[${key}]`)
      for (const [k, v] of Object.entries(val)) {
        if (v === undefined) continue
        lines.push(`${k} = ${JSON.stringify(v)}`)
      }
    } else {
      lines.push(`${key} = ${JSON.stringify(val)}`)
    }
  }
  return lines.join('\n')
}

export function writeConfigFile(path: string, content?: string): ConfigFileWriteResult {
  if (existsSync(path)) {
    const msg = `Config file already exists: ${path}`
    return { success: false, error: msg }
  }
  const cfg = content ?? generateDefaultConfig()
  writeFileSync(path, cfg, 'utf-8')
  return { success: true, path, error: undefined }
}

export function loadProjectConfig(baseDir?: string): ParsedConfig {
  const path = discoverConfigPath(baseDir)
  if (path) {
    try {
      const tomlString = readFileSync(path, 'utf-8')
      const { config, errors } = parseTomlString(tomlString)
      return { source: 'file', config, errors: errors.length ? errors : undefined }
    } catch {
      return { source: 'default', config: { ...DEFAULTS } }
    }
  }
  return { source: 'default', config: { ...DEFAULTS } }
}

export function parseExplicitConfig(config: ProjectConfig): ParsedConfig {
  const errors = validateConfig(config)
  const merged = mergeWithDefaults(config)
  return { source: 'explicit', config: merged, errors: errors.length ? errors : undefined }
}

