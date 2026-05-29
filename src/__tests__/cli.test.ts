import { execFile, execSync } from 'child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const SYNAX_BIN = path.resolve(__dirname, '../../dist/cli.js');

function runSynax(args: string[], options: { cwd?: string; timeout?: number } = {}): string {
  try {
    const cmd = `bun "${SYNAX_BIN}" ${args.map((a) => `'${a}'`).join(' ')}`;
    const home = options.cwd ? path.join(options.cwd, '.home') : process.env.HOME;
    return execSync(cmd, {
      cwd: options.cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      timeout: options.timeout ?? 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trimEnd();
  } catch (error: unknown) {
    if (error instanceof Error) {
      const err = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
      const stdout = typeof err.stdout === 'string' ? err.stdout : err.stdout?.toString();
      const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString();
      return stdout?.trimEnd() ?? stderr?.trimEnd() ?? error.message;
    }
    return String(error);
  }
}

function runSynaxDetailed(args: string[], options: { cwd?: string; timeout?: number } = {}) {
  const home = options.cwd ? path.join(options.cwd, '.home') : process.env.HOME;
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      'bun',
      [SYNAX_BIN, ...args],
      {
        cwd: options.cwd,
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: 'utf8',
        timeout: options.timeout ?? 15000,
      },
      (error, stdout, stderr) => {
        resolve({
          status: error && 'code' in error && typeof error.code === 'number' ? error.code : 0,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
        });
      },
    );
  });
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

function closeServer(srv: Server): Promise<void> {
  return new Promise((resolve) => {
    srv.close(() => resolve());
  });
}

function getServerUrl(srv: Server): string {
  const addr = srv.address();
  if (addr && typeof addr === 'object' && 'port' in addr) return `http://127.0.0.1:${addr.port}`;
  throw new Error('Could not get server port');
}

