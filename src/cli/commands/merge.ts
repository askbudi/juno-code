import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import { Command } from 'commander';
import { routeControlPlane } from '../../utils/control-plane-router.js';
import { checkpointControllerAfterFinalization } from '../../utils/controller-checkpoint.js';

export type MergeQueueOperation = 'status' | 'next' | 'resolve' | 'review' | 'reopen';
export type MergeQueueInvoker = (operation: MergeQueueOperation, taskId?: string) => Promise<void>;
export type MergeQueueCheckpointer = typeof checkpointControllerAfterFinalization;

export const MAX_MERGE_RESULT_LINE_CHARS = 1024 * 1024;

/** Retain only one bounded terminal stdout line while all output is streamed. */
export class TerminalMergeResultExtractor {
  private pending = '';
  private pendingOversized = false;
  private terminal: unknown;

  append(text: string): void {
    for (let start = 0; start <= text.length;) {
      const newline = text.indexOf('\n', start);
      const end = newline === -1 ? text.length : newline;
      if (!this.pendingOversized) {
        const remaining = MAX_MERGE_RESULT_LINE_CHARS - this.pending.length;
        const part = text.slice(start, Math.min(end, start + Math.max(remaining, 0)));
        this.pending += part;
        if (end - start > remaining) this.pendingOversized = true;
      }
      if (newline === -1) break;
      this.completeLine();
      start = newline + 1;
    }
  }

  finish(): unknown {
    if (this.pending.length > 0 || this.pendingOversized) this.completeLine();
    return this.terminal;
  }

  private completeLine(): void {
    if (this.pendingOversized) {
      this.terminal = undefined;
    } else if (this.pending.trim()) {
      try {
        this.terminal = JSON.parse(this.pending);
      } catch {
        this.terminal = undefined;
      }
    }
    this.pending = '';
    this.pendingOversized = false;
  }
}

export async function checkpointMergeQueueAfterFinalization(
  operation: MergeQueueOperation,
  controllerRoot: string,
  exitCode: number,
  result: unknown,
  checkpoint: MergeQueueCheckpointer = checkpointControllerAfterFinalization,
): Promise<void> {
  const payload = result && typeof result === 'object'
    ? result as Record<string, unknown>
    : undefined;
  const postIntegration = payload?.post_integration;
  const phases = postIntegration && typeof postIntegration === 'object'
    ? postIntegration as Record<string, unknown>
    : undefined;
  const kanban = phases?.kanban_finalization;
  const kanbanPhase = kanban && typeof kanban === 'object'
    ? kanban as Record<string, unknown>
    : undefined;
  // Do not checkpoint successful intermediate review/admission transitions.
  // MERGED is persisted only after the terminal Kanban mutation and readback.
  if (!['next', 'resolve'].includes(operation) || exitCode !== 0
      || payload?.outcome !== 'MERGED' || kanbanPhase?.status !== 'complete') return;
  await checkpoint(controllerRoot, exitCode);
}

export async function invokeMergeQueueAtController(
  operation: MergeQueueOperation,
  controllerRoot: string,
  env: NodeJS.ProcessEnv,
  taskId?: string,
  checkpoint: MergeQueueCheckpointer = checkpointControllerAfterFinalization,
): Promise<void> {
  const script = path.join(controllerRoot, '.juno_task', 'scripts', 'merge_queue.py');
  if (!(await fs.pathExists(script))) {
    throw new Error('Missing managed merge queue runtime. Run `yy scripts update` and retry.');
  }
  const args = [script, operation, ...(taskId ? [taskId] : [])];
  const extractor = new TerminalMergeResultExtractor();
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn('python3', args, { cwd: controllerRoot, env, stdio: ['inherit', 'pipe', 'inherit'] });
    child.stdout.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      extractor.append(text);
      process.stdout.write(text);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`Merge queue command terminated by signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
  const result = exitCode === 0 ? extractor.finish() : undefined;
  await checkpointMergeQueueAfterFinalization(operation, controllerRoot, exitCode, result, checkpoint);
  if (exitCode !== 0) process.exitCode = exitCode;
}

export async function invokeMergeQueue(operation: MergeQueueOperation, taskId?: string): Promise<void> {
  const route = routeControlPlane(
    process.cwd(),
    operation === 'status' ? 'kanban' : 'orchestration',
  );
  await invokeMergeQueueAtController(operation, route.controllerRoot, route.env, taskId);
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
