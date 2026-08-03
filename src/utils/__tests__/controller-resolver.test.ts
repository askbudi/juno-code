import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveAutomaticProjectBootstrap } from '../controller-resolver.js';

const resolverTemplate = path.resolve(process.cwd(), 'src/templates/scripts/controller_resolver.py');
const wrapperTemplate = path.resolve(process.cwd(), 'src/templates/scripts/kanban.sh');
const policyTemplate = path.resolve(process.cwd(), 'src/templates/scripts/juno-toolchain-policy.sh');

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      JUNO_TASK_ROOT: '',
      JUNO_CONTROLLER_BRANCH: '',
      JUNO_WORKSPACE_ROLE: '',
      JUNO_WORKSPACE_ENFORCEMENT: '',
      ...env,
    },
  });
}

function git(cwd: string, ...args: string[]) {
  const result = run('git', args, cwd);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe('canonical controller resolver', () => {
  let sandbox: string;
  let controller: string;
  let task: string;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'juno controller resolver '));
    controller = path.join(sandbox, 'controller checkout');
    task = path.join(sandbox, 'task checkout');
    await fs.ensureDir(path.join(controller, '.juno_task', 'scripts'));
    controller = await fs.realpath(controller);
    await fs.copy(resolverTemplate, path.join(controller, '.juno_task', 'scripts', 'controller_resolver.py'));
    await fs.copy(wrapperTemplate, path.join(controller, '.juno_task', 'scripts', 'kanban.sh'));
    await fs.copy(policyTemplate, path.join(controller, '.juno_task', 'scripts', 'juno-toolchain-policy.sh'));
    git(controller, 'init', '-b', 'controller-branch');
    git(controller, 'config', 'user.email', 'test@example.invalid');
    git(controller, 'config', 'user.name', 'Test');
    git(controller, 'add', '.juno_task');
    git(controller, 'commit', '-m', 'fixture');
    git(controller, 'worktree', 'add', '-b', 'feature-task', task);
    task = await fs.realpath(task);
    git(task, 'config', '--local', 'juno.controller.path', controller);
    git(task, 'config', '--local', 'juno.controller.branch', 'controller-branch');
  });

  afterEach(async () => fs.remove(sandbox));

  it('resolves a registered controller across a real linked worktree with spaces', () => {
    const result = run('python3', [path.join(task, '.juno_task/scripts/controller_resolver.py'), '--cwd', task], task);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ path: controller, current_root: task, resolver: 'installed', source: 'registration', actual_branch: 'controller-branch', role: 'task', valid: true });
  });

  it('allows implicit bootstrap only in the resolved controller and preserves resolver failure truth', () => {
    const names = ['JUNO_TASK_ROOT', 'JUNO_CONTROLLER_BRANCH', 'JUNO_WORKSPACE_ROLE', 'JUNO_WORKSPACE_ENFORCEMENT'] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) process.env[name] = '';
      expect(resolveAutomaticProjectBootstrap(controller)).toMatchObject({
        allowed: true,
        reason: 'controller',
        resolution: { current_root: controller, role: 'controller' },
      });

      // Environment role is assertion-only and cannot reclassify persisted task topology.
      process.env.JUNO_WORKSPACE_ROLE = 'controller';
      expect(() => resolveAutomaticProjectBootstrap(task)).toThrow();
      process.env.JUNO_WORKSPACE_ROLE = '';

      git(task, 'config', '--local', 'juno.controller.path', path.join(sandbox, 'missing-controller'));
      expect(() => resolveAutomaticProjectBootstrap(task)).toThrow();
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('treats explicit roots as assertions and never falls back from invalid or unrelated roots', async () => {
    const explicit = run('python3', [path.join(task, '.juno_task/scripts/controller_resolver.py'), '--cwd', task], task, { JUNO_TASK_ROOT: controller });
    expect(JSON.parse(explicit.stdout).source).toBe('registration');
    const invalid = run('python3', [path.join(task, '.juno_task/scripts/controller_resolver.py'), '--cwd', task], task, { JUNO_TASK_ROOT: path.join(sandbox, 'missing') });
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain('assertion mismatch');

    const unrelated = path.join(sandbox, 'unrelated controller');
    await fs.ensureDir(path.join(unrelated, '.juno_task'));
    git(unrelated, 'init', '-b', 'controller-branch');
    const wrongRepository = run(
      'python3',
      [path.join(task, '.juno_task/scripts/controller_resolver.py'), '--cwd', task],
      task,
      { JUNO_TASK_ROOT: unrelated, JUNO_CONTROLLER_BRANCH: 'controller-branch' },
    );
    expect(wrongRepository.status).toBe(2);
    expect(wrongRepository.stderr).toContain('assertion mismatch');
  });

  it('rejects stale and wrong-branch registrations without changing either HEAD', () => {
    git(task, 'config', '--local', 'juno.controller.branch', 'wrong-branch');
    const beforeTask = git(task, 'rev-parse', 'HEAD');
    const beforeController = git(controller, 'rev-parse', 'HEAD');
    const wrong = run('python3', [path.join(task, '.juno_task/scripts/controller_resolver.py'), '--cwd', task], task);
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain('branch mismatch');
    git(task, 'config', '--local', 'juno.controller.path', path.join(sandbox, 'gone'));
    const missing = run('python3', [path.join(task, '.juno_task/scripts/controller_resolver.py'), '--cwd', task], task);
    expect(missing.status).toBe(2);
    expect(git(task, 'rev-parse', 'HEAD')).toBe(beforeTask);
    expect(git(controller, 'rev-parse', 'HEAD')).toBe(beforeController);
  });

  it('supports warn and strict integration-owner enforcement', () => {
    const registration = run('python3', [path.join(task, '.juno_task/scripts/controller_resolver.py'), '--cwd', task, '--register-workspace-role', 'integration-owner'], task);
    expect(registration.status, registration.stderr).toBe(0);
    const warn = run('python3', [path.join(task, '.juno_task/scripts/controller_resolver.py'), '--cwd', task, '--operation', 'orchestration'], task, { JUNO_WORKSPACE_ROLE: 'integration-owner', JUNO_WORKSPACE_ENFORCEMENT: 'warn' });
    expect(warn.status).toBe(0);
    expect(warn.stderr).toContain('warning');
    const strict = run('python3', [path.join(task, '.juno_task/scripts/controller_resolver.py'), '--cwd', task, '--operation', 'session-write'], task, { JUNO_WORKSPACE_ROLE: 'integration-owner', JUNO_WORKSPACE_ENFORCEMENT: 'strict' });
    expect(strict.status).toBe(2);
    expect(strict.stderr).toContain('refuses session-write');
  });

  it('routes the task wrapper mutation process to controller storage', async () => {
    const bin = path.join(controller, '.venv_juno', 'bin');
    await fs.ensureDir(bin);
    await fs.writeFile(path.join(bin, 'activate'), `export VIRTUAL_ENV=${JSON.stringify(path.join(controller, '.venv_juno'))}\nexport PATH=${JSON.stringify(bin)}:$PATH\n`);
    await fs.writeFile(path.join(bin, 'juno-kanban'), '#!/usr/bin/env python3\nimport os,sys\nif sys.argv[1:] == ["--version"]: print("task 2.0.5")\nelse: print(os.environ["JUNO_TASK_ROOT"] + "|" + " ".join(sys.argv[1:]))\n');
    await fs.chmod(path.join(bin, 'juno-kanban'), 0o755);
    const result = run(path.join(task, '.juno_task/scripts/kanban.sh'), ['mark', 'done', '--id', 'ABC123'], task);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`${controller}|mark done --id ABC123`);
    expect(await fs.pathExists(path.join(task, '.venv_juno'))).toBe(false);
  });
});
