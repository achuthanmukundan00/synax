/**
 * Config loading, merging, and writing for the extended Synax config schema.
 *
 * Handles:
 *  - Global config:   ~/.config/synax/config.toml
 *  - Local config:    <repo>/.synax.toml
 *  - Defaults → global → local merging
 *  - Validation
 *  - Persisting changes
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { parse as parseToml } from 'toml';
import type {
  SynaxConfig,
  EffectiveSynaxConfig,
  ResolvedProviderConfig,
  ResolvedModelConfig,
  ResolvedSkillsConfig,
  ResolvedMcpConfig,
  ResolvedActiveConfig,
  ActiveConfig,
  ProviderConfig,
  ModelConfig,
  ThinkingLevel,
  SkillsConfig,
  McpConfig,
  McpServerConfig,
} from './schema';

// ─── Defaults ──────────────────────────────────────────────

const DEFAULT_MODELS: Record<string, ResolvedModelConfig[]> = {
  'relay-local': [
    {
      id: 'Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf',
      displayName: 'Qwen3.6 35B Local',
      contextWindow: 88000,
      supportsThinking: false,
      thinkingLevels: [],
    },
  ],
};

const DEFAULT_PROVIDERS: Record<string, ResolvedProviderConfig> = {
  'relay-local': {
    id: 'relay-local',
    name: 'Relay Local',
    compatibility: 'openai-compatible',
    enabled: true,
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKeyEnv: undefined,
    headers: {},
    models: DEFAULT_MODELS['relay-local'] ?? [],
  },
};

function defaultActiveConfig(): ResolvedActiveConfig {
  const provider = 'relay-local';
  const models = DEFAULT_PROVIDERS[provider]?.models ?? [];
  return {
    provider,
    model: models[0]?.id ?? '',
    thinking: models[0]?.defaultThinkingLevel ?? 'off',
  };
}

function defaultSkillsConfig(): ResolvedSkillsConfig {
  return { enabled: [], disabled: [] };
}

function defaultMcpConfig(): ResolvedMcpConfig {
  return { servers: {} };
}

function defaultEffectiveConfig(): EffectiveSynaxConfig {
  return {
    active: defaultActiveConfig(),
    providers: { ...DEFAULT_PROVIDERS },
    skills: defaultSkillsConfig(),
    mcp: defaultMcpConfig(),
    coreVisualProfile: undefined,
    source: null,
    errors: [],
  };
}

// ─── Path resolution ───────────────────────────────────────

export function globalConfigPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return join(home, '.config', 'synax', 'config.toml');
}

export function discoverLocalConfigPath(baseDir?: string): string | null {
  const dir = baseDir ?? process.cwd();
  const candidate = join(dir, '.synax.toml');
  if (existsSync(candidate)) return candidate;
  const parent = dirname(dir);
  if (parent === dir) return null;
  if (parent === '/' || parent === '.') return null;
  return discoverLocalConfigPath(parent);
}

// ─── Parsing ───────────────────────────────────────────────

export function parseSynaxToml(raw: string): { config: SynaxConfig; errors: string[] } {
  try {
    const parsed = parseToml(raw) as Record<string, unknown>;
    const config = configFromParsed(parsed);
    const errors = validateSynaxConfig(config);
    return { config, errors };
  } catch (err) {
    return {
      config: {},
      errors: [`Failed to parse TOML: ${(err as Error).message}`],
    };
  }
}

export function parseProviderConfig(raw: Record<string, unknown>): ProviderConfig | null {
  if (typeof raw.id !== 'string') return null;
  const compat = raw.compatibility;
  if (compat !== 'openai-compatible' && compat !== 'anthropic-compatible') return null;

  const rawModels = Array.isArray(raw.models) ? (raw.models as Record<string, unknown>[]) : [];
  const models: ModelConfig[] = rawModels.map((m) => parseModelConfig(m)).filter((m): m is ModelConfig => m !== null);

  const headersRaw = raw.headers;
  const headers: Record<string, string> = {};
  if (headersRaw && typeof headersRaw === 'object' && !Array.isArray(headersRaw)) {
    for (const [k, v] of Object.entries(headersRaw as Record<string, unknown>)) {
      if (typeof v === 'string') headers[k] = v;
    }
  }

  return {
    id: raw.id as string,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    compatibility: compat as ProviderConfig['compatibility'],
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
    baseUrl:
      typeof raw.base_url === 'string' ? raw.base_url : typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined,
    base_url: typeof raw.base_url === 'string' ? raw.base_url : undefined,
    apiKeyEnv:
      typeof raw.api_key_env === 'string'
        ? raw.api_key_env
        : typeof raw.apiKeyEnv === 'string'
          ? raw.apiKeyEnv
          : undefined,
    api_key_env: typeof raw.api_key_env === 'string' ? raw.api_key_env : undefined,
    apiKey: typeof raw.api_key === 'string' ? raw.api_key : typeof raw.apiKey === 'string' ? raw.apiKey : undefined,
    api_key: typeof raw.api_key === 'string' ? raw.api_key : undefined,
    headers,
    models,
  };
}

function parseModelConfig(raw: Record<string, unknown>): ModelConfig | null {
  if (typeof raw.id !== 'string') return null;
  const thinkingLevels = Array.isArray(raw.thinking_levels ?? raw.thinkingLevels)
    ? ((raw.thinking_levels ?? raw.thinkingLevels) as string[]).filter(isThinkingLevel)
    : undefined;

  return {
    id: raw.id as string,
    displayName: (raw.display_name ?? raw.displayName) as string | undefined,
    display_name: (raw.display_name ?? raw.displayName) as string | undefined,
    contextWindow: (raw.context_window ?? raw.contextWindow) as number | undefined,
    context_window: (raw.context_window ?? raw.contextWindow) as number | undefined,
    supportsThinking: (raw.supports_thinking ?? raw.supportsThinking) as boolean | undefined,
    supports_thinking: (raw.supports_thinking ?? raw.supportsThinking) as boolean | undefined,
    thinkingLevels,
    thinking_levels: thinkingLevels,
    defaultThinkingLevel: (raw.default_thinking ?? raw.defaultThinking) as ThinkingLevel | undefined,
    default_thinking: (raw.default_thinking ?? raw.defaultThinking) as ThinkingLevel | undefined,
  };
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return ['off', 'low', 'medium', 'high', 'auto'].includes(value);
}

// ─── Config from parsed TOML ────────────────────────────────

export function configFromParsed(parsed: Record<string, unknown>): SynaxConfig {
  const config: SynaxConfig = {};
  const provider =
    parsed.provider && typeof parsed.provider === 'object' ? (parsed.provider as Record<string, unknown>) : undefined;

  const coreVisualProfile =
    stringValue(parsed.coreVisualProfile) ??
    stringValue(parsed.core_visual_profile) ??
    stringValue(provider?.coreVisualProfile) ??
    stringValue(provider?.core_visual_profile);
  if (coreVisualProfile !== undefined) config.coreVisualProfile = normalizeCoreVisualProfile(coreVisualProfile);

  // Active config
  if (parsed.active && typeof parsed.active === 'object') {
    const active = parsed.active as ActiveConfig;
    config.active = {
      provider: typeof active.provider === 'string' ? active.provider : undefined,
      model: typeof active.model === 'string' ? active.model : undefined,
      thinking: isThinkingLevel(String(active.thinking ?? '')) ? (active.thinking as ThinkingLevel) : undefined,
    };
  }

  // Legacy single provider
  if (parsed.provider && typeof parsed.provider === 'object') {
    config.provider = parsed.provider as Record<string, unknown>;
  }

  // Multi-provider config
  if (parsed.providers && typeof parsed.providers === 'object' && !Array.isArray(parsed.providers)) {
    const providers: Record<string, ProviderConfig> = {};
    for (const [id, raw] of Object.entries(parsed.providers as Record<string, unknown>)) {
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const parsed = parseProviderConfig({ id, ...(raw as Record<string, unknown>) });
        if (parsed) providers[id] = parsed;
      }
    }
    if (Object.keys(providers).length > 0) config.providers = providers;
  }

  // Skills
  if (parsed.skills && typeof parsed.skills === 'object') {
    const skills = parsed.skills as SkillsConfig;
    config.skills = {
      enabled: Array.isArray(skills.enabled)
        ? skills.enabled.filter((s): s is string => typeof s === 'string')
        : undefined,
      disabled: Array.isArray(skills.disabled)
        ? skills.disabled.filter((s): s is string => typeof s === 'string')
        : undefined,
    };
  }

  // MCP
  if (parsed.mcp && typeof parsed.mcp === 'object') {
    const mcp = parsed.mcp as McpConfig;
    if (mcp.servers && typeof mcp.servers === 'object') {
      const servers: Record<string, McpServerConfig> = {};
      for (const [name, raw] of Object.entries(mcp.servers as Record<string, unknown>)) {
        if (raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).command === 'string') {
          const srv = raw as Record<string, unknown>;
          servers[name] = {
            enabled: typeof srv.enabled === 'boolean' ? srv.enabled : true,
            command: srv.command as string,
            args: Array.isArray(srv.args) ? srv.args.filter((a): a is string => typeof a === 'string') : undefined,
            env: srv.env && typeof srv.env === 'object' ? (srv.env as Record<string, string>) : undefined,
          };
        }
      }
      if (Object.keys(servers).length > 0) {
        config.mcp = { servers };
      }
    } else {
      config.mcp = mcp;
    }
  }

  return config;
}

// ─── Validation ─────────────────────────────────────────────

export function validateSynaxConfig(config: SynaxConfig): string[] {
  const errors: string[] = [];

  if (config.active) {
    if (config.active.provider !== undefined && typeof config.active.provider !== 'string') {
      errors.push('active.provider must be a string');
    }
    if (config.active.model !== undefined && typeof config.active.model !== 'string') {
      errors.push('active.model must be a string');
    }
    if (config.active.thinking !== undefined && !isThinkingLevel(config.active.thinking)) {
      errors.push(`active.thinking must be one of: off, low, medium, high, auto`);
    }
  }

  if (config.providers) {
    for (const [id, provider] of Object.entries(config.providers)) {
      if (!provider.baseUrl && !provider.base_url && !DEFAULT_PROVIDERS[id]) {
        errors.push(`providers.${id}: base_url is required for unknown providers`);
      }
      if (!provider.compatibility) {
        errors.push(`providers.${id}: compatibility is required`);
      }
      for (const model of provider.models) {
        if (!model.id) {
          errors.push(`providers.${id}.models: each model requires an id`);
        }
        if (model.thinking_levels && !model.thinking_levels.every(isThinkingLevel)) {
          errors.push(`providers.${id}.models.${model.id}: invalid thinking level`);
        }
      }
    }
  }

  if (config.mcp?.servers) {
    for (const [name, server] of Object.entries(config.mcp.servers)) {
      if (!server.command.trim()) {
        errors.push(`mcp.servers.${name}: command is required`);
      }
    }
  }

  if (config.coreVisualProfile !== undefined && !isCoreVisualProfile(config.coreVisualProfile)) {
    errors.push('coreVisualProfile must be one of: model, default, qwen, openai, claude, deepseek, gemini');
  }

  return errors;
}

// ─── Loading ────────────────────────────────────────────────

export function loadSynaxConfig(baseDir?: string): EffectiveSynaxConfig {
  const configs: Array<{ config: SynaxConfig; source: string | null }> = [];
  const allErrors: string[] = [];

  // 1. Global config
  const globalPath = globalConfigPath();
  if (existsSync(globalPath)) {
    try {
      const raw = readFileSync(globalPath, 'utf-8');
      const parsed = parseSynaxToml(raw);
      allErrors.push(...parsed.errors.map((e) => `global config (${globalPath}): ${e}`));
      configs.push({ config: parsed.config, source: globalPath });
    } catch (err) {
      allErrors.push(`Failed to read global config: ${(err as Error).message}`);
    }
  }

  // 2. Local config
  const localPath = discoverLocalConfigPath(baseDir);
  if (localPath) {
    try {
      const raw = readFileSync(localPath, 'utf-8');
      const parsed = parseSynaxToml(raw);
      allErrors.push(...parsed.errors.map((e) => `local config (${localPath}): ${e}`));
      configs.push({ config: parsed.config, source: localPath });
    } catch (err) {
      allErrors.push(`Failed to read local config: ${(err as Error).message}`);
    }
  }

  // 3. Merge
  const effective = mergeConfigs(defaultEffectiveConfig(), configs);
  effective.errors.push(...allErrors);

  // 4. Resolve active provider/model
  resolveActive(effective);

  return effective;
}

// ─── Merging ────────────────────────────────────────────────

function mergeConfigs(
  base: EffectiveSynaxConfig,
  layers: Array<{ config: SynaxConfig; source: string | null }>,
): EffectiveSynaxConfig {
  const result = { ...base, providers: { ...base.providers } };
  let lastSource: string | null = base.source;

  for (const layer of layers) {
    lastSource = layer.source ?? lastSource;

    // Merge active
    if (layer.config.active) {
      result.active = {
        ...result.active,
        ...(layer.config.active.provider !== undefined ? { provider: layer.config.active.provider } : {}),
        ...(layer.config.active.model !== undefined ? { model: layer.config.active.model } : {}),
        ...(layer.config.active.thinking !== undefined ? { thinking: layer.config.active.thinking } : {}),
      };
    }

    // Merge providers
    if (layer.config.providers) {
      for (const [id, provider] of Object.entries(layer.config.providers)) {
        result.providers[id] = resolveProvider(id, provider, result.providers[id]);
      }
    }

    // Legacy single provider support: if no multi-provider config, use legacy.
    if (layer.config.provider && !layer.config.providers) {
      const legacy = layer.config.provider;
      const providerId = (legacy.preset as string) || (legacy.id as string) || 'custom';
      const model = (legacy.model as string) || '';
      const baseUrl = (legacy.base_url as string) || (legacy.baseUrl as string) || '';
      const existing = result.providers[providerId];
      const legacyProvider: ProviderConfig = {
        id: providerId,
        compatibility: 'openai-compatible',
        enabled: true,
        baseUrl,
        apiKeyEnv: (legacy.api_key_env as string) || (legacy.apiKeyEnv as string) || undefined,
        apiKey: (legacy.api_key as string) || (legacy.apiKey as string) || undefined,
        headers:
          (legacy.custom_headers as Record<string, string>) || (legacy.customHeaders as Record<string, string>) || {},
        models: model ? [{ id: model }] : [],
      };
      result.providers[providerId] = resolveProvider(providerId, legacyProvider, existing);
    }

    // Merge skills
    if (layer.config.skills) {
      const enabled = layer.config.skills.enabled ?? [];
      const disabled = layer.config.skills.disabled ?? [];
      result.skills = {
        enabled: [...new Set([...result.skills.enabled, ...enabled])],
        disabled: [...new Set([...result.skills.disabled, ...disabled])],
      };
    }

    // Merge MCP
    if (layer.config.mcp?.servers) {
      result.mcp = { servers: { ...result.mcp.servers } };
      for (const [name, server] of Object.entries(layer.config.mcp.servers)) {
        const existing = result.mcp.servers[name];
        result.mcp.servers[name] = {
          enabled: server.enabled ?? existing?.enabled ?? true,
          command: server.command || existing?.command || '',
          args: server.args ?? existing?.args ?? [],
          env: { ...existing?.env, ...server.env },
        };
      }
    }

    if (layer.config.coreVisualProfile !== undefined) {
      result.coreVisualProfile = layer.config.coreVisualProfile;
    }
  }

  result.source = lastSource;
  return result;
}

function resolveProvider(id: string, layer: ProviderConfig, existing?: ResolvedProviderConfig): ResolvedProviderConfig {
  const base = existing ?? {
    id,
    name: id,
    compatibility: 'openai-compatible' as const,
    enabled: true,
    baseUrl: '',
    headers: {},
    models: [],
  };

  const models = mergeModels(existing?.models ?? [], layer.models);

  return {
    id,
    name: layer.name ?? base.name,
    compatibility: layer.compatibility ?? base.compatibility,
    enabled: layer.enabled ?? base.enabled,
    baseUrl: layer.baseUrl ?? layer.base_url ?? base.baseUrl,
    apiKeyEnv: layer.apiKeyEnv ?? layer.api_key_env ?? base.apiKeyEnv,
    apiKey: layer.apiKey ?? layer.api_key ?? base.apiKey,
    headers: { ...base.headers, ...layer.headers },
    models,
  };
}

function mergeModels(existing: ResolvedModelConfig[], incoming: ModelConfig[]): ResolvedModelConfig[] {
  const byId = new Map<string, ResolvedModelConfig>();
  for (const m of existing) byId.set(m.id, m);

  for (const m of incoming) {
    const prev = byId.get(m.id);
    byId.set(m.id, {
      id: m.id,
      displayName: m.displayName ?? m.display_name ?? prev?.displayName,
      contextWindow: m.contextWindow ?? m.context_window ?? prev?.contextWindow,
      supportsThinking: m.supportsThinking ?? m.supports_thinking ?? prev?.supportsThinking ?? false,
      thinkingLevels: m.thinkingLevels ?? m.thinking_levels ?? prev?.thinkingLevels ?? [],
      defaultThinkingLevel: m.defaultThinkingLevel ?? m.default_thinking ?? prev?.defaultThinkingLevel,
    });
  }

  return Array.from(byId.values());
}

// ─── Active resolution ──────────────────────────────────────

function resolveActive(effective: EffectiveSynaxConfig): void {
  const providerId = effective.active.provider;
  const provider = providerId ? effective.providers[providerId] : undefined;

  if (!provider || !provider.enabled) {
    // Fall back to first enabled provider
    const first = Object.values(effective.providers).find((p) => p.enabled);
    if (first) {
      effective.active.provider = first.id;
      const firstModel = first.models[0];
      if (firstModel) effective.active.model = firstModel.id;
    }
    return;
  }

  // Validate model exists on provider
  if (effective.active.model) {
    const modelExists = provider.models.some((m) => m.id === effective.active.model);
    if (!modelExists) {
      // Fall back to first model on provider
      const firstModel = provider.models[0];
      effective.active.model = firstModel?.id ?? '';
    }
  } else {
    effective.active.model = provider.models[0]?.id ?? '';
  }

  // Validate thinking level for model
  const activeModel = provider.models.find((m) => m.id === effective.active.model);
  if (activeModel) {
    if (!activeModel.supportsThinking || activeModel.thinkingLevels.length === 0) {
      effective.active.thinking = 'off';
    } else if (effective.active.thinking && !activeModel.thinkingLevels.includes(effective.active.thinking)) {
      effective.active.thinking = activeModel.defaultThinkingLevel ?? activeModel.thinkingLevels[0];
    }
  }
}

// ─── Writing ────────────────────────────────────────────────

export function writeSynaxConfig(
  config: EffectiveSynaxConfig,
  targetPath: string,
): { success: boolean; error?: string } {
  try {
    const toml = serializeEffectiveConfig(config);
    writeFileSync(targetPath, toml, 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export function serializeEffectiveConfig(config: EffectiveSynaxConfig): string {
  const lines: string[] = [];

  if (config.coreVisualProfile) {
    lines.push(`coreVisualProfile = "${escapeTomlString(config.coreVisualProfile)}"`);
    lines.push('');
  }

  // Active
  lines.push('[active]');
  lines.push(`provider = "${escapeTomlString(config.active.provider)}"`);
  lines.push(`model = "${escapeTomlString(config.active.model)}"`);
  lines.push(`thinking = "${config.active.thinking}"`);
  lines.push('');

  // Providers
  for (const [id, provider] of Object.entries(config.providers)) {
    const key = tomlTableKey(id);
    lines.push(`[providers.${key}]`);
    lines.push(`enabled = ${provider.enabled}`);
    lines.push(`name = "${escapeTomlString(provider.name)}"`);
    lines.push(`compatibility = "${provider.compatibility}"`);
    lines.push(`base_url = "${escapeTomlString(provider.baseUrl)}"`);
    if (provider.apiKeyEnv) lines.push(`api_key_env = "${provider.apiKeyEnv}"`);
    if (provider.apiKey) lines.push(`api_key = "••••"`); // never write raw secret

    if (Object.keys(provider.headers).length > 0) {
      lines.push('');
      lines.push(`[providers.${key}.headers]`);
      for (const [k, v] of Object.entries(provider.headers)) {
        lines.push(`"${escapeTomlString(k)}" = "${escapeTomlString(v)}"`);
      }
    }

    for (const model of provider.models) {
      lines.push('');
      lines.push(`[[providers.${key}.models]]`);
      lines.push(`id = "${escapeTomlString(model.id)}"`);
      if (model.displayName) lines.push(`display_name = "${escapeTomlString(model.displayName)}"`);
      if (model.contextWindow) lines.push(`context_window = ${model.contextWindow}`);
      lines.push(`supports_thinking = ${model.supportsThinking}`);
      if (model.thinkingLevels.length > 0) {
        lines.push(`thinking_levels = [${model.thinkingLevels.map((l) => `"${l}"`).join(', ')}]`);
      }
      if (model.defaultThinkingLevel) {
        lines.push(`default_thinking = "${model.defaultThinkingLevel}"`);
      }
    }

    lines.push('');
  }

  // Skills
  if (config.skills.enabled.length > 0 || config.skills.disabled.length > 0) {
    lines.push('[skills]');
    if (config.skills.enabled.length > 0) {
      lines.push(`enabled = [${config.skills.enabled.map((s) => `"${escapeTomlString(s)}"`).join(', ')}]`);
    }
    if (config.skills.disabled.length > 0) {
      lines.push(`disabled = [${config.skills.disabled.map((s) => `"${escapeTomlString(s)}"`).join(', ')}]`);
    }
    lines.push('');
  }

  // MCP
  if (Object.keys(config.mcp.servers).length > 0) {
    for (const [name, server] of Object.entries(config.mcp.servers)) {
      const key = tomlTableKey(name);
      lines.push(`[mcp.servers.${key}]`);
      lines.push(`enabled = ${server.enabled}`);
      lines.push(`command = "${escapeTomlString(server.command)}"`);
      if (server.args.length > 0) {
        lines.push(`args = [${server.args.map((a) => `"${escapeTomlString(a)}"`).join(', ')}]`);
      }
      if (Object.keys(server.env).length > 0) {
        lines.push('');
        lines.push(`[mcp.servers.${key}.env]`);
        for (const [k, v] of Object.entries(server.env)) {
          lines.push(`"${escapeTomlString(k)}" = "${escapeTomlString(v)}"`);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n') + '\n';
}

function escapeTomlString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** Returns true if the key is safe to use as a TOML bare key (unquoted table key). */
function isTomlBareKey(key: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(key) && key.length > 0;
}

