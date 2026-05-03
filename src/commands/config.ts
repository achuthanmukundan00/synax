import { Command } from 'commander';

export function configCommand(program: Command): void {
  const config = new Command('config');
  config.description('Manage Synax configuration');

  const configInit = new Command('init');
  configInit
    .description('Initialize a new Synax configuration file')
    .option('-o, --output <path>', 'Output path for config file (default: .synax.toml)')
    .action((options: { output?: string }) => {
      const outputPath = options.output || '.synax.toml';
      console.log(`[synax] Initializing configuration to: ${outputPath}`);
      console.log('[synax] Placeholder: Configuration file generation not yet implemented.');
    });
  config.addCommand(configInit);

  program.addCommand(config);
}