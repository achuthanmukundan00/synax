/**
 * Settings menu state management.
 *
 * Pure state reducer for the interactive settings modal.
 * Keyboard-first, tab-based navigation.
 */
import type { EffectiveSynaxConfig, ResolvedMcpServerConfig, ThinkingLevel } from '../config/schema';
import { buildConfigUpdate } from '../config/load-config';

// ─── Tab definitions ───────────────────────────────────────

export type SettingsTab = 'model' | 'providers' | 'skills' | 'mcp' | 'config' | 'help';

export const SETTINGS_TABS: SettingsTab[] = ['model', 'providers', 'skills', 'mcp', 'config', 'help'];

export function tabLabel(tab: SettingsTab): string {
  const labels: Record<SettingsTab, string> = {
    model: 'Model',
    providers: 'Providers',
    skills: 'Skills',
    mcp: 'MCP',
    config: 'Config',
    help: 'Help',
  };
  return labels[tab];
}

// ─── Focus areas ────────────────────────────────────────────

export type SettingsFocus = 'tab' | 'rows' | 'text-input';

// ─── Row item types ────────────────────────────────────────

export interface SettingsRow {
  id: string;
  label: string;
  value: string;
  kind: 'info' | 'toggle' | 'select' | 'editable';
  enabled?: boolean;
  dimmed?: boolean;
  /** For select kind — list of options */
  options?: string[];
}

// ─── State ──────────────────────────────────────────────────

export interface SettingsState {
  active: boolean;
  tab: SettingsTab;
  focus: SettingsFocus;
  selectedRow: number;
  config: EffectiveSynaxConfig;
  /** For text input mode */
  textInput?: {
    rowId: string;
    value: string;
    cursor: number;
  };
  /** Track if config was modified */
  dirty: boolean;
}

export function createSettingsState(config: EffectiveSynaxConfig): SettingsState {
  return {
    active: false,
    tab: 'model',
    focus: 'tab',
    selectedRow: 0,
    config,
    dirty: false,
  };
}

// ─── Actions ────────────────────────────────────────────────

export type SettingsAction =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'next_tab' }
  | { type: 'prev_tab' }
  | { type: 'select_tab'; tab: SettingsTab }
  | { type: 'move_up' }
  | { type: 'move_down' }
  | { type: 'select_row' }
  | { type: 'toggle' }
  | { type: 'start_edit' }
  | { type: 'text_input'; char: string }
  | { type: 'text_backspace' }
  | { type: 'text_commit' }
  | { type: 'text_cancel' }
  | { type: 'set_config'; config: EffectiveSynaxConfig };

