#!/usr/bin/env node
import { Command } from 'commander';
import { chatCommand } from './commands/chat.js';
import { askCommand } from './commands/ask.js';
import { runCommand } from './commands/run.js';
import { runInspectCommand } from './commands/inspect.js';
import { runConfigCommand } from './commands/config.js';
import { doctorCommand } from './commands/doctor.js';
import { setGlobalLogLevel, isLogLevel, type LogLevel } from './logging/index.js';
import pkg from '../package.json';

const program = new Command();

program
  .name('synax')
  .description('A local-first coding agent for consumer-GPU developers')
  .version(pkg.version)
  .option('--log-level <level>', 'Log level: trace, debug, info, warn, error', (value: string) => {
    if (isLogLevel(value)) return value;
    throw new Error(`Invalid log level: ${value}. Must be one of: trace, debug, info, warn, error`);
  });

// Default command: shows help
program
  .command('synax')
  .description('Show help information about Synax CLI')
  .action(() => {
    process.stdout.write(program.helpInformation());
  });

// Chat command
chatCommand(program);

// Ask command
askCommand(program);

// Run command
runCommand(program);

// Config command
runConfigCommand(program);

// Doctor command
doctorCommand(program);

// Inspect command (options registered in runInspectCommand)
runInspectCommand(program);

// Set global log level from CLI option before any command runs.
program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.opts();
  if (opts.logLevel) {
    setGlobalLogLevel(opts.logLevel as LogLevel);
  }
});

// Hidden liminal command — intercepted before commander to avoid help exposure
if (process.argv[2] === '__liminal__') {
  import('./backrooms/index.js')
    .then(({ runSynaxBackrooms }) => {
      return runSynaxBackrooms();
    })
    .catch((err: unknown) => {
      process.stderr.write(`liminal layer error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
  // don't let commander parse this
} else {
  if (process.argv.length === 2) {
    process.argv.push('chat');
  }

  // Parse command line arguments
  void program.parseAsync(process.argv);
}
