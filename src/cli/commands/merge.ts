import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import { Command } from 'commander';
import { routeControlPlane } from '../../utils/control-plane-router.js';

export type MergeQueueOperation = 'status' | 'next' | 'resolve' | 'review' | 'reopen';
export type MergeQueueInvoker = (operation: MergeQueueOperation, taskId?: string) => Promise<void>;

export async function invokeMergeQueue(operation: MergeQueueOperation, taskId?: string): Promise<void> {
  const route = routeControlPlane(
    process.cwd(),
    operation === 'status' ? 'kanban' : 'orchestration',
  );
  const controllerRoot = route.controllerRoot;
  const script = path.join(controllerRoot, '.juno_task', 'scripts', 'merge_queue.py');
  if (!(await fs.pathExists(script))) {
    throw new Error('Missing managed merge queue runtime. Run `yy scripts update` and retry.');
  }
  const args = [script, operation, ...(taskId ? [taskId] : [])];
  const env = route.env;
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn('python3', args, { cwd: controllerRoot, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Merge queue command terminated by signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}

export function configureMergeQueueCommand(
  program: Command,
  invoke: MergeQueueInvoker = invokeMergeQueue,
): void {
  const merge = program.command('merge').description('Inspect or advance the conflict-aware product merge queue');
  merge.command('status').action(() => invoke('status'));
  merge
    .command('next')
    .description('Advance the queue, or continue paused evidence for TASK_ID')
    .argument('[task-id]', 'Paused task whose evidence/review processing should continue')
    .action((taskId?: string) =>
      taskId === undefined ? invoke('next') : invoke('next', taskId),
    );
  merge.command('resolve').argument('<task-id>', 'Canonical Kanban task ID').action((taskId: string) => invoke('resolve', taskId));
  merge.command('review').argument('<task-id>', 'Canonical Kanban task ID').action((taskId: string) => invoke('review', taskId));
  merge.command('reopen').argument('<task-id>', 'Task with review findings and a new committed tip').action((taskId: string) => invoke('reopen', taskId));
}
