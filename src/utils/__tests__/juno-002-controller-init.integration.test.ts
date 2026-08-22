import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const codeRoot = path.resolve(process.cwd());
const repositoryRoot = path.resolve(codeRoot, '..');
const tool = path.join(codeRoot, 'scripts/juno-002-source-toolchain.sh');
const tempDirs: string[] = [];
const realGitIntegrationIt = process.env.YYLO_REAL_GIT_INTEGRATION === '1' ? it : it.skip;

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function expectOk(result: ReturnType<typeof run>, label: string) {
  expect(result.status, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
}

async function sha256(file: string) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function treeDigest(root: string): Promise<string> {
  if (!(await fs.pathExists(root))) return '<missing>';
  const files: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of (await fs.readdir(directory)).sort()) {
      const absolute = path.join(directory, entry);
      const stat = await fs.stat(absolute);
      if (stat.isDirectory()) await visit(absolute);
      else if (stat.isFile()) files.push(absolute);
    }
  };
  await visit(root);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(root, file));
    hash.update(await fs.readFile(file));
  }
  return hash.digest('hex');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.remove(directory)));
});

describe('isolated Juno 2 controller initialization', () => {
  realGitIntegrationIt('source install -> alias init -> linked wrapper mutates only controller Kanban 2 storage', { timeout: 300_000 }, async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-002-controller-init-'));
    tempDirs.push(temp);
    const state = path.join(temp, 'toolchain');
    const controller = path.join(temp, 'controller');
    const task = path.join(temp, 'task-worktree');
    const stableBin = path.join(temp, 'stable-bin');
    const unrelatedKanban = path.join(temp, 'unrelated', '.venv_juno', 'bin', 'juno-kanban');
    const stableYy = path.join(stableBin, 'yy');
    const stableKanban = path.join(stableBin, 'juno-kanban');

    await fs.outputFile(stableYy, '#!/usr/bin/env bash\necho stable-yy\n', { mode: 0o755 });
    await fs.outputFile(stableKanban, '#!/usr/bin/env bash\necho stable-kanban\n', { mode: 0o755 });
    await fs.outputFile(unrelatedKanban, '#!/usr/bin/env bash\necho unrelated-kanban\n', { mode: 0o755 });
    const immutableFiles = [stableYy, stableKanban, unrelatedKanban, path.join(codeRoot, 'package.json'), path.join(repositoryRoot, 'juno_kanban', 'setup.py')];
    const beforeHashes = await Promise.all(immutableFiles.map(sha256));
    const isolatedEnv = {
      JUNO_002_STATE_DIR: state,
      PATH: `${stableBin}:${process.env.PATH ?? ''}`,
      VIRTUAL_ENV: path.dirname(path.dirname(unrelatedKanban)),
      JUNO_TASK_ROOT: '',
      JUNO_CONTROLLER_BRANCH: '',
      JUNO_WORKSPACE_ENFORCEMENT: 'off',
      JUNO_WORKSPACE_ROLE: '',
    };

    const install = run('bash', [tool, 'install'], { cwd: repositoryRoot, env: isolatedEnv });
    expectOk(install, 'isolated source install');

    await fs.ensureDir(controller);
    expectOk(run('git', ['init', '-b', 'controller'], { cwd: controller }), 'git init controller');
    const alias = path.join(state, 'bin', 'yy-juno-002');
    const init = run(alias, ['init', 'canary', '--directory', controller, '--subagent', 'claude'], {
      cwd: temp,
      env: isolatedEnv,
    });
    expectOk(init, 'isolated alias init');

    const controllerKanban = path.join(controller, '.venv_juno', 'bin', 'juno-kanban');
    expect((await fs.stat(controllerKanban)).mode & 0o111).not.toBe(0);
    const version = run(controllerKanban, ['--version'], { cwd: controller });
    expectOk(version, 'controller Kanban version');
    const match = `${version.stdout}${version.stderr}`.match(/(\d+)\.(\d+)\.(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(2);

    const gitEnv = {
      ...isolatedEnv,
      GIT_AUTHOR_NAME: 'Juno Test',
      GIT_AUTHOR_EMAIL: 'juno@example.invalid',
      GIT_COMMITTER_NAME: 'Juno Test',
      GIT_COMMITTER_EMAIL: 'juno@example.invalid',
    };
    expectOk(run('git', ['add', '.'], { cwd: controller, env: gitEnv }), 'stage controller');
    expectOk(run('git', ['commit', '-m', 'initialize disposable controller'], { cwd: controller, env: gitEnv }), 'commit controller');
    const controllerBranchResult = run('git', ['branch', '--show-current'], { cwd: controller, env: gitEnv });
    expectOk(controllerBranchResult, 'read controller branch');
    const controllerBranch = controllerBranchResult.stdout.trim();
    expectOk(run('git', ['worktree', 'add', '-b', 'task', task], { cwd: controller, env: gitEnv }), 'add task worktree');

    const resolver = path.join(task, '.juno_task', 'scripts', 'controller_resolver.py');
    const registration = run('python3', [resolver, '--cwd', task, '--register', controller, '--branch', controllerBranch, '--format', 'json'], { cwd: task, env: gitEnv });
    expectOk(registration, 'register disposable controller');

    const taskStorage = path.join(task, '.juno_task', 'tasks');
    const controllerStorage = path.join(controller, '.juno_task', 'tasks');
    const taskBefore = await treeDigest(taskStorage);
    const controllerBefore = await treeDigest(controllerStorage);
    const wrapper = path.join(task, '.juno_task', 'scripts', 'kanban.sh');
    const create = run(wrapper, ['create', 'linked controller mutation', '--status', 'backlog'], { cwd: task, env: gitEnv });
    expectOk(create, 'linked-worktree wrapper mutation');
    const readback = run(wrapper, ['search', '--body', 'linked controller mutation'], { cwd: task, env: gitEnv });
    expectOk(readback, 'linked-worktree wrapper readback');
    expect(readback.stdout).toContain('linked controller mutation');
    expect(await treeDigest(controllerStorage)).not.toBe(controllerBefore);
    expect(await treeDigest(taskStorage)).toBe(taskBefore);

    const controllerDataBeforeSelectorRollback = await treeDigest(controllerStorage);
    expectOk(run('bash', [tool, 'install'], { cwd: repositoryRoot, env: isolatedEnv }), 'second isolated install');
    expectOk(run('bash', [tool, 'rollback-selection'], { cwd: repositoryRoot, env: isolatedEnv }), 'executable selector rollback');
    expect(await treeDigest(controllerStorage)).toBe(controllerDataBeforeSelectorRollback);
    expect(await Promise.all(immutableFiles.map(sha256))).toEqual(beforeHashes);
  });
});
