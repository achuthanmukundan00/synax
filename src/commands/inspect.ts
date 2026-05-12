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
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { execSync } from 'child_process';
import { Command } from 'commander';
import { buildProjectProfile, formatTextProfile, FullProfile, type ConfigProfile } from '../config/profile';
import { discoverConfigPath, loadProjectConfig } from '../config/project';
import {
  discoverLocalDocs,
  readLocalDoc,
  searchLocalDocs,
  type LocalDocRead,
  type LocalDocsDiscovery,
  type LocalDocsSearchResult,
} from '../context/local-docs';
import { Session } from '../session/Session';
import { resolveContextBudgetSettings } from '../agent/context-budget';
import { createContextLedger, type ContextLedger, type ModelCallEntry } from '../tools';
import { EventStore } from '../store/EventStore';
import { runMetricsCommand, type MetricsOptions } from './inspect-metrics';
import { discoverSkills } from '../skills/SkillLoader';

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
  budget?: boolean;
  metrics?: boolean;
  session?: string;
  stats?: boolean;
  docs?: boolean;
  doc?: string;
  searchDocs?: string;
  docsImpact?: boolean;
  skills?: boolean;
  skill?: string;
}

/**
 * Run the inspect command.
 */
interface InspectActionOptions {
  json?: boolean;
  path?: string;
  section?: string[];
  profile?: boolean;
  brief?: boolean;
  ledger?: boolean;
  context?: boolean;
  expanded?: boolean;
  budget?: boolean;
  metrics?: boolean;
  session?: string;
  stats?: boolean;
  docs?: boolean;
  doc?: string;
  searchDocs?: string;
  docsImpact?: boolean;
  skills?: boolean;
  skill?: string;
}

