import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectWorkspaceTopology, workspaceLocation } from '../workspace-topology.js';

const fixtures: string[] = [];
function run(cwd: string, ...args: string[]): string {
  return execFileSync(args[0]!, args.slice(1), {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function git(cwd: string, ...args: string[]): string {
  return run(cwd, 'git', ...args);
}

function fixture(): { primary: string; controller: string; integration: string; task: string } {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'juno-topology-')));
  fixtures.push(base);
  const primary = path.join(base, 'primary');
  mkdirSync(primary);
  git(primary, 'init', '-q');
  git(primary, 'config', 'user.email', 'test@example.com');
  git(primary, 'config', 'user.name', 'Test');
  writeFileSync(path.join(primary, 'README.md'), 'fixture\n');
  git(primary, 'add', 'README.md');
  git(primary, 'commit', '-qm', 'initial');
  git(primary, 'branch', 'target');
  git(primary, 'branch', 'controller');
  const controller = path.join(base, 'controller');
  const integration = path.join(base, 'integration');
  const task = path.join(base, 'task-T1');
  git(primary, 'worktree', 'add', '-q', controller, 'controller');
  git(primary, 'worktree', 'add', '-q', '--detach', integration, 'target');
  git(primary, 'worktree', 'add', '-q', '-b', 'task-T1', task, 'target');
  for (const root of [primary, controller, integration, task])
    mkdirSync(path.join(root, '.juno_task', 'scripts'), { recursive: true });
  const resolver = path.resolve(process.cwd(), 'src/templates/scripts/controller_resolver.py');
  for (const root of [primary, controller, integration, task])
    writeFileSync(
      path.join(root, '.juno_task/scripts/controller_resolver.py'),
      readFileSync(resolver),
    );
  mkdirSync(path.join(controller, '.juno_task', 'config'), { recursive: true });
  writeFileSync(
    path.join(controller, '.juno_task/config/task-workspace.json'),
    JSON.stringify({ target_ref: 'refs/heads/target' }),
  );
  git(primary, 'config', 'extensions.worktreeConfig', 'true');
  git(primary, 'config', 'juno.controller.path', controller);
  // Deliberately short: normalized comparison must remain valid and diagnose spelling drift.
  git(primary, 'config', 'juno.controller.branch', 'controller');
  git(controller, 'config', '--worktree', 'juno.workspace.role', 'controller');
  git(integration, 'config', '--worktree', 'juno.workspace.role', 'integration-owner');
  git(
    integration,
    'config',
    '--worktree',
    'juno.workspace.roleAuthority',
    'protected-integration.v1',
  );
  git(task, 'config', '--worktree', 'juno.workspace.role', 'task');
  git(task, 'config', '--worktree', 'juno.workspace.taskId', 'T1');
  for (const key of ['manifestIdentity', 'createReceiptSha256', 'expectedPathsSha256'])
    git(task, 'config', '--worktree', `juno.workspace.${key}`, 'identity');
  return { primary, controller, integration, task };
}

afterEach(() => {
  for (const item of fixtures.splice(0)) spawnSync('rm', ['-rf', item]);
});

describe('normalized workspace topology', () => {
  it('discovers linked roles, normalizes controller refs, and resolves script-safe paths', () => {
    const value = fixture();
    const report = inspectWorkspaceTopology(path.join(value.task, '.juno_task'), '2.1.1');
    expect(report.schemaVersion).toBe('juno.workspace-topology.v1');
    expect(report.invocation.role).toBe('task');
    expect(report.controller.valid).toBe(true);
    expect(report.findings.map((item) => item.code)).toContain('controller-ref-spelling-drift');
    expect(report.integration.owner?.path).toBe(value.integration);
    expect(workspaceLocation(report, 'controller')).toBe(value.controller);
    expect(workspaceLocation(report, 'integration')).toBe(value.integration);
    expect(workspaceLocation(report, 'task', 'T1')).toBe(value.task);
  });

  it('shows missing resolver as unmanaged rather than valid controller truth', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'juno-unmanaged-'));
    fixtures.push(base);
    git(base, 'init', '-q');
    const report = inspectWorkspaceTopology(base, '2.1.1');
    expect(report.resolver.status).toBe('missing');
    expect(report.invocation.role).toBe('unregistered');
    expect(report.invocation.managed).toBe(false);
    expect(report.repository.managed).toBe(false);
    expect(() => workspaceLocation(report, 'controller')).toThrow(/found 0/);
  });

  it('detects stale owners, wrong-role target holders, and incomplete tasks', () => {
    const value = fixture();
    git(value.primary, 'checkout', 'target');
    writeFileSync(path.join(value.primary, 'later'), 'later');
    git(value.primary, 'add', 'later');
    git(value.primary, 'commit', '-qm', 'advance target');
    git(value.task, 'config', '--worktree', '--unset', 'juno.workspace.manifestIdentity');
    const report = inspectWorkspaceTopology(value.controller, '2.1.1');
    const codes = report.findings.map((item) => item.code);
    expect(codes).toContain('integration-owner-stale');
    expect(codes).toContain('target-owner-role-mismatch');
    expect(codes).toContain('task-identity-incomplete');
  });

  it('does not mutate Git or filesystem state', () => {
    const value = fixture();
    const before =
      run(value.primary, 'git', 'for-each-ref', '--format=%(refname) %(objectname)') +
      run(value.primary, 'git', 'worktree', 'list', '--porcelain');
    inspectWorkspaceTopology(value.integration, '2.1.1');
    const after =
      run(value.primary, 'git', 'for-each-ref', '--format=%(refname) %(objectname)') +
      run(value.primary, 'git', 'worktree', 'list', '--porcelain');
    expect(after).toBe(before);
  });
});
