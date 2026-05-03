#!/usr/bin/env node
import { Command } from 'commander';
import { chatCommand } from './commands/chat.js';
import { askCommand } from './commands/ask.js';
import { runCommand } from './commands/run.js';
import { inspectCommand } from './commands/inspect.js';
import { configCommand } from './commands/config.js';
import { doctorCommand } from './commands/doctor.js';

const program = new Command();

program
  .name('synax')
  .description('A local-first coding agent for consumer-GPU developers')
  .version('0.1.0');

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

// Inspect command
inspectCommand(program);

// Config command
configCommand(program);

// Doctor command
doctorCommand(program);

// Parse command line arguments
program.parse(process.argv);