export function runInspectCommand(program: Command): void {
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
    .option('--budget', 'Show context budget configuration')
    .option('--docs', 'List bounded local docs and specs available to Synax')
    .option('--doc <path>', 'Read a bounded local docs/spec file')
    .option('--search-docs <query>', 'Search bounded local docs/spec files')
    .option('--docs-impact', 'Check whether current source changes likely require docs updates')
    .option('--metrics', 'Show run metrics dashboard from event store')
    .option('--session <id>', 'Show event timeline for a specific session')
    .option('--stats', 'Show aggregate statistics (use with --metrics)')
    .option('--skills', 'List auto-discovered skills from ~/.synax/skills/ and .synax/skills/')
    .option('--skill <name>', 'Show full instructions for a specific skill')
    .action(async (options: InspectActionOptions) => {
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
        budget: options.budget,
        metrics: options.metrics,
        session: options.session,
        stats: options.stats,
        docs: options.docs,
        doc: options.doc,
        searchDocs: options.searchDocs,
        docsImpact: options.docsImpact,
        skills: options.skills,
        skill: options.skill,
      };

      // --skills or --skill: show auto-discovered skills
      if (opts.skills || opts.skill) {
        await printSkills(targetPath, opts);
        return;
      }

      // --metrics: show run dashboard from event store
      if (opts.metrics || opts.session || opts.stats) {
        const store = new EventStore();
        try {
          runMetricsCommand(store, {
            json: opts.json,
            session: opts.session,
            stats: opts.stats,
          } satisfies MetricsOptions);
        } finally {
          store.close();
        }
        return;
      }

      if (opts.docsImpact) {
        await printDocsImpact(targetPath, opts);
        return;
      }

      if (opts.docs || opts.doc || opts.searchDocs) {
        await printLocalDocs(targetPath, opts);
        return;
      }

      // --budget: show context budget configuration
      if (opts.budget) {
        const loaded = loadProjectConfig(targetPath);
        const settings = resolveContextBudgetSettings({
          contextBudgetTokens: loaded.config.contextBudgetTokens,
        });
        const effectiveInputLimit = settings.contextWindowTokens - settings.reservedOutputTokens;

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                contextWindowTokens: settings.contextWindowTokens,
                reservedOutputTokens: settings.reservedOutputTokens,
                keepRecentTokens: settings.keepRecentTokens,
                maxSingleReadResultTokens: settings.maxSingleReadResultTokens,
                maxTotalReadResultTokensPerTurn: settings.maxTotalReadResultTokensPerTurn,
                effectiveInputLimit,
                compactionThreshold: `${Math.floor(0.6 * effectiveInputLimit)} tokens (60% of effective limit)`,
              },
              null,
              2,
            ),
          );
        } else {
          console.log('Synax Context Budget');
          console.log('--------------------');
          console.log(`  context window:     ${settings.contextWindowTokens} tokens`);
          console.log(`  reserved output:    ${settings.reservedOutputTokens} tokens`);
          console.log(`  effective limit:    ${effectiveInputLimit} tokens`);
          console.log(`  compaction tail:    ${settings.keepRecentTokens} tokens`);
          console.log(`  single read cap:    ${settings.maxSingleReadResultTokens} tokens`);
          console.log(`  per-turn read cap:  ${settings.maxTotalReadResultTokensPerTurn} tokens`);
          console.log(`  compaction at:      ~${Math.floor(0.6 * effectiveInputLimit)} tokens (60%)`);
          console.log(`  estimator:          chars / 3 (approximate)`);
        }
        return;
      }

      // --ledger or --context: show the context ledger/state
      if (opts.ledger || opts.context) {
        const contextPath = resolve(targetPath, '.synax', 'context.json');
        const legacyPath = resolve(targetPath, '.synax-ledger.json');
        let contextData: Record<string, unknown> | null = null;

        try {
          if (existsSync(contextPath)) {
            contextData = JSON.parse(readFileSync(contextPath, 'utf-8'));
          } else if (existsSync(legacyPath)) {
            contextData = JSON.parse(readFileSync(legacyPath, 'utf-8'));
          }
        } catch {
          // ignore parse errors
        }

        if (!contextData) {
          console.log('[synax] No context state found. Run a chat/ask session first.');
          return;
        }

        if (opts.context || opts.expanded || opts.json) {
          console.log(JSON.stringify(contextData, null, 2));
        } else {
          console.log(contextData.orientation ?? JSON.stringify(contextData, null, 2));
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

async function printLocalDocs(targetPath: string, opts: InspectCommandOptions): Promise<void> {
  try {
    if (opts.searchDocs) {
      const search = await searchLocalDocs(targetPath, opts.searchDocs);
      if (opts.json) {
        console.log(JSON.stringify(search, null, 2));
      } else {
        console.log(formatLocalDocsSearch(search));
      }
      return;
    }
    if (opts.doc) {
      const read = await readLocalDoc(targetPath, opts.doc);
      if (opts.json) {
        console.log(JSON.stringify(read, null, 2));
      } else {
        console.log(formatLocalDocRead(read));
      }
      return;
    }

    const discovery = await discoverLocalDocs(targetPath);
    if (opts.json) {
      console.log(JSON.stringify(discovery, null, 2));
    } else {
      console.log(formatLocalDocsDiscovery(discovery));
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[synax] Docs error: ${message}`);
    process.exitCode = 1;
  }
}

async function printDocsImpact(targetPath: string, opts: InspectCommandOptions): Promise<void> {
  const changed = detectChangedFiles(targetPath);
  const docsChanged = changed.some((file) => file.startsWith('docs/') || file === 'README.md');
  const behaviorChanged = changed.some(
    (file) => file.startsWith('src/commands/') || file.startsWith('src/agent/') || file.startsWith('src/config/'),
  );
  const needsDocs = behaviorChanged && !docsChanged;
  const output = {
    changedFiles: changed,
    docsChanged,
    behaviorChanged,
    needsDocsUpdate: needsDocs,
    message: needsDocs
      ? 'Public behavior likely changed without docs updates.'
      : 'No obvious docs-impact mismatch detected.',
  };
  if (opts.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  console.log(
    [
      'Synax Docs Impact',
      `changed files: ${changed.length}`,
      `behavior-facing changes: ${behaviorChanged ? 'yes' : 'no'}`,
      `docs changed: ${docsChanged ? 'yes' : 'no'}`,
      `needs docs update: ${needsDocs ? 'yes' : 'no'}`,
      output.message,
    ].join('\n'),
  );
}

function detectChangedFiles(targetPath: string): string[] {
  try {
    const out = execSync('git status --porcelain', {
      cwd: targetPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function formatLocalDocsDiscovery(discovery: LocalDocsDiscovery): string {
  const lines = ['Synax Local Docs'];
  if (discovery.files.length === 0) {
    lines.push('(none found)');
  } else {
    lines.push(...discovery.files.map((file) => `- ${file}`));
  }
  if (discovery.truncated) {
    lines.push('(truncated)');
  }
  return lines.join('\n');
}

function formatLocalDocRead(read: LocalDocRead): string {
  const lines = [
    `Synax Local Doc: ${read.path}`,
    `Lines ${read.startLine}-${read.endLine} of ${read.totalLines}${read.truncated ? ' (truncated)' : ''}`,
    ...read.lines.map((line) => `${line.lineNumber} | ${line.text}`),
  ];
  return lines.join('\n');
}

function formatLocalDocsSearch(search: LocalDocsSearchResult): string {
  const lines = [`Synax Local Docs Search: ${search.query}`];
  if (search.matches.length === 0) {
    lines.push('(no matches)');
  } else {
    lines.push(...search.matches.map((m) => `- ${m.path}:${m.lineNumber} | ${m.line}`));
  }
  if (search.truncated) lines.push('(truncated)');
  return lines.join('\n');
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
  const tmpPath = `${contextPath}.synax-tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(context, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, contextPath);
  return contextPath;
}

export function buildInspectConfigProfile(baseDir: string): ConfigProfile {
  const configPath = discoverConfigPath(baseDir);
  const parsedConfig = loadProjectConfig(baseDir);
  const budgetSummary = {
    contextBudgetTokens: parsedConfig.config.contextBudgetTokens,
    maxModelSteps: parsedConfig.config.maxModelSteps,
    maxToolCalls: parsedConfig.config.maxToolCalls,
    tools: Session.buildModelTools({ bashEnabled: parsedConfig.config.tools?.bash?.enabled }).map((tool) => tool.name),
    shell: parsedConfig.config.tools?.shell ?? 'zsh',
    bash: parsedConfig.config.tools?.bash?.enabled ?? false,
    providerPreset: parsedConfig.config.provider?.preset ?? 'relay',
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

// ─── Skills display ──────────────────────────────────────────────────────────

async function printSkills(targetPath: string, opts: InspectCommandOptions): Promise<void> {
  try {
    const discovery = discoverSkills(targetPath);

    if (opts.skill) {
      // Show a specific skill's full instructions
      const skill = discovery.skills.find((s) => s.name === opts.skill || s.path.endsWith(`/${opts.skill}/SKILL.md`));
      if (!skill) {
        console.log(`[synax] Skill not found: ${opts.skill}`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(skill, null, 2));
      } else {
        console.log(`Skill: ${skill.name}`);
        console.log(`Source: ${skill.source}`);
        console.log(`Enabled: ${skill.enabled}`);
        console.log(`Path: ${skill.path}`);
        console.log(`Description: ${skill.description}`);
        console.log('');
        console.log('--- Instructions ---');
        console.log(skill.instructions);
      }
      return;
    }

    // List all skills
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            total: discovery.skills.length,
            loaded: discovery.loaded.length,
            disabled: discovery.disabled.length,
            skills: discovery.skills.map((s) => ({
              name: s.name,
              source: s.source,
              enabled: s.enabled,
              description: s.description,
              path: s.path,
            })),
            errors: discovery.errors,
          },
          null,
          2,
        ),
      );
    } else {
      const lines = ['Synax Skills'];
      lines.push(
        `Total: ${discovery.skills.length} (${discovery.loaded.length} loaded, ${discovery.disabled.length} disabled)`,
      );
      lines.push('');

      if (discovery.skills.length === 0) {
        lines.push('  (no skills discovered)');
        lines.push('');
        lines.push('  Add skills by creating directories with SKILL.md files:');
        lines.push(`    Global: ~/.synax/skills/<skill-name>/SKILL.md`);
        lines.push(`    Project: .synax/skills/<skill-name>/SKILL.md`);
      }

      for (const skill of discovery.skills) {
        const status = skill.enabled ? '✓' : '✗';
        lines.push(`  ${status} ${skill.name} (${skill.source})`);
        lines.push(`    ${skill.description}`);
        lines.push(`    ${skill.path}`);
      }

      if (discovery.errors.length > 0) {
        lines.push('');
        lines.push('Errors:');
        for (const err of discovery.errors) {
          lines.push(`  ! ${err}`);
        }
      }

      console.log(lines.join('\n'));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[synax] Skills error: ${message}`);
    process.exitCode = 1;
  }
}