export function settingsReducer(state: SettingsState, action: SettingsAction): SettingsState {
  switch (action.type) {
    case 'open':
      return { ...state, active: true, focus: 'tab', selectedRow: 0, dirty: false };

    case 'close':
      return { ...state, active: false, textInput: undefined };

    case 'next_tab': {
      if (state.textInput) return state;
      const idx = SETTINGS_TABS.indexOf(state.tab);
      const next = SETTINGS_TABS[(idx + 1) % SETTINGS_TABS.length];
      return { ...state, tab: next, selectedRow: 0, focus: 'rows' };
    }

    case 'prev_tab': {
      if (state.textInput) return state;
      const idx = SETTINGS_TABS.indexOf(state.tab);
      const prev = SETTINGS_TABS[(idx - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length];
      return { ...state, tab: prev, selectedRow: 0, focus: 'rows' };
    }

    case 'select_tab':
      if (state.textInput) return state;
      return { ...state, tab: action.tab, selectedRow: 0, focus: 'rows' };

    case 'move_up': {
      if (state.textInput) return state;
      if (state.focus === 'tab') {
        return { ...state, focus: 'rows', selectedRow: 0 };
      }
      return { ...state, selectedRow: Math.max(0, state.selectedRow - 1) };
    }

    case 'move_down': {
      if (state.textInput) return state;
      const rows = getTabRows(state.tab, state.config);
      const max = Math.max(0, rows.length - 1);
      return { ...state, selectedRow: Math.min(max, state.selectedRow + 1) };
    }

    case 'select_row': {
      if (state.textInput) {
        return settingsReducer(state, { type: 'text_commit' });
      }

      const rows = getTabRows(state.tab, state.config);
      const row = rows[state.selectedRow];
      if (!row) return state;

      // Handle toggle
      if (row.kind === 'toggle') {
        return handleToggle(state, row);
      }

      // Handle select
      if (row.kind === 'select') {
        return handleSelect(state, row);
      }

      // Handle editable
      if (row.kind === 'editable') {
        return {
          ...state,
          textInput: { rowId: row.id, value: row.value, cursor: row.value.length },
          focus: 'text-input',
        };
      }

      return state;
    }

    case 'toggle': {
      const rows = getTabRows(state.tab, state.config);
      const row = rows[state.selectedRow];
      if (!row) return state;

      if (row.kind === 'toggle') {
        return handleToggle(state, row);
      }
      return state;
    }

    case 'start_edit': {
      return settingsReducer(state, { type: 'select_row' });
    }

    case 'text_input': {
      if (!state.textInput) return state;
      const { rowId, value, cursor } = state.textInput;
      const before = value.slice(0, cursor);
      const after = value.slice(cursor);
      const newValue = before + action.char + after;
      return {
        ...state,
        textInput: { rowId, value: newValue, cursor: cursor + action.char.length },
      };
    }

    case 'text_backspace': {
      if (!state.textInput) return state;
      const { rowId, value, cursor } = state.textInput;
      if (cursor === 0) return state;
      const newValue = value.slice(0, cursor - 1) + value.slice(cursor);
      return {
        ...state,
        textInput: { rowId, value: newValue, cursor: cursor - 1 },
      };
    }

    case 'text_commit': {
      if (!state.textInput) return state;
      const { rowId, value } = state.textInput;
      const withoutInput: SettingsState = { ...state, textInput: undefined, focus: 'rows', dirty: true };
      return applyTextCommit(withoutInput, rowId, value);
    }

    case 'text_cancel':
      return { ...state, textInput: undefined, focus: 'rows' as const };

    case 'set_config':
      return { ...state, config: action.config };
  }
}

// ─── Row builders ───────────────────────────────────────────

export function getTabRows(tab: SettingsTab, config: EffectiveSynaxConfig): SettingsRow[] {
  switch (tab) {
    case 'model':
      return buildModelRows(config);
    case 'providers':
      return buildProviderRows(config);
    case 'skills':
      return buildSkillsRows(config);
    case 'mcp':
      return buildMcpRows(config);
    case 'config':
      return buildConfigRows(config);
    case 'help':
      return buildHelpRows();
  }
}

function buildModelRows(config: EffectiveSynaxConfig): SettingsRow[] {
  const active = config.active;
  const provider = config.providers[active.provider];
  const activeModel = provider?.models.find((m) => m.id === active.model);
  const rows: SettingsRow[] = [];

  rows.push({
    id: 'active-provider',
    label: 'Active Provider',
    value: provider?.name ?? active.provider,
    kind: 'select',
    options: Object.values(config.providers)
      .filter((p) => p.enabled)
      .map((p) => p.id),
  });

  rows.push({
    id: 'active-model',
    label: 'Active Model',
    value: activeModel?.displayName ?? active.model,
    kind: 'select',
    options: provider?.models.map((m) => m.id) ?? [],
  });

  const thinkingLabel = 'Thinking';
  if (activeModel?.supportsThinking && activeModel.thinkingLevels.length > 0) {
    rows.push({
      id: 'active-thinking',
      label: thinkingLabel,
      value: active.thinking,
      kind: 'select',
      options: activeModel.thinkingLevels,
    });
  } else {
    rows.push({
      id: 'active-thinking',
      label: thinkingLabel,
      value: 'n/a',
      kind: 'info',
      dimmed: true,
    });
  }

  // Model list
  rows.push({ id: 'models-header', label: 'Models', value: '', kind: 'info', dimmed: true });
  for (const model of provider?.models ?? []) {
    const isActive = model.id === active.model;
    const ctxStr = model.contextWindow ? `ctx ${formatContext(model.contextWindow)}` : '';
    const thinkStr = model.supportsThinking
      ? `think ${model.defaultThinkingLevel ?? model.thinkingLevels[0] ?? 'off'}`
      : 'think n/a';
    rows.push({
      id: `model-${model.id}`,
      label: isActive ? `→ ${model.id}` : `  ${model.id}`,
      value: [model.displayName, ctxStr, thinkStr].filter(Boolean).join('  '),
      kind: 'select',
      options: [], // selecting navigates to that model
    });
  }

  return rows;
}

function buildProviderRows(config: EffectiveSynaxConfig): SettingsRow[] {
  const rows: SettingsRow[] = [];

  for (const [id, provider] of Object.entries(config.providers)) {
    const statusIcon = provider.enabled ? '✓' : '○';
    const isActive = id === config.active.provider;
    const prefix = isActive ? '→ ' : '  ';

    rows.push({
      id: `provider-${id}`,
      label: `${prefix}${statusIcon} ${provider.name}`,
      value: `${provider.compatibility} · ${sanitizeEndpoint(provider.baseUrl)} · ${provider.models.length} models`,
      kind: 'info',
      enabled: provider.enabled,
    });

    // Show models under provider
    for (const model of provider.models) {
      const ctxStr = model.contextWindow ? `ctx ${formatContext(model.contextWindow)}` : '';
      rows.push({
        id: `provider-${id}-model-${model.id}`,
        label: `      ${model.id}`,
        value: [model.displayName, ctxStr].filter(Boolean).join('  '),
        kind: 'info',
        dimmed: true,
      });
    }
  }

  return rows;
}

function buildSkillsRows(config: EffectiveSynaxConfig): SettingsRow[] {
  const rows: SettingsRow[] = [];
  const installed = discoverInstalledSkills();

  for (const skill of installed) {
    const enabled = config.skills.enabled.includes(skill.id);
    const disabled = config.skills.disabled.includes(skill.id);
    const status = skill.broken ? '!' : enabled ? '✓' : disabled ? '○' : '○';
    const reason = skill.broken ? `  ${skill.brokenReason ?? 'unavailable'}` : '';

    rows.push({
      id: `skill-${skill.id}`,
      label: `${status} ${skill.id}`,
      value: `${skill.description ?? ''}${reason}`,
      kind: 'toggle',
      enabled,
    });
  }

  return rows;
}

function buildMcpRows(config: EffectiveSynaxConfig): SettingsRow[] {
  const rows: SettingsRow[] = [];
  const servers = config.mcp.servers;

  for (const [name, server] of Object.entries(servers)) {
    const statusIcon = server.enabled ? '✓' : '○';
    const cmdStr = `${server.command} ${server.args?.join(' ') ?? ''}`.trim();
    const errors = validateMcpServer(server);

    rows.push({
      id: `mcp-${name}`,
      label: `${statusIcon} ${name}`,
      value: errors.length > 0 ? errors[0] : cmdStr,
      kind: 'toggle',
      enabled: server.enabled,
    });
  }

  return rows;
}

function buildConfigRows(config: EffectiveSynaxConfig): SettingsRow[] {
  const rows: SettingsRow[] = [];

  rows.push({
    id: 'config-source-header',
    label: 'Config Sources',
    value: '',
    kind: 'info',
    dimmed: true,
  });

  rows.push({
    id: 'config-global',
    label: 'Global config',
    value: '~/.config/synax/config.toml' + (existsGlobalConfig() ? '' : ' (not found)'),
    kind: 'info',
    dimmed: !existsGlobalConfig(),
  });

  rows.push({
    id: 'config-local',
    label: 'Local config',
    value: config.source ?? '(not found)',
    kind: 'info',
    dimmed: !config.source,
  });

  rows.push({
    id: 'config-effective-model',
    label: 'Effective model',
    value: config.active.model,
    kind: 'info',
  });

  rows.push({
    id: 'config-effective-source',
    label: 'Effective source',
    value: config.source ? 'local .synax.toml overrides global' : 'defaults',
    kind: 'info',
  });

  rows.push({ id: 'config-loaded-header', label: 'Loaded', value: '', kind: 'info', dimmed: true });

  const providerCount = Object.keys(config.providers).length;
  rows.push({
    id: 'config-loaded-providers',
    label: '✓ providers',
    value: `${providerCount} configured`,
    kind: 'info',
  });

  const modelCount = Object.values(config.providers).reduce((sum, p) => sum + p.models.length, 0);
  rows.push({
    id: 'config-loaded-models',
    label: '✓ models',
    value: `${modelCount} total`,
    kind: 'info',
  });

  const skillCount = config.skills.enabled.length + config.skills.disabled.length;
  rows.push({
    id: 'config-loaded-skills',
    label: '✓ skills',
    value: `${skillCount} known`,
    kind: 'info',
  });

  const mcpCount = Object.keys(config.mcp.servers).length;
  rows.push({
    id: 'config-loaded-mcp',
    label: '✓ mcp',
    value: `${mcpCount} servers`,
    kind: 'info',
  });

  if (config.errors.length > 0) {
    rows.push({ id: 'config-errors-header', label: 'Errors', value: '', kind: 'info', dimmed: true });
    for (const err of config.errors.slice(0, 5)) {
      rows.push({
        id: `config-error-${err.slice(0, 20)}`,
        label: '! error',
        value: err,
        kind: 'info',
      });
    }
  }

  return rows;
}

function buildHelpRows(): SettingsRow[] {
  return [
    { id: 'help-nav', label: 'Navigation', value: '', kind: 'info', dimmed: true },
    { id: 'help-tab', label: 'Tab / Shift+Tab', value: 'Switch tabs', kind: 'info' },
    { id: 'help-arrows', label: '↑/↓ or k/j', value: 'Move selected row', kind: 'info' },
    { id: 'help-enter', label: 'Enter', value: 'Select / toggle / edit', kind: 'info' },
    { id: 'help-esc', label: 'Escape', value: 'Close settings / cancel edit', kind: 'info' },
    { id: 'help-slash', label: '/', value: 'Open command autocomplete (when not in text entry)', kind: 'info' },
    { id: 'help-q', label: 'q', value: 'Close settings (when not in text entry)', kind: 'info' },
    { id: 'help-space', label: 'Space', value: 'Toggle checkbox', kind: 'info' },
    { id: 'help-blank1', label: '', value: '', kind: 'info' },
    { id: 'help-config', label: 'Config Files', value: '', kind: 'info', dimmed: true },
    { id: 'help-global-path', label: 'Global', value: '~/.config/synax/config.toml', kind: 'info' },
    { id: 'help-local-path', label: 'Local', value: '<repo>/.synax.toml', kind: 'info' },
    { id: 'help-precedence', label: 'Precedence', value: 'defaults → global → local', kind: 'info' },
    { id: 'help-blank2', label: '', value: '', kind: 'info' },
    { id: 'help-providers', label: 'Provider Setup', value: '', kind: 'info', dimmed: true },
    {
      id: 'help-provider-eg',
      label: 'Example',
      value: 'Add [providers.<id>] with base_url and compatibility',
      kind: 'info',
    },
    { id: 'help-blank3', label: '', value: '', kind: 'info' },
    { id: 'help-slash-cmds', label: 'Slash Commands', value: '', kind: 'info', dimmed: true },
    { id: 'help-cmd-slash', label: '/help, /settings', value: 'Open settings', kind: 'info' },
    { id: 'help-cmd-model', label: '/model', value: 'Select model', kind: 'info' },
    { id: 'help-cmd-resume', label: '/resume', value: 'Resume previous session', kind: 'info' },
    { id: 'help-cmd-exit', label: '/exit, /quit', value: 'Exit Synax', kind: 'info' },
  ];
}

// ─── Toggle / Select handlers ───────────────────────────────

function handleToggle(state: SettingsState, row: SettingsRow): SettingsState {
  let next = { ...state, dirty: true };

  // Skill toggle
  if (row.id.startsWith('skill-')) {
    const skillId = row.id.slice('skill-'.length);
    next.config = buildConfigUpdate(next.config, { toggleSkill: skillId });
  }

  // MCP toggle
  if (row.id.startsWith('mcp-')) {
    const serverId = row.id.slice('mcp-'.length);
    next.config = buildConfigUpdate(next.config, { toggleMcpServer: serverId });
  }

  // Provider toggle
  if (row.id.startsWith('provider-toggle-')) {
    const providerId = row.id.slice('provider-toggle-'.length);
    const provider = next.config.providers[providerId];
    if (provider) {
      next.config = {
        ...next.config,
        providers: {
          ...next.config.providers,
          [providerId]: { ...provider, enabled: !provider.enabled },
        },
      };
    }
  }

  return next;
}

function handleSelect(state: SettingsState, row: SettingsRow): SettingsState {
  let next = { ...state, dirty: true };

  if (row.id === 'active-provider') {
    next.config = buildConfigUpdate(next.config, { activeProvider: row.value });
  }

  if (row.id === 'active-model' || row.id.startsWith('model-')) {
    const modelId = row.id.startsWith('model-') ? row.id.slice('model-'.length) : row.value;
    next.config = buildConfigUpdate(next.config, { activeModel: modelId });
  }

  if (row.id === 'active-thinking') {
    next.config = buildConfigUpdate(next.config, {
      activeThinking: row.value as ThinkingLevel,
    });
  }

  return next;
}

function applyTextCommit(state: SettingsState, rowId: string, value: string): SettingsState {
  // For now, text edits mostly apply to provider fields
  const parts = rowId.split('-');
  if (parts[0] === 'provider' && parts.length >= 3) {
    const providerId = parts[1];
    const field = parts.slice(2).join('-');
    const provider = state.config.providers[providerId];
    if (!provider) return state;

    const updated = { ...provider };
    if (field === 'endpoint' || field === 'base_url') {
      updated.baseUrl = value;
    } else if (field === 'api_key_env') {
      updated.apiKeyEnv = value || undefined;
    }

    return {
      ...state,
      config: {
        ...state.config,
        providers: { ...state.config.providers, [providerId]: updated },
      },
    };
  }

  return state;
}

// ─── Helpers ────────────────────────────────────────────────

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}K`;
  return String(tokens);
}

function sanitizeEndpoint(raw: string): string {
  try {
    const url = new URL(raw);
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '/');
  } catch {
    return raw;
  }
}

function existsGlobalConfig(): boolean {
  const { existsSync } = require('fs');
  const { globalConfigPath } = require('../config/load-config');
  return existsSync(globalConfigPath());
}

interface InstalledSkill {
  id: string;
  description?: string;
  broken?: boolean;
  brokenReason?: string;
}

function discoverInstalledSkills(): InstalledSkill[] {
  // In future, scan the skills directory. For now, return known built-in skills
  // from the extensions architecture.
  const skills: InstalledSkill[] = [];

  // Check if the skills directory exists under user's .agents
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) {
    const { existsSync, readdirSync } = require('fs');
    const { join } = require('path');
    const skillsDir = join(home, '.agents', 'skills');
    if (existsSync(skillsDir)) {
      try {
        const entries = readdirSync(skillsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() || entry.isSymbolicLink()) {
            const manifestPath = join(skillsDir, entry.name, 'SKILL.md');
            const broken = !existsSync(manifestPath);
            skills.push({
              id: entry.name,
              description: broken ? undefined : 'Installed skill',
              broken,
              brokenReason: broken ? 'Missing SKILL.md manifest' : undefined,
            });
          }
        }
      } catch {
        // ignore
      }
    }

    // Also check coderabbit-review if it exists
    const coderabbitPath = join(home, '.agents', 'skills', 'coderabbit-review', 'SKILL.md');
    if (existsSync(coderabbitPath) && !skills.some((s) => s.id === 'coderabbit-review')) {
      skills.push({ id: 'coderabbit-review', description: 'AI code review of working tree changes' });
    }

    const grillmePath = join(home, '.agents', 'skills', 'grill-me', 'SKILL.md');
    if (existsSync(grillmePath) && !skills.some((s) => s.id === 'grill-me')) {
      skills.push({ id: 'grill-me', description: 'Harsh critique of ideas, plans, or code' });
    }
  }

  return skills;
}

function validateMcpServer(server: ResolvedMcpServerConfig): string[] {
  const errors: string[] = [];
  if (!server.command.trim()) errors.push('Missing command');
  // Check for missing env vars that look like tokens
  for (const [key, value] of Object.entries(server.env)) {
    if (!value && key.includes('TOKEN')) {
      errors.push(`Missing ${key}`);
    }
  }
  return errors;
}
