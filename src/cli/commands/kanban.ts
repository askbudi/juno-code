import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import { Command } from 'commander';
import { routeControlPlane } from '../../utils/control-plane-router.js';

export type KanbanInvoker = (args: string[]) => Promise<void>;

export async function invokeKanban(args: string[]): Promise<void> {
  const route = routeControlPlane(process.cwd(), 'kanban');
  const wrapper = path.join(route.controllerRoot, '.juno_task', 'scripts', 'kanban.sh');
  if (!(await fs.pathExists(wrapper))) {
    throw new Error('Missing canonical controller Juno Ledger wrapper (`kanban.sh`). Run `yy scripts update` from the controller.');
  }
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn('bash', [wrapper, ...args], {
      cwd: route.controllerRoot,
      env: route.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Juno Ledger command terminated by signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}

export function configureKanbanCommand(
  program: Command,
  invoke: KanbanInvoker = invokeKanban,
): void {
  program
    .command('ledger [args...]')
    .alias('kanban')
    .description('Run the canonical controller Juno Ledger facade (legacy alias: kanban)')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action((args: string[]) => invoke(args));
}
