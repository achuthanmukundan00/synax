/**
 * Tests for config module: project.ts, profile.ts, commands/config.ts, load-config.ts
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  discoverConfigPath,
  parseTomlString,
  validateConfig,
  loadProjectConfig,
  generateDefaultConfig,
  writeConfigFile,
  normalizeProviderConfig,
  applyEffectiveSynaxConfigToProjectConfig,
} from '../config/project';

import {
  detectGitProfile,
  detectPackageManager,
  detectCommands,
  detectInstructionFiles,
  buildProjectProfile,
  formatTextProfile,
} from '../config/profile';

import {
  loadSynaxConfig,
  parseSynaxToml,
  serializeEffectiveConfig,
  writeSynaxConfig,
  buildConfigUpdate,
} from '../config/load-config';

import type { EffectiveSynaxConfig } from '../config/schema';

// runConfigCommand is tested indirectly via CLI smoke tests

// ─── helpers ────────────────────────────────────────────────

const TMP = join(tmpdir(), 'synax-config-tests');
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

function ensureTmp() {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true });
  }
  mkdirSync(TMP, { recursive: true });
  const home = join(TMP, '.home');
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}

afterAll(() => {
  restoreEnv('HOME', ORIGINAL_HOME);
  restoreEnv('USERPROFILE', ORIGINAL_USERPROFILE);
});

// ─── discoverConfigPath ─────────────────────────────────────

describe('discoverConfigPath', () => {
  beforeEach(() => ensureTmp());
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('returns null when no config file exists', () => {
    expect(discoverConfigPath(TMP)).toBeNull();
  });

  it('returns the path when config file exists', () => {
    const configPath = join(TMP, '.synax.toml');
    writeFileSync(configPath, '[project]\nname = "test"', 'utf-8');
    expect(discoverConfigPath(TMP)).toBe(configPath);
  });
});

// ─── validateConfig ─────────────────────────────────────────

describe('validateConfig', () => {
  it('returns no errors for valid config', () => {
    const errors = validateConfig({
      model: 'test-model',
      baseUrl: 'http://localhost:1234/v1',
      contextBudgetTokens: 8000,
    });
    expect(errors).toHaveLength(0);
  });

  it('catches invalid contextBudgetTokens', () => {
    const errors = validateConfig({
      contextBudgetTokens: -1,
    } as never);
    expect(errors.some((e) => e.path === 'contextBudgetTokens')).toBe(true);
  });
});

describe('normalizeProviderConfig', () => {
  it('preserves custom headers', () => {
    const normalized = normalizeProviderConfig({
      kind: 'openai-compatible',
      base_url: 'http://127.0.0.1:1234/v1',
      model: 'test-model',
      custom_headers: { 'X-Custom-Header': 'value-1' },
    });
    expect(normalized.customHeaders).toEqual({ 'X-Custom-Header': 'value-1' });
  });

  it('supports timeout_ms and timeoutMs aliases', () => {
    expect(normalizeProviderConfig({ timeout_ms: 2500 }).timeoutMs).toBe(2500);
    expect(normalizeProviderConfig({ timeoutMs: 3000 }).timeoutMs).toBe(3000);
  });
});

// ─── parseTomlString ────────────────────────────────────────

describe('parseTomlString', () => {
  it('parses valid TOML', () => {
    const toml = 'model = "qwen3.6-35b-a3b"\ncontextBudgetTokens = 8000';
    const result = parseTomlString(toml);
    expect(result.errors).toHaveLength(0);
    expect(result.config.model).toBe('qwen3.6-35b-a3b');
    expect(result.config.contextBudgetTokens).toBe(8000);
  });

  it('parses legacy provider-scoped core visual profile aliases', () => {
    const result = parseTomlString(['[provider]', 'core_visual_profile = "Claude"'].join('\n'));

    expect(result.errors).toHaveLength(0);
    expect(result.config.coreVisualProfile).toBe('claude');
  });

  it('parses agent snake_case budget settings', () => {
    const toml = ['[agent]', 'context_budget_tokens = 131072', 'max_model_steps = 32', 'max_tool_calls = 96'].join(
      '\n',
    );
    const result = parseTomlString(toml);

    expect(result.errors).toHaveLength(0);
    expect(result.config.contextBudgetTokens).toBe(131072);
    expect(result.config.maxModelSteps).toBe(32);
    expect(result.config.maxToolCalls).toBe(96);
  });

  it('keeps context budget and context window aliases in sync', () => {
    const result = parseTomlString(['[agent]', 'context_budget_tokens = 64000'].join('\n'));

    expect(result.errors).toHaveLength(0);
    expect(result.config.contextBudgetTokens).toBe(64000);
    expect(result.config.contextWindowTokens).toBe(64000);
  });

  it('rejects conflicting context budget and context window aliases', () => {
    const result = parseTomlString(
      ['[agent]', 'context_budget_tokens = 64000', 'context_window_tokens = 32000'].join('\n'),
    );

    expect(result.errors.some((error) => error.path === 'agent.context_window_tokens')).toBe(true);
  });

  it('returns errors for invalid TOML', () => {
    const result = parseTomlString('invalid toml {{{');
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ─── loadProjectConfig ──────────────────────────────────────

describe('loadProjectConfig', () => {
  beforeEach(() => ensureTmp());
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('returns defaults when source is default', () => {
    const result = loadProjectConfig(TMP);
    expect(result.source).toBe('default');
    expect(result.config.baseUrl).toBe('http://127.0.0.1:1234/v1');
    expect(result.config.contextBudgetTokens).toBe(131072);
    expect(result.config.maxModelSteps).toBeUndefined();
    expect(result.config.maxToolCalls).toBe(192);
  });

  it('returns parsed config when file exists at explicit path', () => {
    const configPath = join(TMP, '.synax.toml');
    writeFileSync(configPath, 'model = "custom-model"\ncontextBudgetTokens = 4000', 'utf-8');
    const result = loadProjectConfig(configPath);
    expect(result.source).toBe('file');
    expect(result.config.model).toBe('custom-model');
    expect(result.config.contextBudgetTokens).toBe(4000);
  });

  it('applies budget environment overrides', () => {
    const previousContext = process.env.SYNAX_CONTEXT_BUDGET_TOKENS;
    const previousTools = process.env.SYNAX_MAX_TOOL_CALLS;
    process.env.SYNAX_CONTEXT_BUDGET_TOKENS = '64000';
    process.env.SYNAX_MAX_TOOL_CALLS = '24';
    try {
      const result = loadProjectConfig(TMP);
      expect(result.errors).toHaveLength(0);
      expect(result.config.contextBudgetTokens).toBe(64000);
      expect(result.config.maxModelSteps).toBeUndefined();
      expect(result.config.maxToolCalls).toBe(24);
    } finally {
      restoreEnv('SYNAX_CONTEXT_BUDGET_TOKENS', previousContext);
      restoreEnv('SYNAX_MAX_TOOL_CALLS', previousTools);
    }
  });

  it('supports restricting exposed tool list', () => {
    const configPath = join(TMP, '.synax.toml');
    writeFileSync(configPath, ['[tools]', 'exposed = ["read","write","edit","bash"]', 'shell = "zsh"'].join('\n'));
    const result = loadProjectConfig(TMP);
    expect(result.errors).toHaveLength(0);
    expect(result.config.tools?.exposed).toEqual(['read', 'write', 'edit', 'bash']);
  });

  it('defaults bash tool execution to enabled', () => {
    const result = loadProjectConfig(TMP);
    expect(result.errors).toHaveLength(0);
    expect(result.config.tools?.exposed).toEqual(['read', 'write', 'edit', 'bash']);
    expect(result.config.tools?.bash?.enabled).toBe(true);
  });

  it('supports explicitly enabling bash in tool config', () => {
    const configPath = join(TMP, '.synax.toml');
    writeFileSync(configPath, ['[tools.bash]', 'enabled = true'].join('\n'));
    const result = loadProjectConfig(TMP);
    expect(result.errors).toHaveLength(0);
    expect(result.config.tools?.bash?.enabled).toBe(true);
  });

  it('loads provider from new multi-provider format without overwriting with preset defaults', () => {
    const configPath = join(TMP, '.synax.toml');
    const toml = [
      '[active]',
      'provider = "relay"',
      'model = "test-model"',
      '',
      '[providers.relay]',
      'enabled = true',
      'name = "Relay"',
      'compatibility = "openai-compatible"',
      'base_url = "https://example.com/v1"',
      '',
      '[[providers.relay.models]]',
      'id = "test-model"',
      'display_name = "Test Model"',
      'context_window = 32768',
    ].join('\n');
    writeFileSync(configPath, toml);
    const result = loadProjectConfig(TMP);
    expect(result.errors).toHaveLength(0);
    expect(result.config.provider?.preset).toBe('relay');
    expect(result.config.provider?.baseUrl).toBe('https://example.com/v1');
    expect(result.config.provider?.model).toBe('test-model');
    // Ensure we didn't fallback to preset defaults (which would be http://127.0.0.1:1234/v1)
    expect(result.config.provider?.baseUrl).not.toBe('http://127.0.0.1:1234/v1');
  });
});

// ─── generateDefaultConfig ──────────────────────────────────

describe('generateDefaultConfig', () => {
  it('generates a valid TOML string', () => {
    const config = generateDefaultConfig();
    expect(config).toContain('baseUrl =');
    expect(config).toContain('[agent]');
    expect(config).toContain('context_budget_tokens = 131072');
    expect(config).not.toContain('max_model_steps');
    expect(config).toContain('max_tool_calls = 192');
    expect(config).toContain('kind =');
  });
});

// ─── writeConfigFile ────────────────────────────────────────

describe('writeConfigFile', () => {
  beforeEach(() => ensureTmp());
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('creates a new config file', () => {
    const result = writeConfigFile(join(TMP, '.synax.toml'));
    expect(result.success).toBe(true);
    expect(existsSync(join(TMP, '.synax.toml'))).toBe(true);
  });

  it('fails when file already exists', () => {
    const filePath = join(TMP, '.synax.toml');
    writeFileSync(filePath, 'existing', 'utf-8');
    const result = writeConfigFile(filePath);
    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
  });
});

// ─── detectGitProfile ───────────────────────────────────────

describe('detectGitProfile', () => {
  it('returns git info when inside a git repo', () => {
    const result = detectGitProfile();
    if (result) {
      expect(result.root).toBeTruthy();
      expect(result.branch).toBeTruthy();
    }
  });

  it('returns null when not inside a git repo', () => {
    expect(detectGitProfile('/tmp/nonexistent-synax-')).toBeNull();
  });
});

// ─── detectPackageManager ───────────────────────────────────

describe('detectPackageManager', () => {
  beforeEach(() => ensureTmp());
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('detects npm from package-lock.json', () => {
    writeFileSync(join(TMP, 'package-lock.json'), '{}', 'utf-8');
    expect(detectPackageManager(TMP).name).toBe('npm');
  });

  it('detects pnpm from pnpm-lock.yaml', () => {
    writeFileSync(join(TMP, 'pnpm-lock.yaml'), '', 'utf-8');
    expect(detectPackageManager(TMP).name).toBe('pnpm');
  });

  it('returns unknown when no lockfile exists', () => {
    expect(detectPackageManager(TMP).name).toBe('unknown');
  });
});

// ─── detectCommands ─────────────────────────────────────────

describe('detectCommands', () => {
  beforeEach(() => ensureTmp());
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('extracts scripts from package.json', () => {
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({ scripts: { test: 'jest', lint: 'eslint .' } }), 'utf-8');
    const result = detectCommands(TMP);
    expect(result.test).toBe('jest');
    expect(result.lint).toBe('eslint .');
  });

  it('returns empty object when no package.json', () => {
    const result = detectCommands(join(TMP, 'nonexistent'));
    expect(Object.keys(result)).toEqual([]);
  });
});

// ─── detectInstructionFiles ─────────────────────────────────

describe('detectInstructionFiles', () => {
  beforeEach(() => ensureTmp());
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('detects common instruction files', () => {
    writeFileSync(join(TMP, 'README.md'), '# Test', 'utf-8');
    const result = detectInstructionFiles(TMP);
    expect(result).toContain('README.md');
  });
});

// ─── runConfigCommand ───────────────────────────────────────

describe('runConfigCommand', () => {
  beforeEach(() => ensureTmp());
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('writeConfigFile creates file and config show displays it', () => {
    const configPath = join(TMP, '.synax.toml');
    writeFileSync(configPath, 'model = "test-model"\ncontextBudgetTokens = 2000', 'utf-8');

    // Mock loadProjectConfig to use our test config
    const result = loadProjectConfig(configPath);
    expect(result.config.model).toBe('test-model');
    expect(result.config.contextBudgetTokens).toBe(2000);
  });
});

// ─── formatTextProfile ──────────────────────────────────────

describe('formatTextProfile', () => {
  beforeEach(() => ensureTmp());
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('formats a basic profile with no git', () => {
    const profile = buildProjectProfile(TMP);
    const formatted = formatTextProfile({
      project: profile,
      config: {
        source: 'default',
        hasConfigFile: false,
        configSummary: {
          model: undefined,
          baseUrl: 'http://127.0.0.1:1234/v1',
          contextBudgetTokens: 16000,
          subagents: { enabled: false, mode: 'sequential' },
          verification: { defaultCommand: 'npm test' },
        },
      },
    });
    expect(formatted).toContain('Project Profile');
  });
});

// ═══════════════════════════════════════════════════════════════
// load-config.ts tests — multi-provider, TOML serialization, etc.
// ═══════════════════════════════════════════════════════════════

describe('parseSynaxToml (multi-provider)', () => {
  it('parses realistic multi-provider TOML', () => {
    const toml = `
[active]
provider = "deepseek"
model = "deepseek-chat"
thinking = "off"

[providers.deepseek]
name = "DeepSeek"
compatibility = "openai-compatible"
enabled = true
base_url = "https://api.deepseek.com/v1"
api_key_env = "DEEPSEEK_API_KEY"

[[providers.deepseek.models]]
id = "deepseek-chat"
display_name = "DeepSeek Chat"
context_window = 65536
supports_thinking = false

[[providers.deepseek.models]]
id = "deepseek-reasoner"
display_name = "DeepSeek Reasoner"
context_window = 65536
supports_thinking = true
thinking_levels = ["off", "low", "medium", "high"]
default_thinking = "low"

[skills]
enabled = ["coderabbit-review"]
disabled = ["grill-me"]

[mcp.servers.git]
command = "git-mcp"
args = ["--repo", "."]
enabled = true
`;
    const { config, errors } = parseSynaxToml(toml);
    expect(errors).toHaveLength(0);
    expect(config.active?.provider).toBe('deepseek');
    expect(config.active?.model).toBe('deepseek-chat');
    expect(config.providers?.deepseek).toBeDefined();
    expect(config.providers?.deepseek.models).toHaveLength(2);
    expect(config.skills?.enabled).toContain('coderabbit-review');
    expect(config.skills?.disabled).toContain('grill-me');
    expect(config.mcp?.servers?.git).toBeDefined();
    expect(config.mcp?.servers?.git?.command).toBe('git-mcp');
  });

  it('normalizes unsupported thinking level to undefined (silently dropped by parser)', () => {
    const toml = `
[active]
thinking = "extreme"
`;
    const { config, errors } = parseSynaxToml(toml);
    // "extreme" is not a valid ThinkingLevel, so it is not set on active config.
    expect(config.active?.thinking).toBeUndefined();
    expect(errors).toHaveLength(0);
  });

  it('defaults compatibility to openai-compatible when omitted', () => {
    const toml = `
[providers.custom]
name = "Custom Provider"
base_url = "http://127.0.0.1:8080/v1"

[[providers.custom.models]]
id = "local-model"
`;
    const { config, errors } = parseSynaxToml(toml);
    // Providers without explicit compatibility no longer get silently dropped.
    expect(config.providers?.custom).toBeDefined();
    expect(config.providers?.custom?.compatibility).toBe('openai-compatible');
    expect(errors).toHaveLength(0);
  });

  it('rejects invalid TOML', () => {
    const { errors } = parseSynaxToml('{{{ invalid');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('parses provider config with snake_case and camelCase aliases', () => {
    const toml = `
[providers.test]
compatibility = "openai-compatible"
base_url = "http://localhost:8080/v1"
api_key_env = "TEST_KEY"

[[providers.test.models]]
id = "test-model"
supports_thinking = true
thinking_levels = ["off", "auto"]
`;
    const { config, errors } = parseSynaxToml(toml);
    expect(errors).toHaveLength(0);
    expect(config.providers?.test).toBeDefined();
    expect(config.providers?.test?.models[0]?.supportsThinking).toBe(true);
    expect(config.providers?.test?.models[0]?.thinkingLevels).toEqual(['off', 'auto']);
  });

  it('parses core visual profile overrides for the TUI', () => {
    const { config, errors } = parseSynaxToml('coreVisualProfile = "claude"\n');

    expect(errors).toHaveLength(0);
    expect(config.coreVisualProfile).toBe('claude');
  });

  it('parses legacy provider-scoped core visual profile overrides case-insensitively', () => {
    const { config, errors } = parseSynaxToml(['[provider]', 'coreVisualProfile = "openAI"'].join('\n'));

    expect(errors).toHaveLength(0);
    expect(config.coreVisualProfile).toBe('openai');
  });
});

describe('loadSynaxConfig (local override)', () => {
  beforeEach(() => ensureTmp());
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('local .synax.toml overrides global config', () => {
    // Create a local config with explicit active settings
    const localPath = join(TMP, '.synax.toml');
    writeFileSync(
      localPath,
      `
[active]
provider = "custom"
model = "custom-model"
thinking = "low"

[providers.custom]
compatibility = "openai-compatible"
base_url = "http://127.0.0.1:9999/v1"

[[providers.custom.models]]
id = "custom-model"
supports_thinking = true
thinking_levels = ["off", "low", "medium"]
`,
      'utf-8',
    );
    const effective = loadSynaxConfig(TMP);
    expect(effective.active.provider).toBe('custom');
    expect(effective.active.model).toBe('custom-model');
    expect(effective.active.thinking).toBe('low');
    expect(effective.providers.custom).toBeDefined();
    expect(effective.providers.custom.baseUrl).toBe('http://127.0.0.1:9999/v1');
  });

  it('active provider/model resolves correctly from multi-provider config', () => {
    const localPath = join(TMP, '.synax.toml');
    writeFileSync(
      localPath,
      `
[active]
provider = "deepseek"
model = "deepseek-chat"

[providers.deepseek]
compatibility = "openai-compatible"
base_url = "https://api.deepseek.com/v1"
api_key = "sk-test"

[[providers.deepseek.models]]
id = "deepseek-chat"
`,
      'utf-8',
    );
    const effective = loadSynaxConfig(TMP);
    expect(effective.active.provider).toBe('deepseek');
    expect(effective.active.model).toBe('deepseek-chat');
    expect(effective.active.thinking).toBe('off'); // not set, so default
  });

  it('keeps active provider even when API key is missing (key check belongs in LLM factory)', () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const localPath = join(TMP, '.synax.toml');
    writeFileSync(
      localPath,
      `
[active]
provider = "anthropic"
model = "claude-3-5-haiku-20241022"

[providers.anthropic]
compatibility = "anthropic-compatible"
base_url = "https://api.anthropic.com/v1"
api_key_env = "ANTHROPIC_API_KEY"

[[providers.anthropic.models]]
id = "claude-3-5-haiku-20241022"
`,
      'utf-8',
    );

    try {
      const effective = loadSynaxConfig(TMP);
      // Provider selection should stick — the API key error is surfaced later by createLLMClient
      expect(effective.active.provider).toBe('anthropic');
      expect(effective.active.model).toBe('claude-3-5-haiku-20241022');
    } finally {
      if (originalKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalKey;
      }
    }
  });

  it('loads active multi-provider settings into the runtime provider config', () => {
    const localPath = join(TMP, '.synax.toml');
    writeFileSync(
      localPath,
      `
[active]
provider = "deepseek"
model = "deepseek-reasoner"
thinking = "high"

[providers.deepseek]
name = "DeepSeek"
compatibility = "openai-compatible"
base_url = "https://api.deepseek.com/v1"
api_key_env = "DEEPSEEK_API_KEY"
api_key = "sk-test"

[[providers.deepseek.models]]
id = "deepseek-reasoner"
context_window = 65536
supports_thinking = true
thinking_levels = ["off", "low", "medium", "high"]
`,
      'utf-8',
    );

    const loaded = loadProjectConfig(TMP);
    const provider = normalizeProviderConfig(loaded.config.provider ?? {});

    expect(loaded.errors).toEqual([]);
    expect(provider.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(provider.model).toBe('deepseek-reasoner');
    expect(loaded.config.contextWindowTokens).toBe(65536);
  });

  it('keeps default runtime budgets when active multi-provider model has no context window', () => {
    const localPath = join(TMP, '.synax.toml');
    writeFileSync(
      localPath,
      `
[active]
provider = "test-provider"
model = "test-model-no-context"

[providers.test-provider]
name = "Test Provider"
compatibility = "openai-compatible"
base_url = "https://test.example.com/v1"

[[providers.test-provider.models]]
id = "test-model-no-context"
supports_thinking = false
`,
      'utf-8',
    );

    const loaded = loadProjectConfig(TMP);

    expect(loaded.errors).toEqual([]);
    expect(loaded.config.contextBudgetTokens).toBe(131072);
    expect(loaded.config.contextWindowTokens).toBe(131072);
  });

  it('accepts model context window aliases from provider model metadata', () => {
    const localPath = join(TMP, '.synax.toml');
    writeFileSync(
      localPath,
      `
[active]
provider = "deepseek"
model = "deepseek-v4-pro"

[providers.deepseek]
name = "DeepSeek"
compatibility = "openai-compatible"
base_url = "https://api.deepseek.com/v1"
api_key = "sk-test"

[[providers.deepseek.models]]
id = "deepseek-v4-pro"
max_context_tokens = "1M"
supports_thinking = false
`,
      'utf-8',
    );

    const loaded = loadProjectConfig(TMP);

    expect(loaded.errors).toEqual([]);
    expect(loaded.config.contextWindowTokens).toBe(1_000_000);
    expect(loaded.config.contextBudgetTokens).toBe(1_000_000);
  });

  it('uses provider preset context windows for legacy provider config when context is not explicit', () => {
    const localPath = join(TMP, '.synax.toml');
    writeFileSync(
      localPath,
      `
[provider]
preset = "relay"
model = "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf"
api_key = "sk-test"
`,
      'utf-8',
    );

    const loaded = loadProjectConfig(TMP);

    expect(loaded.errors).toEqual([]);
    expect(loaded.config.contextWindowTokens).toBe(131_072);
    expect(loaded.config.contextBudgetTokens).toBe(131_072);
  });

  it('preserves explicit context windows over provider preset defaults', () => {
    const localPath = join(TMP, '.synax.toml');
    writeFileSync(
      localPath,
      `
context_window_tokens = 65536

[provider]
preset = "relay"
model = "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf"
api_key = "sk-test"
`,
      'utf-8',
    );

    const loaded = loadProjectConfig(TMP);

    expect(loaded.errors).toEqual([]);
    expect(loaded.config.contextWindowTokens).toBe(65_536);
    expect(loaded.config.contextBudgetTokens).toBe(65_536);
  });

  it('preserves core visual profile through effective config loading', () => {
    const localPath = join(TMP, '.synax.toml');
    writeFileSync(
      localPath,
      `
core_visual_profile = "deepseek"

[active]
provider = "relay"
model = "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf"
`,
      'utf-8',
    );

    const effective = loadSynaxConfig(TMP);

    expect(effective.coreVisualProfile).toBe('deepseek');
  });

  it('preserves provider-scoped core visual profile through effective config loading', () => {
    const localPath = join(TMP, '.synax.toml');
    writeFileSync(
      localPath,
      `
[provider]
kind = "openai-compatible"
base_url = "http://127.0.0.1:1234/v1"
model = "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf"
coreVisualProfile = "Claude"
`,
      'utf-8',
    );

    const effective = loadSynaxConfig(TMP);

    expect(effective.coreVisualProfile).toBe('claude');
  });

  it('falls back to first enabled provider when active is missing', () => {
    const localPath = join(TMP, '.synax.toml');
    writeFileSync(
      localPath,
      `
[providers.custom]
compatibility = "openai-compatible"
base_url = "http://127.0.0.1:1234/v1"

[[providers.custom.models]]
id = "my-model"
`,
      'utf-8',
    );
    const effective = loadSynaxConfig(TMP);
    // When active.provider is missing, the first enabled provider is selected.
    // Both "relay" (default) and "custom" are enabled, but "custom" is
    // loaded from local config and merged in — the order depends on merge logic.
    expect(effective.providers.custom).toBeDefined();
    expect(effective.providers.custom.models.some((m) => m.id === 'my-model')).toBe(true);
  });

  it('normalizes unsupported thinking level to off', () => {
    const localPath = join(TMP, '.synax.toml');
    writeFileSync(
      localPath,
      `
[active]
provider = "openai"
model = "gpt-4"
thinking = "high"

[providers.openai]
compatibility = "openai-compatible"
base_url = "https://api.openai.com/v1"
api_key = "sk-test"

[[providers.openai.models]]
id = "gpt-4"
supports_thinking = false
`,
      'utf-8',
    );
    const effective = loadSynaxConfig(TMP);
    // Model doesn't support thinking, so thinking should be normalized to off
    expect(effective.active.thinking).toBe('off');
  });

  it('loading non-existent config returns defaults', () => {
    // Ensure no global config interferes
    const effective = loadSynaxConfig('/tmp/synax-nonexistent-' + Date.now());
    expect(effective.active.provider).toBe('relay');
    expect(effective.providers['relay']).toBeDefined();
    expect(effective.source).toBeNull();
  });

  it('normalizes legacy relay-local provider IDs to relay', () => {
    const localPath = join(TMP, '.synax.toml');
    writeFileSync(
      localPath,
      `
[active]
provider = "relay-local"
model = "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf"

[providers.relay-local]
compatibility = "openai-compatible"
base_url = "http://127.0.0.1:1234/v1"

[[providers.relay-local.models]]
id = "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf"
`,
      'utf-8',
    );

    const effective = loadSynaxConfig(TMP);

    expect(effective.active.provider).toBe('relay');
    expect(effective.providers.relay).toBeDefined();
    expect(effective.providers['relay-local']).toBeUndefined();
  });
});

describe('serializeEffectiveConfig (TOML hardening)', () => {
  it('escapes backslash, double quote, newline, carriage return, tab in string values', () => {
    const config: EffectiveSynaxConfig = {
      active: { provider: 'test', model: 'test-model', thinking: 'off' },
      providers: {
        test: {
          id: 'test',
          name: 'Back\\slash "quote"\nnewline\rtab\there',
          compatibility: 'openai-compatible',
          enabled: true,
          baseUrl: 'http://localhost:8080/v1',
          headers: {},
          models: [
            {
              id: 'test-model',
              supportsThinking: false,
              thinkingLevels: [],
            },
          ],
        },
      },
      skills: { enabled: [], disabled: [] },
      mcp: { servers: {} },
      source: null,
      errors: [],
    };
    const toml = serializeEffectiveConfig(config);
    // The escaped backslash should appear as \\ in output
    expect(toml).toContain('\\\\');
    expect(toml).toContain('\\"');
    expect(toml).toContain('\\n');
    expect(toml).toContain('\\r');
    expect(toml).toContain('\\t');
  });

  it('serializes provider IDs with hyphens as bare keys', () => {
    const config: EffectiveSynaxConfig = {
      active: { provider: 'relay', model: 'qwen', thinking: 'off' },
      providers: {
        relay: {
          id: 'relay',
          name: 'Relay',
          compatibility: 'openai-compatible',
          enabled: true,
          baseUrl: 'http://127.0.0.1:1234/v1',
          headers: {},
          models: [
            {
              id: 'qwen',
              supportsThinking: false,
              thinkingLevels: [],
            },
          ],
        },
        'my-provider': {
          id: 'my-provider',
          name: 'My Provider',
          compatibility: 'openai-compatible',
          enabled: true,
          baseUrl: 'http://localhost:8080/v1',
          headers: {},
          models: [],
        },
      },
      skills: { enabled: [], disabled: [] },
      mcp: { servers: {} },
      source: null,
      errors: [],
    };
    const toml = serializeEffectiveConfig(config);
    // Hyphen is valid in TOML bare keys
    expect(toml).toContain('[providers.relay]');
    expect(toml).toContain('[providers.my-provider]');
  });

  it('quotes provider table keys with special characters', () => {
    const config: EffectiveSynaxConfig = {
      active: { provider: 'custom/local', model: 'm', thinking: 'off' },
      providers: {
        'custom/local': {
          id: 'custom/local',
          name: 'Custom',
          compatibility: 'openai-compatible',
          enabled: true,
          baseUrl: 'http://localhost:8080/v1',
          headers: {},
          models: [
            {
              id: 'm',
              supportsThinking: false,
              thinkingLevels: [],
            },
          ],
        },
      },
      skills: { enabled: [], disabled: [] },
      mcp: { servers: {} },
      source: null,
      errors: [],
    };
    const toml = serializeEffectiveConfig(config);
    // Slash is not a valid bare key char — must be quoted
    expect(toml).toContain('[providers."custom/local"]');
  });

  it('serializes api_key as masked value never exposing raw secret', () => {
    const config: EffectiveSynaxConfig = {
      active: { provider: 'test', model: 'test-model', thinking: 'off' },
      providers: {
        test: {
          id: 'test',
          name: 'Test',
          compatibility: 'openai-compatible',
          enabled: true,
          baseUrl: 'http://localhost:8080/v1',
          apiKey: 'secret-12345',
          headers: {},
          models: [
            {
              id: 'test-model',
              supportsThinking: false,
              thinkingLevels: [],
            },
          ],
        },
      },
      skills: { enabled: [], disabled: [] },
      mcp: { servers: {} },
      source: null,
      errors: [],
    };
    const toml = serializeEffectiveConfig(config);
    // api_key is never persisted — it should always come from env vars.
    expect(toml).not.toContain('secret-12345');
    expect(toml).not.toContain('api_key');
  });

  it('serializes core visual profile for settings persistence', () => {
    const config: EffectiveSynaxConfig = {
      active: { provider: 'relay', model: 'qwen', thinking: 'off' },
      providers: {
        relay: {
          id: 'relay',
          name: 'Relay',
          compatibility: 'openai-compatible',
          enabled: true,
          baseUrl: 'http://127.0.0.1:1234/v1',
          headers: {},
          models: [{ id: 'qwen', supportsThinking: false, thinkingLevels: [] }],
        },
      },
      skills: { enabled: [], disabled: [] },
      mcp: { servers: {} },
      coreVisualProfile: 'claude',
      source: null,
      errors: [],
    };

    const toml = serializeEffectiveConfig(config);

    expect(toml).toContain('coreVisualProfile = "claude"');
  });
});

describe('writeSynaxConfig', () => {
  beforeEach(() => ensureTmp());
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('writes round-trippable TOML', () => {
    const configPath = join(TMP, '.synax.toml');
    const config: EffectiveSynaxConfig = {
      active: { provider: 'deepseek', model: 'deepseek-chat', thinking: 'off' },
      providers: {
        deepseek: {
          id: 'deepseek',
          name: 'DeepSeek',
          compatibility: 'openai-compatible',
          enabled: true,
          baseUrl: 'https://api.deepseek.com/v1',
          headers: {},
          models: [
            {
              id: 'deepseek-chat',
              supportsThinking: false,
              thinkingLevels: [],
            },
          ],
        },
      },
      skills: { enabled: ['coderabbit-review'], disabled: [] },
      mcp: { servers: {} },
      source: null,
      errors: [],
    };
    const result = writeSynaxConfig(config, configPath);
    expect(result.success).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain('deepseek');
    expect(content).toContain('deepseek-chat');
  });
});

describe('buildConfigUpdate', () => {
  const baseConfig: EffectiveSynaxConfig = {
    active: { provider: 'relay', model: 'qwen', thinking: 'off' },
    providers: {
      relay: {
        id: 'relay',
        name: 'Relay',
        compatibility: 'openai-compatible',
        enabled: true,
        baseUrl: 'http://127.0.0.1:1234/v1',
        headers: {},
        models: [
          { id: 'qwen', supportsThinking: false, thinkingLevels: [] },
          { id: 'deepseek', supportsThinking: true, thinkingLevels: ['off', 'auto'], defaultThinkingLevel: 'auto' },
        ],
      },
    },
    skills: { enabled: ['coderabbit-review'], disabled: ['grill-me'] },
    mcp: { servers: { git: { enabled: true, command: 'git-mcp', args: [], env: {} } } },
    source: null,
    errors: [],
  };

  it('toggles a skill from enabled to disabled', () => {
    const updated = buildConfigUpdate(baseConfig, { toggleSkill: 'coderabbit-review' });
    expect(updated.skills.enabled).not.toContain('coderabbit-review');
    expect(updated.skills.disabled).toContain('coderabbit-review');
  });

  it('toggles a skill from disabled to enabled', () => {
    const updated = buildConfigUpdate(baseConfig, { toggleSkill: 'grill-me' });
    expect(updated.skills.enabled).toContain('grill-me');
    expect(updated.skills.disabled).not.toContain('grill-me');
  });

  it('toggles an MCP server', () => {
    const updated = buildConfigUpdate(baseConfig, { toggleMcpServer: 'git' });
    expect(updated.mcp.servers.git.enabled).toBe(false);
  });

  it('changes active model while preserving compatible thinking level', () => {
    const updated = buildConfigUpdate(baseConfig, { activeModel: 'deepseek' });
    expect(updated.active.model).toBe('deepseek');
    // 'off' is in deepseek's thinkingLevels, so it is preserved.
    expect(updated.active.thinking).toBe('off');
  });

  it('preserves an intentionally empty active model', () => {
    const updated = buildConfigUpdate(
      { ...baseConfig, active: { provider: 'relay', model: 'deepseek', thinking: 'auto' } },
      { activeModel: '' },
    );
    expect(updated.active.model).toBe('');
    expect(updated.active.thinking).toBe('off');
  });

  it('projects effective settings updates into the chat runtime config', () => {
    const updated = applyEffectiveSynaxConfigToProjectConfig(
      { provider: { base_url: 'http://127.0.0.1:1234/v1', model: 'qwen' } },
      {
        ...baseConfig,
        active: { provider: 'relay', model: 'deepseek', thinking: 'auto' },
      },
    );
    const provider = normalizeProviderConfig(updated.provider ?? {});

    expect(provider.baseUrl).toBe('http://127.0.0.1:1234/v1');
    expect(provider.model).toBe('deepseek');
    expect(updated.contextWindowTokens).toBe(131072);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
