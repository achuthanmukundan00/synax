/**
 * `synax inspect` command implementation.
 *
 * Reads and displays project metadata: git info, package manager,
 * detected commands, instruction files, and config summary.
 */

import { resolve } from 'path';
import { buildProjectProfile, formatTextProfile, FullProfile } from '../config/profile';
import { loadProjectConfig } from '../config/project';

export interface InspectCommandOptions {
  json?: boolean;
  path?: string;
  section?: string[];
  profile?: boolean;
  brief?: boolean;
}

/**
 * Run the inspect command.
 */
export function runInspectCommand(program: any): void {
  const cwd = process.cwd();

  program
    .command('inspect')
    .description('Inspect project metadata and configuration')
    .option('-j, --json', 'Output as JSON')
    .option('-p, --path <path>', 'Path to project directory')
    .option('-s, --section <sections...>', 'Sections to inspect')
    .option('--profile', 'Show full project profile')
    .option('--brief', 'Show brief summary')
    .action((options: any) => {
      const targetPath = options.path ? resolve(options.path) : cwd;
      const projectProfile = buildProjectProfile(targetPath);
      const parsedConfig = loadProjectConfig('file', options.path);

      const fullProfile: FullProfile = {
        project: projectProfile,
        config: {
          source: parsedConfig.source,
          hasConfigFile: parsedConfig.source !== 'default',
          configSummary: parsedConfig.config as Record<string, unknown>,
        },
      };

      const opts: InspectCommandOptions = {
        json: options.json,
        path: options.path,
        section: options.section,
        profile: options.profile,
        brief: options.brief,
      };

      // --brief shows a condensed summary
      if (opts.brief) {
        const summary: Record<string, unknown> = {
          git: fullProfile.project.git ? { root: fullProfile.project.git.root, branch: fullProfile.project.git.branch, dirty: fullProfile.project.git.isDirty } : null,
          packageManager: fullProfile.project.packageManager,
          configSource: fullProfile.config.source,
        };
        console.log(JSON.stringify(summary, null, 2));
        return;
      }

      if (opts.json) {
        const output: Record<string, unknown> = {
          git: fullProfile.project.git,
          packageManager: fullProfile.project.packageManager,
          detectedCommands: fullProfile.project.detectedCommands,
          instructionFiles: fullProfile.project.instructionFiles,
          config: {
            source: fullProfile.config.source,
            hasConfigFile: fullProfile.config.hasConfigFile,
            configSummary: fullProfile.config.configSummary,
          },
        };

        // Filter by sections if specified
        if (opts.section && opts.section.length > 0) {
          const filtered: Record<string, unknown> = {};
          for (const section of opts.section) {
            if (section === 'git' && output.git) filtered.git = output.git;
            else if (section === 'packageManager' && output.packageManager) filtered.packageManager = output.packageManager;
            else if (section === 'detectedCommands' && output.detectedCommands) filtered.detectedCommands = output.detectedCommands;
            else if (section === 'instructionFiles' && output.instructionFiles) filtered.instructionFiles = output.instructionFiles;
            else if (section === 'config' && output.config) filtered.config = output.config;
          }
          console.log(JSON.stringify(filtered, null, 2));
        } else {
          console.log(JSON.stringify(output, null, 2));
        }
      } else {
        const textProfile = formatTextProfile(fullProfile);
        console.log(textProfile);
      }
    });
}
