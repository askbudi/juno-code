import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import { Command } from 'commander';

export type MigrationInvocation = (args: string[]) => Promise<void>;

function packagedEngine(): string {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Bundled CLI: dist/bin/cli.mjs -> dist/templates/scripts.
    path.resolve(directory, '../templates/scripts/migration_inventory.py'),
    // Source execution: src/cli/commands -> src/templates/scripts.
    path.resolve(directory, '../../templates/scripts/migration_inventory.py'),
    // Bundled CLI executed from a source checkout before packaging.
    path.resolve(directory, '../../src/templates/scripts/migration_inventory.py'),
  ];
  const engine = candidates.find((candidate) => fs.existsSync(candidate));
  if (!engine) throw new Error('The packaged migration inventory engine is missing');
  return engine;
}

export async function invokeMigration(args: string[]): Promise<void> {
  const engine = packagedEngine();
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn('python3', [engine, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Migration inventory terminated by signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}

export function configureMigrationCommand(
  program: Command,
  invoke: MigrationInvocation = invokeMigration,
): void {
  const migrate = program
    .command('migrate')
    .description('Inventory and plan a reviewed Juno architecture migration');
  migrate
    .command('inventory')
    .description('Freeze a deterministic read-only project inventory')
    .option('--project <path>', 'Project worktree to inspect', process.cwd())
    .option('--controller <path>', 'Explicit controller candidate')
    .option('--product-ref <ref>', 'Explicit full product target ref')
    .option('--runtime <path>', 'Exact Juno runtime executable')
    .option('--kanban-runtime <path>', 'Exact Juno Kanban executable')
    .option('--heavy-threshold-bytes <bytes>', 'Heavy file threshold', String(10 * 1024 * 1024))
    .requiredOption('--output <path>', 'New receipt path outside the inspected project')
    .action((options) => {
      const args = ['inventory', '--project', options.project, '--heavy-threshold-bytes', options.heavyThresholdBytes, '--output', options.output];
      if (options.controller) args.push('--controller', options.controller);
      if (options.productRef) args.push('--product-ref', options.productRef);
      if (options.runtime) args.push('--runtime', options.runtime);
      if (options.kanbanRuntime) args.push('--kanban-runtime', options.kanbanRuntime);
      return invoke(args);
    });
  migrate
    .command('owner-template')
    .description('Create an unresolved owner-answer template bound to an inventory')
    .requiredOption('--inventory <path>', 'Immutable inventory receipt')
    .requiredOption('--output <path>', 'New owner-answer template outside the project')
    .action((options) => invoke(['owner-template', '--inventory', options.inventory, '--output', options.output]));
  migrate
    .command('generate-policy')
    .description('Generate candidate policies only from complete owner-reviewed answers')
    .requiredOption('--inventory <path>', 'Immutable inventory receipt')
    .requiredOption('--answers <path>', 'Completed owner answers JSON')
    .requiredOption('--output <path>', 'New policy bundle receipt')
    .action((options) => invoke(['generate-policy', '--inventory', options.inventory, '--answers', options.answers, '--output', options.output]));
}
