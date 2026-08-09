import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import { Command } from 'commander';
import { resolveController } from '../../utils/controller-resolver.js';
import type { ControllerResolution } from '../../utils/controller-resolver.js';

export type MergeQueueOperation = 'status' | 'next' | 'resolve';
export type MergeQueueInvoker = (operation: MergeQueueOperation, taskId?: string) => Promise<void>;

export function requireExactMergeController(resolution: ControllerResolution): string {
  const controllerRoot = path.resolve(resolution.path);
  const currentRoot = path.resolve(resolution.current_root);
  if (
    resolution.resolver !== 'installed' ||
    !resolution.valid ||
    resolution.role !== 'controller' ||
    controllerRoot !== currentRoot
  ) {
    throw new Error(
      'Merge queue commands require an installed resolver and the exact canonical controller root',
    );
  }
  return controllerRoot;
}

export async function invokeMergeQueue(operation: MergeQueueOperation, taskId?: string): Promise<void> {
  const resolution = resolveController(process.cwd(), operation === 'status' ? 'kanban' : 'orchestration');
  const controllerRoot = requireExactMergeController(resolution);
  const script = path.join(controllerRoot, '.juno_task', 'scripts', 'merge_queue.py');
  if (!(await fs.pathExists(script))) {
    throw new Error('Missing managed merge queue runtime. Run `yy scripts update` and retry.');
  }
  const args = [script, operation, ...(taskId ? [taskId] : [])];
  const env = {
    ...process.env,
    JUNO_TASK_ROOT: controllerRoot,
    JUNO_WORKSPACE_ROLE: 'controller',
    JUNO_WORKSPACE_ENFORCEMENT: 'strict',
  };
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
  merge.command('next').action(() => invoke('next'));
  merge.command('resolve').argument('<task-id>', 'Canonical Kanban task ID').action((taskId: string) => invoke('resolve', taskId));
}
