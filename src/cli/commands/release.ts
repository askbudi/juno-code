import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import { Command } from 'commander';
import { routeControlPlane } from '../../utils/control-plane-router.js';

export type ReleaseTrainOperation = 'plan' | 'status';
export type ReleaseTrainInvoker = (
  operation: ReleaseTrainOperation, declaration: string, extraArgs?: string[],
) => Promise<void>;

export async function invokeReleaseTrain(
  operation: ReleaseTrainOperation, declaration: string, extraArgs: string[] = [],
): Promise<void> {
  const route = routeControlPlane(process.cwd(), 'kanban');
  const script = path.join(route.controllerRoot, '.juno_task', 'scripts', 'release_train.py');
  if (!(await fs.pathExists(script))) {
    throw new Error('Missing managed release-train runtime. Run `yy scripts update --force` and retry.');
  }
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn('python3', [script, operation, declaration, ...extraArgs], {
      cwd: route.controllerRoot, env: route.env, stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => signal
      ? reject(new Error(`Release-train command terminated by signal ${signal}`))
      : resolve(exitCode ?? 1));
  });
  if (code !== 0) process.exitCode = code;
}

export function configureReleaseTrainCommand(
  program: Command, invoke: ReleaseTrainInvoker = invokeReleaseTrain,
): void {
  const train = program.command('release').description('Plan explicitly declared release trains')
    .command('train').description('Inspect a release train without mutation');
  for (const operation of ['plan', 'status'] as const) {
    train.command(operation)
      .argument('<declaration>', 'Versioned release-train declaration JSON')
      .option('--json', 'Emit stable versioned JSON')
      .option('--output <path>', 'Write the exact JSON plan for a later stale-plan gate')
      .action((declaration: string, options: { json?: boolean; output?: string }) => invoke(
        operation, declaration,
        [...(options.json ? ['--json'] : []), ...(options.output ? ['--output', options.output] : [])],
      ));
  }
}
