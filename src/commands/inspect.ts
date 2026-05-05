/**
 * `synax inspect` command implementation.
 *
 * Reads and displays project metadata: git info, package manager,
 * detected commands, instruction files, and config summary.
 *
 * Also supports `--ledger` and `--context` flags to display the
 * context ledger when it is available via a JSON file.
 */

import { join, resolve } from 'path';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { buildProjectProfile, formatTextProfile, FullProfile, type ConfigProfile } from '../config/profile';
import { discoverConfigPath, loadProjectConfig } from '../config/project';
import { buildModelFacingTools } from '../agent/runner';
import { createContextLedger, type ContextLedger, type ModelCallEntry } from '../tools';

export const PROJECT_CONTEXT_PATH = join('.synax', 'context.json');

export interface ProjectContextFile {
  version: 1;
  kind: 'inspect-profile';
  profile: FullProfile;
  profileText: string;
}

export interface InspectCommandOptions {
  json?: boolean;
  path?: string;
  section?: string[];
  profile?: boolean;
  brief?: boolean;
  ledger?: boolean;
  context?: boolean;
  expanded?: boolean;
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
    .option('--ledger', 'Show the context ledger (from .synax-ledger.json)')
    .option('--context', 'Show the context ledger in expanded format')
    .option('-e, --expanded', 'Show expanded ledger output')
    .action((options: any) => {
      const targetPath = options.path ? resolve(options.path) : cwd;
      const projectProfile = buildProjectProfile(targetPath);
      const configProfile = buildInspectConfigProfile(targetPath);

      const fullProfile: FullProfile = {
        project: projectProfile,
        config: configProfile,
      };
      writeProjectContext(targetPath, fullProfile);

      const opts: InspectCommandOptions = {
        json: options.json,
        path: options.path,
        section: options.section,
        profile: options.profile,
        brief: options.brief,
        ledger: options.ledger,
        context: options.context,
        expanded: options.expanded,
      };

      // --ledger or --context: show the context ledger
      if (opts.ledger || opts.context) {
        const ledgerPath = resolve(targetPath, '.synax-ledger.json');
        const ledger = loadLedgerFromDisk(ledgerPath);

        if (!ledger) {
          console.log('[synax] No ledger data found. Run a chat/ask session first.');
          return;
        }

        if (opts.context || opts.expanded) {
          console.log(JSON.stringify(ledger, null, 2));
        } else {
          console.log(ledger.getCompact());
        }
        return;
      }

      // --brief shows a condensed summary
      if (opts.brief) {
        const summary: Record<string, unknown> = {
          git: fullProfile.project.git
            ? {
                root: fullProfile.project.git.root,
                branch: fullProfile.project.git.branch,
                dirty: fullProfile.project.git.isDirty,
              }
            : null,
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
            else if (section === 'packageManager' && output.packageManager)
              filtered.packageManager = output.packageManager;
            else if (section === 'detectedCommands' && output.detectedCommands)
              filtered.detectedCommands = output.detectedCommands;
            else if (section === 'instructionFiles' && output.instructionFiles)
              filtered.instructionFiles = output.instructionFiles;
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

export function writeProjectContext(baseDir: string, profile: FullProfile): string {
  const contextPath = join(baseDir, PROJECT_CONTEXT_PATH);
  const context: ProjectContextFile = {
    version: 1,
    kind: 'inspect-profile',
    profile,
    profileText: formatTextProfile(profile),
  };

  mkdirSync(join(baseDir, '.synax'), { recursive: true });
  writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, 'utf-8');
  return contextPath;
}

export function buildInspectConfigProfile(baseDir: string): ConfigProfile {
  const configPath = discoverConfigPath(baseDir);
  const parsedConfig = loadProjectConfig(baseDir);
  const budgetSummary = {
    contextBudgetTokens: parsedConfig.config.contextBudgetTokens,
    maxModelSteps: parsedConfig.config.maxModelSteps,
    maxToolCalls: parsedConfig.config.maxToolCalls,
    tools: buildModelFacingTools({ bashEnabled: parsedConfig.config.tools?.bash?.enabled }).map((tool) => tool.name),
    shell: parsedConfig.config.tools?.shell ?? 'zsh',
    bash: parsedConfig.config.tools?.bash?.enabled ?? false,
    providerPreset: parsedConfig.config.provider?.preset ?? 'relay-local',
  };

  if (configPath) {
    return {
      source: 'file',
      hasConfigFile: true,
      configSummary: {
        '.synax.toml': 'skipped secret-bearing file',
        ...budgetSummary,
      },
    };
  }

  return {
    source: parsedConfig.source,
    hasConfigFile: false,
    configSummary: parsedConfig.config as Record<string, unknown>,
  };
}

/**
 * Load a context ledger from disk (written after a session).
 */
export function loadLedgerFromDisk(path: string): ContextLedger | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as ModelCallEntry;

    // Reconstruct a ledger from the saved entry.
    const ledger = createContextLedger();
    if (data.task) ledger.setTask(data.task);
    if (data.budget.total > 0) ledger.setBudget(data.budget.total);
    if (data.budget.used > 0) ledger.recordTokenUsage(data.budget.used);

    for (const src of data.instructionSources) {
      ledger.recordInstructionSource(src.name, {
        included: src.included,
        summarized: src.summarized,
        truncated: src.truncated,
        omitted: src.omitted,
        approximateTokens: src.approximateTokens,
      });
    }

    for (const file of data.files) {
      ledger.recordFile(file.path, {
        lineRange: file.lineRange ? { start: file.lineRange.start, end: file.lineRange.end } : undefined,
        included: file.included,
        summarized: file.summarized,
        truncated: file.truncated,
        omitted: file.omitted,
        approximateTokens: file.approximateTokens,
      });
    }

    for (const cmd of data.commands) {
      ledger.recordCommand(cmd.command, {
        truncated: cmd.truncated,
        approximateTokens: cmd.approximateTokens,
      });
    }

    for (const summ of data.summaries) {
      ledger.recordSummary(summ.source, { approximateTokens: summ.approximateTokens });
    }

    for (const trunc of data.truncations) {
      ledger.recordTruncation(trunc.location, trunc.reason);
    }

    for (const omit of data.omissions) {
      ledger.recordOmission(omit.location, omit.reason);
    }

    return ledger;
  } catch {
    return null;
  }
}

/**
 * Save a context ledger entry to disk for later inspection.
 */
export function saveLedgerToDisk(ledger: ContextLedger, path: string): void {
  const entry = ledger.getExpanded();
  try {
    writeFileSync(path, JSON.stringify(entry, null, 2), 'utf-8');
  } catch {
    // Silently ignore write failures — ledger is best-effort.
  }
}
