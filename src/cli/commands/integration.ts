import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import { Command } from 'commander';
import { routeControlPlane } from '../../utils/control-plane-router.js';

export type IntegrationOperation = 'status' | 'sync' | 'register' | 'repair' | 'push';
export type IntegrationInvoker = (
  operation: IntegrationOperation,
  options: { fetch?: boolean; owner?: string; replace?: boolean; dryRun?: boolean; apply?: string },
) => Promise<void>;

export async function invokeIntegration(
  operation: IntegrationOperation,
  options: { fetch?: boolean; owner?: string; replace?: boolean; dryRun?: boolean; apply?: string } = {},
): Promise<void> {
  const route = routeControlPlane(process.cwd(), 'orchestration');
  const script = path.join(route.controllerRoot, '.juno_task', 'scripts', 'integration_workspace.py');
  if (!(await fs.pathExists(script))) {
    throw new Error('Missing managed integration runtime. Run `yy scripts update` and retry.');
  }
  const argv = [script, '--controller', route.controllerRoot, operation];
  if (operation === 'status' && options.fetch) argv.push('--fetch');
  if (operation === 'register') {
    if (!options.owner) throw new Error('integration register requires an owner path');
    argv.push(path.resolve(options.owner));
    if (options.replace) argv.push('--replace');
  }
  if (operation === 'repair' || operation === 'push') {
    if (options.dryRun) argv.push('--dry-run');
    else if (options.apply) argv.push('--apply', path.resolve(options.apply));
    else throw new Error(`integration ${operation} requires --dry-run or --apply <receipt>`);
  }
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn('python3', argv, {
      cwd: route.controllerRoot,
      env: route.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Integration command terminated by signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}

export function configureIntegrationCommand(
  program: Command,
  invoke: IntegrationInvoker = invokeIntegration,
): void {
  const integration = program
    .command('integration')
    .description('Inspect or synchronize the registered integration owner');
  integration
    .command('status')
    .description('Show offline integration drift; fetch only when explicitly requested')
    .option('--fetch', 'Refresh the configured remote-tracking ref before reporting')
    .action((options: { fetch?: boolean }) => invoke('status', options));
  integration
    .command('sync')
    .description('Guard, fetch, fast-forward when safe, and refresh exact submodule gitlinks')
    .action(() => invoke('sync', {}));
  integration
    .command('register')
    .description('Bind one verified protected worktree as the canonical integration owner')
    .argument('<owner>', 'Exact linked integration-owner worktree path')
    .option('--replace', 'Replace a different existing canonical registration')
    .action((owner: string, options: { replace?: boolean }) =>
      invoke('register', options.replace ? { owner, replace: true } : { owner }));
  for (const operation of ['repair', 'push'] as const) {
    integration
      .command(operation)
      .description(operation === 'repair'
        ? 'Plan or apply exact, receipt-bound integration topology repair'
        : 'Plan or apply child-first, root-last remote publication')
      .option('--dry-run', 'Persist and print a non-mutating plan receipt')
      .option('--apply <receipt>', 'Apply one exact previously generated plan receipt')
      .action((options: { dryRun?: boolean; apply?: string }) => {
        if (Boolean(options.dryRun) === Boolean(options.apply)) {
          throw new Error(`integration ${operation} requires exactly one of --dry-run or --apply <receipt>`);
        }
        return invoke(operation, options.dryRun
          ? { dryRun: true }
          : { apply: options.apply! });
      });
  }
}
