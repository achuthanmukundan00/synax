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
  TuiConfig,
  ResolvedTuiConfig,
} from './schema';

// ─── Defaults ──────────────────────────────────────────────

const DEFAULT_MODELS: Record<string, ResolvedModelConfig[]> = {
  relay: [
    {
      id: 'Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf',
      displayName: 'Qwen3.6 35B',
      contextWindow: 131072,
      supportsThinking: false,
      thinkingLevels: [],
    },
  ],
  deepseek: [
    {
      id: 'deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
      contextWindow: 1_000_000,
      supportsThinking: true,
      thinkingLevels: ['off', 'high', 'xhigh'],
      defaultThinkingLevel: 'high',
    },
    {
      id: 'deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      contextWindow: 1_000_000,
      supportsThinking: false,
      thinkingLevels: [],
    },
  ],
  openai: [
    {
      id: 'gpt-4o',
      displayName: 'GPT-4o',
      contextWindow: 128_000,
      supportsThinking: false,
      thinkingLevels: [],
    },
    {
      id: 'o3-mini',
      displayName: 'o3-mini',
      contextWindow: 200_000,
      supportsThinking: true,
      thinkingLevels: ['off', 'low', 'medium', 'high'],
      defaultThinkingLevel: 'medium',
    },
  ],
  anthropic: [
    {
      id: 'frontier-sonnet-4-20250514',
      displayName: 'Frontier Sonnet 4',
      contextWindow: 200_000,
      supportsThinking: true,
      thinkingLevels: ['off', 'low', 'medium', 'high'],
      defaultThinkingLevel: 'off',
    },
    {
      id: 'frontier-3-5-haiku-20241022',
      displayName: 'Frontier 3.5 Haiku',
      contextWindow: 200_000,
      supportsThinking: false,
      thinkingLevels: [],
    },
  ],
};

const DEFAULT_PROVIDERS: Record<string, ResolvedProviderConfig> = {
  relay: {
    id: 'relay',
    name: 'Relay',
    compatibility: 'openai-compatible',
    enabled: true,
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKeyEnv: undefined,
    headers: {},
    models: DEFAULT_MODELS.relay ?? [],
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    compatibility: 'openai-compatible',
    enabled: false,
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    headers: {},
    models: DEFAULT_MODELS.deepseek ?? [],
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    compatibility: 'openai-compatible',
    enabled: false,
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    headers: {},
    models: DEFAULT_MODELS.openai ?? [],
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    compatibility: 'anthropic-compatible',
    enabled: false,
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    headers: {},
    models: DEFAULT_MODELS.anthropic ?? [],
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    compatibility: 'openai-compatible',
    enabled: false,
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    headers: {
      'HTTP-Referer': 'https://github.com/achuthanmukundan00/synax',
      'X-Title': 'Synax',
    },
    models: [
      {
        id: 'openrouter/auto',
        displayName: 'OpenRouter (auto)',
        contextWindow: 64000,
        supportsThinking: false,
        thinkingLevels: [],
      },
    ],
  },
};

