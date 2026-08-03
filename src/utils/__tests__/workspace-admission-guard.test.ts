import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const scripts = path.resolve(process.cwd(), 'src/templates/scripts');
const checkpoint = path.join(scripts, 'controller_checkpoint.py');
const lifecycle = path.join(scripts, 'worktree_lifecycle.py');
const resolver = path.join(scripts, 'controller_resolver.py');

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, JUNO_TASK_ROOT: '', JUNO_WORKSPACE_ROLE: '', JUNO_CONTROLLER_BRANCH: '', ...env } });
}
function git(cwd: string, ...args: string[]) {
  const result = run('git', args, cwd);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
function python(script: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return run('python3', [script, ...args], cwd, env);
}

describe('joined workspace edit and commit admission', () => {
  let temp: string;
  let controller: string;
  let task: string;
  let base: string;
  let manifest: string;
  let verification: string;

  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-admission-'));
    controller = path.join(temp, 'controller');
    task = path.join(temp, 'task');
    await fs.ensureDir(path.join(controller, '.juno_task', 'tasks'));
    await fs.writeJson(path.join(controller, '.juno_task', 'config.json'), {});
    await fs.ensureDir(path.join(controller, '.juno_task', 'scripts'));
    for (const name of ['controller_resolver.py', 'integration_candidate.py', 'worktree_lifecycle.py']) {
      await fs.copy(path.join(scripts, name), path.join(controller, '.juno_task', 'scripts', name));
    }
    await fs.writeFile(path.join(controller, '.juno_task', 'tasks', 'one.md'), 'one\n');
    await fs.writeFile(path.join(controller, 'product.txt'), 'initial\n');
    git(controller, 'init', '-b', 'main');
    git(controller, 'config', 'user.name', 'Fixture');
    git(controller, 'config', 'user.email', 'fixture@example.invalid');
    git(controller, 'add', '.');
    git(controller, 'commit', '-m', 'initial');
    base = git(controller, 'rev-parse', 'HEAD');
    manifest = path.join(temp, 'create.json');
    verification = path.join(temp, 'verify.json');
    const created = python(lifecycle, ['create', '--repository', controller, '--target-ref', 'refs/heads/main', '--expected-base', base,
      '--path', task, '--branch-ref', 'refs/heads/task-T1', '--task-id', 'T1', '--expected-path', 'product.txt',
      '--cleanup-owner', 'fixture', '--output', manifest], controller);
    expect(created.status, created.stderr).toBe(0);
    const verified = python(lifecycle, ['verify', '--manifest', manifest, '--path', task, '--output', verification], controller);
    expect(verified.status, verified.stderr).toBe(0);
  });

  afterEach(async () => fs.remove(temp));

  it('uses persisted role evidence and refuses environment reclassification', () => {
    const taskRole = python(resolver, ['--cwd', task], task);
    expect(taskRole.status, taskRole.stderr).toBe(0);
    expect(JSON.parse(taskRole.stdout)).toMatchObject({ role: 'task', role_source: 'worktree-registration', role_base: base });
    const spoof = python(resolver, ['--cwd', task], task, { JUNO_WORKSPACE_ROLE: 'controller' });
    expect(spoof.status).toBe(2);
    expect(spoof.stderr).toContain('assertion mismatch');

    const registered = python(resolver, ['--cwd', task, '--register-workspace-role', 'integration-owner'], task);
    expect(registered.status, registered.stderr).toBe(0);
    expect(JSON.parse(registered.stdout).role).toBe('integration-owner');
    fs.writeFileSync(path.join(task, 'product.txt'), 'owner edit\n');
    git(task, 'add', 'product.txt');
    const ownerBoundary = python(checkpoint, ['--root', task, 'staged-check', '--json'], task);
    expect(ownerBoundary.status).toBe(2);
    expect(ownerBoundary.stderr).toContain('integration_owner_commit_forbidden');
  });

  it('refuses an exact staged gitlink without changing HEAD or index', async () => {
    const child = path.join(temp, 'child');
    git(temp, 'init', '-b', 'main', child);
    git(child, 'config', 'user.name', 'Fixture');
    git(child, 'config', 'user.email', 'fixture@example.invalid');
    await fs.writeFile(path.join(child, 'tracked'), 'one\n');
    git(child, 'add', 'tracked');
    git(child, 'commit', '-m', 'child one');
    git(controller, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'nested');
    git(controller, 'commit', '-m', 'add nested product');
    await fs.writeFile(path.join(child, 'tracked'), 'two\n');
    git(child, 'add', 'tracked');
    git(child, 'commit', '-m', 'child two');
    git(path.join(controller, 'nested'), 'fetch');
    git(path.join(controller, 'nested'), 'checkout', git(child, 'rev-parse', 'HEAD'));
    git(controller, 'add', 'nested');
    const head = git(controller, 'rev-parse', 'HEAD');
    const index = git(controller, 'write-tree');
    const result = python(checkpoint, ['--root', controller, 'staged-check', '--json'], controller);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('nested (gitlink)');
    expect(git(controller, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(controller, 'write-tree')).toBe(index);
  });

  it('writes a typed controller refusal and admits only the exact clean verified task tree', async () => {
    const controllerReceipt = path.join(temp, 'controller-edit.json');
    const refused = python(lifecycle, ['edit-preflight', '--repository', controller, '--target-ref', 'refs/heads/main', '--approved-base', base,
      '--task-id', 'T1', '--expected-path', 'product.txt', '--path', controller, '--task-worktree', task,
      '--task-branch-ref', 'refs/heads/task-T1', '--cleanup-owner', 'fixture', '--next-receipt', path.join(temp, 'next.json'),
      '--output', controllerReceipt], controller);
    expect(refused.status).toBe(2);
    const refusal = JSON.parse(fs.readFileSync(controllerReceipt, 'utf8'));
    expect(refusal).toMatchObject({ schema_version: 'juno_edit_preflight.v1', passed: false, workspace: { role: 'controller' } });
    expect(refusal.refusals).toContain('workspace_role_controller_refuses_product_edit');
    expect(refusal.safe_next_action.argv).toContain('create');

    const receipt = path.join(temp, 'task-edit.json');
    const installedLifecycle = path.join(task, '.juno_task', 'scripts', 'worktree_lifecycle.py');
    const admitted = python(installedLifecycle, ['edit-preflight', '--repository', task, '--target-ref', 'refs/heads/main', '--approved-base', base,
      '--task-id', 'T1', '--expected-path', 'product.txt', '--path', task, '--manifest', manifest, '--verify-receipt', verification,
      '--task-worktree', task, '--task-branch-ref', 'refs/heads/task-T1', '--cleanup-owner', 'fixture',
      '--next-receipt', path.join(temp, 'next-verify.json'), '--output', receipt], controller);
    expect(admitted.status, admitted.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(receipt, 'utf8'))).toMatchObject({ passed: true, workspace: { role: 'task' }, expected_paths: ['product.txt'] });
    expect(git(task, 'status', '--porcelain')).toBe('');
    expect(await fs.pathExists(path.join(task, '.juno_task', 'scripts', '__pycache__'))).toBe(false);
  });

  it('shares one classifier across staged checks, hooks, and no-verify detection', async () => {
    await fs.writeFile(path.join(controller, 'product.txt'), 'controller product\n');
    git(controller, 'add', 'product.txt');
    const beforeHead = git(controller, 'rev-parse', 'HEAD');
    const beforeIndex = git(controller, 'write-tree');
    const refused = python(checkpoint, ['--root', controller, 'staged-check', '--json'], controller);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('product.txt');
    expect(git(controller, 'rev-parse', 'HEAD')).toBe(beforeHead);
    expect(git(controller, 'write-tree')).toBe(beforeIndex);
    git(controller, 'restore', '--staged', '--worktree', 'product.txt');

    const hook = path.join(controller, '.git', 'hooks', 'pre-commit');
    await fs.ensureDir(path.dirname(hook));
    await fs.writeFile(hook, '#!/bin/sh\nprintf user-hook\\n >> "' + path.join(temp, 'hook.log') + '"\n');
    await fs.chmod(hook, 0o755);
    const digest = createHash('sha256').update(await fs.readFile(hook)).digest('hex');
    expect(python(checkpoint, ['--root', controller, 'hook', 'install'], controller).status).toBe(2);
    const installed = python(checkpoint, ['--root', controller, 'hook', 'install', '--approve-existing', `${hook}=${digest}`], controller);
    expect(installed.status, installed.stderr).toBe(0);
    expect(python(checkpoint, ['--root', controller, 'hook', 'install'], controller).status).toBe(0);

    await fs.writeFile(path.join(controller, '.juno_task', 'tasks', 'one.md'), 'two\n');
    git(controller, 'add', '.juno_task/tasks/one.md');
    git(controller, 'commit', '-m', 'controller evidence');
    expect(await fs.readFile(path.join(temp, 'hook.log'), 'utf8')).toContain('user-hook');

    const bypassBase = git(controller, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(controller, 'product.txt'), 'bypass\n');
    git(controller, 'add', 'product.txt');
    git(controller, 'commit', '--no-verify', '-m', 'unsafe bypass');
    const independent = python(checkpoint, ['--root', controller, 'committed-check', '--base', bypassBase, '--json'], controller);
    expect(independent.status).toBe(2);
    expect(independent.stderr).toContain('product.txt');
    const removed = python(checkpoint, ['--root', controller, 'hook', 'remove'], controller);
    expect(removed.status, removed.stderr).toBe(0);
    expect(createHash('sha256').update(await fs.readFile(hook)).digest('hex')).toBe(digest);
    expect(python(checkpoint, ['--root', controller, 'hook', 'remove'], controller).status).toBe(0);
  });
});
