import { Command } from 'commander';
import { createOpenAICompatibleClient, type BudgetPolicy } from '../llm/client';
import { normalizeProviderConfig, loadProjectConfig } from '../config/project';
import { createContextLedger } from '../tools';
import { saveLedgerToDisk } from './inspect';

/**
 * `synax chat` — interactive agent loop with full ledger wiring.
 *
 * Every model call:
 * 1. Sets task, budget, instruction sources, files, commands on the ledger.
 * 2. Sends the request through the LLM client.
 * 3. Records token usage from the response (handled by the client).
 * 4. Prints the compact ledger after each call.
 * 5. Persists the ledger to `.synax-ledger.json` on session end.
 *
 * Budget enforcement is handled by the client (warn / hard-stop).
 */
export function chatCommand(program: Command): void {
  const chat = new Command('chat');
  chat
    .description('Chat with the Synax agent in an interactive session')
    .option('-m, --message <message>', 'Single-shot message mode')
    .option('-y, --yes', 'Auto-accept without prompts')
    .action(async (options: { message?: string; yes?: boolean }) => {
      const cwd = process.cwd();

      // Load config and build provider config
      const parsedConfig = loadProjectConfig(cwd);
      const configAny = parsedConfig.config as Record<string, unknown>;
      const providerCfg = normalizeProviderConfig((configAny.provider ?? {}) as any);
      const budget = (configAny.contextBudgetTokens ?? 16000) as number;

      // Create the context ledger for this session.
      const ledger = createContextLedger();
      ledger.setBudget(budget);

      // Create the LLM client with ledger wiring and budget policy.
      const budgetPolicy: BudgetPolicy = {
        warnThreshold: Math.floor(budget * 0.1), // warn at 10% remaining
        hardStopThreshold: Math.floor(budget * 0.05), // hard-stop at 5% remaining
      };

      const client = createOpenAICompatibleClient(providerCfg, { ledger, budgetPolicy });

      // Build instruction sources for the ledger.
      ledger.recordInstructionSource('system', { included: true, approximateTokens: 500 });
      ledger.recordInstructionSource('task', { included: true, approximateTokens: 200 });

      // Single-shot mode: send one message and exit.
      if (options.message) {
        await executeSingleChat(client, ledger, options.message);
        saveLedgerToDisk(ledger, getLedgerPath(cwd));
        return;
      }

      // Interactive mode: read messages from stdin.
      console.log('[synax] Chat initialized. Type a message and press Enter. Ctrl+D to exit.');
      console.log('[synax] Run `synax inspect --ledger` to view the session ledger.');
      console.log('');

      const readline = await import('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const question = (prompt: string): Promise<string> =>
        new Promise<string>((resolve) => {
          rl.question(prompt, (answer) => resolve(answer));
        });

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const input = await question('\nYou: ');
          if (!input || input.trim().length === 0) continue;
          await executeSingleChat(client, ledger, input.trim());
        }
      } catch (err) {
        // Only show ledger and handle budget errors; rethrow everything else
        if (err instanceof Error && err.message.includes('Context budget')) {
          console.error(`\n[synax] ❌ ${err.message}`);
          console.log(`\n[synax] Session ledger:\n${ledger.getCompact()}`);
        } else {
          throw err;
        }
      } finally {
        saveLedgerToDisk(ledger, getLedgerPath(cwd));
        rl.close();
      }
    });
  program.addCommand(chat);
}

/**
 * Get the ledger file path for a project directory.
 */
function getLedgerPath(cwd: string): string {
  // Use template literal with trailing slash to avoid path dependency
  const normalized = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return `${normalized}.synax-ledger.json`;
}

/**
 * Execute a single chat turn: set task on ledger, call LLM, record usage.
 */
async function executeSingleChat(
  client: ReturnType<typeof createOpenAICompatibleClient>,
  ledger: ReturnType<typeof createContextLedger>,
  userMessage: string,
): Promise<void> {
  // Reset ledger for the new call, then set task + budget.
  ledger.reset();
  ledger.setTask(userMessage);
  ledger.setBudget(ledger.getExpanded().budget.total); // restore budget from saved total

  // Record instruction sources for this call.
  ledger.recordInstructionSource('system', { included: true, approximateTokens: 500 });
  ledger.recordInstructionSource('task', { included: true, approximateTokens: 200 });

  // Build messages.
  const messages = [
    { role: 'system', content: 'You are a helpful coding assistant. Be precise and concise.' },
    { role: 'user', content: userMessage },
  ];

  console.log(`\n[synax] → ${userMessage}`);

  const response = await client.chat({ messages, temperature: 0 });

  // Record the assistant response.
  ledger.recordInstructionSource('assistant', { included: true });

  console.log(`\n[synax] ← ${response.content.slice(0, 500)}${response.content.length > 500 ? '...' : ''}`);
  console.log('');
  console.log(`[synax] ${ledger.getCompact()}`);
}
