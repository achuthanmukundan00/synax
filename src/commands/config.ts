/**
 * `synax config` command implementation.
 *
 * Supports `init`, `show`, and `get` subcommands.
 */

import { resolve, join } from 'path';
import { Command } from 'commander';
import { loadProjectConfig, writeConfigFile, generateDefaultConfig, ProjectConfig } from '../config/project';
import { buildProjectProfile, formatTextProfile, FullProfile } from '../config/profile';

export interface ConfigCommandOptions {
  command: 'init' | 'show' | 'get';
  path?: string;
  key?: string;
  json?: boolean;
  force?: boolean;
}

/**
 * Run the config command.
 */
interface ConfigActionOptions {
  path?: string;
  key?: string;
  json?: boolean;
  force?: boolean;
}

export function runConfigCommand(program: Command): void {
  const cwd = process.cwd();

  program
    .command('config')
    .description('Manage Synax project configuration')
    .argument('[subcommand]', 'Subcommand: init, show, get')
    .option('-p, --path <path>', 'Path to config file')
    .option('-k, --key <key>', 'Key to get')
    .option('-j, --json', 'Output as JSON')
    .option('-f, --force', 'Overwrite existing config')
    .action((subcommand: string, options: ConfigActionOptions) => {
      const targetPath = options.path ? resolve(options.path) : cwd;
      const opts: ConfigCommandOptions = {
        command: subcommand as 'init' | 'show' | 'get',
        path: options.path,
        key: options.key,
        json: options.json,
        force: options.force,
      };

      switch (opts.command) {
        case 'init':
          handleInit(targetPath, opts);
          break;
        case 'show':
          handleShow(targetPath, opts);
          break;
        case 'get':
          handleGet(targetPath, opts);
          break;
        default:
          console.error(`Unknown subcommand: ${opts.command}`);
          process.exit(1);
      }
    });
}

/**
 * Handle `config init` subcommand.
 */
function handleInit(baseDir: string, opts: ConfigCommandOptions): void {
  const configPath = join(baseDir, '.synax.toml');
  const result = writeConfigFile(configPath, generateDefaultConfig(), opts.force ?? false);

  if (!result.success) {
    if (result.error?.includes('already exists')) {
      console.error(`Config file already exists: ${configPath}`);
      console.error('Use --force to overwrite.');
    } else {
      console.error(`Failed to create config: ${result.error}`);
    }
    process.exit(1);
  } else {
    console.log(`Config file created at ${configPath}`);
  }
}

/**
 * Handle `config show` subcommand.
 */
function handleShow(baseDir: string, opts: ConfigCommandOptions): void {
  const parsedConfig = loadProjectConfig(opts.path);
  const projectProfile = buildProjectProfile(baseDir);

  const fullProfile: FullProfile = {
    project: projectProfile,
    config: {
      source: parsedConfig.source,
      hasConfigFile: parsedConfig.source !== 'default',
      configSummary: parsedConfig.config as Record<string, unknown>,
    },
  };

  const textProfile = formatTextProfile(fullProfile);
  console.log(textProfile);
}

/**
 * Handle `config get` subcommand.
 */
function handleGet(_baseDir: string, opts: ConfigCommandOptions): void {
  if (!opts.key) {
    console.error('Missing key argument for `config get`');
    process.exit(1);
  }

  const parsedConfig = loadProjectConfig(opts.path);
  const config = parsedConfig.config as ProjectConfig;

  // Parse nested key path (e.g., "subagents.enabled")
  const keys = opts.key.split('.');
  let value: unknown = config;
  for (const key of keys) {
    if (value && typeof value === 'object' && key in (value as Record<string, unknown>)) {
      value = (value as Record<string, unknown>)[key];
    } else {
      console.error(`Unknown config key: ${opts.key}`);
      process.exit(1);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(String(value));
  }
}
