import { Command } from 'commander';
import { runAgentTask } from '../agent/run-task';

export function runCommand(program: Command): void {
  const run = new Command('run');
  run
    .description('Run one bounded Synax agent task')
    .option('-t, --task <task>', 'Task description to execute')
    .option('-p, --plan <plan>', 'Path to a plan file')
    .option('-y, --yes', 'Accept previewed replacement edits in non-interactive runs')
    .option('--verification-profile <profile>', 'Verification profile: quick or full')
    .option('--repair-attempts <count>', 'Bounded verification repair attempts')
    .action(async (options: {
      task?: string;
      plan?: string;
      yes?: boolean;
      verificationProfile?: 'quick' | 'full';
      repairAttempts?: string;
    }) => {
      if (options.task) {
        try {
          const report = await runAgentTask({
            repoRoot: process.cwd(),
            task: options.task,
            yes: options.yes,
            verificationProfile: options.verificationProfile,
            repairAttempts: options.repairAttempts ? Number.parseInt(options.repairAttempts, 10) : undefined,
            onActivity(activity) {
              console.log(`[synax] ${activity.kind}: ${activity.message}`);
            },
            onEvent(event) {
              if (event.type === 'patch_preview') {
                console.log(`[synax] patch preview: ${event.path}`);
                console.log(event.diff || '(no changes)');
              }
            },
          });
          printReport(report);
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

function printReport(report: Awaited<ReturnType<typeof runAgentTask>>): void {
  console.log('Synax run report');
  console.log(`Task: ${report.task}`);
  console.log(`Terminal state: ${report.terminalState}`);
  if (report.error) console.log(`Error: ${report.error}`);
  console.log(`Steps: ${report.steps}`);
  if (report.toolCalls.length > 0) {
    console.log('Tool activity:');
    for (const call of report.toolCalls) {
      console.log(`- ${call.name}: ${call.success ? 'ok' : (call.error ?? 'failed')}`);
    }
  }
  console.log('Final answer:');
  console.log(report.finalAnswer || '(none)');
  console.log(`Files changed: ${report.filesChanged.length > 0 ? report.filesChanged.join(', ') : 'none'}`);
  console.log(`Verification: ${report.verification.state}`);
  if (report.verification.command) {
    console.log(`Verification command: ${report.verification.command}`);
    console.log(`Verification exit code: ${report.verification.exitCode ?? 'unknown'}`);
  }
  if (report.messages.length > 0) {
    console.log('Details:');
    for (const message of report.messages) {
      console.log(message);
    }
  }
}
