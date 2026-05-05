/**
 * Tests for inspect command and project profile module.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

import {
  detectGitProfile,
  detectPackageManager,
  detectCommands,
  detectInstructionFiles,
  buildProjectProfile,
  formatTextProfile,
} from '../config/profile';

import { loadProjectConfig } from '../config/project';
import {
  buildInspectConfigProfile,
  saveLedgerToDisk,
  loadLedgerFromDisk,
  PROJECT_CONTEXT_PATH,
  writeProjectContext,
} from '../commands/inspect';
import { createContextLedger } from '../tools';

// ─── helpers ────────────────────────────────────────────────

const TMP = join(__dirname, '..', '..', '..', 'tmp', 'synax-inspect-tests');

function ensureTmp() {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true });
  }
  mkdirSync(TMP, { recursive: true });
}

// ─── buildProjectProfile ────────────────────────────────────

describe('buildProjectProfile', () => {
  beforeEach(() => ensureTmp());
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('returns git info when inside a git repo', () => {
    const profile = buildProjectProfile(TMP);
    if (profile.git) {
      expect(typeof profile.git.root).toBe('string');
      expect(typeof profile.git.branch).toBe('string');
    }
  });

  it('detects package manager from lockfile', () => {
    writeFileSync(join(TMP, 'package-lock.json'), '{}', 'utf-8');
    const result = detectPackageManager(TMP);
    expect(result.name).toBe('npm');
  });

  it('detects commands from package.json', () => {
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({ scripts: { test: 'jest', lint: 'eslint .' } }), 'utf-8');
    const result = detectCommands(TMP);
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });

  it('detects instruction files', () => {
    writeFileSync(join(TMP, 'README.md'), '# Test', 'utf-8');
    const result = detectInstructionFiles(TMP);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── formatTextProfile ──────────────────────────────────────

describe('formatTextProfile', () => {
  beforeEach(() => ensureTmp());
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('formats profile as readable text', () => {
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
    expect(formatted).toContain('Synax Project Profile');
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

  it('detects yarn from yarn.lock', () => {
    writeFileSync(join(TMP, 'yarn.lock'), '', 'utf-8');
    expect(detectPackageManager(TMP).name).toBe('yarn');
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
    const result = detectCommands(TMP);
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

// ─── loadProjectConfig (inspect-related) ────────────────────

describe('loadProjectConfig for inspect', () => {
  beforeEach(() => ensureTmp());
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('returns defaults when no config file', () => {
    const tmpDir = join(__dirname, '..', '..', '..', 'tmp', 'synax-inspect-defaults');
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    try {
      const result = loadProjectConfig(tmpDir);
      expect(result.source).toBe('default');
    } finally {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns parsed config when file exists', () => {
    const configPath = join(TMP, '.synax.toml');
    writeFileSync(configPath, 'model = "test-model"\ncontextBudgetTokens = 2000', 'utf-8');
    const result = loadProjectConfig(configPath);
    expect(result.source).toBe('file');
    expect(result.config.model).toBe('test-model');
  });
});

// ─── inspect secret handling ────────────────────────────────

describe('inspect secret handling', () => {
  beforeEach(() => ensureTmp());
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('reports .synax.toml as skipped metadata without reading secret values', () => {
    writeFileSync(
      join(TMP, '.synax.toml'),
      [
        '[provider]',
        'api_key = "sk-never-print-this"',
        'base_url = "http://127.0.0.1:1234/v1"',
        'model = "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf"',
      ].join('\n'),
      'utf-8',
    );

    const profile = buildInspectConfigProfile(TMP);
    const output = formatTextProfile({
      project: buildProjectProfile(TMP),
      config: profile,
    });

    expect(output).not.toContain('sk-never-print-this');
    expect(output).toContain('.synax.toml');
    expect(output).toContain('skipped secret-bearing file');
  });
});

// ─── inspect project context handoff ────────────────────────

describe('inspect project context handoff', () => {
  beforeEach(() => ensureTmp());
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('writes a safe project context file', () => {
    const profile = {
      project: buildProjectProfile(TMP),
      config: buildInspectConfigProfile(TMP),
    };

    const contextPath = writeProjectContext(TMP, profile);

    expect(contextPath).toBe(join(TMP, PROJECT_CONTEXT_PATH));
    expect(existsSync(contextPath)).toBe(true);
    const raw = readFileSync(contextPath, 'utf-8');
    const parsed = JSON.parse(raw) as { profileText?: string; profile?: unknown };
    expect(parsed.profileText).toContain('Synax Project Profile');
    expect(parsed.profile).toEqual(profile);
  });

  it('does not write .synax.toml secret values to project context', () => {
    writeFileSync(
      join(TMP, '.synax.toml'),
      [
        '[provider]',
        'api_key = "sk-never-write-this"',
        'base_url = "http://127.0.0.1:1234/v1"',
        'model = "secret-model-name"',
      ].join('\n'),
      'utf-8',
    );
    const profile = {
      project: buildProjectProfile(TMP),
      config: buildInspectConfigProfile(TMP),
    };

    const contextPath = writeProjectContext(TMP, profile);
    const raw = readFileSync(contextPath, 'utf-8');

    expect(raw).not.toContain('sk-never-write-this');
    expect(raw).not.toContain('secret-model-name');
    expect(raw).toContain('.synax.toml');
    expect(raw).toContain('skipped secret-bearing file');
  });
});

// ─── Ledger save/load ──────────────────────────────────────

describe('ledger save and load from disk', () => {
  beforeEach(() => ensureTmp());
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('round-trips a full ledger entry through JSON', () => {
    const ledger = createContextLedger();
    ledger.setTask('refactor auth module');
    ledger.setBudget(16000);
    ledger.recordInstructionSource('system', { included: true, approximateTokens: 500 });
    ledger.recordFile('src/auth.ts', {
      lineRange: { start: 1, end: 50 },
      truncated: false,
      summarized: false,
      approximateTokens: 800,
    });
    ledger.recordCommand('git status --short', { truncated: true, approximateTokens: 200 });
    ledger.recordSummary('previous task', { approximateTokens: 300 });
    ledger.recordTokenUsage(9500);
    ledger.recordTruncation('src/large.ts', 'exceeded line limit');
    ledger.recordOmission('vendor/pkg', 'blocked path');

    const ledgerPath = join(TMP, '.synax-ledger.json');
    saveLedgerToDisk(ledger, ledgerPath);
    expect(existsSync(ledgerPath)).toBe(true);

    const loaded = loadLedgerFromDisk(ledgerPath);
    expect(loaded).not.toBeNull();

    const expanded = loaded!.getExpanded();
    expect(expanded.task).toBe('refactor auth module');
    expect(expanded.budget.total).toBe(16000);
    expect(expanded.budget.used).toBe(9500);
    expect(expanded.instructionSources[0].name).toBe('system');
    expect(expanded.files[0].path).toBe('src/auth.ts');
    expect(expanded.files[0].lineRange).toEqual({ start: 1, end: 50 });
    expect(expanded.commands[0].command).toBe('git status --short');
    expect(expanded.commands[0].truncated).toBe(true);
    expect(expanded.summaries[0].source).toBe('previous task');
    expect(expanded.truncations[0]).toEqual({ location: 'src/large.ts', reason: 'exceeded line limit' });
    expect(expanded.omissions[0]).toEqual({ location: 'vendor/pkg', reason: 'blocked path' });
  });

  it('returns null when ledger file does not exist', () => {
    const nonExistent = join(TMP, '.synax-ledger.json');
    expect(loadLedgerFromDisk(nonExistent)).toBeNull();
  });

  it('handles invalid JSON gracefully', () => {
    const badPath = join(TMP, '.synax-ledger-invalid.json');
    writeFileSync(badPath, 'not valid json {[[[', 'utf-8');
    expect(loadLedgerFromDisk(badPath)).toBeNull();
  });

  it('handles empty ledger file gracefully', () => {
    const emptyPath = join(TMP, '.synax-ledger-empty.json');
    writeFileSync(emptyPath, '', 'utf-8');
    expect(loadLedgerFromDisk(emptyPath)).toBeNull();
  });

  it('round-trips an empty ledger', () => {
    const ledger = createContextLedger();

    const ledgerPath = join(TMP, '.synax-ledger-empty.json');
    saveLedgerToDisk(ledger, ledgerPath);

    const loaded = loadLedgerFromDisk(ledgerPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.getExpanded().task).toBeNull();
    expect(loaded!.getExpanded().instructionSources).toHaveLength(0);
  });
});
