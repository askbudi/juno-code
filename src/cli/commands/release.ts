import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import { Command } from 'commander';
import { routeControlPlane } from '../../utils/control-plane-router.js';

export type ReleaseTrainOperation = 'plan' | 'status' | 'inspect' | 'seal' | 'epoch-status' | 'drive' | 'eject' | 'repair' | 'shadow';
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
  const train = program.command('release').description('Plan and drive explicitly sealed release epochs')
    .command('train').description('Inspect, seal, and drive a release epoch');
  for (const operation of ['plan', 'status', 'inspect'] as const) {
    train.command(operation)
      .argument('<declaration>', 'Versioned release-train declaration JSON')
      .option('--json', 'Emit stable versioned JSON')
      .option('--output <path>', 'Write the exact JSON projection')
      .action((declaration: string, options: { json?: boolean; output?: string }) => invoke(
        operation, declaration,
        [...(options.json ? ['--json'] : []), ...(options.output ? ['--output', options.output] : [])],
      ));
  }
  train.command('seal')
    .argument('<declaration>', 'Versioned release-train declaration JSON')
    .option('--json', 'Emit stable versioned JSON')
    .action((declaration: string, options: { json?: boolean }) => invoke(
      'seal', declaration, options.json ? ['--json'] : [],
    ));
  train.command('epoch-status')
    .argument('<epoch-id>', 'Sealed epoch identity')
    .option('--json', 'Emit stable versioned JSON')
    .action((epochId: string, options: { json?: boolean }) => invoke(
      'epoch-status', epochId, options.json ? ['--json'] : [],
    ));
  train.command('drive')
    .argument('<epoch-id>', 'Sealed epoch identity')
    .requiredOption('--epoch-token <token>', 'Exact fencing token emitted once by seal')
    .option('--json', 'Emit stable versioned JSON')
    .action((epochId: string, options: { epochToken: string; json?: boolean }) => invoke(
      'drive', epochId, ['--epoch-token', options.epochToken, ...(options.json ? ['--json'] : [])],
    ));
  train.command('eject')
    .argument('<epoch-id>', 'Sealed epoch identity')
    .argument('<task-id>', 'Optional failed member')
    .requiredOption('--reason <reason>', 'Receipt-bound failure reason')
    .requiredOption('--epoch-token <token>', 'Exact epoch fencing token')
    .action((epochId: string, taskId: string, options: { reason: string; epochToken: string }) => invoke(
      'eject', epochId, [taskId, '--reason', options.reason, '--epoch-token', options.epochToken],
    ));
  train.command('repair')
    .argument('<epoch-id>', 'Recovering epoch identity')
    .requiredOption('--receipt <path>', 'Successful canonical managed-worker receipt')
    .requiredOption('--epoch-token <token>', 'Exact epoch fencing token')
    .action((epochId: string, options: { receipt: string; epochToken: string }) => invoke(
      'repair', epochId, ['--receipt', options.receipt, '--epoch-token', options.epochToken],
    ));
  train.command('shadow')
    .argument('<declaration>', 'Versioned release-train declaration JSON')
    .option('--baseline <path>', 'Frozen telemetry baseline JSON')
    .option('--json', 'Emit stable versioned JSON')
    .option('--output <path>', 'Write the canary decision receipt')
    .action((declaration: string, options: { baseline?: string; json?: boolean; output?: string }) => invoke(
      'shadow', declaration, [...(options.baseline ? ['--baseline', options.baseline] : []),
        ...(options.json ? ['--json'] : []), ...(options.output ? ['--output', options.output] : [])],
    ));
}
