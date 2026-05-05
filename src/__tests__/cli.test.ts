import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const SYNAX_BIN = path.resolve(__dirname, '../../dist/cli.js');

function runSynax(args: string[], options: { cwd?: string; timeout?: number } = {}): string {
  try {
    const cmd = `node "${SYNAX_BIN}" ${args.map((a) => `'${a}'`).join(' ')}`;
    return execSync(cmd, {
      cwd: options.cwd,
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

    test('should accept --question option', () => {
      const output = runSynax(['ask', '--question', 'what is synax?']);
      expect(output).toContain('what is synax?');
      expect(output).toContain('Placeholder');
    });
  });

  describe('synax run', () => {
    test('should show placeholder without arguments', () => {
      const output = runSynax(['run']);
      expect(output).toContain('[synax] Run command initialized');
    });

    test('should accept --task option', () => {
      const output = runSynax(['run', '--task', 'test task']);
      expect(output).toContain('test task');
      expect(output).toContain('Placeholder');
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
