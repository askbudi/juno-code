import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import { Command } from 'commander';

export type MigrationInvocation = (args: string[]) => Promise<void>;

function packagedEngine(name = 'migration_inventory.py'): string {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Bundled CLI: dist/bin/cli.mjs -> dist/templates/scripts.
    path.resolve(directory, `../templates/scripts/${name}`),
    // Source execution: src/cli/commands -> src/templates/scripts.
    path.resolve(directory, `../../templates/scripts/${name}`),
    // Bundled CLI executed from a source checkout before packaging.
    path.resolve(directory, `../../src/templates/scripts/${name}`),
  ];
  const engine = candidates.find((candidate) => fs.existsSync(candidate));
  if (!engine) throw new Error(`The packaged migration engine is missing: ${name}`);
  return engine;
}

export async function invokeMigration(args: string[]): Promise<void> {
  const evacuation = args[0]?.startsWith('evacuation-');
  const registration = args[0] === 'registration';
  const runtimeRebind = args[0] === 'runtime-rebind';
  const engine = packagedEngine(
    registration
      ? 'controller_registration.py'
      : runtimeRebind
        ? 'metadata_controller.py'
        : evacuation
          ? 'metadata_evacuation.py'
          : 'migration_inventory.py',
  );
  const engineArgs = registration ? args.slice(1) : args;
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn('python3', [engine, ...engineArgs], {
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
    .command('runtime-rebind')
    .description('Explicitly rebind a clean metadata controller to one installed runtime executable')
    .requiredOption('--root <path>', 'Exact metadata-controller worktree')
    .requiredOption('--branch <ref>', 'Exact controller branch ref')
    .requiredOption('--runtime <path>', 'Installed cli.mjs executable to bind (does not install a package)')
    .requiredOption('--runtime-version <version>', 'Version printed by the runtime executable')
    .requiredOption('--output <path>', 'New local receipt outside the controller worktree')
    .action((options) => invoke([
      'runtime-rebind', '--root', options.root, '--branch', options.branch,
      '--runtime', options.runtime, '--runtime-version', options.runtimeVersion,
      '--output', options.output,
    ]));
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
  migrate
    .command('evacuation-plan')
    .description('Create a byte-stable controller-metadata evacuation plan')
    .requiredOption('--inventory <path>', 'Reviewed immutable inventory receipt')
    .requiredOption('--policy <path>', 'Reviewed generated migration policy bundle')
    .requiredOption('--project <path>', 'Exact product source worktree')
    .requiredOption('--output <path>', 'New plan receipt outside all repositories')
    .action((options) => invoke(['evacuation-plan', '--inventory', options.inventory, '--policy', options.policy, '--project', options.project, '--output', options.output]));
  migrate
    .command('evacuation-apply')
    .description('Apply an evacuation plan only to a clean disposable linked worktree')
    .requiredOption('--plan <path>', 'Reviewed evacuation plan')
    .requiredOption('--candidate <path>', 'Disposable linked candidate worktree')
    .requiredOption('--output <path>', 'New apply receipt outside all repositories')
    .requiredOption('--allow-disposable-mutation', 'Acknowledge mutation of the disposable candidate')
    .action((options) => invoke(['evacuation-apply', '--plan', options.plan, '--candidate', options.candidate, '--output', options.output, '--allow-disposable-mutation']));
  migrate
    .command('evacuation-verify')
    .description('Verify an applied candidate has only the planned metadata changes')
    .requiredOption('--plan <path>', 'Reviewed evacuation plan')
    .requiredOption('--candidate <path>', 'Candidate worktree to verify')
    .requiredOption('--output <path>', 'New verification receipt outside all repositories')
    .action((options) => invoke(['evacuation-verify', '--plan', options.plan, '--candidate', options.candidate, '--output', options.output]));

  const registration = migrate
    .command('registration')
    .description('Plan, apply, verify, or roll back protected controller registration');
  registration
    .command('plan')
    .description('Freeze an exact no-mutation controller registration plan')
    .requiredOption('--source-controller <path>')
    .requiredOption('--source-ref <ref>')
    .requiredOption('--expected-source-head <sha>')
    .requiredOption('--target-controller <path>')
    .requiredOption('--target-ref <ref>')
    .requiredOption('--expected-target-head <sha>')
    .requiredOption('--product-root <path>')
    .requiredOption('--product-ref <ref>')
    .requiredOption('--expected-product-head <sha>')
    .requiredOption('--runtime <path>')
    .requiredOption('--runtime-version <version>')
    .requiredOption('--inventory <path>')
    .requiredOption('--policy-bundle <path>')
    .requiredOption('--pending-verification <path>')
    .requiredOption('--output <path>')
    .action((options) => invoke([
      'registration', 'plan',
      '--source-controller', options.sourceController, '--source-ref', options.sourceRef,
      '--expected-source-head', options.expectedSourceHead,
      '--target-controller', options.targetController, '--target-ref', options.targetRef,
      '--expected-target-head', options.expectedTargetHead,
      '--product-root', options.productRoot, '--product-ref', options.productRef,
      '--expected-product-head', options.expectedProductHead,
      '--runtime', options.runtime, '--runtime-version', options.runtimeVersion,
      '--inventory', options.inventory, '--policy-bundle', options.policyBundle,
      '--pending-verification', options.pendingVerification,
      '--output', options.output,
    ]));
  registration.command('apply')
    .description('Apply an exact plan under an explicit registration authorization')
    .requiredOption('--plan <path>').requiredOption('--output <path>')
    .requiredOption('--authorize-apply', 'Authorize only this local controller registration')
    .action((options) => invoke(['registration', 'apply', '--plan', options.plan, '--output', options.output, '--authorize-apply']));
  registration.command('verify')
    .description('Read back registration truth without mutation')
    .requiredOption('--plan <path>').requiredOption('--output <path>')
    .action((options) => invoke(['registration', 'verify', '--plan', options.plan, '--output', options.output]));
  registration.command('rollback')
    .description('Restore the exact prior registration under explicit authorization')
    .requiredOption('--plan <path>').requiredOption('--output <path>')
    .requiredOption('--authorize-rollback', 'Authorize only this local registration rollback')
    .action((options) => invoke(['registration', 'rollback', '--plan', options.plan, '--output', options.output, '--authorize-rollback']));
}
