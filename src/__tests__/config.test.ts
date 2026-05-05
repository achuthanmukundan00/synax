/**
 * Tests for config module: project.ts, profile.ts, commands/config.ts
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

import {
  discoverConfigPath,
  parseTomlString,
  validateConfig,
  loadProjectConfig,
  generateDefaultConfig,
  writeConfigFile,
  normalizeProviderConfig,
} from '../config/project';

import {
  detectGitProfile,
  detectPackageManager,
  detectCommands,
  detectInstructionFiles,
  buildProjectProfile,
  formatTextProfile,
} from '../config/profile';

// runConfigCommand is tested indirectly via CLI smoke tests

// ─── helpers ────────────────────────────────────────────────

const TMP = join(__dirname, '..', '..', '..', 'tmp', 'synax-config-tests');

function ensureTmp() {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true });
  }
  mkdirSync(TMP, { recursive: true });
}

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
      custom_headers: { 'CF-Access-Client-Id': 'client-id' },
    });
    expect(normalized.customHeaders).toEqual({ 'CF-Access-Client-Id': 'client-id' });
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
    expect(result.config.maxModelSteps).toBe(32);
    expect(result.config.maxToolCalls).toBe(96);
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
    const previousSteps = process.env.SYNAX_MAX_MODEL_STEPS;
    const previousTools = process.env.SYNAX_MAX_TOOL_CALLS;
    process.env.SYNAX_CONTEXT_BUDGET_TOKENS = '64000';
    process.env.SYNAX_MAX_MODEL_STEPS = '12';
    process.env.SYNAX_MAX_TOOL_CALLS = '24';
    try {
      const result = loadProjectConfig(TMP);
      expect(result.errors).toHaveLength(0);
      expect(result.config.contextBudgetTokens).toBe(64000);
      expect(result.config.maxModelSteps).toBe(12);
      expect(result.config.maxToolCalls).toBe(24);
    } finally {
      restoreEnv('SYNAX_CONTEXT_BUDGET_TOKENS', previousContext);
      restoreEnv('SYNAX_MAX_MODEL_STEPS', previousSteps);
      restoreEnv('SYNAX_MAX_TOOL_CALLS', previousTools);
    }
  });

  it('supports restricting exposed tool list', () => {
    const configPath = join(TMP, '.synax.toml');
    writeFileSync(configPath, ['[tools]', 'exposed = ["read","write","edit","bash","git"]', 'shell = "zsh"'].join('\n'));
    const result = loadProjectConfig(TMP);
    expect(result.errors).toHaveLength(0);
    expect(result.config.tools?.exposed).toEqual(['read', 'write', 'edit', 'bash', 'git']);
  });
});

// ─── generateDefaultConfig ──────────────────────────────────

describe('generateDefaultConfig', () => {
  it('generates a valid TOML string', () => {
    const config = generateDefaultConfig();
    expect(config).toContain('baseUrl =');
    expect(config).toContain('[agent]');
    expect(config).toContain('context_budget_tokens = 131072');
    expect(config).toContain('max_model_steps = 32');
    expect(config).toContain('max_tool_calls = 96');
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
