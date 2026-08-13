import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import { Command } from 'commander';
import { routeControlPlane } from '../../utils/control-plane-router.js';
import { checkpointControllerAfterFinalization } from '../../utils/controller-checkpoint.js';

export type TaskWorkspaceOperation = 'start' | 'status' | 'preflight' | 'finish';
export type TaskWorkspaceInvoker = (
  operation: TaskWorkspaceOperation,
  taskId: string,
  requiredPaths?: string[],
) => Promise<void>;
export type TaskWorkspaceCheckpointer = typeof checkpointControllerAfterFinalization;

export async function checkpointTaskWorkspaceAfterFinalization(
  operation: TaskWorkspaceOperation,
  controllerRoot: string,
  exitCode: number,
  checkpoint: TaskWorkspaceCheckpointer = checkpointControllerAfterFinalization,
): Promise<void> {
  if (operation === 'status' || operation === 'preflight') return;
  await checkpoint(controllerRoot, exitCode);
}

export async function invokeTaskWorkspace(
  operation: TaskWorkspaceOperation,
  taskId: string,
  requiredPaths: string[] = [],
): Promise<void> {
  const route = routeControlPlane(
    process.cwd(),
    operation === 'status' || operation === 'preflight' ? 'kanban' : 'orchestration',
  );
  const controllerRoot = route.controllerRoot;
  const script = path.join(controllerRoot, '.juno_task', 'scripts', 'task_workspace.py');
  if (!(await fs.pathExists(script))) {
    throw new Error('Missing managed task workspace runtime. Run `yy scripts update` and retry.');
  }
  const taskEnv = route.env;
  const exitCode = await new Promise<number>((resolve, reject) => {
    const pathArgs = requiredPaths.flatMap((requiredPath) => ['--path', requiredPath]);
    const child = spawn('python3', [script, operation, '--task', taskId, ...pathArgs], {
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
    .action((taskId: string, options: { path: string[] }) => invoke('start', taskId, options.path));
  task.command('preflight')
    .description('Read-only finish/admission check before expensive validation')
    .argument('<task-id>', 'Canonical Kanban task ID')
    .action((taskId: string) => invoke('preflight', taskId, []));
  for (const operation of ['status', 'finish'] as const) {
    task.command(operation)
      .argument('<task-id>', 'Canonical Kanban task ID')
      .action((taskId: string) => invoke(operation, taskId, []));
  }
}
