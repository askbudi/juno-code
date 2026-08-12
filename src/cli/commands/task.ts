import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import { Command } from 'commander';
import { routeControlPlane } from '../../utils/control-plane-router.js';
import { checkpointControllerAfterFinalization } from '../../utils/controller-checkpoint.js';

export type TaskWorkspaceOperation = 'start' | 'status' | 'finish' | 'recovery-plan' | 'recovery-authorize' | 'recovery-apply';
export type TaskWorkspaceInvoker = (
  operation: TaskWorkspaceOperation,
  taskId: string,
  requiredPaths?: string[],
  admissionArgs?: string[],
) => Promise<void>;
export type TaskWorkspaceCheckpointer = typeof checkpointControllerAfterFinalization;

export function taskWorkspaceControlOperation(operation: TaskWorkspaceOperation): 'kanban' | 'orchestration' {
  return operation === 'status' || operation === 'recovery-plan' ? 'kanban' : 'orchestration';
}

export async function checkpointTaskWorkspaceAfterFinalization(
  operation: TaskWorkspaceOperation,
  controllerRoot: string,
  exitCode: number,
  checkpoint: TaskWorkspaceCheckpointer = checkpointControllerAfterFinalization,
): Promise<void> {
  if (operation === 'status' || operation === 'recovery-plan') return;
  await checkpoint(controllerRoot, exitCode);
}

export async function invokeTaskWorkspace(
  operation: TaskWorkspaceOperation,
  taskId: string,
  requiredPaths: string[] = [],
  admissionArgs: string[] = [],
): Promise<void> {
  const route = routeControlPlane(
    process.cwd(),
    taskWorkspaceControlOperation(operation),
  );
  const controllerRoot = route.controllerRoot;
  const script = path.join(controllerRoot, '.juno_task', 'scripts', 'task_workspace.py');
  if (!(await fs.pathExists(script))) {
    throw new Error('Missing managed task workspace runtime. Run `yy scripts update` and retry.');
  }
  const taskEnv = route.env;
  const exitCode = await new Promise<number>((resolve, reject) => {
    const pathArgs = requiredPaths.flatMap((requiredPath) => ['--path', requiredPath]);
    const child = spawn('python3', [script, operation, '--task', taskId, ...pathArgs, ...admissionArgs], {
      cwd: controllerRoot,
      env: taskEnv,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Task workspace command terminated by signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
  await checkpointTaskWorkspaceAfterFinalization(operation, controllerRoot, exitCode);
  if (exitCode !== 0) process.exitCode = exitCode;
}

export function configureTaskWorkspaceCommand(
  program: Command,
  invoke: TaskWorkspaceInvoker = invokeTaskWorkspace,
): void {
  const task = program
    .command('task')
    .description('Create, inspect, and queue one exact-base feature worktree');
  task
    .command('start')
    .argument('<task-id>', 'Canonical Kanban task ID')
    .option('--path <path>', 'Required product root admitted by task-workspace policy', (value, values: string[]) => [...values, value], [])
    .option('--umbrella-admission <file>', 'Versioned ordered-child exact-scope input')
    .action((taskId: string, options: { path: string[]; umbrellaAdmission?: string }) => (
      options.umbrellaAdmission
        ? invoke('start', taskId, options.path, ['--umbrella-admission', options.umbrellaAdmission])
        : invoke('start', taskId, options.path)
    ));
  for (const operation of ['status', 'finish'] as const) {
    task.command(operation)
      .argument('<task-id>', 'Canonical Kanban task ID')
      .action((taskId: string) => invoke(operation, taskId, []));
  }
  task.command('recovery-plan')
    .argument('<task-id>', 'Canonical umbrella Kanban task ID')
    .requiredOption('--umbrella-admission <file>', 'Frozen ordered-child exact-scope input')
    .requiredOption('--output <file>', 'New exclusive recovery plan path')
    .action((taskId: string, options: { umbrellaAdmission: string; output: string }) => invoke(
      'recovery-plan', taskId, [], ['--umbrella-admission', options.umbrellaAdmission,
        '--output', options.output],
    ));
  task.command('recovery-authorize')
    .argument('<task-id>', 'Canonical umbrella Kanban task ID')
    .requiredOption('--umbrella-admission <file>', 'Frozen ordered-child exact-scope input')
    .requiredOption('--plan <file>', 'Exact reviewed recovery plan')
    .action((taskId: string, options: { umbrellaAdmission: string; plan: string }) => invoke(
      'recovery-authorize', taskId, [], ['--umbrella-admission', options.umbrellaAdmission,
        '--plan', options.plan],
    ));
  task.command('recovery-apply')
    .argument('<task-id>', 'Canonical umbrella Kanban task ID')
    .requiredOption('--umbrella-admission <file>', 'Frozen ordered-child exact-scope input')
    .requiredOption('--plan <file>', 'Exact reviewed recovery plan')
    .requiredOption('--authorization-receipt <file>', 'Canonical immutable authorization for the exact plan')
    .action((taskId: string, options: { umbrellaAdmission: string; plan: string; authorizationReceipt: string }) => invoke(
      'recovery-apply', taskId, [], ['--umbrella-admission', options.umbrellaAdmission,
        '--plan', options.plan, '--authorization-receipt', options.authorizationReceipt],
    ));
}
