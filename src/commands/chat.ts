import { Command } from 'commander';

export function chatCommand(program: Command): void {
  const chat = new Command('chat');
  chat
    .description('Chat with the Synax agent in an interactive session')
    .option('-m, --message <message>', 'Single-shot message mode')
    .action((options: { message?: string }) => {
      if (options.message) {
        console.log(`[synax] Chat message received: "${options.message}"`);
        console.log('[synax] Placeholder: LLM provider not yet configured.');
      } else {
        console.log('[synax] Chat command initialized. Use --message to send a message.');
      }
    });
  program.addCommand(chat);
}