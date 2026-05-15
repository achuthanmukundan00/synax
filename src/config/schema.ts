/**
 * Synax config schema — multi-provider, model, skills, MCP, thinking levels.
 *
 * This extends the existing single-provider config in project.ts with
 * the new multi-provider format. Both formats coexist; the effective
 * config layer resolves the active provider from whichever format is used.
 */

// ─── Provider types ────────────────────────────────────────

export type ProviderCompatibility = 'openai-compatible' | 'anthropic-compatible';

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'auto';

export interface ModelConfig {
  id: string;
  displayName?: string;
  display_name?: string;
  contextWindow?: number;
  context_window?: number;
  supportsThinking?: boolean;
  supports_thinking?: boolean;
  thinkingLevels?: ThinkingLevel[];
  thinking_levels?: ThinkingLevel[];
  defaultThinkingLevel?: ThinkingLevel;
  default_thinking?: ThinkingLevel;
}

export interface ProviderConfig {
  id: string;
  name?: string;
  compatibility: ProviderCompatibility;
  enabled?: boolean;
  baseUrl?: string;
  base_url?: string;
  apiKeyEnv?: string;
  api_key_env?: string;
  apiKey?: string;
  api_key?: string;
  headers?: Record<string, string>;
  models: ModelConfig[];
}

// ─── Active config ─────────────────────────────────────────

export interface ActiveConfig {
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
}

// ─── Skills config ─────────────────────────────────────────

export interface SkillsConfig {
  enabled?: string[];
  disabled?: string[];
}

// ─── MCP config ────────────────────────────────────────────

export interface McpServerConfig {
  enabled?: boolean;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  servers?: Record<string, McpServerConfig>;
}

// ─── TUI config ────────────────────────────────────────────

export interface TuiConfig {
  /** Enable SGR mouse tracking for app-managed wheel scrolling. Default false. */
  mouse?: boolean;
  /** Use alternate screen buffer. Default true. When false, prefer append-style output. */
  alternateScreen?: boolean;
  alternate_screen?: boolean;
}

export interface ResolvedTuiConfig {
  mouse: boolean;
  alternateScreen: boolean;
}

// ─── Full project config (extended) ────────────────────────

export interface SynaxConfig {
  active?: ActiveConfig;
  provider?: Record<string, unknown>; // legacy single-provider
  providers?: Record<string, ProviderConfig>;
  skills?: SkillsConfig;
  mcp?: McpConfig;
  tui?: TuiConfig;
  /** @deprecated No longer consumed by the TUI. Kept for config compatibility. */
  coreVisualProfile?: string;
}

// ─── Resolved / effective types ────────────────────────────

export interface ResolvedModelConfig {
  id: string;
  displayName?: string;
  contextWindow?: number;
  supportsThinking: boolean;
  thinkingLevels: ThinkingLevel[];
  defaultThinkingLevel?: ThinkingLevel;
}

export interface ResolvedProviderConfig {
  id: string;
  name: string;
  compatibility: ProviderCompatibility;
  enabled: boolean;
  baseUrl: string;
  apiKeyEnv?: string;
  apiKey?: string;
  headers: Record<string, string>;
  models: ResolvedModelConfig[];
}

export interface ResolvedSkillsConfig {
  enabled: string[];
  disabled: string[];
}

export interface ResolvedMcpConfig {
  servers: Record<string, ResolvedMcpServerConfig>;
}

export interface ResolvedMcpServerConfig {
  enabled: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ResolvedActiveConfig {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
}

export interface EffectiveSynaxConfig {
  active: ResolvedActiveConfig;
  providers: Record<string, ResolvedProviderConfig>;
  skills: ResolvedSkillsConfig;
  mcp: ResolvedMcpConfig;
  tui?: ResolvedTuiConfig;
  /** @deprecated No longer consumed by the TUI. Kept for config compatibility. */
  coreVisualProfile?: string;
  /** The source path that provided the effective config, or null for defaults. */
  source: string | null;
  /** Validation errors encountered during loading/merging. */
  errors: string[];
}

// ─── Config source tracking ────────────────────────────────

export type ConfigSource = 'default' | 'global' | 'local';

export interface ConfigSourceInfo {
  source: ConfigSource;
  path: string | null;
}