describe('CLI', () => {
  describe('synax --help', () => {
    test('should show help with all commands', () => {
      const output = runSynax(['--help']);
      expect(output).toContain('synax');
      expect(output).toContain('chat');
      expect(output).toContain('ask');
      expect(output).toContain('run');
      expect(output).toContain('inspect');
      expect(output).toContain('config');
      expect(output).toContain('doctor');
    });
  });

  describe('synax chat', () => {
    test('should initialize chat mode', () => {
      const output = runSynax(['chat']);
      expect(output).toContain('[synax] Chat initialized');
      expect(output).toContain('Synax');
      expect(output).toContain('/settings');
    });

    test('should initialize chat mode before hosted-provider credentials are configured', () => {
      const cwd = mkdtempSync(path.join(tmpdir(), 'synax-cli-chat-provider-'));
      const originalKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        writeFileSync(
          path.join(cwd, '.synax.toml'),
          ['[active]', 'provider = "anthropic"', 'model = "frontier-sonnet-4-20250514"'].join('\n'),
          'utf-8',
        );
        const output = runSynax(['chat'], { cwd });
        expect(output).toContain('[synax] Chat initialized');
        expect(output).toContain('Synax');
        expect(output).toContain('/settings');
      } finally {
        if (originalKey === undefined) {
          delete process.env.ANTHROPIC_API_KEY;
        } else {
          process.env.ANTHROPIC_API_KEY = originalKey;
        }
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('should accept --message option', () => {
      const cwd = mkdtempSync(path.join(tmpdir(), 'synax-cli-chat-'));
      try {
        writeFileSync(
          path.join(cwd, '.synax.toml'),
          [
            '[provider]',
            'kind = "openai-compatible"',
            'base_url = "http://127.0.0.1:9/v1"',
            'model = "test-model"',
            'timeout_seconds = 1',
          ].join('\n'),
          'utf-8',
        );
        const output = runSynax(['chat', '--message', 'hello'], { cwd, timeout: 5000 });
        expect(output).toContain('hello');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('synax ask', () => {
    test('should show placeholder without arguments', () => {
      const output = runSynax(['ask']);
      expect(output).toContain('[synax] Ask command initialized');
    });

    test('should call the provider client and print returned content for --question', async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), 'synax-cli-ask-'));
      const srv = await createMockServer((req, res) => {
        expect(req.method).toBe('POST');
        expect(req.path).toBe('/v1/chat/completions');
        expect(req.headers['x-custom-header']).toBe('test-value');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'test-model',
            choices: [{ message: { role: 'assistant', content: '  synax-ok  ' }, finish_reason: 'stop' }],
          }),
        );
      });
      try {
        writeFileSync(
          path.join(cwd, '.synax.toml'),
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
        const result = await runSynaxDetailed(['ask', '--question', 'Reply with exactly: synax-ok'], { cwd });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('[model] test-model');
        expect(result.stdout).toContain('[mode]');
        expect(result.stdout).toContain('synax-ok');
        expect(result.stderr).toBe('');
      } finally {
        await closeServer(srv);
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('should refuse repo-specific questions without loaded project context', async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), 'synax-cli-ask-no-context-'));
      let requestCount = 0;
      const srv = await createMockServer((_req, res) => {
        requestCount += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'test-model',
            choices: [{ message: { role: 'assistant', content: 'fabricated repo details' }, finish_reason: 'stop' }],
          }),
        );
      });
      try {
        writeFileSync(
          path.join(cwd, '.synax.toml'),
          [
            '[provider]',
            'kind = "openai-compatible"',
            `base_url = "${getServerUrl(srv)}/v1"`,
            'model = "test-model"',
          ].join('\n'),
          'utf-8',
        );
        const result = await runSynaxDetailed(['ask', '--question', 'Describe the contents of this directory'], {
          cwd,
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('fabricated repo details');
        expect(result.stderr).toBe('');
        expect(requestCount).toBe(1);
      } finally {
        await closeServer(srv);
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('should refuse validation-command questions without loaded project context', async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), 'synax-cli-ask-no-context-command-'));
      let requestCount = 0;
      const srv = await createMockServer((_req, res) => {
        requestCount += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'test-model',
            choices: [{ message: { role: 'assistant', content: 'run npm test' }, finish_reason: 'stop' }],
          }),
        );
      });
      try {
        writeFileSync(
          path.join(cwd, '.synax.toml'),
          [
            '[provider]',
            'kind = "openai-compatible"',
            `base_url = "${getServerUrl(srv)}/v1"`,
            'model = "test-model"',
          ].join('\n'),
          'utf-8',
        );
        const result = await runSynaxDetailed(
          ['ask', '--question', 'What validation command should I run for this repo?'],
          {
            cwd,
          },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('run npm test');
        expect(result.stderr).toBe('');
        expect(requestCount).toBe(1);
      } finally {
        await closeServer(srv);
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('should include inspect profile for repo-specific questions when context exists', async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), 'synax-cli-ask-context-'));
      let requestBody = '';
      const srv = await createMockServer((req, res) => {
        requestBody = req.body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'test-model',
            choices: [{ message: { role: 'assistant', content: 'profile-grounded answer' }, finish_reason: 'stop' }],
          }),
        );
      });
      try {
        writeFileSync(
          path.join(cwd, 'package.json'),
          JSON.stringify({ scripts: { test: 'jest', build: 'tsc', synax: 'node dist/cli.js' } }),
          'utf-8',
        );
        execSync('git init', { cwd, stdio: 'ignore' });
        writeFileSync(
          path.join(cwd, '.synax.toml'),
          [
            '[provider]',
            'kind = "openai-compatible"',
            `base_url = "${getServerUrl(srv)}/v1"`,
            'model = "test-model"',
            'api_key = "sk-context-secret"',
          ].join('\n'),
          'utf-8',
        );
        runSynax(['inspect'], { cwd });

        const contextPath = path.join(cwd, '.synax', 'context.json');
        expect(existsSync(contextPath)).toBe(true);
        expect(readFileSync(contextPath, 'utf-8')).not.toContain('sk-context-secret');

        const result = await runSynaxDetailed(['ask', '--question', 'Summarize this project in 5 bullets.'], { cwd });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('profile-grounded answer');
        expect(result.stderr).toBe('');

        const parsed = JSON.parse(requestBody) as {
          messages: Array<{ role: string; content: string }>;
          tools: Array<{ function: { name: string } }>;
        };
        expect(parsed.messages[0].role).toBe('system');
        expect(parsed.messages[0].content).toContain('You are Suitcase');
        expect(parsed.tools.map((tool) => tool.function.name)).toEqual([
          'read',
          'write',
          'edit',
          'bash',
          'save_memory',
          'search_memory',
          'view_image',
        ]);
        expect(parsed.messages[0].content).not.toContain('sk-context-secret');
      } finally {
        await closeServer(srv);
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('should handle provider errors without leaking secrets', async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), 'synax-cli-ask-error-'));
      const srv = await createMockServer((_req, res) => {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'access denied' } }));
      });
      try {
        writeFileSync(
          path.join(cwd, '.synax.toml'),
          [
            '[provider]',
            'kind = "openai-compatible"',
            `base_url = "${getServerUrl(srv)}/v1"`,
            'model = "test-model"',
            'timeout_seconds = 1',
          ].join('\n'),
          'utf-8',
        );
        const result = await runSynaxDetailed(['ask', '--question', 'hello'], { cwd });
        const combined = `${result.stdout}\n${result.stderr}`;
        expect(result.status).not.toBe(0);
        expect(combined).toContain('Status: model_error');
        expect(combined).toContain('Provider error (403)');
        expect(combined).toContain('access denied');
        expect(combined).not.toContain('secret-api-key');
      } finally {
        await closeServer(srv);
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('synax run', () => {
    test('should show placeholder without arguments', () => {
      const output = runSynax(['run']);
      expect(output).toContain('[synax] Run command initialized');
    });

    test('should accept --task option without advertising disabled bash', async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), 'synax-cli-run-task-'));
      let requestBody = '';
      const srv = await createMockServer((req, res) => {
        requestBody = req.body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'test-model',
            choices: [{ message: { role: 'assistant', content: 'run complete' }, finish_reason: 'stop' }],
          }),
        );
      });
      try {
        writeFileSync(
          path.join(cwd, '.synax.toml'),
          [
            '[provider]',
            'kind = "openai-compatible"',
            `base_url = "${getServerUrl(srv)}/v1"`,
            'model = "test-model"',
            'timeout_seconds = 1',
          ].join('\n'),
          'utf-8',
        );
        const result = await runSynaxDetailed(['run', '--task', 'test task'], { cwd });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('run complete');
        expect(result.stdout).toContain('[summary] Status: completed');

        const parsed = JSON.parse(requestBody) as {
          tools: Array<{ function: { name: string } }>;
        };
        expect(parsed.tools.map((tool) => tool.function.name)).toEqual([
          'read',
          'write',
          'edit',
          'bash',
          'save_memory',
          'search_memory',
          'view_image',
        ]);
      } finally {
        await closeServer(srv);
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('should reject invalid --repair-attempts values cleanly', async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), 'synax-cli-run-repair-'));
      try {
        writeFileSync(
          path.join(cwd, '.synax.toml'),
          ['[provider]', 'kind = "openai-compatible"', 'base_url = "http://localhost/v1"', 'model = "test-model"'].join(
            '\n',
          ),
          'utf-8',
        );

        const invalid = await runSynaxDetailed(['run', '--task', 'test task', '--repair-attempts', 'nope'], { cwd });
        const negative = await runSynaxDetailed(['run', '--task', 'test task', '--repair-attempts', '-1'], { cwd });
        const large = await runSynaxDetailed(['run', '--task', 'test task', '--repair-attempts', '11'], { cwd });

        expect(invalid.status).not.toBe(0);
        expect(invalid.stderr).toContain('--repair-attempts must be a non-negative integer');
        expect(negative.status).not.toBe(0);
        expect(negative.stderr).toContain('--repair-attempts must be a non-negative integer');
        expect(large.status).not.toBe(0);
        expect(large.stderr).toContain('--repair-attempts must be between 0 and 10');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('should accept --plan option', () => {
      const output = runSynax(['run', '--plan', './plan.md']);
      expect(output).toContain('./plan.md');
      expect(output).toContain('Placeholder');
    });
  });

  describe('synax inspect', () => {
    test('should show full project profile without arguments (spec 002)', () => {
      const output = runSynax(['inspect']);
      expect(output).toContain('Synax Project Profile');
      expect(output).toContain('Package manager:');
    });

    test('should accept --profile option (spec 002)', () => {
      const output = runSynax(['inspect', '--profile']);
      expect(output).toContain('Synax Project Profile');
    });

    test('should accept --brief option (spec 002)', () => {
      const output = runSynax(['inspect', '--brief']);
      // Brief mode shows a condensed summary
      expect(output.length).toBeGreaterThan(0);
    });

    test('should show profile even in subdirectory paths', () => {
      const output = runSynax(['inspect', '--path', './src']);
      expect(output).toContain('Synax Project Profile');
    });

    test('should expose local docs listing and bounded reads', () => {
      const cwd = mkdtempSync(path.join(tmpdir(), 'synax-cli-inspect-docs-'));
      try {
        writeFileSync(
          path.join(cwd, 'README.md'),
          ['# Example', 'Authorization: Bearer sk-test-secret'].join('\n'),
          'utf-8',
        );

        const docsOutput = runSynax(['inspect', '--docs'], { cwd });
        expect(docsOutput).toContain('Synax Local Docs');
        expect(docsOutput).toContain('- README.md');

        const docOutput = runSynax(['inspect', '--doc', 'README.md'], { cwd });
        expect(docOutput).toContain('Synax Local Doc: README.md');
        expect(docOutput).toContain('1 | # Example');
        expect(docOutput).toContain('2 | Authorization: Bearer [REDACTED]');
        expect(docOutput).not.toContain('sk-test-secret');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('synax config', () => {
    test('config init should create config file or report existing', () => {
      const output = runSynax(['config', 'init']);
      // Config file already exists in this project, so it reports that
      expect(output).toContain('Config file');
    });

    test('config init should accept --force option', () => {
      const output = runSynax(['config', 'init', '--force']);
      expect(output.length).toBeGreaterThan(0);
    });

    test('config show should display effective config (spec 002)', () => {
      const output = runSynax(['config', 'show']);
      // Config show displays the full project profile
      expect(output).toContain('Synax Project Profile');
    });

    test('config show --path should show config from specific path (spec 002)', () => {
      const output = runSynax(['config', 'show', '--path', './']);
      expect(output).toContain('Synax Project Profile');
    });

    test('config get should retrieve a config value', () => {
      const output = runSynax(['config', 'get', 'model']);
      expect(output.length).toBeGreaterThan(0);
    });

    test('config get --key --json should output JSON', () => {
      const output = runSynax(['config', 'get', 'model', '--json']);
      expect(output.length).toBeGreaterThan(0);
    });
  });

  describe('synax doctor', () => {
    test('should show doctor report without arguments (quick mode)', () => {
      const output = runSynax(['doctor']);
      expect(output).toContain('Synax Doctor Report');
      expect(output).toContain('Summary:');
    });

    test('should accept --full option', () => {
      const output = runSynax(['doctor', '--full']);
      expect(output).toContain('Synax Doctor Report');
      expect(output).toContain('Summary:');
    });

    test('should accept --quick option', () => {
      const output = runSynax(['doctor', '--quick']);
      expect(output).toContain('Synax Doctor Report');
      expect(output).toContain('Summary:');
    });
  });
});
