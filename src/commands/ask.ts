import { Command } from 'commander';
import { runAgentTask } from '../agent/run-task';
import { DebugRenderer, JsonlRenderer, NormalRenderer, QuietRenderer, type AgentRenderer } from '../agent/renderers';

export interface AskOptions {
  question?: string;
  quiet?: boolean;
  json?: boolean;
  debug?: boolean;
}

function resolveRenderer(options: AskOptions): AgentRenderer {
  if (options.json) return options.debug ? new DebugRenderer() : new JsonlRenderer();
  if (options.quiet) return new QuietRenderer();
  return new NormalRenderer();
}

function validateOutputFlags(options: AskOptions): string | null {
  if (options.quiet && options.json) return '--quiet and --json cannot be used together';
  if (options.quiet && options.debug) return '--quiet and --debug cannot be used together';
  return null;
}

export async function handleAskCommand(options: AskOptions): Promise<void> {
  if (!options.question) {
    console.log('[synax] Ask command initialized. Use --question to provide a question.');
    return;
  }

  const flagError = validateOutputFlags(options);
  if (flagError) {
    console.error(`[synax] ${flagError}`);
    process.exitCode = 1;
    return;
  }

  const renderer = resolveRenderer(options);
  const report = await runAgentTask({
    repoRoot: process.cwd(),
    task: options.question,
    onEvent(event) {
      renderer.onEvent(event);
    },
  });
  renderer.finish?.();
  if (report.terminalState !== 'completed') {
    process.exitCode = 1;
  }
}

export function askCommand(program: Command): void {
  const ask = new Command('ask');
  ask
    .description('Run one bounded question/task')
    .option('-q, --question <question>', 'Question to ask')
    .option('--quiet', 'Print only final answer/error')
    .option('--json', 'Emit machine-readable JSONL events')
    .option('--debug', 'Emit debug-focused event output')
    .action(async (options: AskOptions) => {
      await handleAskCommand(options);
    });
  program.addCommand(ask);
}

