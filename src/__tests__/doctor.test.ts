/**
 * Tests for the doctor command.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { join } from 'path';
import { tmpdir } from 'os';

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

const TMP = join(tmpdir(), 'synax-doctor-tests');
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

interface MockRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

function createMockServer(handler: (req: MockRequest, res: ServerResponse<IncomingMessage>) => void): Promise<Server> {
  const srv = createServer((req, res) => {
    const chunks: string[] = [];
    req.on('data', (c) => chunks.push(String(c)));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
      handler(
        {
          method: req.method ?? '',
          path: new URL(req.url ?? '/', 'http://localhost').pathname,
          headers,
          body: chunks.join(''),
        },
        res,
      );
    });
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      srv.off('error', reject);
      resolve(srv);
    });
  });
}

function getServerUrl(srv: Server): string {
  const addr = srv.address();
  if (addr && typeof addr === 'object' && 'port' in addr) return `http://127.0.0.1:${addr.port}`;
  throw new Error('Could not get server port');
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

  it('accepts the 131072-token high-context local profile', () => {
    const result = checkContextBudget({ contextBudgetTokens: 131072, maxModelSteps: 64, maxToolCalls: 192 });
    expect(result.status).toBe('pass');
    expect(result.message).toContain('contextBudgetTokens set to 131072');
    expect(result.message).toContain('modelSteps unlimited');
    expect(result.message).toContain('maxToolCalls set to 192');
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

  it('does not treat unauthenticated base URL failures as final provider truth when chat works', async () => {
    const srv = await createMockServer((req, res) => {
      if (req.path === '/v1/models') {
        expect(req.headers['x-custom-header']).toBe('test-value');
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'models endpoint unavailable' } }));
        return;
      }

      if (req.path === '/v1/chat/completions') {
        expect(req.headers['x-custom-header']).toBe('test-value');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'test-model',
            choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          }),
        );
        return;
      }

      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
    });
    try {
      writeFileSync(
        join(TMP, '.synax.toml'),
        [
          '[provider]',
          'kind = "openai-compatible"',
          `base_url = "${getServerUrl(srv)}/v1"`,
          'model = "test-model"',
          'timeout_seconds = 1',
          '',
          '[provider.custom_headers]',
          '"X-Custom-Header" = "test-value"',
        ].join('\n'),
        'utf-8',
      );

      const report = await runDoctor('full', TMP);
      expect(report.modelRequest.status).toBe('pass');
      expect(report.providerReachability.status).not.toBe('fail');
      expect(report.providerReachability.message).not.toContain('403');
    } finally {
      srv.close();
    }
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
      contextBudget: {
        check: 'context-budget',
        status: 'pass',
        message: 'contextBudgetTokens set to 131072; modelSteps unlimited; maxToolCalls set to 192',
      },
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
