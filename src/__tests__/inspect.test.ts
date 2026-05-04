/**
 * Tests for inspect command and project profile module.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

import {
  detectGitProfile,
  detectPackageManager,
  detectCommands,
  detectInstructionFiles,
  buildProjectProfile,
  formatTextProfile,
} from '../config/profile';

import {
  loadProjectConfig,
} from '../config/project';

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
    writeFileSync(
      join(TMP, 'package.json'),
      JSON.stringify({ scripts: { test: 'jest', lint: 'eslint .' } }),
      'utf-8'
    );
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
    writeFileSync(
      join(TMP, 'package.json'),
      JSON.stringify({ scripts: { test: 'jest', lint: 'eslint .' } }),
      'utf-8'
    );
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
    const { mkdirSync, rmSync, existsSync } = require('fs');
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