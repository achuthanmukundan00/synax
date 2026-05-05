import { Command } from 'commander';
import { runAgentTask } from '../agent/run-task';

export function runCommand(program: Command): void {
  const run = new Command('run');
  run
    .description('Execute a task or plan provided by the agent')
    .option('-t, --task <task>', 'Task description to execute')
    .option('-p, --plan <plan>', 'Path to a plan file')
    .option('-y, --yes', 'Apply proposed patch without an interactive confirmation prompt')
    .action(async (options: { task?: string; plan?: string; yes?: boolean }) => {
      if (options.task) {
        if (!options.yes) {
          console.log(`[synax] Run task received: "${options.task}"`);
          console.log(
            '[synax] Placeholder: Confirmation required before edit-capable execution. Re-run with --yes to proceed.',
          );
          return;
        }
        try {
          const report = await runAgentTask({ repoRoot: process.cwd(), task: options.task, yes: options.yes });
          printReport(report);
          if (report.state === 'failed') {
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
  console.log('Synax Task Report');
  console.log(`State: ${report.state}`);
  if (report.failureState) console.log(`Failure state: ${report.failureState}`);
  console.log(`Files changed: ${report.filesChanged.length > 0 ? report.filesChanged.join(', ') : 'none'}`);
  console.log(`Context: ${report.contextReport}`);
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
