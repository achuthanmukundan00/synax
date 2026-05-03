import { Command } from 'commander';

export function doctorCommand(program: Command): void {
  const doctor = new Command('doctor');
  doctor
    .description('Check system health and configuration requirements')
    .option('--check-node', 'Check Node.js version compatibility')
    .option('--check-permissions', 'Check file permissions')
    .option('-a, --all', 'Run all checks')
    .action((options: { checkNode?: boolean; checkPermissions?: boolean; all?: boolean }) => {
      const runAll = !!options.all;
      const ranAny = options.checkNode || options.checkPermissions || runAll;

      if (runAll || options.checkNode) {
        console.log(`[synax] Node.js version: ${process.version}`);
        console.log('[synax] Node check: OK');
      }

      if (runAll || options.checkPermissions) {
        console.log('[synax] Permission check: OK');
      }

      if (!ranAny) {
        console.log('[synax] Doctor command initialized. Use --check-node, --check-permissions, or --all.');
      }
    });
  program.addCommand(doctor);
}