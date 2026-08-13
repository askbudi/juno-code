import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import { Command } from 'commander';
import { routeControlPlane } from '../../utils/control-plane-router.js';
import { checkpointControllerAfterFinalization } from '../../utils/controller-checkpoint.js';

export type TaskWorkspaceOperation = 'start' | 'status' | 'finish';
export type TaskWorkspaceInvoker = (
  operation: TaskWorkspaceOperation,
  taskId: string,
  requiredPaths?: string[],
) => Promise<void>;
export type TaskWorkspaceCheckpointer = typeof checkpointControllerAfterFinalization;
export type TaskRuntimeBootstrapOptions = { dryRun?: boolean; apply?: string };
export type TaskRuntimeBootstrapInvoker = (options: TaskRuntimeBootstrapOptions) => Promise<void>;

export function packagedTaskRuntimeCandidates(): string[] {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(directory, '../templates/scripts/task_workspace.py'),
    path.resolve(directory, '../../templates/scripts/task_workspace.py'),
    path.resolve(directory, '../../src/templates/scripts/task_workspace.py'),
  ];
}

export async function invokeTaskRuntimeBootstrap(
  options: TaskRuntimeBootstrapOptions,
  packagedCandidates = packagedTaskRuntimeCandidates(),
): Promise<void> {
  if (Boolean(options.dryRun) === Boolean(options.apply)) {
    throw new Error('task runtime-bootstrap requires exactly one of --dry-run or --apply <receipt>');
  }
  const route = routeControlPlane(process.cwd(), 'orchestration');
  const script = packagedCandidates.find((candidate) => fs.existsSync(candidate));
  if (!script) throw new Error('Packaged task-runtime bootstrap engine is missing.');
  const source = await fs.readFile(script);
  const required = [
    'RUNTIME_BOOTSTRAP_SCHEMA = "juno_target_task_runtime_bootstrap.v1"',
    'def runtime_bootstrap(',
    '"runtime-bootstrap"',
  ];
  if (!required.every((marker) => source.includes(Buffer.from(marker)))) {
    throw new Error('Packaged task-runtime bootstrap engine is incompatible.');
  }
  const packagePath = path.resolve(path.dirname(script), '../../..', 'package.json');
  const packageJson = await fs.readJson(packagePath) as { name?: string; version?: string };
  if (packageJson.name !== 'juno-code' || typeof packageJson.version !== 'string') {
    throw new Error('Packaged task-runtime identity is invalid.');
  }
  const hash = createHash('sha256').update(source).digest('hex');
  const argv = [script, 'runtime-bootstrap', '--controller', route.controllerRoot,
    '--package-version', packageJson.version, '--package-runtime-sha256', hash];
  if (options.dryRun) argv.push('--dry-run');
  else argv.push('--apply', path.resolve(options.apply!));
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn('python3', argv, {
      cwd: route.controllerRoot, env: route.env, stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Task runtime bootstrap terminated by signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}

export async function checkpointTaskWorkspaceAfterFinalization(
  operation: TaskWorkspaceOperation,
  controllerRoot: string,
  exitCode: number,
  checkpoint: TaskWorkspaceCheckpointer = checkpointControllerAfterFinalization,
): Promise<void> {
  if (operation === 'status') return;
  await checkpoint(controllerRoot, exitCode);
}

export async function invokeTaskWorkspace(
  operation: TaskWorkspaceOperation,
  taskId: string,
  requiredPaths: string[] = [],
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
  invokeBootstrap: TaskRuntimeBootstrapInvoker = invokeTaskRuntimeBootstrap,
): void {
  const task = program
    .command('task')
    .description('Create, inspect, and queue one exact-base feature worktree');
  task
    .command('start')
    .argument('<task-id>', 'Canonical Kanban task ID')
    .option('--path <path>', 'Required product root admitted by task-workspace policy', (value, values: string[]) => [...values, value], [])
    .action((taskId: string, options: { path: string[] }) => invoke('start', taskId, options.path));
  for (const operation of ['status', 'finish'] as const) {
    task.command(operation)
      .argument('<task-id>', 'Canonical Kanban task ID')
      .action((taskId: string) => invoke(operation, taskId, []));
  }
  task.command('runtime-bootstrap')
    .description('Plan or apply guarded package-bound target task-runtime recovery')
    .option('--dry-run', 'Persist and print a non-mutating target bootstrap plan')
    .option('--apply <receipt>', 'Apply one exact immutable bootstrap plan')
    .action((options: TaskRuntimeBootstrapOptions) => {
      if (Boolean(options.dryRun) === Boolean(options.apply)) {
        throw new Error('task runtime-bootstrap requires exactly one of --dry-run or --apply <receipt>');
      }
      return invokeBootstrap(options.dryRun ? { dryRun: true } : { apply: options.apply! });
    });
}
