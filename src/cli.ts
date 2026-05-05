#!/usr/bin/env node
import { Command } from 'commander';
import { chatCommand } from './commands/chat.js';
import { askCommand } from './commands/ask.js';
import { runCommand } from './commands/run.js';
import { runInspectCommand } from './commands/inspect.js';
import { runConfigCommand } from './commands/config.js';
import { doctorCommand } from './commands/doctor.js';

const program = new Command();

program.name('synax').description('A local-first coding agent for consumer-GPU developers').version('0.2.0');

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

if (process.argv.length === 2) {
  process.argv.push('chat');
}

// Parse command line arguments
void program.parseAsync(process.argv);
