import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import { Command } from 'commander';
import { routeControlPlane } from '../../utils/control-plane-router.js';

export type TaskWorkspaceOperation = 'start' | 'status' | 'finish';
export type TaskWorkspaceInvoker = (operation: TaskWorkspaceOperation, taskId: string) => Promise<void>;

export async function invokeTaskWorkspace(
  operation: TaskWorkspaceOperation,
  taskId: string,
): Promise<void> {
  const route = routeControlPlane(
    process.cwd(),
    operation === 'status' ? 'kanban' : 'orchestration',
  );
  const controllerRoot = route.controllerRoot;
  const script = path.join(controllerRoot, '.juno_task', 'scripts', 'task_workspace.py');
  if (!(await fs.pathExists(script))) {
    throw new Error('Missing managed task workspace runtime. Run `yy scripts update` and retry.');
  }
  const taskEnv = route.env;
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn('python3', [script, operation, '--task', taskId], {
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
  if (exitCode !== 0) process.exitCode = exitCode;
}

export function configureTaskWorkspaceCommand(
  program: Command,
  invoke: TaskWorkspaceInvoker = invokeTaskWorkspace,
): void {
  const task = program
    .command('task')
    .description('Create, inspect, and queue one exact-base feature worktree');
  for (const operation of ['start', 'status', 'finish'] as const) {
    task
      .command(operation)
      .argument('<task-id>', 'Canonical Kanban task ID')
      .action((taskId: string) => invoke(operation, taskId));
  }
}
