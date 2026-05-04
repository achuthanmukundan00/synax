import { Command } from 'commander';

export function askCommand(program: Command): void {
  const ask = new Command('ask');
  ask
    .description('Ask a question without executing any actions')
    .option('-q, --question <question>', 'Question to ask')
    .action((options: { question?: string }) => {
      if (options.question) {
        console.log(`[synax] Ask question received: "${options.question}"`);
        console.log('[synax] Placeholder: LLM provider not yet configured.');
      } else {
        console.log('[synax] Ask command initialized. Use --question to provide a question.');
      }
    });
  program.addCommand(ask);
}
