import { Command } from 'commander';

export function runCommand(program: Command): void {
  const run = new Command('run');
  run
    .description('Execute a task or plan provided by the agent')
    .option('-t, --task <task>', 'Task description to execute')
    .option('-p, --plan <plan>', 'Path to a plan file')
    .action((options: { task?: string; plan?: string }) => {
      if (options.task) {
        console.log(`[synax] Run task received: "${options.task}"`);
        console.log('[synax] Placeholder: Task execution engine not yet implemented.');
      } else if (options.plan) {
        console.log(`[synax] Run plan received: "${options.plan}"`);
        console.log('[synax] Placeholder: Plan execution engine not yet implemented.');
      } else {
        console.log('[synax] Run command initialized. Use --task or --plan to specify work.');
      }
    });
  program.addCommand(run);
}