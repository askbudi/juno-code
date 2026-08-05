import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const engine = path.resolve(process.cwd(), 'src/templates/scripts/git_flow.py');

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
}

function git(cwd: string, ...args: string[]): string {
  const result = run('git', args, cwd);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function commit(repo: string, message: string) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', message);
}

describe('configured Git flow', () => {
  let sandbox: string;
  let controller: string;
  let integration: string;
  let remote: string;
  let childRemote: string;
  let childSeed: string;
  const env = () => ({ JUNO_TASK_ROOT: controller, JUNO_WORKSPACE_ROLE: '', JUNO_GIT_FLOW_PYTHON: process.env.PYTHON || 'python3', GIT_ALLOW_PROTOCOL: 'file' });

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-git-flow-'));
    controller = path.join(sandbox, 'controller');
    integration = path.join(sandbox, 'integration');
    remote = path.join(sandbox, 'origin.git');
    childRemote = path.join(sandbox, 'child.git');
    childSeed = path.join(sandbox, 'child-seed');
    expect(run('git', ['init', '--bare', remote], sandbox).status).toBe(0);
    expect(run('git', ['init', '--bare', childRemote], sandbox).status).toBe(0);
    fs.ensureDirSync(childSeed);
    git(childSeed, 'init', '-b', 'main');
    git(childSeed, 'config', 'user.name', 'Test');
    git(childSeed, 'config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(childSeed, 'child.txt'), 'one\n');
    commit(childSeed, 'child one');
    git(childSeed, 'remote', 'add', 'origin', childRemote);
    git(childSeed, 'push', '-q', '-u', 'origin', 'main');
    fs.ensureDirSync(controller);
    git(controller, 'init', '-b', 'controller');
    git(controller, 'config', 'user.name', 'Test');
    git(controller, 'config', 'user.email', 'test@example.com');
    fs.ensureDirSync(path.join(controller, '.juno_task', 'tasks'));
    fs.writeJsonSync(path.join(controller, '.juno_task', 'config.json'), { defaultSubagent: 'pi' });
    fs.writeFileSync(path.join(controller, '.juno_task', 'tasks', 'board.ndjson'), 'controller-only\n');
    fs.writeFileSync(path.join(controller, 'product.txt'), 'base\n');
    git(controller, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '-b', 'main', childRemote, 'child');
    commit(controller, 'base');
    git(controller, 'branch', 'integration');
    git(controller, 'worktree', 'add', '--detach', integration, 'integration');
    git(integration, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init', '--checkout');
    fs.removeSync(path.join(integration, '.juno_task', 'tasks'));
    fs.writeFileSync(path.join(integration, 'product.txt'), 'integration\n');
    commit(integration, 'integration product');
    const old = git(controller, 'rev-parse', 'refs/heads/integration');
    const tip = git(integration, 'rev-parse', 'HEAD');
    git(controller, 'update-ref', 'refs/heads/integration', tip, old);
    git(controller, 'remote', 'add', 'origin', remote);
    git(controller, 'push', '-q', 'origin', 'controller', 'integration');
    git(controller, 'config', '--local', 'extensions.worktreeConfig', 'true');
    git(controller, 'config', '--local', 'juno.controller.path', controller);
    git(controller, 'config', '--local', 'juno.controller.branch', 'controller');
    git(integration, 'config', '--worktree', 'juno.workspace.role', 'integration-owner');
    git(integration, 'config', '--worktree', 'juno.workspace.roleAuthority', 'protected-integration.v1');
    git(integration, 'config', '--worktree', 'juno.workspace.roleBase', git(controller, 'rev-parse', 'refs/heads/integration'));
  });

  afterEach(async () => fs.remove(sandbox));

  it('configures explicit policy and reports detached integration identity', () => {
    const configured = run('python3', [engine, 'configure', '--integration-branch', 'integration', '--controller-branch', 'controller', '--integration-checkout', integration], controller, env());
    expect(configured.status, configured.stderr).toBe(0);
    const status = run('python3', [engine, 'status', '--no-fetch', '--json'], integration, env());
    expect(status.status, status.stderr).toBe(0);
    const value = JSON.parse(status.stdout);
    expect(value.integration).toMatchObject({ detached: true, clean: true, protectedPathViolations: [] });
    expect(value.integration.checkoutSha).toBe(value.integration.branchSha);
    const policy = fs.readJsonSync(path.join(controller, '.juno_task/config/git-flow.json'));
    expect(policy.schemaVersion).toBe('juno_git_flow.v1');
    expect(policy.controllerOwnedPaths).toContain('.juno_task/tasks');
  });

  it('composes integration locally while preserving controller-owned state and parent order', () => {
    expect(run('python3', [engine, 'configure', '--integration-branch', 'integration', '--controller-branch', 'controller', '--integration-checkout', integration], controller, env()).status).toBe(0);
    // Configuration is controller state and must be committed before the mutation gate.
    commit(controller, 'configure flow');
    const before = git(controller, 'rev-parse', 'HEAD');
    const source = git(controller, 'rev-parse', 'refs/heads/integration');
    const result = run('python3', [engine, 'controller-sync', '--json'], controller, env());
    expect(result.status, result.stderr).toBe(0);
    const head = git(controller, 'rev-parse', 'HEAD');
    expect(git(controller, 'show', '-s', '--format=%P', head).split(' ')).toEqual([before, source]);
    expect(fs.readFileSync(path.join(controller, 'product.txt'), 'utf8')).toBe('integration\n');
    expect(fs.readFileSync(path.join(controller, '.juno_task/tasks/board.ndjson'), 'utf8')).toBe('controller-only\n');
    expect(JSON.parse(result.stdout).remotePublished).toBe(false);
  });

  it('fast-forwards a stale detached checkout and publishes local integration commits', () => {
    expect(run('python3', [engine, 'configure', '--integration-branch', 'integration', '--controller-branch', 'controller', '--integration-checkout', integration], controller, env()).status).toBe(0);
    const publisher = path.join(sandbox, 'publisher');
    expect(run('git', ['clone', '-q', '-b', 'integration', remote, publisher], sandbox).status).toBe(0);
    git(publisher, 'config', 'user.name', 'Test');
    git(publisher, 'config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(publisher, 'remote.txt'), 'new remote\n');
    commit(publisher, 'remote advance');
    git(publisher, 'push', '-q', 'origin', 'integration');

    const synced = run('python3', [engine, 'sync', '--json'], integration, env());
    expect(synced.status, synced.stderr).toBe(0);
    expect(fs.readFileSync(path.join(integration, 'remote.txt'), 'utf8')).toBe('new remote\n');
    expect(run('git', ['-C', integration, 'symbolic-ref', '-q', 'HEAD'], integration).status).not.toBe(0);

    fs.writeFileSync(path.join(integration, 'local.txt'), 'local\n');
    commit(integration, 'local advance');
    const previous = git(controller, 'rev-parse', 'refs/heads/integration');
    git(controller, 'update-ref', 'refs/heads/integration', git(integration, 'rev-parse', 'HEAD'), previous);
    const pushed = run('python3', [engine, 'push', '--json'], integration, env());
    expect(pushed.status, pushed.stderr).toBe(0);
    expect(git(controller, 'ls-remote', 'origin', 'refs/heads/integration').split(/\s/)[0]).toBe(git(integration, 'rev-parse', 'HEAD'));
  });

  it('refuses a stale controller target without replacing the externally moved ref', () => {
    expect(run('python3', [engine, 'configure', '--integration-branch', 'integration', '--controller-branch', 'controller', '--integration-checkout', integration], controller, env()).status).toBe(0);
    commit(controller, 'configure flow');
    const external = path.join(sandbox, 'external-target');
    git(controller, 'worktree', 'add', '--detach', external, 'controller');
    git(external, 'config', 'user.name', 'Test');
    git(external, 'config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(external, 'external.txt'), 'external movement\n');
    commit(external, 'external target movement');
    const expectedExternal = git(external, 'rev-parse', 'HEAD');
    git(controller, 'update-ref', 'refs/heads/controller', expectedExternal);

    const result = run('python3', [engine, 'controller-sync', '--json'], controller, env());
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/controller checkout must be clean|controller moved/);
    expect(git(controller, 'rev-parse', 'refs/heads/controller')).toBe(expectedExternal);
    git(controller, 'worktree', 'remove', '--force', external);
  });

  it('advances configured submodule branches and pushes a local child before the root', () => {
    expect(run('python3', [engine, 'configure', '--integration-branch', 'integration', '--controller-branch', 'controller', '--integration-checkout', integration, '--submodules', 'tracking', '--advance-submodule-branches'], controller, env()).status).toBe(0);
    fs.writeFileSync(path.join(childSeed, 'child.txt'), 'two\n');
    commit(childSeed, 'child two');
    git(childSeed, 'push', '-q', 'origin', 'main');

    const synced = run('python3', [engine, 'sync', '--json'], integration, env());
    expect(synced.status, synced.stderr).toBe(0);
    expect(JSON.parse(synced.stdout).advancedSubmodules).toEqual(['child']);
    const remoteChild = git(childSeed, 'rev-parse', 'HEAD');
    expect(git(integration, 'rev-parse', 'HEAD:child')).toBe(remoteChild);

    const child = path.join(integration, 'child');
    git(child, 'config', 'user.name', 'Test');
    git(child, 'config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(child, 'child.txt'), 'three\n');
    commit(child, 'local child three');
    const localChild = git(child, 'rev-parse', 'HEAD');
    git(integration, 'add', 'child');
    commit(integration, 'record local child');
    const old = git(controller, 'rev-parse', 'refs/heads/integration');
    git(controller, 'update-ref', 'refs/heads/integration', git(integration, 'rev-parse', 'HEAD'), old);

    const pushed = run('python3', [engine, 'push', '--json'], integration, env());
    expect(pushed.status, pushed.stderr).toBe(0);
    expect(JSON.parse(pushed.stdout).pushed).toEqual(['child', 'root']);
    expect(git(childSeed, 'ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0]).toBe(localChild);
    expect(git(controller, 'ls-remote', 'origin', 'refs/heads/integration').split(/\s/)[0]).toBe(git(integration, 'rev-parse', 'HEAD'));
  });

  it('reports attached children and refuses dirty or divergent submodule state', () => {
    expect(run('python3', [engine, 'configure', '--integration-branch', 'integration', '--controller-branch', 'controller', '--integration-checkout', integration, '--submodules', 'tracking', '--advance-submodule-branches'], controller, env()).status).toBe(0);
    const child = path.join(integration, 'child');
    git(child, 'switch', '-c', 'attached-test');
    const attachedStatus = run('python3', [engine, 'status', '--no-fetch', '--json'], integration, env());
    expect(attachedStatus.status, attachedStatus.stderr).toBe(0);
    expect(JSON.parse(attachedStatus.stdout).submodules[0].detached).toBe(false);
    git(child, 'switch', '--detach', 'HEAD');

    fs.writeFileSync(path.join(child, 'dirty.txt'), 'dirty\n');
    const dirty = run('python3', [engine, 'sync', '--json'], integration, env());
    expect(dirty.status).toBe(2);
    expect(dirty.stderr).toMatch(/dirty/);
    fs.removeSync(path.join(child, 'dirty.txt'));

    fs.writeFileSync(path.join(childSeed, 'remote.txt'), 'remote\n');
    commit(childSeed, 'remote side');
    git(childSeed, 'push', '-q', 'origin', 'main');
    git(child, 'config', 'user.name', 'Test');
    git(child, 'config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(child, 'local.txt'), 'local\n');
    commit(child, 'local side');
    git(integration, 'add', 'child');
    commit(integration, 'record divergent child');
    const old = git(controller, 'rev-parse', 'refs/heads/integration');
    git(controller, 'update-ref', 'refs/heads/integration', git(integration, 'rev-parse', 'HEAD'), old);

    const divergent = run('python3', [engine, 'sync', '--json'], integration, env());
    expect(divergent.status).toBe(2);
    expect(divergent.stderr).toContain('submodule diverged: child');
  });

  it('fails closed when integration contains a controller-owned path', () => {
    expect(run('python3', [engine, 'configure', '--integration-branch', 'integration', '--controller-branch', 'controller', '--integration-checkout', integration], controller, env()).status).toBe(0);
    fs.ensureDirSync(path.join(integration, '.juno_task/tasks'));
    fs.writeFileSync(path.join(integration, '.juno_task/tasks/bad'), 'bad');
    commit(integration, 'bad ownership');
    const old = git(controller, 'rev-parse', 'refs/heads/integration');
    git(controller, 'update-ref', 'refs/heads/integration', git(integration, 'rev-parse', 'HEAD'), old);
    const status = run('python3', [engine, 'status', '--no-fetch', '--json'], integration, env());
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout).integration.protectedPathViolations).toContain('.juno_task/tasks');
  });
});
