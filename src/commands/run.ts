import { Command } from 'commander';
import { runAgentTask } from '../agent/run-task';
import { normalizeRunMode, type RunMode } from '../agent/task-policy';
import { TuiRenderer } from '../agent/renderers';
import type { AgentEvent } from '../agent/events';
import { loadProjectConfig, toProviderFactoryInput } from '../config/project';
import { loadSynaxConfig } from '../config/load-config';
import { describeLLMProvider } from '../llm/provider-factory';
import { createChatSession, compactHome, currentGitBranch, providerRuntimeBlockedMessage } from './chat';
import { loadSkills, type SkillDiagnostic } from '../agent/skills';
import { discoverSkills, buildSkillMessages } from '../skills/SkillLoader';
import { runInteractiveTui } from '../tui/interactive-tui';
import { createLogger } from '../logging/index.js';
import { reduceEvents, renderPlainText } from '../presentation';

const MAX_REPAIR_ATTEMPTS = 10;

export function runCommand(program: Command): void {
  const run = new Command('run');
  run
    .description('Run one bounded Synax agent task')
    .option('-t, --task <task>', 'Task description to execute')
    .option('-p, --plan <plan>', 'Path to a plan file')
    .option('--mode <mode>', 'Task mode preset: read-only, patch, verify, or docs', 'patch')
    .option('-y, --yes', 'Accept previewed replacement edits in non-interactive runs')
    .option('--verification-profile <profile>', 'Verification profile: quick or full')
    .option('--repair-attempts <count>', 'Bounded verification repair attempts')
    .option('--tui', 'Render run control surface TUI')
    .option('--cmux-mode', 'Reduce OpenTUI frame rate and live nodes for many parallel terminal sessions')
    .option('--budget <amount>', 'Maximum API cost budget in USD (e.g. 0.50)')
    .option('--strategy <mode>', 'Context strategy override: aggressive, moderate, light, none, or off')
    .option('--verify <level>', 'Verification contract level: none, files-changed, verification-ran, tests-passing')
    .option('--no-skills', 'Disable all skill injection for this run')
    .action(
      async (options: {
        task?: string;
        plan?: string;
        mode?: RunMode;
        yes?: boolean;
        verificationProfile?: 'quick' | 'full';
        repairAttempts?: string;
        tui?: boolean;
        cmuxMode?: boolean;
        budget?: string;
        strategy?: string;
        verify?: string;
        skills?: boolean;
      }) => {
        if (options.task) {
          const collectedEvents: AgentEvent[] = [];
          const renderer = options.tui ? new TuiRenderer() : null;
          try {
            const repairAttemptsResult = parseRepairAttempts(options.repairAttempts);
            if (!repairAttemptsResult.ok) {
              console.error(`[synax] ${repairAttemptsResult.error}`);
              renderer?.finish?.();
              process.exitCode = 1;
              return;
            }
            const report = await runAgentTask({
              repoRoot: process.cwd(),
              task: options.task,
              mode: normalizeRunMode(options.mode),
              yes: options.yes,
              verificationProfile: options.verificationProfile,
              repairAttempts: repairAttemptsResult.value,
              logger: createLogger(),
              maxBudget: parseBudgetOption(options.budget),
              strategy: options.strategy,
              verify: options.verify,
              noSkills: options.skills === false,
              onActivity(activity) {
                if (activity.kind === 'model_response') {
                  const fullContent = activity.modelOutput ?? '';
                  if (fullContent.trim().length > 0) {
                    const event: AgentEvent = {
                      type: 'assistant_message',
                      timestamp: new Date().toISOString(),
                      content: fullContent,
                    };
                    renderer?.onEvent(event);
                    if (!renderer) collectedEvents.push(event);
                  }
                }
                if (renderer) return;
                console.log(`[synax] ${activity.kind}: ${activity.message}`);
              },
              onEvent(event) {
                renderer?.onEvent(event);
                if (!renderer) {
                  collectedEvents.push(event);
                  if (event.type === 'patch_preview') {
                    console.log(`[synax] patch preview: ${event.path}`);
                    console.log(event.diff || '(no changes)');
                  }
                }
              },
            });
            renderer?.finish?.();
            if (!renderer) {
              const state = reduceEvents(collectedEvents);
              process.stdout.write(renderPlainText(state, { showPatchPreviews: true }));
            } else if (report.terminalState !== 'completed') {
              printTuiFailure(report);
            }
            if (report.terminalState !== 'completed') {
              process.exitCode = 1;
            }
          } catch (error) {
            renderer?.finish?.();
            const message = error instanceof Error ? error.message : String(error);
            const logger = createLogger();
            logger.error('Provider or task failure', error instanceof Error ? error : new Error(message));
            console.error(`[synax] Provider or task failure: ${message}`);
            process.exitCode = 1;
          }
        } else if (options.plan) {
          console.log(`[synax] Run plan received: "${options.plan}"`);
          console.log('[synax] Placeholder: Plan execution engine not yet implemented.');
        } else if (options.tui) {
          const repoRoot = process.cwd();
          const loaded = loadProjectConfig(repoRoot);
          if (loaded.errors.length > 0) {
            const tuiLogger = createLogger();
            tuiLogger.error(
              'Config load error',
              new Error(loaded.errors.map((e) => `${e.path}: ${e.message}`).join('\n')),
            );
            console.error(`[synax] Config error:\n${loaded.errors.map((e) => `${e.path}: ${e.message}`).join('\n')}`);
            process.exitCode = 1;
            return;
          }

          const providerDescription = describeLLMProvider(toProviderFactoryInput(loaded.config));
          const metadata = providerDescription.metadata;
          const blockedMessage = providerRuntimeBlockedMessage(metadata, providerDescription.normalizedConfig);

          // Extract thinking level and TUI config from the effective multi-provider config.
          let thinkingLevel: import('../config/schema').ThinkingLevel = 'off';
          let skillMessages: string[] | undefined;
          let skillDiagnostics: SkillDiagnostic[] | undefined;
          let enableMouse = false;
          let alternateScreen = true;
          let cmuxMode = false;
          try {
            const effectiveConfig = loadSynaxConfig();
            if (effectiveConfig.active.thinking && effectiveConfig.active.thinking !== 'off') {
              thinkingLevel = effectiveConfig.active.thinking;
            }
            enableMouse = effectiveConfig.tui?.mouse ?? false;
            alternateScreen = effectiveConfig.tui?.alternateScreen ?? true;
            cmuxMode = effectiveConfig.tui?.cmuxMode ?? false;

            // Config-based skills (personas) — always loaded.
            const configMessages: string[] = [];
            let configDiagnostics: SkillDiagnostic[] = [];
            if (effectiveConfig.skills.enabled.length > 0) {
              const result = loadSkills(effectiveConfig.skills, repoRoot);
              configMessages.push(...result.systemMessages);
              configDiagnostics = result.diagnostics;
            }

            // Auto-discovered skills — skippable via --no-skills.
            const autoMessages: string[] = [];
            if (options.skills !== false) {
              try {
                const discovery = discoverSkills(repoRoot);
                if (discovery.loaded.length > 0) {
                  autoMessages.push(...buildSkillMessages(discovery.loaded));
                }
              } catch {
                // Auto-discovery is best-effort
              }
            }

            // Merge: config-based (persona) first, then auto-discovered domain skills.
            skillMessages = [...configMessages, ...autoMessages];
            if (skillMessages.length === 0) skillMessages = undefined;
            skillDiagnostics = configDiagnostics;
          } catch {
            // best-effort
          }
          let lastModelOutput = '';
          const session = createChatSession({
            repoRoot,
            config: loaded.config,
            thinkingLevel,
            skillMessages,
            skillDiagnostics,
            onActivity: (activity) => {
              if (activity.kind === 'model_response' && activity.modelOutput) {
                lastModelOutput = activity.modelOutput;
              }
            },
            tui: true,
          });
          const modelLabel = metadata.modelId || undefined;
          const cwdLabel = compactHome(repoRoot);
          const gitBranch = await currentGitBranch(repoRoot);
          await runInteractiveTui(session, {
            enableMouse,
            alternateScreen,
            cmuxMode: options.cmuxMode ?? cmuxMode,
            blockedMessage,
            lastModelOutput: () => lastModelOutput,
            modelLabel,
            thinkingEnabled: thinkingLevel !== 'off',
            endpointLabel: metadata.baseUrl !== '(not set)' ? metadata.baseUrl : undefined,
            providerName: metadata.displayName,
            cwdLabel,
            gitBranch,
            contextWindowTokens: loaded.config.contextWindowTokens ?? loaded.config.contextBudgetTokens,
            coreLoaded: blockedMessage === undefined,
            inputPricePer1MTokens: metadata.inputPricePer1MTokens,
            outputPricePer1MTokens: metadata.outputPricePer1MTokens,
          });
        } else {
          console.log('[synax] Run command initialized. Use --task or --plan to specify work.');
        }
      },
    );
  program.addCommand(run);
}

function parseBudgetOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function parseRepairAttempts(
  value: string | undefined,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (!/^\d+$/.test(value)) {
    return { ok: false, error: '--repair-attempts must be a non-negative integer' };
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false, error: '--repair-attempts is too large to be safe' };
  }
  if (parsed > MAX_REPAIR_ATTEMPTS) {
    return { ok: false, error: `--repair-attempts must be between 0 and ${MAX_REPAIR_ATTEMPTS}` };
  }
  return { ok: true, value: parsed };
}

function printTuiFailure(report: Awaited<ReturnType<typeof runAgentTask>>): void {
  console.error(`[synax] Run failed: ${report.terminalState}`);
  if (report.error) {
    console.error(`[synax] Next: ${classifyFailureNextAction(report.error)}`);
    console.error(report.error);
  }
}

function classifyFailureNextAction(error: string): string {
  const lower = error.toLowerCase();
  if (
    lower.includes('provider error') ||
    lower.includes('connection failed') ||
    lower.includes('network error') ||
    lower.includes('timed out') ||
    lower.includes('api key') ||
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('429') ||
    lower.includes('deepseek')
  ) {
    return 'check provider/server/config, then rerun';
  }
  if (lower.includes('context budget') || lower.includes('max tool calls')) {
    return 'narrow the prompt or raise the configured budget/limits';
  }
  if (
    lower.includes('malformed tool call') ||
    lower.includes('ambiguous mixed output') ||
    lower.includes('recoverable tool errors')
  ) {
    return 're-prompt Synax with a smaller, more explicit task';
  }
  return 'inspect the error below, then rerun';
}
