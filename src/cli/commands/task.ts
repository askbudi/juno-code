import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import { Command } from 'commander';
import { routeControlPlane } from '../../utils/control-plane-router.js';
import { checkpointControllerAfterFinalization } from '../../utils/controller-checkpoint.js';

export type TaskWorkspaceOperation =
  | 'start'
  | 'status'
  | 'hydrate'
  | 'preflight'
  | 'finish'
  | 'checkpoint'
  | 'evidence-run'
  | 'evidence-status'
  | 'evidence-await'
  | 'recovery-plan'
  | 'recovery-authorize'
  | 'recovery-apply';
export type TaskWorkspaceInvoker = (
  operation: TaskWorkspaceOperation,
  taskId: string,
  requiredPaths?: string[],
  admissionArgs?: string[],
) => Promise<void>;
export type TaskWorkspaceCheckpointer = typeof checkpointControllerAfterFinalization;
export type TaskRuntimeBootstrapOptions = { dryRun?: boolean; apply?: string };
export type TaskRuntimeBootstrapInvoker = (options: TaskRuntimeBootstrapOptions) => Promise<void>;

export function taskWorkspaceControlOperation(operation: TaskWorkspaceOperation): 'kanban' | 'orchestration' {
  return ['status', 'preflight', 'recovery-plan', 'evidence-status'].includes(operation) ? 'kanban' : 'orchestration';
}

export function packagedTaskRuntimeCandidates(): string[] {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(directory, '../templates/scripts/task_workspace.py'),
    path.resolve(directory, '../../templates/scripts/task_workspace.py'),
    path.resolve(directory, '../../src/templates/scripts/task_workspace.py'),
  ];
}

export async function selectTaskWorkspaceRuntime(
  controllerRoot: string,
  operation: TaskWorkspaceOperation,
  packagedCandidates = packagedTaskRuntimeCandidates(),
): Promise<string> {
  const canonical = path.join(controllerRoot, '.juno_task', 'scripts', 'task_workspace.py');
  if (operation !== 'hydrate') {
    if (!(await fs.pathExists(canonical))) {
      throw new Error('Missing managed task workspace runtime. Run `yy scripts update` and retry.');
    }
    return canonical;
  }
  const packaged = packagedCandidates.find((candidate) => fs.existsSync(candidate));
  if (!packaged) {
    throw new Error('Packaged task-hydrate recovery engine is missing; refusing stale controller fallback.');
  }
  const runner = path.join(path.dirname(packaged), 'workflow_runner.sh');
  if (!(await fs.pathExists(runner))) {
    throw new Error('Packaged task-hydrate recovery engine is incomplete; refusing stale controller fallback.');
  }
  const source = await fs.readFile(packaged, 'utf8');
  const protocol = [
    'TASK_HYDRATE_RECOVERY_SCHEMA = "juno_task_hydrate_recovery.v1"',
    'def hydrate(controller:',
    '"start", "status", "hydrate", "preflight", "finish"',
    '"start", "status", "hydrate", "preflight", "finish",',
  ];
  if (!protocol.every((marker) => source.includes(marker))) {
    throw new Error('Packaged task-hydrate recovery engine is incompatible; refusing stale controller fallback.');
  }
  return packaged;
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
  if (packageJson.name !== '@yylo/cli' || typeof packageJson.version !== 'string') {
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
  taskId?: string,
): Promise<void> {
  if (['status', 'preflight', 'recovery-plan', 'checkpoint', 'evidence-run', 'evidence-status', 'evidence-await'].includes(operation)) return;
  if (taskId) await checkpoint(controllerRoot, exitCode, taskId);
  else await checkpoint(controllerRoot, exitCode);
}

export async function invokeTaskWorkspace(
  operation: TaskWorkspaceOperation,
  taskId: string,
  requiredPaths: string[] = [],
  admissionArgs: string[] = [],
): Promise<void> {
  const route = routeControlPlane(process.cwd(), taskWorkspaceControlOperation(operation));
  const controllerRoot = route.controllerRoot;
  const script = await selectTaskWorkspaceRuntime(controllerRoot, operation);
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
  await checkpointTaskWorkspaceAfterFinalization(operation, controllerRoot, exitCode,
    checkpointControllerAfterFinalization, taskId);
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
    .argument('<task-id>', 'Canonical Juno Ledger task ID')
    .option('--path <path>', 'Required product root admitted by task-workspace policy', (value, values: string[]) => [...values, value], [])
    .option('--umbrella-admission <file>', 'Versioned ordered-child exact-scope input')
    .action((taskId: string, options: { path: string[]; umbrellaAdmission?: string }) => (
      options.umbrellaAdmission
        ? invoke('start', taskId, options.path, ['--umbrella-admission', options.umbrellaAdmission])
        : invoke('start', taskId, options.path)
    ));
  task.command('preflight')
    .description('Read-only finish/admission check before expensive validation')
    .argument('<task-id>', 'Canonical Juno Ledger task ID')
    .action((taskId: string) => invoke('preflight', taskId, []));
  task.command('checkpoint')
    .description('Plan affected validation for one clean coherent committed tip')
    .argument('<task-id>', 'Canonical Juno Ledger task ID')
    .action((taskId: string) => invoke('checkpoint', taskId, []));
  task.command('hydrate')
    .description('Rerun the frozen task hydration workflow on a clean task worktree')
    .argument('<task-id>', 'Canonical Juno Ledger task ID')
    .action((taskId: string) => invoke('hydrate', taskId, []));
  for (const operation of ['status', 'finish'] as const) {
    task.command(operation)
      .argument('<task-id>', 'Canonical Juno Ledger task ID')
      .action((taskId: string) => invoke(operation, taskId, []));
  }
  task.command('recovery-plan')
    .argument('<task-id>', 'Canonical umbrella Juno Ledger task ID')
    .requiredOption('--umbrella-admission <file>', 'Frozen ordered-child exact-scope input')
    .requiredOption('--output <file>', 'New exclusive recovery plan path')
    .action((taskId: string, options: { umbrellaAdmission: string; output: string }) => invoke(
      'recovery-plan', taskId, [], ['--umbrella-admission', options.umbrellaAdmission,
        '--output', options.output],
    ));
  task.command('recovery-authorize')
    .argument('<task-id>', 'Canonical umbrella Juno Ledger task ID')
    .requiredOption('--umbrella-admission <file>', 'Frozen ordered-child exact-scope input')
    .requiredOption('--plan <file>', 'Exact reviewed recovery plan')
    .action((taskId: string, options: { umbrellaAdmission: string; plan: string }) => invoke(
      'recovery-authorize', taskId, [], ['--umbrella-admission', options.umbrellaAdmission,
        '--plan', options.plan],
    ));
  task.command('recovery-apply')
    .argument('<task-id>', 'Canonical umbrella Juno Ledger task ID')
    .requiredOption('--umbrella-admission <file>', 'Frozen ordered-child exact-scope input')
    .requiredOption('--plan <file>', 'Exact reviewed recovery plan')
    .requiredOption('--authorization-receipt <file>', 'Canonical immutable authorization for the exact plan')
    .action((taskId: string, options: { umbrellaAdmission: string; plan: string; authorizationReceipt: string }) => invoke(
      'recovery-apply', taskId, [], ['--umbrella-admission', options.umbrellaAdmission,
        '--plan', options.plan, '--authorization-receipt', options.authorizationReceipt],
    ));
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