function defaultActiveConfig(): ResolvedActiveConfig {
  const provider = 'relay';
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

function defaultTuiConfig(): ResolvedTuiConfig {
  return { mouse: false, alternateScreen: true, cmuxMode: false };
}

function defaultEffectiveConfig(): EffectiveSynaxConfig {
  return {
    active: defaultActiveConfig(),
    providers: { ...DEFAULT_PROVIDERS },
    skills: defaultSkillsConfig(),
    mcp: defaultMcpConfig(),
    tui: defaultTuiConfig(),
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

function canonicalProviderId(id: string): string {
  return id === 'relay-local' ? 'relay' : id;
}

export function parseProviderConfig(raw: Record<string, unknown>): ProviderConfig | null {
  if (typeof raw.id !== 'string') return null;
  const compat = raw.compatibility ?? 'openai-compatible';
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
  const contextWindow = parseContextWindow(raw);

  const maxOutputTokens = parsePositiveInteger(raw.max_output_tokens ?? raw.maxOutputTokens);

  return {
    id: raw.id as string,
    displayName: (raw.display_name ?? raw.displayName) as string | undefined,
    display_name: (raw.display_name ?? raw.displayName) as string | undefined,
    contextWindow,
    context_window: contextWindow,
    supportsThinking: (raw.supports_thinking ?? raw.supportsThinking) as boolean | undefined,
    supports_thinking: (raw.supports_thinking ?? raw.supportsThinking) as boolean | undefined,
    thinkingLevels,
    thinking_levels: thinkingLevels,
    defaultThinkingLevel: (raw.default_thinking ?? raw.defaultThinking) as ThinkingLevel | undefined,
    default_thinking: (raw.default_thinking ?? raw.defaultThinking) as ThinkingLevel | undefined,
    maxOutputTokens,
    max_output_tokens: maxOutputTokens,
  };
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return ['off', 'low', 'medium', 'high', 'xhigh', 'auto'].includes(value);
}

function parseContextWindow(raw: Record<string, unknown>): number | undefined {
  const candidates = [
    raw.context_window,
    raw.contextWindow,
    raw.context_length,
    raw.contextLength,
    raw.max_context_length,
    raw.maxContextLength,
    raw.max_context_tokens,
    raw.maxContextTokens,
    raw.max_input_tokens,
    raw.maxInputTokens,
  ];
  for (const candidate of candidates) {
    const parsed = parsePositiveInteger(candidate);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    const integer = Math.floor(value);
    return integer > 0 ? integer : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const compact = trimmed.replace(/,/g, '');
    const suffixMatch = /^(\d+(?:\.\d+)?)([kKmMgG])$/.exec(compact);
    if (suffixMatch) {
      const base = Number(suffixMatch[1]);
      if (!Number.isFinite(base)) return undefined;
      const multiplier = suffixMatch[2].toLowerCase() === 'k' ? 1_000 : 1_000_000;
      const expanded = Math.floor(base * multiplier);
      return expanded > 0 ? expanded : undefined;
    }
    if (!/^\d+$/.test(compact)) return undefined;
    const parsed = Number(compact);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
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
    const rawThinking = String(active.thinking ?? '');
    config.active = {
      provider: typeof active.provider === 'string' ? canonicalProviderId(active.provider) : undefined,
      model: typeof active.model === 'string' ? active.model : undefined,
      thinking: isThinkingLevel(rawThinking) ? (rawThinking as ThinkingLevel) : undefined,
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
        const providerId = canonicalProviderId(id);
        const parsed = parseProviderConfig({ id: providerId, ...(raw as Record<string, unknown>) });
        if (parsed) providers[providerId] = parsed;
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

  // TUI
  if (parsed.tui && typeof parsed.tui === 'object' && !Array.isArray(parsed.tui)) {
    const raw = parsed.tui as Record<string, unknown>;
    const tui: TuiConfig = {};
    if (typeof raw.mouse === 'boolean') tui.mouse = raw.mouse;
    if (typeof raw.alternate_screen === 'boolean') tui.alternateScreen = raw.alternate_screen;
    if (typeof raw.alternateScreen === 'boolean') tui.alternateScreen = raw.alternateScreen;
    if (typeof raw.cmux_mode === 'boolean') tui.cmuxMode = raw.cmux_mode;
    if (typeof raw.cmuxMode === 'boolean') tui.cmuxMode = raw.cmuxMode;
    config.tui = tui;
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
      errors.push(`active.thinking must be one of: off, low, medium, high, xhigh, auto`);
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
        for (const tk of ['maxOutputTokens', 'max_output_tokens'] as const) {
          const val = model[tk];
          if (val !== undefined && (typeof val !== 'number' || !Number.isInteger(val) || val <= 0)) {
            errors.push(`providers.${id}.models.${model.id}: max_output_tokens must be a positive integer`);
            break;
          }
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
    errors.push('coreVisualProfile must be one of: model, default, qwen, openai, frontier, deepseek, gemini');
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
    //
    // IMPORTANT: do NOT overwrite the active provider when the legacy block
    // has no meaningful model AND no explicit preset — that's the auto-generated
    // scaffold (generateDefaultConfig emits model = "" and no preset), not a
    // deliberate override. Overwriting would clobber a [active] selection from
    // the global multi-provider config and cause resolveActive to fall back to
    // the first queryable default (relay), producing a confusing "model selected
    // but network error" dead-end on startup.
    if (layer.config.provider && !layer.config.providers) {
      const legacy = layer.config.provider;
      const preset = (legacy.preset as string) || (legacy.id as string);
      const providerId = canonicalProviderId(preset || 'custom');
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

      // Only override active when the legacy block carries intent: either a
      // non-empty model or an explicit preset.  An anonymous block with
      // model = "" is just the auto-generated placeholder.
      const hasMeaningfulLegacyProvider = model !== '' || (preset && typeof preset === 'string');
      if (hasMeaningfulLegacyProvider) {
        result.active = {
          ...result.active,
          provider: providerId,
          ...(model ? { model } : {}),
        };
      }
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

    // Merge TUI
    if (layer.config.tui) {
      const prev = result.tui ?? { mouse: false, alternateScreen: true, cmuxMode: false };
      result.tui = {
        mouse: layer.config.tui.mouse ?? prev.mouse,
        alternateScreen: layer.config.tui.alternateScreen ?? layer.config.tui.alternate_screen ?? prev.alternateScreen,
        cmuxMode: layer.config.tui.cmuxMode ?? layer.config.tui.cmux_mode ?? prev.cmuxMode,
      };
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
      maxOutputTokens: m.maxOutputTokens ?? m.max_output_tokens ?? prev?.maxOutputTokens,
    });
  }

  return Array.from(byId.values());
}

// ─── Active resolution ──────────────────────────────────────

function resolveActive(effective: EffectiveSynaxConfig): void {
  const providerId = effective.active.provider;
  const provider = providerId ? effective.providers[providerId] : undefined;

  // When the user explicitly selected a provider, honour that choice even if
  // the provider is not flagged as enabled in defaults. The enabled flag
  // controls visibility in the settings UI, not the active resolution path.
  if (!provider || !provider.baseUrl.trim() || provider.models.length === 0) {
    // Fall back to the first queryable provider.
    const first = Object.values(effective.providers).find(isQueryableProvider);
    if (first) {
      effective.active.provider = first.id;
      const firstModel = first.models[0];
      if (firstModel) effective.active.model = firstModel.id;
    }
    return;
  }

  if (effective.active.model === '') {
    effective.active.thinking = 'off';
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
    } else if (!effective.active.thinking) {
      // thinking was unset or provided an invalid value — default to the model's
      // default level or the first available level.
      effective.active.thinking = activeModel.defaultThinkingLevel ?? activeModel.thinkingLevels[0];
    }
  }
}

function isQueryableProvider(provider: ResolvedProviderConfig | undefined): provider is ResolvedProviderConfig {
  if (!provider?.enabled) return false;
  if (!provider.baseUrl.trim()) return false;
  if (provider.models.length === 0) return false;
  // API key presence is NOT gated here — the LLM factory (createLLMClient)
  // surfaces missing keys as clear, actionable errors at call time.
  // Gating on the key here would silently revert the user's provider
  // selection in the settings UI, which is worse than a clear error.
  return true;
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
    // Never persist api_key values — they should always come from env vars.
    // Writing a masked value like "••••" would corrupt the key on the next load.

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
      if (model.maxOutputTokens) {
        lines.push(`max_output_tokens = ${model.maxOutputTokens}`);
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

  // TUI
  const tui = config.tui ?? { mouse: false, alternateScreen: true, cmuxMode: false };
  lines.push('[tui]');
  lines.push(`mouse = ${tui.mouse}`);
  lines.push(`alternate_screen = ${tui.alternateScreen}`);
  lines.push(`cmux_mode = ${tui.cmuxMode}`);
  lines.push('');

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
  return ['model', 'default', 'qwen', 'openai', 'frontier', 'deepseek', 'gemini'].includes(value);
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
  // Write to the nearest existing config file.  Never auto-create a .synax.toml —
  // if the user hasn't placed one in their project, we always write to the global
  // config.  Auto-creating a local file litters the filesystem and silently changes
  // config resolution on the next run.
  const localPath = repoRoot ? discoverLocalConfigPath(repoRoot) : null;
  const targetPath = localPath ?? globalConfigPath();
  const result = writeSynaxConfig(config, targetPath);
  return { ...result, path: targetPath };
}
