import { Command } from 'commander';
import { runAgentTask } from '../agent/run-task';
import { normalizeRunMode, type RunMode } from '../agent/task-policy';
import { TuiRenderer } from '../agent/renderers';
import { loadProjectConfig, toProviderFactoryInput } from '../config/project';
import { loadSynaxConfig } from '../config/load-config';
import { describeLLMProvider } from '../llm/provider-factory';
import { createChatSession, compactHome, currentGitBranch, providerRuntimeBlockedMessage } from './chat';
import { loadSkills, type SkillDiagnostic } from '../agent/skills';
import { runInteractiveTui } from '../tui/interactive-tui';

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
    .action(
      async (options: {
        task?: string;
        plan?: string;
        mode?: RunMode;
        yes?: boolean;
        verificationProfile?: 'quick' | 'full';
        repairAttempts?: string;
        tui?: boolean;
      }) => {
        if (options.task) {
          const activities: string[] = [];
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
              onActivity(activity) {
                if (activity.kind === 'model_response') {
                  const fullContent = activity.modelOutput || activity.message;
                  if (fullContent.trim().length > 0) {
                    renderer?.onEvent({
                      type: 'assistant_message',
                      timestamp: new Date().toISOString(),
                      content: fullContent,
                    });
                  }
                }
                if (renderer) return;
                activities.push(activity.message);
                console.log(`[synax] ${activity.kind}: ${activity.message}`);
              },
              onEvent(event) {
                renderer?.onEvent(event);
                if (!renderer && event.type === 'patch_preview') {
                  console.log(`[synax] patch preview: ${event.path}`);
                  console.log(event.diff || '(no changes)');
                }
              },
            });
            renderer?.finish?.();
            if (!renderer) {
              printReport(report, activities);
            } else if (report.terminalState !== 'completed') {
              printTuiFailure(report);
            }
            if (report.terminalState !== 'completed') {
              process.exitCode = 1;
            }
          } catch (error) {
            renderer?.finish?.();
            const message = error instanceof Error ? error.message : String(error);
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
          try {
            const effectiveConfig = loadSynaxConfig();
            if (effectiveConfig.active.thinking && effectiveConfig.active.thinking !== 'off') {
              thinkingLevel = effectiveConfig.active.thinking;
            }
            enableMouse = effectiveConfig.tui?.mouse ?? false;
            alternateScreen = effectiveConfig.tui?.alternateScreen ?? true;
            if (effectiveConfig.skills.enabled.length > 0) {
              const result = loadSkills(effectiveConfig.skills, repoRoot);
              skillMessages = result.systemMessages;
              skillDiagnostics = result.diagnostics;
            }
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
            blockedMessage,
            lastModelOutput: () => lastModelOutput,
            modelLabel,
            thinkingEnabled: thinkingLevel !== 'off',
            endpointLabel: metadata.baseUrl !== '(not set)' ? metadata.baseUrl : undefined,
            providerName: metadata.displayName,
            cwdLabel,
            gitBranch,
            contextWindowTokens: loaded.config.contextWindowTokens ?? loaded.config.contextBudgetTokens,
            coreVisualProfile: loaded.config.coreVisualProfile,
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

function printReport(report: Awaited<ReturnType<typeof runAgentTask>>, activities: string[]): void {
  console.log('Synax Run Report');
  console.log('----------------');
  console.log(`Task: ${report.task}`);
  console.log(`Mode: ${report.mode}`);
  console.log(`Status: ${report.terminalState === 'completed' ? 'completed' : 'failed'}`);
  if (report.terminalState !== 'completed') {
    console.log(`Terminal state: ${report.terminalState}`);
  }
  if (report.error) {
    console.log('Error:');
    console.log(report.error);
  }
  console.log(`Model steps: ${report.steps}`);
  console.log(`Tool calls: ${report.toolCalls.length} / ${report.maxToolCalls}`);
  console.log(`Context budget: ${report.contextBudgetTokens}`);
  console.log(`Changed files: ${report.filesChanged.length > 0 ? report.filesChanged.join(', ') : 'none'}`);
  console.log(`Files read this run: ${report.filesRead.length > 0 ? report.filesRead.join(', ') : 'none'}`);
  console.log(
    `Latest checkpoint: ${report.checkpoint ? `${report.checkpoint.id} (${report.checkpoint.statusPath})` : 'none'}`,
  );
  console.log(`Verification: ${report.verification.state}`);
  if (report.verification.state === 'failed' && report.verification.command) {
    console.log(`Verification command: ${report.verification.command}`);
  }
  if (report.verification.state === 'failed' && report.verification.exitCode !== undefined) {
    console.log(`Verification exit code: ${report.verification.exitCode}`);
  }
  if (report.messages.length > 0) {
    console.log('Context notes:');
    for (const message of report.messages) {
      console.log(`  ${message}`);
    }
  }
  console.log('Activity:');
  if (activities.length === 0) {
    console.log('  (none)');
  } else {
    activities.forEach((activity, index) => {
      console.log(`  ${index + 1}. ${activity}`);
    });
  }
  console.log('Final:');
  console.log(report.finalAnswer || '(none)');
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
