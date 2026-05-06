import { Command } from 'commander';
import { runAgentTask } from '../agent/run-task';
import { normalizeRunMode, type RunMode } from '../agent/task-policy';

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
    .action(async (options: {
      task?: string;
      plan?: string;
      mode?: RunMode;
      yes?: boolean;
      verificationProfile?: 'quick' | 'full';
      repairAttempts?: string;
    }) => {
      if (options.task) {
        const activities: string[] = [];
        try {
          const report = await runAgentTask({
            repoRoot: process.cwd(),
            task: options.task,
            mode: normalizeRunMode(options.mode),
            yes: options.yes,
            verificationProfile: options.verificationProfile,
            repairAttempts: options.repairAttempts ? Number.parseInt(options.repairAttempts, 10) : undefined,
            onActivity(activity) {
              activities.push(activity.message);
              console.log(`[synax] ${activity.kind}: ${activity.message}`);
            },
            onEvent(event) {
              if (event.type === 'patch_preview') {
                console.log(`[synax] patch preview: ${event.path}`);
                console.log(event.diff || '(no changes)');
              }
            },
          });
          printReport(report, activities);
          if (report.terminalState !== 'completed') {
            process.exitCode = 1;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[synax] Provider or task failure: ${message}`);
          process.exitCode = 1;
        }
      } else if (options.plan) {
        console.log(`[synax] Run plan received: "${options.plan}"`);
        console.log('[synax] Placeholder: Plan execution engine not yet implemented.');
      } else {
        console.log('[synax] Run command initialized. Use --task or --plan to specify work.');
      }
    });
  program.addCommand(run);
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
  console.log(`Model steps: ${report.steps} / ${report.maxModelSteps}`);
  console.log(`Tool calls: ${report.toolCalls.length} / ${report.maxToolCalls}`);
  console.log(`Context budget: ${report.contextBudgetTokens}`);
  console.log(`Changed files: ${report.filesChanged.length > 0 ? report.filesChanged.join(', ') : 'none'}`);
  console.log(`Files read this run: ${report.filesRead.length > 0 ? report.filesRead.join(', ') : 'none'}`);
  console.log(`Latest checkpoint: ${report.checkpoint ? `${report.checkpoint.id} (${report.checkpoint.statusPath})` : 'none'}`);
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
