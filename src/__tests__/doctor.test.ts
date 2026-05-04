/**
 * Tests for the doctor command.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

import {
  runDoctor,
  formatReport,
  checkGitRepository,
  checkConfig,
  checkPackageManager,
  checkContextBudget,
  checkConfiguredCommands,
  detectPackageManager,
  type DoctorFullReport,
} from '../commands/doctor';

const TMP = join(__dirname, '..', '..', '..', 'tmp', 'synax-doctor-tests');

function ensureTmp() {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true });
  }
  mkdirSync(TMP, { recursive: true });
}

describe('checkGitRepository', () => {
  it('returns pass when inside a git repository', () => {
    const result = checkGitRepository();
    expect(result.status).toBe('pass');
    expect(result.message).toBe('Inside a git repository');
  });
});

describe('detectPackageManager', () => {
  beforeEach(() => ensureTmp());
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('returns a package manager object when one is available', () => {
    const result = detectPackageManager();
    // On this system, at least one of npm/yarn/pnpm/bun should be available
    expect(result).not.toBeNull();
  });
});

describe('checkPackageManager', () => {
  it('returns pass when a package manager is detected', () => {
    const result = checkPackageManager();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('Detected');
  });
});

describe('checkContextBudget', () => {
  it('returns warn for budget below 4000', () => {
    const result = checkContextBudget({ contextBudgetTokens: 2000 });
    expect(result.status).toBe('warn');
    expect(result.message).toContain('below the recommended minimum');
  });

  it('returns warn for budget above 128000', () => {
    const result = checkContextBudget({ contextBudgetTokens: 200000 });
    expect(result.status).toBe('warn');
    expect(result.message).toContain('above typical local model limits');
  });

  it('returns warn for no budget configured', () => {
    const result = checkContextBudget({});
    expect(result.status).toBe('warn');
    expect(result.message).toContain('No contextBudgetTokens configured');
  });
});

describe('checkConfig', () => {
  beforeEach(() => ensureTmp());
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('returns pass when config file exists', () => {
    const configPath = join(TMP, '.synax.toml');
    writeFileSync(configPath, 'model = "test-model"\ncontextBudgetTokens = 8000', 'utf-8');
    const result = checkConfig(TMP);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('Loaded from');
  });

  it('returns warn when no config file exists', () => {
    const result = checkConfig(TMP);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('No .synax.toml found');
  });
});

describe('checkConfiguredCommands', () => {
  it('returns pass when defaultVerificationCommand succeeds', () => {
    const config = { verification: { defaultCommand: 'true' } };
    const result = checkConfiguredCommands(config);
    expect(result.status).toBe('pass');
  });
});

describe('runDoctor', () => {
  beforeEach(() => ensureTmp());
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('returns a report with git-repository and package-manager checks', async () => {
    const report = await runDoctor('quick', TMP);
    expect(report.repo).toBeDefined();
    expect(report.packageManager).toBeDefined();
    expect(report.repo.check).toBe('git-repository');
    expect(report.packageManager.check).toBe('package-manager');
  });

  it('includes config check in report', async () => {
    const report = await runDoctor('quick', TMP);
    expect(report.config).toBeDefined();
    expect(report.config.check).toBe('config');
  });

  it('includes context-budget check in report', async () => {
    const report = await runDoctor('quick', TMP);
    expect(report.contextBudget).toBeDefined();
    expect(report.contextBudget.check).toBe('context-budget');
  });

  it('full mode includes all checks', async () => {
    const report = await runDoctor('full', TMP);
    expect(report.repo).toBeDefined();
    expect(report.config).toBeDefined();
    expect(report.providerReachability).toBeDefined();
    expect(report.modelRequest).toBeDefined();
    expect(report.packageManager).toBeDefined();
    expect(report.configuredCommands).toBeDefined();
    expect(report.contextBudget).toBeDefined();
    expect(report.relayHealth).toBeDefined();
  });
});

describe('formatReport', () => {
  it('produces output containing summary line', () => {
    const emptyReport: DoctorFullReport = {
      repo: { check: 'git-repository', status: 'pass', message: 'Inside a git repository' },
      config: { check: 'config', status: 'warn', message: 'No .synax.toml found' },
      providerReachability: { check: 'provider-reachability', status: 'skip', message: undefined },
      modelRequest: { check: 'model-request', status: 'skip', message: undefined },
      packageManager: { check: 'package-manager', status: 'pass', message: 'Detected npm v10.0.0' },
      configuredCommands: { check: 'configured-commands', status: 'skip', message: undefined },
      contextBudget: { check: 'context-budget', status: 'pass', message: 'contextBudgetTokens set to 16000' },
      relayHealth: { check: 'relay-health', status: 'skip', message: undefined },
    };

    const output = formatReport(emptyReport);
    expect(output).toContain('Synax Doctor Report');
    expect(output).toContain('Summary:');
    expect(output).toContain('passed');
    expect(output).toContain('failed');
    expect(output).toContain('warnings');
    expect(output).toContain('skipped');
  });
});