/** Returns a safe TOML table key segment: bare if allowed, otherwise quoted. */
function tomlTableKey(key: string): string {
  return isTomlBareKey(key) ? key : `"${escapeTomlString(key)}"`;
}

function isCoreVisualProfile(value: string): boolean {
  return ['model', 'default', 'qwen', 'openai', 'claude', 'deepseek', 'gemini'].includes(value);
}

function normalizeCoreVisualProfile(value: string): string {
  return value.trim().toLowerCase();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// ─── Selective mutation helpers ─────────────────────────────

export function buildConfigUpdate(
  current: EffectiveSynaxConfig,
  updates: Partial<{
    activeProvider: string;
    activeModel: string;
    activeThinking: ThinkingLevel;
    toggleSkill: string;
    toggleMcpServer: string;
  }>,
): EffectiveSynaxConfig {
  const next = {
    ...current,
    active: { ...current.active },
    providers: { ...current.providers },
    skills: { ...current.skills, enabled: [...current.skills.enabled], disabled: [...current.skills.disabled] },
    mcp: { servers: { ...current.mcp.servers } },
  };

  if (updates.activeProvider !== undefined) {
    next.active.provider = updates.activeProvider;
    const provider = next.providers[updates.activeProvider];
    if (provider) {
      next.active.model = provider.models[0]?.id ?? '';
      next.active.thinking = provider.models[0]?.defaultThinkingLevel ?? 'off';
    }
    resolveActive(next);
  }

  if (updates.activeModel !== undefined) {
    next.active.model = updates.activeModel;
    resolveActive(next);
  }

  if (updates.activeThinking !== undefined) {
    next.active.thinking = updates.activeThinking;
  }

  if (updates.toggleSkill !== undefined) {
    const skill = updates.toggleSkill;
    const enabledIdx = next.skills.enabled.indexOf(skill);
    const disabledIdx = next.skills.disabled.indexOf(skill);
    if (enabledIdx >= 0) {
      next.skills.enabled.splice(enabledIdx, 1);
      next.skills.disabled.push(skill);
    } else if (disabledIdx >= 0) {
      next.skills.disabled.splice(disabledIdx, 1);
      next.skills.enabled.push(skill);
    } else {
      next.skills.enabled.push(skill);
    }
  }

  if (updates.toggleMcpServer !== undefined) {
    const server = next.mcp.servers[updates.toggleMcpServer];
    if (server) {
      next.mcp.servers = {
        ...next.mcp.servers,
        [updates.toggleMcpServer]: { ...server, enabled: !server.enabled },
      };
    }
  }

  return next;
}

export function persistConfig(
  config: EffectiveSynaxConfig,
  repoRoot?: string,
): { success: boolean; path: string; error?: string } {
  // Prefer local config if we're in a repo
  const localPath = repoRoot ? discoverLocalConfigPath(repoRoot) : null;
  const targetPath = localPath ?? globalConfigPath();

  // If no config file exists, create the local one
  if (!localPath && repoRoot) {
    const newLocalPath = join(repoRoot, '.synax.toml');
    const result = writeSynaxConfig(config, newLocalPath);
    return { ...result, path: newLocalPath };
  }

  const result = writeSynaxConfig(config, targetPath);
  return { ...result, path: targetPath };
}
